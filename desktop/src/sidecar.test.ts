import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { parseReadyLine, resolveSidecarExecutable, stopSidecar, waitForSidecarReady } from './sidecar'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function fakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  return child as unknown as ChildProcessWithoutNullStreams
}

describe('sidecar readiness', () => {
  it('accepts only a valid ready JSON line', () => {
    expect(parseReadyLine('{"event":"ready","port":43123}')).toEqual({ event: 'ready', port: 43123 })
    expect(parseReadyLine('{"event":"ready","port":0}')).toBeNull()
    expect(parseReadyLine('{"event":"log","port":43123}')).toBeNull()
    expect(parseReadyLine('not json')).toBeNull()
  })

  it('ignores log lines before resolving the ready port', async () => {
    const child = fakeChild()
    const ready = waitForSidecarReady(child, 1_000)
    child.stdout.write('starting migrations\n')
    child.stdout.write('{"event":"ready","port":45678}\n')
    await expect(ready).resolves.toBe(45678)
  })

  it('reports stderr when the process exits before readiness', async () => {
    const child = fakeChild()
    const ready = waitForSidecarReady(child, 1_000)
    child.stderr.write('database unavailable')
    child.emit('exit', 2, null)
    await expect(ready).rejects.toThrow('database unavailable')
  })

  it('times out when no ready event arrives', async () => {
    const child = fakeChild()
    await expect(waitForSidecarReady(child, 5)).rejects.toThrow('5ms')
  })

  it('resolves the PyInstaller ShijianBackend onedir layout', async () => {
    const resourceDir = await mkdtemp(path.join(os.tmpdir(), 'shijian-sidecar-'))
    temporaryDirectories.push(resourceDir)
    const executable = process.platform === 'win32' ? 'ShijianBackend.exe' : 'ShijianBackend'
    const executablePath = path.join(resourceDir, 'sidecar', 'ShijianBackend', executable)
    await mkdir(path.dirname(executablePath), { recursive: true })
    await writeFile(executablePath, '')
    await expect(resolveSidecarExecutable(resourceDir, '')).resolves.toBe(executablePath)
  })

  it('closes stdin and waits for a graceful sidecar exit', async () => {
    const child = fakeChild()
    child.stdin.once('finish', () => {
      child.exitCode = 0
      child.emit('exit', 0, null)
    })
    await stopSidecar(child, 1_000)
    expect(child.stdin.writableEnded).toBe(true)
  })
})

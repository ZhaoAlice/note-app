import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'

export interface SidecarReady {
  event: 'ready'
  port: number
}

export interface RunningSidecar {
  child: ChildProcessWithoutNullStreams
  port: number
}

export interface SidecarLaunchOptions {
  executablePath: string
  configPath: string
  resourceDir: string
  desktopToken: string
  parentPid?: number
  readyTimeoutMs?: number
}

export function parseReadyLine(line: string): SidecarReady | null {
  try {
    const value = JSON.parse(line) as { event?: unknown; port?: unknown }
    if (value.event !== 'ready' || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) return null
    return { event: 'ready', port: Number(value.port) }
  } catch {
    return null
  }
}

export async function resolveSidecarExecutable(resourceDir: string, override = process.env.SHIJIAN_SIDECAR_PATH): Promise<string> {
  const executable = process.platform === 'win32' ? 'ShijianBackend.exe' : 'ShijianBackend'
  const candidates = [
    override,
    path.join(resourceDir, 'sidecar', executable),
    path.join(resourceDir, 'sidecar', 'ShijianBackend', executable),
    path.join(resourceDir, 'sidecar', process.platform, executable),
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next supported PyInstaller onedir layout.
    }
  }
  throw new Error(`找不到桌面服务程序。已检查：${candidates.join(', ')}`)
}

export function waitForSidecarReady(child: ChildProcessWithoutNullStreams, timeoutMs = 30_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const stderr: string[] = []
    const lines = readline.createInterface({ input: child.stdout })
    let settled = false
    const finish = (error?: Error, port?: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      lines.close()
      child.stderr.off('data', onStderr)
      child.off('error', onError)
      child.off('exit', onExit)
      if (error) {
        reject(error)
      } else {
        // Uvicorn continues writing access and error logs after the READY line.
        // Drain both pipes for the lifetime of the child; otherwise their OS
        // buffers eventually fill and block every backend request.
        child.stdout.resume()
        child.stderr.resume()
        resolve(port as number)
      }
    }
    const onStderr = (chunk: Buffer): void => {
      stderr.push(chunk.toString('utf8'))
      if (stderr.length > 20) stderr.shift()
    }
    const onError = (error: Error): void => finish(error)
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const detail = stderr.join('').trim()
      finish(new Error(`桌面服务在就绪前退出 (${code ?? signal ?? 'unknown'})${detail ? `：${detail}` : ''}`))
    }
    const timer = setTimeout(() => finish(new Error(`桌面服务在 ${timeoutMs}ms 内未就绪`)), timeoutMs)
    child.stderr.on('data', onStderr)
    child.once('error', onError)
    child.once('exit', onExit)
    lines.on('line', (line) => {
      const ready = parseReadyLine(line)
      if (ready) finish(undefined, ready.port)
    })
  })
}

export async function launchSidecar(options: SidecarLaunchOptions): Promise<RunningSidecar> {
  const args = [
    '--desktop',
    '--config', options.configPath,
    '--resource-dir', options.resourceDir,
    '--port', '0',
    '--token', options.desktopToken,
    '--parent-pid', String(options.parentPid ?? process.pid),
  ]
  const child = spawn(options.executablePath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  })
  try {
    const port = await waitForSidecarReady(child, options.readyTimeoutMs)
    return { child, port }
  } catch (error) {
    await forceKillProcessTree(child)
    throw error
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

export async function forceKillProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve())
    })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

export async function stopSidecar(child: ChildProcessWithoutNullStreams, graceMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.stdin.on('error', () => undefined)
  child.stdin.end()
  if (!(await waitForExit(child, graceMs))) await forceKillProcessTree(child)
}

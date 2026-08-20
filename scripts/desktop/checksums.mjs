import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const rootArgument = process.argv.indexOf('--root')
const outputRoot = rootArgument >= 0 && process.argv[rootArgument + 1]
  ? resolve(process.argv[rootArgument + 1])
  : resolve(repoRoot, 'desktop', 'out', 'make')

async function filesUnder(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) result.push(...await filesUnder(path))
    else if (entry.isFile() && entry.name !== 'SHA256SUMS.txt') result.push(path)
  }
  return result
}

async function sha256(path) {
  const hash = createHash('sha256')
  await new Promise((resolvePromise, rejectPromise) => {
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('end', resolvePromise).on('error', rejectPromise)
  })
  return hash.digest('hex')
}

const info = await stat(outputRoot).catch(() => null)
if (!info?.isDirectory()) throw new Error(`Forge output directory not found: ${outputRoot}`)
const files = (await filesUnder(outputRoot)).sort()
const lines = []
for (const path of files) lines.push(`${await sha256(path)}  ${relative(outputRoot, path).replaceAll('\\', '/')}`)
await writeFile(resolve(outputRoot, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8')
process.stdout.write(`Wrote checksums for ${files.length} desktop artifacts.\n`)

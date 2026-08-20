import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const resourceRoot = resolve(repoRoot, 'desktop', 'resources')

function argument(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name} <path>`)
  const value = process.argv[index + 1]
  return isAbsolute(value) ? resolve(value) : resolve(repoRoot, value)
}

function assertInside(parent, target) {
  const path = relative(parent, target)
  if (!path || path.startsWith('..') || isAbsolute(path)) throw new Error(`Unsafe generated resource path: ${target}`)
}

async function assertDirectory(path, label) {
  const info = await stat(path).catch(() => null)
  if (!info?.isDirectory()) throw new Error(`${label} directory does not exist: ${path}`)
}

async function replaceDirectory(source, target) {
  assertInside(resourceRoot, target)
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  await cp(source, target, { recursive: true, force: true })
}

const sidecarSource = argument('--sidecar')
const modelSource = argument('--models')
const frontendSource = resolve(repoRoot, 'frontend', 'dist')
await Promise.all([
  assertDirectory(frontendSource, 'Frontend build'),
  assertDirectory(sidecarSource, 'PyInstaller sidecar'),
  assertDirectory(modelSource, 'OCR model'),
])

await mkdir(resourceRoot, { recursive: true })
await Promise.all([
  replaceDirectory(frontendSource, join(resourceRoot, 'frontend')),
  replaceDirectory(sidecarSource, join(resourceRoot, 'sidecar')),
  replaceDirectory(modelSource, join(resourceRoot, 'ocr-models')),
])

const desktopPackage = JSON.parse(await readFile(resolve(repoRoot, 'desktop', 'package.json'), 'utf8'))
await writeFile(
  join(resourceRoot, 'build-info.json'),
  `${JSON.stringify({ version: desktopPackage.version, platform: process.platform, arch: process.arch }, null, 2)}\n`,
  'utf8',
)

process.stdout.write(`Prepared desktop resources in ${resourceRoot}\n`)

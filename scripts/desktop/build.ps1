[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$CleanInstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$backendDir = Join-Path $repoRoot 'backend'
$frontendDir = Join-Path $repoRoot 'frontend'
$desktopDir = Join-Path $repoRoot 'desktop'
$backendPython = Join-Path $backendDir '.venv\Scripts\python.exe'

if ($SkipInstall -and $CleanInstall) {
    throw '-SkipInstall and -CleanInstall cannot be used together.'
}

function Install-NodeDependencies {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Directory
    )

    $nodeModules = Join-Path $Directory 'node_modules'
    $canReuse = $env:CI -ne 'true' -and -not $CleanInstall -and (Test-Path -LiteralPath $nodeModules -PathType Container)
    if ($canReuse) {
        npm --prefix $Directory ls --depth=0 --silent *> $null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "$Label dependencies are already complete; reusing node_modules." -ForegroundColor DarkGray
            return
        }
    }

    npm --prefix $Directory ci
    if ($LASTEXITCODE -ne 0) {
        throw "$Label dependency installation failed. If Vite is running, stop it first because Windows locks esbuild.exe, then retry."
    }
}

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'uv was not found on PATH.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm was not found on PATH.' }
if (-not $env:ELECTRON_MIRROR -and $env:CI -ne 'true') {
    $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
}

if (-not $SkipInstall) {
    Install-NodeDependencies -Label 'Frontend' -Directory $frontendDir
    Install-NodeDependencies -Label 'Desktop' -Directory $desktopDir
}

npm --prefix $frontendDir run build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }

Push-Location $backendDir
try {
    uv sync --extra test --extra desktop
    if ($LASTEXITCODE -ne 0) { throw 'Backend desktop dependency installation failed.' }
    uv run --no-sync python -m app.book_ocr --prepare
    if ($LASTEXITCODE -ne 0) { throw 'OCR model preparation failed.' }
    uv run --no-sync pyinstaller --clean --noconfirm desktop.spec
    if ($LASTEXITCODE -ne 0) { throw 'PyInstaller sidecar build failed.' }
}
finally {
    Pop-Location
}

$sidecarExecutable = Join-Path $backendDir 'dist\ShijianBackend\ShijianBackend.exe'
& $sidecarExecutable --self-test
if ($LASTEXITCODE -ne 0) { throw 'Frozen sidecar self-test failed.' }

node (Join-Path $PSScriptRoot 'prepare-resources.mjs') `
    --sidecar (Join-Path $backendDir 'dist\ShijianBackend') `
    --models (Join-Path $backendDir 'data\ocr-models')
if ($LASTEXITCODE -ne 0) { throw 'Desktop resource preparation failed.' }

npm --prefix $desktopDir run test
if ($LASTEXITCODE -ne 0) { throw 'Desktop tests failed.' }
$forgeBuildId = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$forgeOut = Join-Path $desktopDir "out\build-$forgeBuildId"
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$forgeStage = [IO.Path]::GetFullPath((Join-Path $tempRoot "shijian-forge-$PID-$forgeBuildId"))
if (-not $forgeStage.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe Forge staging path: $forgeStage"
}
Write-Host "Using isolated Forge staging directory: $forgeStage" -ForegroundColor DarkGray
New-Item -ItemType Directory -Path $forgeStage -Force | Out-Null
try {
    foreach ($name in @('package.json', 'package-lock.json', 'forge.config.ts', 'tsconfig.json', 'src', 'dist', 'resources')) {
        $source = Join-Path $desktopDir $name
        if (-not (Test-Path -LiteralPath $source)) { throw "Desktop staging source is missing: $source" }
        Copy-Item -LiteralPath $source -Destination (Join-Path $forgeStage $name) -Recurse -Force
    }
    npm --prefix $forgeStage ci --prefer-offline --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Forge staging dependency installation failed.' }
    npm --prefix $forgeStage run make
    if ($LASTEXITCODE -ne 0) { throw 'Electron Forge packaging failed.' }

    $stageOut = Join-Path $forgeStage 'out'
    if (-not (Test-Path -LiteralPath $stageOut -PathType Container)) {
        throw "Forge did not create its output directory: $stageOut"
    }
    New-Item -ItemType Directory -Path $forgeOut -Force | Out-Null
    Copy-Item -Path (Join-Path $stageOut '*') -Destination $forgeOut -Recurse -Force
}
finally {
    $resolvedStage = [IO.Path]::GetFullPath($forgeStage)
    if ($resolvedStage.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedStage)) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
$makeOut = Join-Path $forgeOut 'make'
node (Join-Path $PSScriptRoot 'checksums.mjs') --root $makeOut
if ($LASTEXITCODE -ne 0) { throw 'Desktop checksum generation failed.' }

Write-Host "Desktop installers are available under $makeOut" -ForegroundColor Green

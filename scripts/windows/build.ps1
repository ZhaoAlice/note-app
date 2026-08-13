[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$backendDir = Join-Path $repoRoot 'backend'
$frontendDir = Join-Path $repoRoot 'frontend'
$backendPython = Join-Path $backendDir '.venv\Scripts\python.exe'

if (-not (Test-Path $backendPython)) {
    throw 'Backend virtual environment was not found. Run .\scripts\windows\setup.ps1 first.'
}

Push-Location $backendDir
try {
    & $backendPython -m compileall -q app
    if ($LASTEXITCODE -ne 0) { throw 'Backend syntax check failed.' }
}
finally {
    Pop-Location
}

npm --prefix $frontendDir run build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }

Write-Host "Build complete: $frontendDir\dist" -ForegroundColor Green

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$backendDir = Join-Path $repoRoot 'backend'
$frontendDir = Join-Path $repoRoot 'frontend'

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw 'Python was not found on PATH. Install Python 3.12 or newer.'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'npm was not found on PATH. Install Node.js 20 or newer.'
}
if (-not (Test-Path (Join-Path $backendDir 'pyproject.toml'))) {
    throw "Backend project file not found: $backendDir\pyproject.toml"
}
if (-not (Test-Path (Join-Path $frontendDir 'package.json'))) {
    throw "Frontend package file not found: $frontendDir\package.json"
}

Push-Location $backendDir
try {
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        uv sync --extra test
        if ($LASTEXITCODE -ne 0) { throw 'Failed to install backend dependencies with uv.' }
    }
    else {
        $venvPython = Join-Path $backendDir '.venv\Scripts\python.exe'
        if (-not (Test-Path $venvPython)) {
            python -m venv (Join-Path $backendDir '.venv')
            if ($LASTEXITCODE -ne 0) { throw 'Failed to create the backend virtual environment.' }
        }
        & $venvPython -m pip install --upgrade pip
        if ($LASTEXITCODE -ne 0) { throw 'Failed to upgrade pip.' }
        & $venvPython -m pip install -e '.[test]'
        if ($LASTEXITCODE -ne 0) { throw 'Failed to install backend dependencies.' }
    }
}
finally {
    Pop-Location
}

npm --prefix $frontendDir ci
if ($LASTEXITCODE -ne 0) { throw 'Failed to install frontend dependencies.' }

Write-Host 'Dependencies installed successfully.' -ForegroundColor Green

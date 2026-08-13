[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$UvicornArgs
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$backendDir = Join-Path $repoRoot 'backend'
$frontendDist = Join-Path $repoRoot 'frontend\dist'
$backendPython = Join-Path $backendDir '.venv\Scripts\python.exe'

if (-not (Test-Path $frontendDist)) {
    throw 'frontend/dist was not found. Run .\scripts\windows\build.ps1 first.'
}
if (-not (Test-Path $backendPython)) {
    throw 'Backend virtual environment was not found. Run .\scripts\windows\setup.ps1 first.'
}

Push-Location $backendDir
try {
    & $backendPython -m alembic upgrade head
    if ($LASTEXITCODE -ne 0) { throw 'Database migration failed.' }

    $arguments = @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000')
    if ($UvicornArgs) { $arguments += $UvicornArgs }
    & $backendPython $arguments
    if ($LASTEXITCODE -ne 0) { throw "Server exited with code $LASTEXITCODE." }
}
finally {
    Pop-Location
}

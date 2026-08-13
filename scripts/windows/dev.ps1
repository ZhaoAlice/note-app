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
    & $backendPython -m alembic upgrade head
    if ($LASTEXITCODE -ne 0) { throw 'Database migration failed.' }
}
finally {
    Pop-Location
}

$backend = $null
$frontend = $null
try {
    $backend = Start-Process -FilePath $backendPython -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--reload', '--host', '127.0.0.1', '--port', '8000') -WorkingDirectory $backendDir -NoNewWindow -PassThru
    $frontend = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'dev', '--', '--host', '127.0.0.1') -WorkingDirectory $frontendDir -NoNewWindow -PassThru

    Write-Host 'Frontend: http://localhost:5173' -ForegroundColor Cyan
    Write-Host 'Backend:  http://localhost:8000' -ForegroundColor Cyan
    Write-Host 'Press Ctrl+C to stop both processes.'

    while (-not $backend.HasExited -and -not $frontend.HasExited) {
        Start-Sleep -Milliseconds 500
    }

    if ($backend.HasExited -and $backend.ExitCode -ne 0) {
        throw "Backend exited with code $($backend.ExitCode)."
    }
    if ($frontend.HasExited -and $frontend.ExitCode -ne 0) {
        throw "Frontend exited with code $($frontend.ExitCode)."
    }
}
finally {
    foreach ($process in @($backend, $frontend)) {
        if ($null -ne $process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
        }
    }
}

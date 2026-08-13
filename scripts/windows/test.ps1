[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$backendDir = Join-Path $repoRoot 'backend'
$frontendDir = Join-Path $repoRoot 'frontend'
$backendPython = Join-Path $backendDir '.venv\Scripts\python.exe'
$previousTestDatabaseUrl = $env:NOTE_TEST_DATABASE_URL
$previousDatabaseUrl = $env:NOTE_DATABASE__URL

if (-not (Test-Path $backendPython)) {
    throw 'Backend virtual environment was not found. Run .\scripts\windows\setup.ps1 first.'
}

Push-Location $backendDir
try {
    $env:NOTE_TEST_DATABASE_URL = $null
    $env:NOTE_DATABASE__URL = $null
    & $backendPython -m pytest
    if ($LASTEXITCODE -ne 0) { throw 'Backend tests failed.' }

    $databaseRuns = @(
        @{ Name = 'MySQL'; Url = $env:TEST_MYSQL_URL },
        @{ Name = 'PostgreSQL'; Url = $env:TEST_POSTGRESQL_URL }
    )
    foreach ($databaseRun in $databaseRuns) {
        if ([string]::IsNullOrWhiteSpace($databaseRun.Url)) { continue }
        Write-Host "Running backend tests against $($databaseRun.Name)..." -ForegroundColor Cyan
        $env:NOTE_TEST_DATABASE_URL = $databaseRun.Url
        $env:NOTE_DATABASE__URL = $databaseRun.Url
        & $backendPython -m pytest
        if ($LASTEXITCODE -ne 0) { throw "$($databaseRun.Name) backend tests failed." }
    }
}
finally {
    $env:NOTE_TEST_DATABASE_URL = $previousTestDatabaseUrl
    $env:NOTE_DATABASE__URL = $previousDatabaseUrl
    Pop-Location
}

npm --prefix $frontendDir test -- --run
if ($LASTEXITCODE -ne 0) { throw 'Frontend tests failed.' }

Write-Host 'All tests passed.' -ForegroundColor Green

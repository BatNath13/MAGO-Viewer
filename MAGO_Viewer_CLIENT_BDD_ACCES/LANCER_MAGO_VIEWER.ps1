$ErrorActionPreference = "Stop"

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$API  = Join-Path $ROOT "api\mago-enrichment-api"

function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

function Find-Npm {
    $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidate = "C:\Program Files\nodejs\npm.cmd"
    if (Test-Path $candidate) { return $candidate }
    return $null
}

Refresh-Path
$Npm = Find-Npm
if (-not $Npm) { throw "npm.cmd was not found. Run INSTALLER_VIEWER_COMPLET.ps1 first." }
if (-not (Test-Path (Join-Path $API ".env"))) { throw ".env is missing. Run INSTALLER_VIEWER_COMPLET.ps1 first." }

$PgService = Get-Service -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "postgresql*" } |
    Sort-Object Name -Descending |
    Select-Object -First 1

if ($PgService -and $PgService.Status -ne "Running") {
    Start-Service $PgService.Name
    $PgService.WaitForStatus("Running", [TimeSpan]::FromSeconds(20))
}
elseif (-not $PgService) {
    $PgCtlCandidates = @(
        "C:\PGSQL\pgsql\bin\pg_ctl.exe"
    )
    $PgCtlCandidates += Get-ChildItem "C:\Program Files\PostgreSQL" -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName "bin\pg_ctl.exe" }

    $PgCtl = $PgCtlCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    $PgData = "C:\PGSQL\pgdata"
    if ($PgCtl -and (Test-Path (Join-Path $PgData "PG_VERSION"))) {
        & $PgCtl -D $PgData -l "C:\PGSQL\postgresql.log" start | Out-Null
        Start-Sleep -Seconds 3
    }
}

$ApiOk = $false
try {
    $r = Invoke-WebRequest "http://127.0.0.1:3001/api/health" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $ApiOk = $true }
}
catch {}

if (-not $ApiOk) {
    Start-Process cmd.exe -WindowStyle Minimized -ArgumentList @(
        "/k", "cd /d `"$API`" && `"$Npm`" start"
    )

    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        try {
            $r = Invoke-WebRequest "http://127.0.0.1:3001/api/health" -UseBasicParsing -TimeoutSec 2
            if ($r.StatusCode -eq 200) { $ApiOk = $true; break }
        }
        catch {}
    }
}

if (-not $ApiOk) { throw "MAGO API did not start on port 3001." }
Start-Process "http://localhost:3001/"

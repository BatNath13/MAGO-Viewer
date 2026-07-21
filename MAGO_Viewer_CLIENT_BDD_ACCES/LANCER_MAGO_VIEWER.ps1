$ErrorActionPreference = "SilentlyContinue"

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$API  = Join-Path $ROOT "api\mago-enrichment-api"

$PG_CTL = "D:\PGSQL\pgsql\bin\pg_ctl.exe"
$PGDATA = "D:\PGSQL\pgdata"
$PGLOG  = "D:\PGSQL\postgresql.log"

# 1) Démarrer PostgreSQL si besoin
$pgStatus = & $PG_CTL -D $PGDATA status 2>&1
if ($LASTEXITCODE -ne 0 -or ($pgStatus -notmatch "server is running|serveur est en cours")) {
    & $PG_CTL -D $PGDATA -l $PGLOG start | Out-Null
    Start-Sleep -Seconds 2
}

# 2) Démarrer l'API si elle n'est pas déjà lancée
$apiOk = $false
try {
    $r = Invoke-WebRequest "http://127.0.0.1:3001/api/health" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $apiOk = $true }
} catch {}

if (-not $apiOk) {
    Start-Process powershell.exe -WindowStyle Minimized -ArgumentList @(
        "-NoExit",
        "-ExecutionPolicy", "Bypass",
        "-Command", "cd `"$API`"; npm start"
    )

    for ($i = 0; $i -lt 20; $i++) {
        try {
            $r = Invoke-WebRequest "http://127.0.0.1:3001/api/health" -UseBasicParsing -TimeoutSec 1
            if ($r.StatusCode -eq 200) { break }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
}

# 3) Ouvrir le viewer éditeur comme avant
Start-Process "http://localhost:3001/"

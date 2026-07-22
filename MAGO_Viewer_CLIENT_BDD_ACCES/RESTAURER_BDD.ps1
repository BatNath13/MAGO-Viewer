$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$BACKUPS = Join-Path $ROOT "SAUVEGARDES_BDD"

function Find-PgBin {
    $candidates = @("C:\PGSQL\pgsql\bin")
    $candidates += Get-ChildItem "C:\Program Files\PostgreSQL" -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName "bin" }
    foreach ($dir in $candidates) {
        if (Test-Path (Join-Path $dir "pg_restore.exe")) { return $dir }
    }
    return $null
}

$PG_BIN = Find-PgBin
if (-not $PG_BIN) { throw "pg_restore.exe was not found." }
$dirs = Get-ChildItem $BACKUPS -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
if (-not $dirs) { throw "No backup found in $BACKUPS" }

Write-Host "Available backups:" -ForegroundColor Cyan
for ($i = 0; $i -lt $dirs.Count; $i++) { Write-Host "  [$i] $($dirs[$i].Name)" }
$choice = Read-Host "Backup number"
$SRC = $dirs[[int]$choice].FullName
$confirm = Read-Host "Overwrite current MAGO databases with $($dirs[[int]$choice].Name)? (yes/no)"
if ($confirm -ne "yes") { Write-Host "Cancelled."; exit }

$SecurePassword = Read-Host "PostgreSQL password for user postgres" -AsSecureString
$Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePassword)
try {
    $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr)
    foreach ($db in @("mago_enrichment", "mago_access")) {
        $file = Join-Path $SRC "$db.dump"
        if (-not (Test-Path $file)) { Write-Host "$db.dump missing, skipped" -ForegroundColor Yellow; continue }
        Write-Host "Restore: $db" -ForegroundColor Yellow
        & (Join-Path $PG_BIN "pg_restore.exe") -h localhost -p 5432 -U postgres --clean --if-exists --no-owner --no-privileges -d $db $file
        if ($LASTEXITCODE -ne 0) { throw "pg_restore failed for $db" }
        Write-Host "  -> restored" -ForegroundColor Green
    }
}
finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr)
}
Write-Host "`nRestore completed. Restart MAGO Viewer." -ForegroundColor Green
Read-Host "Enter to close"

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$BACKUPS = Join-Path $ROOT "SAUVEGARDES_BDD"
$STAMP = Get-Date -Format "yyyyMMdd_HHmmss"
$DEST = Join-Path $BACKUPS $STAMP

function Find-PgBin {
    $candidates = @("C:\PGSQL\pgsql\bin")
    $candidates += Get-ChildItem "C:\Program Files\PostgreSQL" -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName "bin" }
    foreach ($dir in $candidates) {
        if (Test-Path (Join-Path $dir "pg_dump.exe")) { return $dir }
    }
    return $null
}

$PG_BIN = Find-PgBin
if (-not $PG_BIN) { throw "pg_dump.exe was not found." }
New-Item -ItemType Directory -Path $DEST -Force | Out-Null

$SecurePassword = Read-Host "PostgreSQL password for user postgres" -AsSecureString
$Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePassword)
try {
    $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr)
    foreach ($db in @("mago_enrichment", "mago_access")) {
        $file = Join-Path $DEST "$db.dump"
        Write-Host "Backup: $db" -ForegroundColor Yellow
        & (Join-Path $PG_BIN "pg_dump.exe") -h localhost -p 5432 -U postgres -F c --no-owner --no-privileges -f $file $db
        if ($LASTEXITCODE -ne 0) { throw "pg_dump failed for $db" }
        Write-Host "  -> $file" -ForegroundColor Green
    }
}
finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr)
}

Get-ChildItem $BACKUPS -Directory | Sort-Object Name -Descending | Select-Object -Skip 15 | Remove-Item -Recurse -Force
Write-Host "`nBackup completed: $DEST" -ForegroundColor Green
Read-Host "Enter to close"

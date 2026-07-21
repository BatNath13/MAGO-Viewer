# ============================================================
# MAGO Viewer - Sauvegarde des bases PostgreSQL
# Sauvegarde mago_enrichment (semantique) et mago_access (clients)
# vers .\SAUVEGARDES_BDD\<horodatage>\
# A lancer regulierement (et AVANT toute manipulation risquee).
# ============================================================
$ErrorActionPreference = "Stop"
$PG_BIN  = "D:\PGSQL\pgsql\bin"
$BACKUPS = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "SAUVEGARDES_BDD"
$STAMP   = Get-Date -Format "yyyyMMdd_HHmmss"
$DEST    = Join-Path $BACKUPS $STAMP
New-Item -ItemType Directory -Path $DEST -Force | Out-Null

$env:PGPASSWORD = "12345678"   # mot de passe postgres du .env
foreach ($db in @("mago_enrichment", "mago_access")) {
    $file = Join-Path $DEST "$db.dump"
    Write-Host "Sauvegarde de $db ..." -ForegroundColor Yellow
    & "$PG_BIN\pg_dump.exe" -h localhost -p 5432 -U postgres -F c -f $file $db
    if ($LASTEXITCODE -ne 0) { throw "Echec pg_dump sur $db" }
    Write-Host "  -> $file" -ForegroundColor Green
}
Remove-Item Env:\PGPASSWORD

# Menage : garder les 15 sauvegardes les plus recentes
Get-ChildItem $BACKUPS -Directory | Sort-Object Name -Descending | Select-Object -Skip 15 | Remove-Item -Recurse -Force
Write-Host "`nSauvegarde terminee : $DEST" -ForegroundColor Green
Read-Host "Entree pour fermer"

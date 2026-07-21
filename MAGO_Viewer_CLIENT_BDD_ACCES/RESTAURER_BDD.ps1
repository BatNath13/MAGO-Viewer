# ============================================================
# MAGO Viewer - Restauration des bases PostgreSQL
# Restaure une sauvegarde creee par SAUVEGARDER_BDD.ps1.
# ATTENTION : ecrase le contenu actuel des bases.
# ============================================================
$ErrorActionPreference = "Stop"
$PG_BIN  = "D:\PGSQL\pgsql\bin"
$BACKUPS = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "SAUVEGARDES_BDD"

$dirs = Get-ChildItem $BACKUPS -Directory | Sort-Object Name -Descending
if (-not $dirs) { throw "Aucune sauvegarde dans $BACKUPS" }
Write-Host "Sauvegardes disponibles :" -ForegroundColor Cyan
for ($i = 0; $i -lt $dirs.Count; $i++) { Write-Host "  [$i] $($dirs[$i].Name)" }
$choice = Read-Host "Numero de la sauvegarde a restaurer"
$SRC = $dirs[[int]$choice].FullName

$confirm = Read-Host "Ecraser mago_enrichment et mago_access avec $($dirs[[int]$choice].Name) ? (oui/non)"
if ($confirm -ne "oui") { Write-Host "Annule."; exit }

$env:PGPASSWORD = "12345678"
foreach ($db in @("mago_enrichment", "mago_access")) {
    $file = Join-Path $SRC "$db.dump"
    if (-not (Test-Path $file)) { Write-Host "  $db.dump absent, ignore" -ForegroundColor Yellow; continue }
    Write-Host "Restauration de $db ..." -ForegroundColor Yellow
    & "$PG_BIN\pg_restore.exe" -h localhost -p 5432 -U postgres --clean --if-exists -d $db $file
    Write-Host "  -> $db restauree" -ForegroundColor Green
}
Remove-Item Env:\PGPASSWORD
Write-Host "`nRestauration terminee. Redemarrer l'API MAGO si elle tournait." -ForegroundColor Green
Read-Host "Entree pour fermer"

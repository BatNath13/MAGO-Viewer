# ============================================================
# MAGO Viewer COMPLET (tous patchs integres) - Installation
# A executer APRES extraction du zip dans C:\MAGO\
# 1. Reconstruit le frontend (npm run build)
# 2. Recree l'icone bureau
# ============================================================
$ErrorActionPreference = "Stop"
$PROJ = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "MAGO_Viewer_CLIENT_BDD_ACCES"
if (-not (Test-Path "$PROJ\package.json")) { throw "Projet introuvable : $PROJ" }
Write-Host "Projet : $PROJ" -ForegroundColor Green

Write-Host "`nnpm run build (le build livre est perime : obligatoire)..." -ForegroundColor Yellow
Push-Location $PROJ
cmd /c "npm run build"
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { Write-Host "ECHEC du build : envoyer la sortie ci-dessus." -ForegroundColor Red; Read-Host "Entree"; exit 1 }

$ICONE = Join-Path $PROJ "INSTALLER_ICONE_MAGO_VIEWER.ps1"
if (Test-Path $ICONE) { powershell -ExecutionPolicy Bypass -File $ICONE }

Write-Host "`nTermine. Lancer via l'icone MAGO Viewer, puis Ctrl+F5 dans le navigateur." -ForegroundColor Green
Write-Host "Rappel : re-exporter les splats alignes et recreer la vue client" -ForegroundColor Yellow
Write-Host "(les fichiers cuits avec l'ancienne version restent faux)." -ForegroundColor Yellow
Read-Host "Entree pour fermer"

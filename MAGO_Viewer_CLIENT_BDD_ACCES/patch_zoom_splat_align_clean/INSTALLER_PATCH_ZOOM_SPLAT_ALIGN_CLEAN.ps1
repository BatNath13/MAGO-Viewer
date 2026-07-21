$ErrorActionPreference = "Stop"

$PATCH = $PSScriptRoot
$ROOT = Split-Path $PATCH -Parent

if (!(Test-Path (Join-Path $ROOT "src\main.ts"))) {
  throw "Le patch doit être placé à la racine du projet MAGO_Viewer_CLIENT_BDD_ACCES. src\main.ts introuvable."
}

$STAMP = Get-Date -Format "yyyyMMdd_HHmmss"
$BACKUP = Join-Path $ROOT "BACKUP_AVANT_PATCH_ZOOM_SPLAT_ALIGN_CLEAN_$STAMP"
New-Item -ItemType Directory -Force (Join-Path $BACKUP "src\scene") | Out-Null

$toBackup = @(
  "index.html",
  "src\main.ts",
  "src\scene\sceneSetup.ts",
  "src\scene\cameraTools.ts"
)

foreach ($rel in $toBackup) {
  $src = Join-Path $ROOT $rel
  if (Test-Path $src) {
    $dst = Join-Path $BACKUP $rel
    New-Item -ItemType Directory -Force (Split-Path $dst -Parent) | Out-Null
    Copy-Item $src $dst -Force
  }
}

$toCopy = @(
  "index.html",
  "src\main.ts",
  "src\scene\sceneSetup.ts",
  "src\scene\cameraTools.ts"
)

foreach ($rel in $toCopy) {
  $src = Join-Path $PATCH $rel
  $dst = Join-Path $ROOT $rel
  if (!(Test-Path $src)) { throw "Fichier de patch manquant : $rel" }
  New-Item -ItemType Directory -Force (Split-Path $dst -Parent) | Out-Null
  Copy-Item $src $dst -Force
}

Write-Host "Patch propre zoom + piquage splats appliqué."
Write-Host "Backup : $BACKUP"
Write-Host "Lance maintenant : npm run build"

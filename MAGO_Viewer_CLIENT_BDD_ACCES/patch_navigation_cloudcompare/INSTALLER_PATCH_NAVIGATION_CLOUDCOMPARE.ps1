$ErrorActionPreference = "Stop"

$PROJECT = (Get-Location).Path
$PATCH = $PSScriptRoot

$required = @(
  "src\main.ts",
  "src\scene\sceneSetup.ts",
  "index.html"
)

foreach ($rel in $required) {
  if (!(Test-Path (Join-Path $PROJECT $rel))) {
    throw "Projet MAGO invalide : fichier introuvable $rel. Lance ce script depuis la racine MAGO_Viewer_CLIENT_BDD_ACCES."
  }
  if (!(Test-Path (Join-Path $PATCH $rel))) {
    throw "Patch incomplet : fichier introuvable dans le patch : $rel"
  }
}

$STAMP = Get-Date -Format "yyyyMMdd_HHmmss"
$BACKUP = Join-Path $PROJECT "BACKUP_AVANT_NAVIGATION_CLOUDCOMPARE_$STAMP"
New-Item -ItemType Directory -Force $BACKUP | Out-Null

foreach ($rel in $required) {
  $srcProject = Join-Path $PROJECT $rel
  $dstBackup = Join-Path $BACKUP $rel
  New-Item -ItemType Directory -Force (Split-Path $dstBackup -Parent) | Out-Null
  Copy-Item $srcProject $dstBackup -Force
}

foreach ($rel in $required) {
  $srcPatch = Join-Path $PATCH $rel
  $dstProject = Join-Path $PROJECT $rel
  Copy-Item $srcPatch $dstProject -Force
}

Write-Host "Patch navigation CloudCompare applique. Backup : $BACKUP"
Write-Host "Lance ensuite : npm run build"

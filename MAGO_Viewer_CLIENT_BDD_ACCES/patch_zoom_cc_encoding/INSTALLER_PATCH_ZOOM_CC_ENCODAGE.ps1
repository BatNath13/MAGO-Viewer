$ErrorActionPreference = "Stop"

$PROJECT = (Get-Location).Path
$PATCH = $PSScriptRoot
$APPLY = Join-Path $PATCH "apply_patch.cjs"

if (!(Test-Path (Join-Path $PROJECT "src\main.ts"))) {
  throw "Projet MAGO invalide : lance ce script depuis la racine MAGO_Viewer_CLIENT_BDD_ACCES."
}
if (!(Test-Path $APPLY)) {
  throw "Patch incomplet : apply_patch.cjs introuvable."
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js introuvable. Impossible d'appliquer le patch sans node."
}

& node $APPLY $PROJECT
if ($LASTEXITCODE -ne 0) {
  throw "Le patch JS a echoue."
}

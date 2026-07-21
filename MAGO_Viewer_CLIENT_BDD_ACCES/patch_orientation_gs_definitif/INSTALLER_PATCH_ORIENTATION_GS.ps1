$ErrorActionPreference = "Stop"

$ROOT = (Get-Location).Path
$SRC = Join-Path $ROOT "src\main.ts"
$SCENE = Join-Path $ROOT "src\scene\sceneSetup.ts"

if (!(Test-Path $SRC)) { throw "src\main.ts introuvable. Lance ce script depuis la racine du viewer MAGO." }
if (!(Test-Path $SCENE)) { throw "src\scene\sceneSetup.ts introuvable. Lance ce script depuis la racine du viewer MAGO." }

$STAMP = Get-Date -Format "yyyyMMdd_HHmmss"
$BACKUP = Join-Path $ROOT "BACKUP_AVANT_FIX_ORIENTATION_GS_$STAMP"
New-Item -ItemType Directory -Force (Join-Path $BACKUP "src\scene") | Out-Null
Copy-Item $SRC (Join-Path $BACKUP "src\main.ts") -Force
Copy-Item $SCENE (Join-Path $BACKUP "src\scene\sceneSetup.ts") -Force

Copy-Item (Join-Path $PSScriptRoot "src\main.ts") $SRC -Force
Copy-Item (Join-Path $PSScriptRoot "src\scene\sceneSetup.ts") $SCENE -Force

Write-Host "Patch orientation GS appliqué. Backup : $BACKUP"
Write-Host "Lance ensuite : npm run build"

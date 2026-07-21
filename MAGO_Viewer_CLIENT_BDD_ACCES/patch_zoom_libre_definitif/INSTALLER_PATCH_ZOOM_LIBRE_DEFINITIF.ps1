$ErrorActionPreference = "Stop"

$Project = Resolve-Path (Join-Path $PSScriptRoot "..")
$Backup = Join-Path $Project ("BACKUP_AVANT_ZOOM_LIBRE_DEFINITIF_" + (Get-Date -Format "yyyyMMdd_HHmmss"))
New-Item -ItemType Directory -Force $Backup | Out-Null

function Backup-File($relative) {
  $src = Join-Path $Project $relative
  if (!(Test-Path $src)) { throw "Fichier introuvable : $src" }
  $dst = Join-Path $Backup $relative
  New-Item -ItemType Directory -Force (Split-Path $dst -Parent) | Out-Null
  Copy-Item $src $dst -Force
}

function Write-Utf8NoBom($path, $text) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $text, $enc)
}

function Replace-Once($text, $old, $new, $label) {
  if ($text.Contains($new)) { return $text }
  if (!$text.Contains($old)) { throw "Bloc introuvable pour : $label" }
  return $text.Replace($old, $new)
}

Backup-File "src\main.ts"
Backup-File "src\scene\sceneSetup.ts"
Backup-File "src\scene\cameraTools.ts"
if (Test-Path (Join-Path $Project "index.html")) { Backup-File "index.html" }

# -----------------------------------------------------------------------------
# 1) main.ts : installe un zoom molette libre = déplacement caméra dans l'axe de vue.
#    On ne change plus la target sous la souris et on ne change plus le radius Babylon.
#    Résultat : plus de zoom bloqué par le centre scène / plus de dérive orbitale.
# -----------------------------------------------------------------------------
$mainPath = Join-Path $Project "src\main.ts"
$main = Get-Content $mainPath -Raw

if (!$main.Contains("bindFreeDollyWheelZoom(canvas);")) {
  $oldCallCRLF = "  bindKeyboard();`r`n  applyRenderScale(state.performance.renderScale);"
  $newCallCRLF = "  bindKeyboard();`r`n  bindFreeDollyWheelZoom(canvas);`r`n  applyRenderScale(state.performance.renderScale);"
  $oldCallLF = "  bindKeyboard();`n  applyRenderScale(state.performance.renderScale);"
  $newCallLF = "  bindKeyboard();`n  bindFreeDollyWheelZoom(canvas);`n  applyRenderScale(state.performance.renderScale);"
  if ($main.Contains($oldCallCRLF)) { $main = $main.Replace($oldCallCRLF, $newCallCRLF) }
  elseif ($main.Contains($oldCallLF)) { $main = $main.Replace($oldCallLF, $newCallLF) }
  else { throw "Bloc introuvable pour : appel bindFreeDollyWheelZoom" }
}

$freeZoomFunction = @'
function bindFreeDollyWheelZoom(canvas: HTMLCanvasElement): void {
  // IMPORTANT : on neutralise le zoom molette natif de l'ArcRotateCamera.
  // Le zoom natif modifie le radius autour de camera.target ; si la scène est loin
  // du centre/pivot, le zoom devient imprévisible selon l'angle de vue.
  try {
    const inputs = state.ctx.camera.inputs as any;
    inputs?.removeByType?.('ArcRotateCameraMouseWheelInput');
    if (inputs?.attached?.mousewheel) inputs.remove(inputs.attached.mousewheel);
  } catch { /* noop */ }

  canvas.addEventListener('wheel', (e: WheelEvent) => {
    // Le listener est posé sur le canvas : ici on prend la main avant Babylon.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const camera = state.ctx.camera;
    const rawDelta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    if (!Number.isFinite(rawDelta) || Math.abs(rawDelta) < 0.0001) return;

    // Molette vers le haut = avancer dans la scène. Molette vers le bas = reculer.
    const directionSign = rawDelta < 0 ? 1 : -1;
    const wheelSteps = Math.max(0.15, Math.min(8, Math.abs(rawDelta) / 100));
    const zoomSensitivity = Math.max(0.05, state.cameraControls.zoomSensitivity || 1);

    const forward = camera.getForwardRay(1).direction;
    if (forward.lengthSquared() < 1e-12) return;
    forward.normalize();

    // Pas métrique adaptatif : assez rapide sur les grosses scènes, mais sans saut violent.
    const bounds = computeSceneBounds(getAllAssets());
    const diag = bounds ? Math.max(0.001, bounds.boundingBox.extendSizeWorld.length() * 2) : Math.max(1, camera.radius);
    const radiusRef = Math.max(0.001, Math.abs(camera.radius));
    const minStep = Math.max(0.005, diag * 0.0008);
    const preferredStep = Math.max(radiusRef * 0.08, diag * 0.006);
    const maxStep = Math.max(0.05, diag * 0.20);
    const baseStep = Math.max(minStep, Math.min(preferredStep, maxStep));

    const move = forward.scale(directionSign * baseStep * zoomSensitivity * wheelSteps);

    // Au lieu de zoomer autour d'une cible fixe, on translate la caméra ET sa cible
    // dans l'axe de vue. Cela permet de traverser l'objet et de zoomer où on regarde.
    camera.target.addInPlace(move);
    camera.lowerRadiusLimit = 0;
    camera.upperRadiusLimit = Number.MAX_SAFE_INTEGER;
  }, { passive: false, capture: true });
}

'@

if (!$main.Contains("function bindFreeDollyWheelZoom")) {
  $marker = "function bindKeyboard(): void {"
  if (!$main.Contains($marker)) { throw "Impossible d'insérer bindFreeDollyWheelZoom : bindKeyboard introuvable." }
  $main = $main.Replace($marker, $freeZoomFunction + $marker)
}

# Rend le slider zoom vraiment utile sur grosses scènes.
$main = $main.Replace("state.ctx.camera.wheelDeltaPercentage = 0.012 * value;", "state.ctx.camera.wheelDeltaPercentage = 0; // zoom molette natif désactivé : bindFreeDollyWheelZoom gère le déplacement")
$main = $main.Replace("state.ctx.camera.pinchDeltaPercentage = 0.012 * value;", "state.ctx.camera.pinchDeltaPercentage = 0.012 * value;")

Write-Utf8NoBom $mainPath $main

# -----------------------------------------------------------------------------
# 2) sceneSetup.ts : désactive aussi le wheel input Babylon dès la création caméra.
# -----------------------------------------------------------------------------
$setupPath = Join-Path $Project "src\scene\sceneSetup.ts"
$setup = Get-Content $setupPath -Raw
$setupOld = "  camera.attachControl(canvas, true);`r`n  camera.wheelDeltaPercentage = 0.012; // ajusté par le slider Vitesse zoom"
$setupNew = "  camera.attachControl(canvas, true);`r`n  try {`r`n    const inputs = camera.inputs as any;`r`n    inputs?.removeByType?.('ArcRotateCameraMouseWheelInput');`r`n    if (inputs?.attached?.mousewheel) inputs.remove(inputs.attached.mousewheel);`r`n  } catch { /* noop */ }`r`n  camera.wheelDeltaPercentage = 0; // zoom molette natif désactivé : zoom libre géré dans main.ts"
if ($setup.Contains($setupOld) -and !$setup.Contains("zoom libre géré dans main.ts")) { $setup = $setup.Replace($setupOld, $setupNew) }
$setupOldLf = "  camera.attachControl(canvas, true);`n  camera.wheelDeltaPercentage = 0.012; // ajusté par le slider Vitesse zoom"
$setupNewLf = $setupNew.Replace("`r`n", "`n")
if ($setup.Contains($setupOldLf) -and !$setup.Contains("zoom libre géré dans main.ts")) { $setup = $setup.Replace($setupOldLf, $setupNewLf) }
$setup = $setup.Replace("  camera.lowerRadiusLimit = 0.001;", "  camera.lowerRadiusLimit = 0;")
$setup = $setup.Replace("  camera.upperRadiusLimit = Math.max(maxDim * 200, 100000);", "  camera.upperRadiusLimit = Number.MAX_SAFE_INTEGER;")
Write-Utf8NoBom $setupPath $setup

# -----------------------------------------------------------------------------
# 3) cameraTools.ts : frameScene ne remet plus de limite de zoom.
# -----------------------------------------------------------------------------
$camToolsPath = Join-Path $Project "src\scene\cameraTools.ts"
$camTools = Get-Content $camToolsPath -Raw
$camTools = $camTools.Replace("  camera.lowerRadiusLimit = 0.001;", "  camera.lowerRadiusLimit = 0;")
$camTools = $camTools.Replace("  camera.upperRadiusLimit = Math.max(maxDim * 200, 100000);", "  camera.upperRadiusLimit = Number.MAX_SAFE_INTEGER;")
Write-Utf8NoBom $camToolsPath $camTools

# -----------------------------------------------------------------------------
# 4) index.html : slider zoom avec plage plus large.
# -----------------------------------------------------------------------------
$indexPath = Join-Path $Project "index.html"
if (Test-Path $indexPath) {
  $index = Get-Content $indexPath -Raw
  $index = $index.Replace('id="zoom-sensitivity" max="6" min="0.1" step="0.05" type="range" value="1"', 'id="zoom-sensitivity" max="20" min="0.05" step="0.05" type="range" value="1"')
  Write-Utf8NoBom $indexPath $index
}

Write-Host "Patch zoom libre définitif appliqué. Backup : $Backup"
Write-Host "Lance ensuite : npm run build"

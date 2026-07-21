const fs = require('fs');
const path = require('path');

const project = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
const backupRoot = path.join(project, `BACKUP_AVANT_FIX_ZOOM_ENCODAGE_${stamp}`);

const required = [
  'index.html',
  path.join('src', 'main.ts'),
  path.join('src', 'scene', 'sceneSetup.ts'),
];

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

for (const rel of required) {
  if (!fs.existsSync(path.join(project, rel))) {
    fail(`Projet MAGO invalide : fichier introuvable ${rel}. Lance le script depuis la racine MAGO_Viewer_CLIENT_BDD_ACCES.`);
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyFilePreserve(rel) {
  const src = path.join(project, rel);
  const dst = path.join(backupRoot, rel);
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

for (const rel of required) copyFilePreserve(rel);

// Repare le mojibake UTF-8 lu/ecrit par PowerShell en ANSI : DÃ©tails -> Détails, â€” -> —, etc.
// On ne fait pas de conversion globale dangereuse : uniquement les sequences connues.
const charsToRepair = Array.from(new Set([
  ...'éèêëàâäîïôöùûüçÉÈÊËÀÂÄÎÏÔÖÙÛÜÇ',
  'œ','Œ','·','«','»','°','²','³','±','µ','×','÷',
  '—','–','…','•','→','←','↔','↑','↓',
  '✓','✔','✗','✕','▼','▲','≥','≤','≈','≠','−','’','‘','“','”','‰','€',
  '\u00a0'
]));
const mojibakeMap = new Map();
for (const ch of charsToRepair) {
  const bad = Buffer.from(ch, 'utf8').toString('latin1');
  mojibakeMap.set(bad, ch === '\u00a0' ? ' ' : ch);
}
// Quelques variantes frequentes.
mojibakeMap.set('â€˜', '‘');
mojibakeMap.set('â€™', '’');
mojibakeMap.set('â€œ', '“');
mojibakeMap.set('â€�', '”');
mojibakeMap.set('â€', '”');
mojibakeMap.set('â€“', '–');
mojibakeMap.set('â€”', '—');
mojibakeMap.set('â€¦', '…');
mojibakeMap.set('â€¢', '•');
mojibakeMap.set('â†’', '→');
mojibakeMap.set('â†', '←');
mojibakeMap.set('â†”', '↔');
mojibakeMap.set('â‰¥', '≥');
mojibakeMap.set('â‰¤', '≤');
mojibakeMap.set('â‰ˆ', '≈');
mojibakeMap.set('â‰ ', '≠');
mojibakeMap.set('âˆ’', '−');
mojibakeMap.set('âœ“', '✓');
mojibakeMap.set('âœ”', '✔');
mojibakeMap.set('âœ—', '✗');
mojibakeMap.set('âœ•', '✕');
mojibakeMap.set('â–¼', '▼');
mojibakeMap.set('â–²', '▲');
mojibakeMap.set('Â ', ' ');

// Variantes Windows-1252 (PowerShell 5.1 lit souvent l'UTF-8 sans BOM comme ANSI Windows).
const cp1252Pairs = [
  ['Ã©','é'],['Ã¨','è'],['Ãª','ê'],['Ã«','ë'],['Ã\xa0','à'],['Ã¢','â'],['Ã¤','ä'],['Ã®','î'],['Ã¯','ï'],['Ã´','ô'],['Ã¶','ö'],['Ã¹','ù'],['Ã»','û'],['Ã¼','ü'],['Ã§','ç'],
  ['Ã‰','É'],['Ãˆ','È'],['ÃŠ','Ê'],['Ã‹','Ë'],['Ã€','À'],['Ã‚','Â'],['Ã„','Ä'],['ÃŽ','Î'],['Ã”','Ô'],['Ã–','Ö'],['Ã™','Ù'],['Ã›','Û'],['Ãœ','Ü'],['Ã‡','Ç'],
  ['Å“','œ'],['Å’','Œ'],['Â·','·'],['Â«','«'],['Â»','»'],['Â°','°'],['Â²','²'],['Â³','³'],['Â±','±'],['Âµ','µ'],['Ã—','×'],['Ã·','÷'],
  ['â€”','—'],['â€“','–'],['â€¦','…'],['â€¢','•'],['â†’','→'],['â†”','↔'],['â†‘','↑'],['â†“','↓'],['âœ“','✓'],['âœ”','✔'],['âœ—','✗'],['âœ•','✕'],
  ['â–¼','▼'],['â–²','▲'],['â–¸','▸'],['â‰¥','≥'],['â‰¤','≤'],['â‰ˆ','≈'],['âˆ’','−'],['â€™','’'],['â€˜','‘'],['â€œ','“'],['â€°','‰'],['â‚¬','€'],['â‡’','⇒']
];
for (const [bad, good] of cp1252Pairs) mojibakeMap.set(bad, good);

function repairText(text) {
  let out = text;
  // Remplacements les plus longs d'abord pour eviter les reparations partielles.
  const entries = Array.from(mojibakeMap.entries()).sort((a, b) => b[0].length - a[0].length);
  for (const [bad, good] of entries) {
    if (!bad) continue;
    out = out.split(bad).join(good);
  }
  return out;
}

function read(rel) {
  return fs.readFileSync(path.join(project, rel), 'utf8');
}
function write(rel, text) {
  fs.writeFileSync(path.join(project, rel), text, 'utf8');
}

function replaceFunction(text, functionName, replacement) {
  const marker = `function ${functionName}`;
  const start = text.indexOf(marker);
  if (start < 0) fail(`Fonction introuvable : ${functionName}`);
  const brace = text.indexOf('{', start);
  if (brace < 0) fail(`Ouverture de fonction introuvable : ${functionName}`);
  let depth = 0;
  for (let i = brace; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(0, start) + replacement + text.slice(i + 1);
      }
    }
  }
  fail(`Fin de fonction introuvable : ${functionName}`);
}

const newNavigationFunction = `function bindCloudCompareNavigation(canvas: HTMLCanvasElement): void {
  const camera = state.ctx.camera;

  // Navigation cible type CloudCompare :
  // - rotation autour d'un pivot stable ;
  // - molette = zoom vers le point sous la souris quand il existe ;
  // - aucun zoom Babylon natif en doublon ;
  // - double-clic = definit le pivot de rotation.
  try {
    const inputs = camera.inputs as any;
    inputs?.removeByType?.('ArcRotateCameraMouseWheelInput');
    if (inputs?.attached?.mousewheel) inputs.remove(inputs.attached.mousewheel);
  } catch { /* noop */ }

  camera.wheelDeltaPercentage = 0;
  camera.lowerRadiusLimit = 0.00001;
  camera.upperRadiusLimit = Number.MAX_SAFE_INTEGER;

  const isUiTarget = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null;
    return !!el && !!el.closest('#toolbar, #tools-dropdown, #sidebar-left, .client-login-card, .modal, input, select, textarea, button');
  };

  const getSceneCenter = (): Vector3 | null => {
    const bounds = computeSceneBounds(getAllAssets());
    return bounds ? bounds.boundingBox.centerWorld.clone() : null;
  };

  const setOrbitPivotKeepingView = (pivot: Vector3): void => {
    if (!Number.isFinite(pivot.x) || !Number.isFinite(pivot.y) || !Number.isFinite(pivot.z)) return;
    const cam = state.ctx.camera;
    const currentPosition = cam.position.clone();
    cam.target.copyFrom(pivot);
    cam.setPosition(currentPosition);
    cam.lowerRadiusLimit = 0.00001;
    cam.upperRadiusLimit = Number.MAX_SAFE_INTEGER;
  };

  const pickViewportPoint = (clientX: number, clientY: number): Vector3 | null => {
    const scene = state.ctx.scene;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > rect.width || y > rect.height) return null;

    const pick = scene.pick(
      x,
      y,
      (mesh) => {
        if (!mesh || mesh.isDisposed?.()) return false;
        if (!mesh.isEnabled() || !mesh.isVisible) return false;
        if (mesh.name === 'grid') return false;
        return mesh.isPickable !== false;
      },
      false,
      camera,
    );

    if (pick?.hit && pick.pickedPoint) return pick.pickedPoint.clone();
    return null;
  };

  const dollyZoom = (focus: Vector3, factor: number): void => {
    const cam = state.ctx.camera;
    const oldPos = cam.position.clone();
    const oldTarget = cam.target.clone();

    const safeFactor = Math.max(0.025, Math.min(40, factor));
    let newPos = focus.add(oldPos.subtract(focus).scale(safeFactor));
    let newTarget = focus.add(oldTarget.subtract(focus).scale(safeFactor));

    const view = newPos.subtract(newTarget);
    if (!Number.isFinite(view.lengthSquared()) || view.lengthSquared() < 1e-10) {
      const fallbackDir = oldPos.subtract(oldTarget);
      fallbackDir.normalize();
      newPos = newTarget.add(fallbackDir.scale(0.0001));
    }

    cam.target.copyFrom(newTarget);
    cam.setPosition(newPos);
    cam.lowerRadiusLimit = 0.00001;
    cam.upperRadiusLimit = Number.MAX_SAFE_INTEGER;
  };

  canvas.addEventListener('wheel', (e: WheelEvent) => {
    if (isUiTarget(e.target)) return;
    if (isViewportInteractionBlocked()) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const rawDelta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    if (!Number.isFinite(rawDelta) || Math.abs(rawDelta) < 0.0001) return;

    const zoomSensitivity = Math.max(0.05, Math.min(8, state.cameraControls.zoomSensitivity || 1));
    const notches = Math.max(-8, Math.min(8, rawDelta / 120));
    const factor = Math.exp(notches * 0.22 * zoomSensitivity);

    // Si la souris pointe un objet, on zoome vers ce point comme CloudCompare.
    // Sinon, on zoome autour du pivot actuel de la camera.
    const focus = pickViewportPoint(e.clientX, e.clientY) ?? state.ctx.camera.target.clone();
    dollyZoom(focus, factor);
  }, { passive: false, capture: true });

  canvas.addEventListener('dblclick', (e: MouseEvent) => {
    if (isUiTarget(e.target)) return;
    if (isViewportInteractionBlocked()) return;

    const picked = pickViewportPoint(e.clientX, e.clientY);
    if (picked) {
      setOrbitPivotKeepingView(picked);
      setStatus('pivot camera place sur le point clique');
      return;
    }

    const center = getSceneCenter();
    if (center) {
      setOrbitPivotKeepingView(center);
      setStatus('pivot camera replace au centre de la scene');
    }
  });
}`;

// 1) Repare les accents/menus dans les fichiers vivants affiches par le viewer.
const liveFiles = [
  'index.html',
  path.join('src', 'main.ts'),
  path.join('src', 'scene', 'sceneSetup.ts'),
  path.join('api', 'mago-enrichment-api', 'public', 'index.html'),
];

for (const rel of liveFiles) {
  const abs = path.join(project, rel);
  if (!fs.existsSync(abs)) continue;
  const original = fs.readFileSync(abs, 'utf8');
  const repaired = repairText(original);
  if (repaired !== original) {
    // Backup supplementaire pour le public s'il existe.
    const dst = path.join(backupRoot, rel);
    ensureDir(path.dirname(dst));
    if (!fs.existsSync(dst)) fs.copyFileSync(abs, dst);
    fs.writeFileSync(abs, repaired, 'utf8');
  }
}

// 2) Remplace uniquement la fonction de navigation, sans toucher au reste du fichier.
let main = read(path.join('src', 'main.ts'));
main = repairText(main);
main = replaceFunction(main, 'bindCloudCompareNavigation', newNavigationFunction);
write(path.join('src', 'main.ts'), main);

// 3) Securise sceneSetup : pas de zoom molette Babylon natif en doublon, radius libre.
let setup = read(path.join('src', 'scene', 'sceneSetup.ts'));
setup = repairText(setup);
setup = setup.replace(/camera\.wheelDeltaPercentage\s*=\s*[^;]+;/g, 'camera.wheelDeltaPercentage = 0;');
setup = setup.replace(/camera\.lowerRadiusLimit\s*=\s*[^;]+;/g, 'camera.lowerRadiusLimit = 0.00001;');
setup = setup.replace(/camera\.upperRadiusLimit\s*=\s*[^;]+;/g, 'camera.upperRadiusLimit = Number.MAX_SAFE_INTEGER;');
write(path.join('src', 'scene', 'sceneSetup.ts'), setup);

console.log(`Patch zoom/encodage applique. Backup : ${backupRoot}`);
console.log('Lance ensuite : npm run build');

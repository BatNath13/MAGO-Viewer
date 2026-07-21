/**
 * MAGO Viewer · main.ts
 * =======================
 * Point d'entrée. Bootstrap la scène Babylon et branche toute l'UI.
 */

import { initI18n } from "./i18n";
import {
  Color3,
  Color4,
  GizmoManager,
  Mesh,
  AbstractMesh,
  MeshBuilder,
  Matrix,
  PointerEventTypes,
  Scene,
  StandardMaterial,
  PBRMaterial,
  Quaternion,
  TransformNode,
  Vector3,
  VertexData,
  Constants,
  Effect,
  PostProcess,
  RenderTargetTexture,
  Texture,
} from '@babylonjs/core';
// Enregistre le composant de rendu de contour (active mesh.renderOutline / outlineColor / outlineWidth).
import '@babylonjs/core/Rendering/outlineRenderer';

import { createSceneContext, SceneContext } from './scene/sceneSetup';
import { loadMesh, loadSplats, loadPointCloud, unloadAsset, parseMagoLayer } from './scene/loaders';
import { initEnrichment, enrichment } from './scene/enrichment';
import {
  applyPredefinedView,
  captureScreenshot,
  computeSceneBounds,
  formatNumber,
  formatVec3,
  frameScene,
} from './scene/cameraTools';
import { MeasureTool, MeasurementResult, MeasureMode } from './scene/measureTool';
import { toast } from './utils/toast';
import { applyClientMode, isClientMode } from './scene/clientMode';
import { login as clientLogin, fetchManifest, fetchSceneFile, fetchSession, isLoggedIn, logout as clientLogout } from './scene/clientSession';
import type { AlignableKind, LayerKind, LayerTransform, LoadedAsset, MeshRenderMode, SceneExportConfig, MeshSubLayer } from './types';
import {
  DEFAULT_TRANSFORM,
  applyLayerTransform,
  cloneTransform,
  readTransformFromInputs,
  writeTransformToInputs,
  zUpToYUpTransform,
} from './scene/transforms';
import { downloadMeshGlb, downloadMeshPlyMago, downloadMeshObjMago, downloadScenePackageZip, downloadText, exportMeshGlb } from './scene/exportTools';
import {
  buildFarFromMeshMask,
  buildLightMask,
  buildPlyBlobFromMask,
  buildSorOutlierMask,
  buildTransformedPlyBlobFromMask,
  countMask,
  createFullMask,
  intersectMasks,
  invertMask,
  parseSplatPly,
  selectByScreenBrush,
  selectByScreenCircle,
  selectByScreenLasso,
  selectByScreenRectangle,
  subtractMask,
  unionMasks,
  type SplatFilterSettings,
  type SplatPlyData,
} from './scene/splatPlyEditor';

initI18n();

// =================================================================
//  ÉTAT GLOBAL DE L'APP
// =================================================================


type MeshTriangleCache = {
  mesh: Mesh;
  indices: ArrayLike<number>;
  centroids: Float32Array;
  vertices: Float32Array;
  triangleCount: number;
  sourceIndexCount: number;
  sourceVertexCount: number;
  screenKey?: string;
  screenX?: Float32Array;
  screenY?: Float32Array;
  screenVisible?: Uint8Array;
  screenDepth?: Float32Array;
};

const MESH_SELECTION_CHUNK_SIZE = 120000;
const MESH_SELECTION_PREVIEW_MAX_TRIANGLES = 60000;
const MESH_BRUSH_PATH_MIN_DISTANCE_PX = 6;

type ScreenSelectionPredicate = {
  test: (x: number, y: number) => boolean;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

type MeshLodGroup = {
  baseName: string;
  levels: Map<number, Mesh[]>;
  triangleCounts: Map<number, number>;
  currentLevel: number;
};

type MeshLodState = {
  enabled: boolean;
  groups: MeshLodGroup[];
  meshLevel: Map<Mesh, number>;
  availableLevels: number[];
  sceneDiagonal: number;
  currentLevel: number | null;
  currentLabel: string;
  lastRadius: number;
};

type MagoTileLodMeta = {
  level: number;
  ratio?: number;
  file: string;
  size_bytes?: number | null;
};

type MagoTileRuntime = {
  id: string;
  index: number;
  bbox: number[];
  center: Vector3;
  radius: number;
  lods: MagoTileLodMeta[];
  currentLevel: number | null;
  loading: boolean;
  asset: LoadedAsset | null;
  failCount: number;
};

type MagoTilesState = {
  enabled: boolean;
  name: string;
  rootHandle: any | null;
  tiles: MagoTileRuntime[];
  availableLevels: number[];
  sceneDiagonal: number;
  lastUpdate: number;
  loadedCount: number;
  maxConcurrentLoads: number;
  maxResidentTiles: number;
  maxResidentTriangles: number;
  errorShown: boolean;
};

type AlignmentPickedPoint = {
  kind: AlignableKind;
  local: Vector3;
  world: Vector3;
  marker: Mesh;
};

type AlignmentPair = {
  source: AlignmentPickedPoint;
  target: AlignmentPickedPoint;
};

type AlignmentState = {
  active: boolean;
  sourceKind: AlignableKind;
  targetKind: AlignableKind;
  waitingFor: 'source' | 'target';
  currentSource: AlignmentPickedPoint | null;
  pairs: AlignmentPair[];
  lastMatrix: number[][] | null;
  /** True si lastMatrix a déjà été bake dans la transformation monde de la source. */
  lastMatrixAppliedToSource: boolean;
  /** UID de la source utilisée lors du calcul/import de lastMatrix. */
  lastMatrixSourceUid: number | null;
  applyToSource: boolean;
  scaleMode: 'keep' | 'estimate' | 'manual';
  manualScale: number;
  hideSourceDuringPick: boolean;
  hideTargetDuringPick: boolean;
  _pickVisBackup?: Map<LoadedAsset, boolean>;
};

interface AppState {
  ctx: SceneContext;
  measure: MeasureTool;
  assets: {
    mesh: LoadedAsset | null;
    splat: LoadedAsset | null;
  };
  /** Transformations issues d'un mago_scene_config.json importé AVANT le chargement
   *  des fichiers : consommées (une fois) par handleFile au prochain chargement. */
  pendingConfigTransforms: { mesh: LayerTransform | null; splat: LayerTransform | null };
  extraAssets: LoadedAsset[];
  selectedObjectUid: number | null;
  /** id du calque (sous-couche mesh) actuellement sélectionné pour le liseré rouge. */
  selectedLayerId: string | null;
  meshOpacity: number;
  meshMode: MeshRenderMode;
  meshBackface: boolean;
  transforms: Record<LayerKind, LayerTransform>;
  originalFiles: {
    mesh: File | null;
    splat: File | null;
  };
  cameraControls: {
    mouseSensitivity: number;
    zoomSensitivity: number;
    panSensitivity: number;
    keyboardSpeed: number;
    pressed: Set<string>;
    lastMoveTime: number;
  };
  performance: {
    renderScale: number;
    adaptiveRender: boolean;
    movingRenderScale: number;
    currentHardwareScale: number;
    lastCameraSignature: string;
    lastCameraMoveTime: number;
  };
  manipulator: {
    gizmo: GizmoManager;
    selectedKind: LayerKind | null;
    mode: 'none' | 'move' | 'rotate' | 'scale';
    isDragging: boolean;
  };
  alignment: AlignmentState;
  meshEditor: {
    active: boolean;
    drawing: boolean;
    points: Array<{ x: number; y: number }>;
    selectionMode: 'lasso' | 'rectangle' | 'circle' | 'brush';
    brushSize: number;
    visibleOnly: boolean;
    combineNext: 'replace' | 'add' | 'subtract' | null;
    selected: Map<Mesh, Set<number>>;
    preview: Mesh | null;
    /** Triangles masqués temporairement (isolation) : retirés du buffer d'indices
     *  mais conservés ici sous forme de triplets d'indices de sommets, pour être
     *  ré-injectés tels quels au réaffichage. */
    hiddenTriangles: Array<{ mesh: Mesh; triplets: number[] }>;
    undoStack: Array<{
      label: string;
      meshes: Array<{ mesh: Mesh; indices: number[] }>;
      created?: Mesh[];
      createdLayers?: string[];
    }>;
    triangleCache: Map<Mesh, MeshTriangleCache>;
    selectionToken: number;
  };
  meshLod: MeshLodState;
  magoTiles: MagoTilesState;
  splatEditor: {
    data: SplatPlyData | null;
    baseMask: Uint8Array | null;
    visibleMask: Uint8Array | null;
    selectedMask: Uint8Array | null;
    /** Splats masqués temporairement (isolation) : invisibles, insélectionnables,
     *  protégés de la suppression, mais TOUJOURS présents dans baseMask/exports. */
    hiddenMask: Uint8Array | null;
    lightOnly: boolean;
    lassoActive: boolean;
    lassoDrawing: boolean;
    /** Mode restauration : le tracé écran restaure les splats SUPPRIMÉS de la zone
     *  au lieu de sélectionner. Réutilise toute la machinerie de dessin du lasso. */
    restoreActive: boolean;
    /** Maj = ajouter, Ctrl/Alt = soustraire, sinon remplacer (comme le mesh). */
    combineNext: 'replace' | 'add' | 'subtract' | null;
    lassoPoints: Array<{ x: number; y: number }>;
    selectionMode: 'lasso' | 'rectangle' | 'circle' | 'brush';
    brushSize: number;
    settings: SplatFilterSettings;
    /** SOR façon CloudCompare : k voisins, seuil = μ + nSigma·σ. */
    sor: { k: number; nSigma: number; running: boolean };
    /** Filtre distance au mesh : flotteur si à plus de maxDistance (m) du mesh recalé. */
    meshDist: { maxDistance: number; running: boolean };
    undoStack: Array<{
      baseMask: Uint8Array;
      visibleMask: Uint8Array | null;
      hiddenMask: Uint8Array | null;
      lightOnly: boolean;
      label: string;
    }>;
  };
}

let state: AppState;

// -----------------------------------------------------------------------------
// CONTOUR AP EN ESPACE ECRAN
// Le mesh principal reste cache. Une texture hors ecran rend un masque blanc de
// la selection, puis un post-traitement ne conserve que la frontiere du masque.
// Aucune texture ni couleur du mesh ne peut apparaitre dans la vue principale.
// -----------------------------------------------------------------------------
let apSelectionMaskTexture: RenderTargetTexture | null = null;
let apSelectionMaskMaterial: StandardMaterial | null = null;
let apSelectionOutlinePostProcess: PostProcess | null = null;
let apSelectionMaskMeshes: Mesh[] = [];
let apSelectionOutlineActive = false;

function ensureApSelectionOutlineResources(): void {
  if (apSelectionMaskTexture && apSelectionMaskMaterial && apSelectionOutlinePostProcess) return;

  const { scene, engine, camera } = state.ctx;

  Effect.ShadersStore['magoApSelectionOutlineFragmentShader'] = `
    precision highp float;
    varying vec2 vUV;
    uniform sampler2D textureSampler;
    uniform sampler2D maskSampler;
    uniform vec2 texelSize;
    uniform vec3 outlineColor;
    uniform float outlineEnabled;

    float maskValue(vec2 uv) {
      return texture2D(maskSampler, clamp(uv, vec2(0.0), vec2(1.0))).r;
    }

    void main(void) {
      vec4 base = texture2D(textureSampler, vUV);
      if (outlineEnabled < 0.5) {
        gl_FragColor = base;
        return;
      }

      vec2 p = texelSize * 1.35;
      float c  = maskValue(vUV);
      float n0 = maskValue(vUV + vec2( p.x,  0.0));
      float n1 = maskValue(vUV + vec2(-p.x,  0.0));
      float n2 = maskValue(vUV + vec2( 0.0,  p.y));
      float n3 = maskValue(vUV + vec2( 0.0, -p.y));
      float n4 = maskValue(vUV + vec2( p.x,  p.y));
      float n5 = maskValue(vUV + vec2(-p.x,  p.y));
      float n6 = maskValue(vUV + vec2( p.x, -p.y));
      float n7 = maskValue(vUV + vec2(-p.x, -p.y));

      float hi = max(c, max(max(max(n0, n1), max(n2, n3)), max(max(n4, n5), max(n6, n7))));
      float lo = min(c, min(min(min(n0, n1), min(n2, n3)), min(min(n4, n5), min(n6, n7))));
      float edge = smoothstep(0.12, 0.55, hi - lo);

      gl_FragColor = vec4(mix(base.rgb, outlineColor, edge), base.a);
    }
  `;

  apSelectionMaskMaterial = new StandardMaterial('mago-ap-mask-material', scene);
  apSelectionMaskMaterial.disableLighting = true;
  apSelectionMaskMaterial.backFaceCulling = false;
  apSelectionMaskMaterial.diffuseColor = Color3.White();
  apSelectionMaskMaterial.emissiveColor = Color3.White();
  apSelectionMaskMaterial.specularColor = Color3.Black();
  apSelectionMaskMaterial.alpha = 1;
  apSelectionMaskMaterial.disableDepthWrite = false;

  apSelectionMaskTexture = new RenderTargetTexture(
    'mago-ap-selection-mask',
    { ratio: 1 },
    scene,
    {
      generateMipMaps: false,
      doNotChangeAspectRatio: true,
      type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
      samplingMode: Texture.NEAREST_SAMPLINGMODE,
      generateDepthBuffer: true,
      generateStencilBuffer: false,
      format: Constants.TEXTUREFORMAT_RGBA,
    },
  );
  apSelectionMaskTexture.activeCamera = camera;
  apSelectionMaskTexture.clearColor = new Color4(0, 0, 0, 0);
  apSelectionMaskTexture.renderParticles = false;
  apSelectionMaskTexture.ignoreCameraViewport = true;
  apSelectionMaskTexture.renderList = apSelectionMaskMeshes;
  scene.customRenderTargets.push(apSelectionMaskTexture);

  // La selection devient visible uniquement dans la texture de masque.
  apSelectionMaskTexture.onBeforeRenderObservable.add(() => {
    if (!apSelectionOutlineActive) return;
    for (const mesh of apSelectionMaskMeshes) {
      if (mesh.isEnabled() && mesh.isVisible) mesh.visibility = 1;
    }
  });

  // Avant le rendu principal, le vrai mesh redevient immediatement invisible.
  apSelectionMaskTexture.onAfterRenderObservable.add(() => {
    if (!state.assets.mesh?.background) return;
    for (const mesh of apSelectionMaskMeshes) mesh.visibility = 0;
  });

  apSelectionOutlinePostProcess = new PostProcess(
    'mago-ap-selection-outline',
    'magoApSelectionOutline',
    ['texelSize', 'outlineColor', 'outlineEnabled'],
    ['maskSampler'],
    1.0,
    camera,
    Texture.NEAREST_SAMPLINGMODE,
    engine,
    false,
  );

  apSelectionOutlinePostProcess.onApply = (effect) => {
    const mask = apSelectionMaskTexture;
    if (!mask) return;
    const size = mask.getSize();
    effect.setTexture('maskSampler', mask);
    effect.setFloat2('texelSize', 1 / Math.max(1, size.width), 1 / Math.max(1, size.height));
    effect.setColor3('outlineColor', LAYER_SELECTION_COLOR);
    effect.setFloat('outlineEnabled', apSelectionOutlineActive ? 1 : 0);
  };
}

function setApSelectionMaskMeshes(meshes: Mesh[]): void {
  ensureApSelectionOutlineResources();

  if (apSelectionMaskTexture && apSelectionMaskMeshes.length > 0) {
    apSelectionMaskTexture.setMaterialForRendering(apSelectionMaskMeshes, undefined);
  }

  apSelectionMaskMeshes = meshes;
  apSelectionOutlineActive = meshes.length > 0;

  if (!apSelectionMaskTexture || !apSelectionMaskMaterial) return;
  apSelectionMaskTexture.renderList = apSelectionMaskMeshes;
  if (meshes.length > 0) {
    apSelectionMaskTexture.setMaterialForRendering(meshes, apSelectionMaskMaterial);
  }
}

function clearApSelectionMask(): void {
  if (apSelectionMaskTexture && apSelectionMaskMeshes.length > 0) {
    apSelectionMaskTexture.setMaterialForRendering(apSelectionMaskMeshes, undefined);
  }
  for (const mesh of apSelectionMaskMeshes) {
    if (state.assets.mesh?.background) mesh.visibility = 0;
  }
  apSelectionMaskMeshes = [];
  apSelectionOutlineActive = false;
  if (apSelectionMaskTexture) apSelectionMaskTexture.renderList = apSelectionMaskMeshes;
}


// =================================================================
//  BOOTSTRAP
// =================================================================

function bootstrap(): void {
  // Mode client : pose la classe `client-mode` sur <body> si ?client=1 ou flag serveur.
  // Hors mode client, sans effet : l'interface complète reste inchangée.
  applyClientMode();

  const canvas = document.getElementById('render-canvas') as HTMLCanvasElement;
  if (!canvas) throw new Error('render-canvas introuvable');

  const ctx = createSceneContext(canvas);
  (window as any).MAGO_DEBUG = () => state;
  const measure = new MeasureTool(ctx.scene);

  state = {
    ctx,
    measure,
    assets: { mesh: null, splat: null },
    pendingConfigTransforms: { mesh: null, splat: null },
    extraAssets: [],
    selectedObjectUid: null,
    selectedLayerId: null,
    meshOpacity: 1,
    meshMode: 'solid',
    meshBackface: true,
    transforms: {
      // Les données scan/Blender/CloudCompare arrivent presque toujours en Z-up.
      // On applique donc Z-up → Y-up par défaut, tout en gardant les champs modifiables.
      mesh: zUpToYUpTransform(),
      splat: zUpToYUpTransform(),
    },
    originalFiles: { mesh: null, splat: null },
    cameraControls: {
      mouseSensitivity: 1,
      zoomSensitivity: 1,
      // Pan clic droit ralenti par défaut : l'ancien réglage était trop nerveux.
      panSensitivity: 0.35,
      keyboardSpeed: 1,
      pressed: new Set<string>(),
      lastMoveTime: performance.now(),
    },
    performance: {
      // Par défaut on garde une image nette. Le LOD géométrique sert à fluidifier
      // sans dégrader la résolution comme le faisait le mode performance agressif.
      renderScale: 1,
      adaptiveRender: false,
      movingRenderScale: 0.8,
      currentHardwareScale: -1,
      lastCameraSignature: '',
      lastCameraMoveTime: performance.now(),
    },
    manipulator: {
      gizmo: createObjectGizmo(ctx.scene),
      selectedKind: null,
      mode: 'none',
      isDragging: false,
    },
    alignment: {
      active: false,
      sourceKind: 'splat',
      targetKind: 'mesh',
      waitingFor: 'source',
      currentSource: null,
      pairs: [],
      lastMatrix: null,
      lastMatrixAppliedToSource: false,
      lastMatrixSourceUid: null,
      applyToSource: true,
      scaleMode: 'keep',
      manualScale: 1,
      hideSourceDuringPick: false,
      hideTargetDuringPick: false,
    },
    meshEditor: {
      active: false,
      drawing: false,
      points: [],
      selectionMode: 'lasso',
      brushSize: 36,
      visibleOnly: true,
      combineNext: null,
      selected: new Map<Mesh, Set<number>>(),
      preview: null,
      hiddenTriangles: [],
      undoStack: [],
      triangleCache: new Map<Mesh, MeshTriangleCache>(),
      selectionToken: 0,
    },
    meshLod: {
      enabled: true,
      groups: [],
      meshLevel: new Map<Mesh, number>(),
      availableLevels: [],
      sceneDiagonal: 1,
      currentLevel: null,
      currentLabel: 'LOD unique',
      lastRadius: -1,
    },
    magoTiles: {
      enabled: false,
      name: '',
      rootHandle: null,
      tiles: [],
      availableLevels: [],
      sceneDiagonal: 1,
      lastUpdate: 0,
      loadedCount: 0,
      maxConcurrentLoads: 2,
      maxResidentTiles: 6,
      maxResidentTriangles: 4_000_000,
      errorShown: false,
    },
    splatEditor: {
      data: null,
      baseMask: null,
      visibleMask: null,
      selectedMask: null,
      hiddenMask: null,
      lightOnly: false,
      lassoActive: false,
      lassoDrawing: false,
      restoreActive: false,
      combineNext: null,
      lassoPoints: [],
      selectionMode: 'lasso',
      brushSize: 32,
      settings: { lightnessMin: 0.72, neutralityMin: 0.72 },
      sor: { k: 6, nSigma: 1.0, running: false },
      meshDist: { maxDistance: 0.05, running: false },
      undoStack: [],
    },
  };

  setupCollapsiblePanels();
  bindLayoutControls();
  bindUI();
  bindLodHudControls();
  writeTransformToInputs('mesh', state.transforms.mesh);
  writeTransformToInputs('splat', state.transforms.splat);
  bindKeyboard();
  applyRenderScale(state.performance.renderScale);
  startRenderLoop();

  // Enrichissement sémantique : panneau d'attributs (clic couche ou clic mesh 3D).
  // Le picking 3D est ignoré quand un autre outil interactif est actif.
  initEnrichment(state.ctx.scene, {
    isInteractionBlocked: isViewportInteractionBlocked,
  });

  // Sélection d'une couche par clic direct sur un mesh dans la vue 3D (liseré rouge).
  // Aucun outil à activer : un simple clic suffit ; clic dans le vide = désélection.
  initLayerPickSelection();

  setStatus('prêt');

  if (isClientMode()) {
    // Vue client épurée : ni grille, ni repère XYZ.
    state.ctx.grid.setEnabled(false);
    setAxesVisible(false);
    const gridToggle = document.getElementById('toggle-grid') as HTMLInputElement | null;
    if (gridToggle) gridToggle.checked = false;
    const axesToggle = document.getElementById('toggle-axes') as HTMLInputElement | null;
    if (axesToggle) axesToggle.checked = false;
    // Mode client : on bloque l'accès derrière l'écran de connexion.
    initClientLoginGate();
  } else {
    toast('Viewer prêt. Charge un mesh et/ou un fichier de splats pour commencer.');
  }
}

// =================================================================
//  MODE CLIENT — écran de connexion + chargement de la scène hébergée
// =================================================================

let clientExpiryTimeout: number | null = null;
let clientSessionPoll: number | null = null;

function clearClientSessionTimers(): void {
  if (clientExpiryTimeout !== null) {
    window.clearTimeout(clientExpiryTimeout);
    clientExpiryTimeout = null;
  }
  if (clientSessionPoll !== null) {
    window.clearInterval(clientSessionPoll);
    clientSessionPoll = null;
  }
}

function showClientLoginMessage(message: string): void {
  const overlay = document.getElementById('client-login');
  const userInput = document.getElementById('client-login-user') as HTMLInputElement | null;
  const passInput = document.getElementById('client-login-pass') as HTMLInputElement | null;
  const errorEl = document.getElementById('client-login-error');
  if (overlay) overlay.removeAttribute('hidden');
  if (errorEl) errorEl.textContent = message;
  if (passInput) passInput.value = '';
  (userInput ?? passInput)?.focus();
}

function lockClientAccess(message = 'Abonnement expiré — accès coupé.'): void {
  clearClientSessionTimers();
  clientLogout();
  showClientLoginMessage(message);
  toast(message, 'warn', 6000);
}

function scheduleClientExpiry(expiresAt: string | null): void {
  if (clientExpiryTimeout !== null) {
    window.clearTimeout(clientExpiryTimeout);
    clientExpiryTimeout = null;
  }
  if (!expiresAt) return;

  const expiresMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresMs)) return;

  const delay = expiresMs - Date.now();
  if (delay <= 0) {
    lockClientAccess('Abonnement expiré — accès coupé.');
    return;
  }

  // Limite technique des timers navigateur (~24,8 jours). Au-delà, on reprogramme.
  const maxDelay = 2_147_483_647;
  clientExpiryTimeout = window.setTimeout(() => {
    if (delay > maxDelay) {
      refreshClientSessionWatch().catch(() => lockClientAccess('Session expirée — reconnecte-toi.'));
    } else {
      lockClientAccess('Abonnement expiré — accès coupé.');
    }
  }, Math.min(delay, maxDelay));
}

async function refreshClientSessionWatch(): Promise<void> {
  const session = await fetchSession();
  scheduleClientExpiry(session.expires_at);
}

function startClientSessionWatch(): void {
  if (clientSessionPoll !== null) return;
  // Re-vérifie la base toutes les minutes : utile si tu avances l'expiration,
  // désactives le compte ou changes le mot de passe pendant que le client est connecté.
  clientSessionPoll = window.setInterval(() => {
    refreshClientSessionWatch().catch(() => lockClientAccess('Session expirée — reconnecte-toi.'));
  }, 60_000);
}

/** Affiche l'écran de connexion et, après authentification, charge la scène du compte. */
function initClientLoginGate(): void {
  const overlay = document.getElementById('client-login');
  const userInput = document.getElementById('client-login-user') as HTMLInputElement | null;
  const passInput = document.getElementById('client-login-pass') as HTMLInputElement | null;
  const submitBtn = document.getElementById('client-login-submit') as HTMLButtonElement | null;
  const errorEl = document.getElementById('client-login-error');
  if (!overlay || !userInput || !passInput || !submitBtn) return;

  // Sécurité demandée : à chaque ouverture d'un lien client, on repart sur l'écran de connexion.
  // Cela évite qu'un ancien jeton sessionStorage laisse voir le viewer sans retaper le mot de passe.
  clientLogout();
  clearClientSessionTimers();

  const showError = (msg: string) => { if (errorEl) errorEl.textContent = msg; };

  const attempt = async () => {
    const username = userInput.value.trim();
    const password = passInput.value;
    if (!username || !password) { showError('Identifiant et mot de passe requis.'); return; }
    submitBtn.disabled = true;
    showError('');
    submitBtn.textContent = 'Connexion…';
    try {
      await clientLogin(username, password);
      await refreshClientSessionWatch();
      startClientSessionWatch();
      overlay.setAttribute('hidden', '');
      await loadHostedScene();
    } catch (e) {
      showError((e as Error).message || 'Connexion refusée.');
      passInput.value = '';
      passInput.focus();
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Se connecter';
    }
  };

  submitBtn.addEventListener('click', () => void attempt());
  passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') void attempt(); });
  userInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') passInput.focus(); });

  // Toujours demander l'identifiant et le mot de passe à l'ouverture du lien client.
  // Le jeton n'est créé qu'après validation du formulaire ci-dessus.
  overlay.removeAttribute('hidden');
  userInput.focus();
}

// --- Barre de chargement de la scène client -----------------------------------
function showClientLoading(title: string): void {
  const overlay = document.getElementById('client-loading');
  const titleEl = document.getElementById('client-loading-title');
  const fill = document.getElementById('client-loading-fill');
  const pct = document.getElementById('client-loading-pct');
  if (titleEl) titleEl.textContent = title;
  if (fill) { fill.classList.remove('indeterminate'); fill.style.width = '0%'; }
  if (pct) pct.textContent = '';
  overlay?.removeAttribute('hidden');
}
function setClientLoadingProgress(title: string, loaded: number, total: number): void {
  const titleEl = document.getElementById('client-loading-title');
  const fill = document.getElementById('client-loading-fill');
  const pct = document.getElementById('client-loading-pct');
  if (total > 0) {
    const p = Math.min(100, (loaded / total) * 100);
    if (titleEl) titleEl.textContent = `${title}…`;
    if (fill) { fill.classList.remove('indeterminate'); fill.style.width = `${p.toFixed(0)}%`; }
    if (pct) pct.textContent = `${formatBytes(loaded)} / ${formatBytes(total)} · ${p.toFixed(0)} %`;
  } else {
    if (titleEl) titleEl.textContent = `${title}…`;
    if (fill) fill.classList.add('indeterminate');
    if (pct) pct.textContent = formatBytes(loaded);
  }
}
function setClientLoadingIndeterminate(title: string): void {
  const titleEl = document.getElementById('client-loading-title');
  const fill = document.getElementById('client-loading-fill');
  const pct = document.getElementById('client-loading-pct');
  if (titleEl) titleEl.textContent = title;
  if (fill) { fill.classList.add('indeterminate'); fill.style.width = '40%'; }
  if (pct) pct.textContent = '';
}
function hideClientLoading(): void {
  document.getElementById('client-loading')?.setAttribute('hidden', '');
}

/** Récupère le manifeste de la scène du compte et charge mesh/splats via handleFile. */
async function loadHostedScene(): Promise<void> {
  setStatus('chargement de la scène…');
  showClientLoading('Chargement de la scène…');
  let loadedSomething = false;
  try {
    await refreshClientSessionWatch();
    startClientSessionWatch();

    const manifest = await fetchManifest();
    const displayName = manifest.name ?? undefined;

    if (manifest.mesh) {
      const file = await fetchSceneFile(manifest.mesh, displayName, (loaded, total) => {
        setClientLoadingProgress('Chargement de la scène', loaded, total);
      });
      setClientLoadingIndeterminate('Préparation de l’affichage…');
      await handleFile(file, 'mesh');
      // Mode « arrière-plan » figé à la publication : mesh invisible mais
      // sélectionnable (liseré, mesures). Non modifiable côté client
      // (bouton AP masqué par client-mode.css + garde isClientMode()).
      if (manifest.meshBackground && state.assets.mesh) {
        setAssetBackground(state.assets.mesh, true);
        renderSceneObjectList();
      }
      loadedSomething = true;
    }
    if (manifest.splat) {
      const file = await fetchSceneFile(manifest.splat, undefined, (loaded, total) => {
        setClientLoadingProgress('Chargement de la scène (splats)', loaded, total);
      });
      setClientLoadingIndeterminate('Préparation de l’affichage…');
      await handleFile(file, 'splat');
      loadedSomething = true;
    }
    if (manifest.cloud) {
      const file = await fetchSceneFile(manifest.cloud, undefined, (loaded, total) => {
        setClientLoadingProgress('Chargement de la scène (nuage)', loaded, total);
      });
      setClientLoadingIndeterminate('Préparation de l’affichage…');
      await handlePointCloudFile(file);
      loadedSomething = true;
    }

    if (loadedSomething) {
      const allAssets = getAllAssets();
      if (allAssets.length) frameScene(state.ctx.camera, allAssets, false);
      toast('Scène chargée.');
    } else {
      toast('Aucune scène associée à ce compte.', 'warn', 5000);
    }
  } catch (e) {
    console.error(e);
    toast('Échec du chargement de la scène : ' + (e as Error).message, 'error', 6000);
    throw e;
  } finally {
    hideClientLoading();
    setStatus('prêt');
  }
}

/** Vrai si un outil interactif est actif → le clic 3D « passif » (enrichissement, sélection de couche) doit s'effacer. */
function isViewportInteractionBlocked(): boolean {
  return (
    state.measure.isActive() ||
    state.alignment.active ||
    state.meshEditor.active ||
    state.splatEditor.lassoActive ||
    state.manipulator.isDragging
  );
}

/** Retrouve la couche logique (sous-couche mesh) à laquelle appartient un mesh donné. */
function findLayerForMesh(mesh: AbstractMesh): MeshSubLayer | null {
  const layers = state.assets.mesh?.meshLayers ?? [];
  let found = layers.find((l) => l.meshes.includes(mesh)) ?? null;
  if (!found) {
    // Repli : tuiles / meshes rechargés non présents dans layer.meshes mais portant la clé de classe.
    const key = (mesh.metadata as any)?.magoClassKey as string | undefined;
    if (key) found = layers.find((l) => l.classKey === key) ?? null;
  }
  return found;
}

function initLayerPickSelection(): void {
  state.ctx.scene.onPointerObservable.add((pi) => {
    if (pi.type !== PointerEventTypes.POINTERTAP) return;
    if (isViewportInteractionBlocked()) return; // un autre outil gère le clic
    const pick = pi.pickInfo;
    const mesh = pick?.hit ? pick.pickedMesh : null;
    const layer = mesh ? findLayerForMesh(mesh) : null;
    const newId = layer?.id ?? null; // clic dans le vide → désélection
    if (state.selectedLayerId === newId) return;
    state.selectedLayerId = newId;
    renderMeshSubLayerList();
    if (layer) toast(`Couche sélectionnée : ${layer.name}`, 'info', 1500);
  });
}

function startRenderLoop(): void {
  const { engine, scene } = state.ctx;

  engine.runRenderLoop(() => {
    updateKeyboardMovement();
    syncTransformFromActiveGizmo();
    updateAdaptiveRenderScale();
    updateMeshLodByCamera();
    updateMagoTilesByCamera();
    scene.render();
  });

  window.addEventListener('resize', () => engine.resize());

  // Stats : FPS, splats count, tris count
  const fpsEl = document.getElementById('stat-fps')!;
  const splatsEl = document.getElementById('stat-splats')!;
  const trisEl = document.getElementById('stat-tris')!;

  setInterval(() => {
    fpsEl.textContent = engine.getFps().toFixed(0);
    splatsEl.textContent = state.assets.splat
      ? formatNumber(state.assets.splat.splatCount)
      : '—';
    trisEl.textContent = state.assets.mesh
      ? formatNumber(state.assets.mesh.triangleCount)
      : '—';

    // Caméra info
    updateCameraInfo();
    updateLodHud();
    if (state.splatEditor.selectedMask) drawSelectionHighlightOverlay();
  }, 250);
}

// =================================================================
//  PANNEAUX DÉROULANTS
// =================================================================

function setupCollapsiblePanels(): void {
  document.querySelectorAll<HTMLElement>('#sidebar-left .panel').forEach((panel) => {
    if (panel.dataset.collapsibleReady === '1') return;
    const h2 = panel.querySelector(':scope > h2');
    if (!h2) return;

    const title = h2.textContent?.trim() ?? 'Panneau';
    const body = document.createElement('div');
    body.className = 'panel-body';

    const children = Array.from(panel.childNodes);
    for (const child of children) {
      if (child === h2) continue;
      body.appendChild(child);
    }

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'panel-toggle-btn';
    header.innerHTML = `<span>${title}</span><span class="panel-chevron">▾</span>`;

    h2.remove();
    panel.appendChild(header);
    panel.appendChild(body);
    panel.dataset.collapsibleReady = '1';

    const defaultOpen = title === 'Chargement' || title === 'Calques';
    panel.classList.toggle('collapsed', !defaultOpen);

    header.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
    });
  });
}

function bindLayoutControls(): void {
  const body = document.body;
  const sidebar = document.getElementById('sidebar-left') as HTMLElement | null;
  const toggle = document.getElementById('btn-sidebar-toggle');
  const resizer = document.getElementById('sidebar-resizer');
  const toolsButton = document.getElementById('btn-tools-menu');
  const toolsDropdown = document.getElementById('tools-dropdown');

  toggle?.addEventListener('click', () => {
    body.classList.toggle('sidebar-collapsed');
    body.classList.toggle('sidebar-open', !body.classList.contains('sidebar-collapsed'));
    setTimeout(() => state.ctx.engine.resize(), 220);
  });

  toolsButton?.addEventListener('click', (e) => {
    e.stopPropagation();
    toolsDropdown?.classList.toggle('open');
  });
  // Important : le menu Outils ne se ferme plus quand on travaille dans la scène
  // (lasso, rectangle, pinceau, orbit, mesure...). Il se replie uniquement si
  // l'utilisateur reclique sur le bouton "Outils".
  toolsDropdown?.addEventListener('click', (e) => e.stopPropagation());

  let resizing = false;
  resizer?.addEventListener('pointerdown', (e) => {
    if (!sidebar) return;
    resizing = true;
    body.classList.add('resizing-sidebar');
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  resizer?.addEventListener('pointermove', (e) => {
    if (!resizing || !sidebar) return;
    const width = Math.min(560, Math.max(230, e.clientX));
    document.documentElement.style.setProperty('--sidebar-w', `${width}px`);
    state.ctx.engine.resize();
  });
  const stopResize = (e?: PointerEvent) => {
    if (!resizing) return;
    resizing = false;
    body.classList.remove('resizing-sidebar');
    try { if (e) (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
  };
  resizer?.addEventListener('pointerup', stopResize);
  resizer?.addEventListener('pointercancel', stopResize);
}

// =================================================================
//  UI BINDINGS
// =================================================================

function bindUI(): void {
  // ----- Drop zones & file pickers -----
  bindDropZone('mesh');
  bindDropZone('splat');
  bindDropZone('auto');

  document.querySelectorAll<HTMLButtonElement>('[data-trigger]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.trigger!;
      const input = document.getElementById(target) as HTMLInputElement | null;
      input?.click();
    });
  });

  (document.getElementById('file-mesh') as HTMLInputElement).addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) handleFile(file, 'mesh');
    input.value = '';
  });
  (document.getElementById('file-splat') as HTMLInputElement).addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) handleFile(file, 'splat');
    input.value = '';
  });
  (document.getElementById('file-pointcloud') as HTMLInputElement).addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) handlePointCloudFile(file);
    input.value = '';
  });
  document.getElementById('btn-import-tiles')?.addEventListener('click', () => {
    loadMagoTilesFromDirectory();
  });

  // ----- Toggles layers -----
  document.getElementById('toggle-mesh')!.addEventListener('change', (e) => {
    const visible = (e.target as HTMLInputElement).checked;
    setMeshVisible(visible);
  });
  document.getElementById('toggle-splat')!.addEventListener('change', (e) => {
    const visible = (e.target as HTMLInputElement).checked;
    setSplatVisible(visible);
  });

  document.getElementById('btn-unload-mesh')?.addEventListener('click', () => clearAsset('mesh'));
  document.getElementById('btn-unload-splat')?.addEventListener('click', () => clearAsset('splat'));
  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedObjectUid != null) {
      if (isClientMode()) return; // édition verrouillée côté client
      deleteSelectedSceneObject();
      e.preventDefault();
    }
  });
  document.getElementById('btn-mesh-layers-all')?.addEventListener('click', () => setAllMeshSubLayersVisible(true));
  document.getElementById('btn-mesh-layers-none')?.addEventListener('click', () => setAllMeshSubLayersVisible(false));
  (document.getElementById('mesh-layer-search') as HTMLInputElement | null)?.addEventListener('input', () => renderMeshSubLayerList());

  // ----- Mesh controls -----
  const opacityRange = document.getElementById('mesh-opacity') as HTMLInputElement;
  const opacityVal = document.getElementById('val-mesh-opacity')!;
  opacityRange.addEventListener('input', (e) => {
    const v = parseFloat((e.target as HTMLInputElement).value);
    state.meshOpacity = v;
    opacityVal.textContent = `${Math.round(v * 100)}%`;
    applyMeshSettings();
  });

  (document.getElementById('mesh-mode') as HTMLSelectElement).addEventListener('change', (e) => {
    state.meshMode = (e.target as HTMLSelectElement).value as MeshRenderMode;
    applyMeshSettings();
  });

  document.getElementById('mesh-backface')?.addEventListener('change', (e) => {
    state.meshBackface = (e.target as HTMLInputElement).checked;
    applyMeshSettings();
  });

  // ----- Scene helpers -----
  document.getElementById('toggle-grid')!.addEventListener('change', (e) => {
    state.ctx.grid.setEnabled((e.target as HTMLInputElement).checked);
  });
  document.getElementById('toggle-axes')!.addEventListener('change', (e) => {
    setAxesVisible((e.target as HTMLInputElement).checked);
  });

  // Fonds de scène : couleurs unies + ciel coucher de soleil.
  document.querySelectorAll<HTMLButtonElement>('.swatch').forEach((sw) => {
    sw.addEventListener('click', () => {
      const canvasWrap = document.getElementById('canvas-wrap');
      const sunset = sw.dataset.bgMode === 'sunset';
      canvasWrap?.classList.toggle('sunset-background', sunset);
      if (sunset) {
        state.ctx.scene.clearColor = new Color4(0, 0, 0, 0);
      } else {
        const hex = sw.dataset.bg;
        if (!hex) return;
        state.ctx.scene.clearColor = hexToColor4(hex);
      }
      document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
      sw.classList.add('active');
    });
  });

  // ----- Toolbar -----
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view! as 'top' | 'front' | 'side' | 'iso';
      applyPredefinedView(state.ctx.camera, view);
    });
  });

  document.getElementById('btn-frame')!.addEventListener('click', () => {
    const allAssets = getAllAssets();
    if (allAssets.length === 0) {
      toast("Aucun asset chargé.", 'warn');
      return;
    }
    frameScene(state.ctx.camera, allAssets, false);
  });

  document.getElementById('btn-screenshot')!.addEventListener('click', async () => {
    try {
      setStatus('capture en cours…');
      await captureScreenshot(state.ctx.scene, 2);
      setStatus('prêt');
      toast('Capture exportée.');
    } catch (e) {
      console.error(e);
      toast('Échec de la capture : ' + (e as Error).message, 'error');
    }
  });

  // Bouton inspecteur supprimé de l'interface : on garde le code robuste si une ancienne page l'a encore.
  document.getElementById('btn-inspector')?.addEventListener('click', () => {
    toast("Inspecteur désactivé dans cette version légère.", 'warn', 3000);
  });

  document.getElementById('btn-toggle-gizmo')?.addEventListener('click', () => {
    const axesCheckbox = document.getElementById('toggle-axes') as HTMLInputElement | null;
    const next = !(axesCheckbox?.checked ?? true);
    if (axesCheckbox) axesCheckbox.checked = next;
    setAxesVisible(next);
  });

  // ----- Transformations par calque -----
  bindTransformControls();
  bindObjectManipulatorControls();
  bindPointAlignmentControls();

  document.getElementById('btn-center-origin')?.addEventListener('click', () => {
    centerAssetAtOrigin();
  });

  document.getElementById('btn-reset-all-transforms')!.addEventListener('click', () => {
    setLayerTransform('mesh', cloneTransform(DEFAULT_TRANSFORM));
    setLayerTransform('splat', cloneTransform(DEFAULT_TRANSFORM));
    updateBboxInfo();
    toast('Transformations réinitialisées.');
  });

  document.getElementById('btn-frame-after-transform')!.addEventListener('click', () => {
    const allAssets = getAllAssets();
    if (allAssets.length === 0) {
      toast('Aucun asset chargé.', 'warn');
      return;
    }
    frameScene(state.ctx.camera, allAssets, false);
  });

  // ----- Export / import scène -----
  bindExportControls();

  // ----- Vue client -----
  // Crée depuis le viewer un accès client dans la base séparée mago_access.
  document.getElementById('btn-create-client-view')?.addEventListener('click', () => {
    void openCreateClientViewDialog();
  });

  // ----- Edition mesh -----
  bindMeshEditorControls();

  // ----- Edition / filtrage des splats -----
  bindSplatEditorControls();

  // ----- Mesure -----
  const btnMeasure = document.getElementById('btn-measure')!;
  btnMeasure.addEventListener('click', () => toggleMeasure());
  (document.getElementById('measure-mode') as HTMLSelectElement | null)?.addEventListener('change', (e) => {
    const mode = (e.target as HTMLSelectElement).value as MeasureMode;
    state.measure.setMode(mode);
    updateMeasureModeHint(mode);
    updateMeasureUI(null);
  });
  document.getElementById('btn-measure-finish-area')?.addEventListener('click', () => {
    state.measure.finishArea();
  });
  document.getElementById('btn-measure-undo-point')?.addEventListener('click', () => {
    state.measure.undoLastPoint();
  });
  document.getElementById('btn-measure-clear')!.addEventListener('click', () => {
    state.measure.clear();
  });
  updateMeasureModeHint(state.measure.getMode());

  state.measure.onChange((res) => updateMeasureUI(res));

  // ----- Caméra -----
  document.getElementById('btn-copy-cam')!.addEventListener('click', () => {
    const c = state.ctx.camera;
    const data = {
      target: { x: c.target.x, y: c.target.y, z: c.target.z },
      alpha: c.alpha,
      beta: c.beta,
      radius: c.radius,
    };
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    toast('Pose caméra copiée dans le presse-papier.');
  });

  bindCameraControlSliders();
  bindPerformanceControls();

  // Active la première swatch par défaut
  document.querySelector<HTMLButtonElement>('.swatch[data-bg="#1a1a1a"]')?.classList.add('active');
}

function bindKeyboard(): void {
  const isTypingTarget = (target: EventTarget | null): boolean => {
    const tgt = target as HTMLElement | null;
    return !!tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA');
  };

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      if (isClientMode()) return; // pas d'édition possible → pas d'undo en mode client
      e.preventDefault();
      if (state.meshEditor.undoStack.length > 0) {
        undoLastMeshEdit();
      } else {
        void undoLastSplatEdit();
      }
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!isClientMode()) {
        if (hasSelectedMeshTriangles()) {
          e.preventDefault();
          deleteSelectedMeshTriangles(false);
          return;
        }
        if (hasSelectedSplats()) {
          e.preventDefault();
          void deleteSelectedSplats(false);
          return;
        }
      }
    }

    const k = normalizeMoveKey(e.key);
    if (k) {
      e.preventDefault();
      state.cameraControls.pressed.add(k);
      return;
    }

    if ((e.key === 'h' || e.key === 'H') && !isClientMode()) {
      if (hasSelectedMeshTriangles()) {
        e.preventDefault();
        hideSelectedMeshTriangles();
        return;
      }
      if (hasSelectedSplats()) {
        e.preventDefault();
        void hideSelectedSplats();
        return;
      }
    }

    if (e.key === 'm' || e.key === 'M') {
      toggleMeasure();
    } else if (e.key === 'f' || e.key === 'F') {
      document.getElementById('btn-frame')?.click();
    } else if (e.key === 'Escape') {
      if (state.alignment.active) setPointAlignmentActive(false);
      else if (state.measure.isActive()) toggleMeasure();
    }
  });

  window.addEventListener('keyup', (e) => {
    const k = normalizeMoveKey(e.key);
    if (k) state.cameraControls.pressed.delete(k);
  });

  window.addEventListener('blur', () => {
    state.cameraControls.pressed.clear();
  });
}

function normalizeMoveKey(key: string): 'forward' | 'backward' | 'left' | 'right' | null {
  switch (key) {
    case 'ArrowUp':
    case 'z':
    case 'Z':
    case 'w':
    case 'W':
      return 'forward';
    case 'ArrowDown':
    case 's':
    case 'S':
      return 'backward';
    case 'ArrowLeft':
    case 'q':
    case 'Q':
    case 'a':
    case 'A':
      return 'left';
    case 'ArrowRight':
    case 'd':
    case 'D':
      return 'right';
    default:
      return null;
  }
}

function bindCameraControlSliders(): void {
  const sens = document.getElementById('mouse-sensitivity') as HTMLInputElement | null;
  const sensVal = document.getElementById('val-mouse-sensitivity');
  const zoom = document.getElementById('zoom-sensitivity') as HTMLInputElement | null;
  const zoomVal = document.getElementById('val-zoom-sensitivity');
  const pan = document.getElementById('pan-sensitivity') as HTMLInputElement | null;
  const panVal = document.getElementById('val-pan-sensitivity');
  const speed = document.getElementById('keyboard-speed') as HTMLInputElement | null;
  const speedVal = document.getElementById('val-keyboard-speed');

  const applySensitivity = (value: number) => {
    const safe = Number.isFinite(value) ? Math.min(Math.max(value, 0.05), 10) : 1;
    state.cameraControls.mouseSensitivity = safe;
    // Babylon fonctionne à l'inverse : plus angularSensibility est bas, plus la souris est sensible.
    const angularBase = 1000;
    state.ctx.camera.angularSensibilityX = angularBase / safe;
    state.ctx.camera.angularSensibilityY = angularBase / safe;
    if (sensVal) sensVal.textContent = `${Math.round(safe * 100)}%`;
  };

  const applyZoom = (value: number) => {
    const safe = Number.isFinite(value) ? Math.min(Math.max(value, 0.05), 20) : 1;
    state.cameraControls.zoomSensitivity = safe;

    // On garde le zoom natif ArcRotateCamera : pas de handler wheel maison,
    // donc le zoom reste actif pendant l'alignement par points / picking.
    // wheelDeltaPercentage est proportionnel au rayon courant : c'est le comportement
    // le plus stable pour des scènes métriques petites ou très éloignées.
    const baseWheelDelta = 0.012;
    state.ctx.camera.wheelDeltaPercentage = baseWheelDelta * safe;
    state.ctx.camera.pinchDeltaPercentage = baseWheelDelta * safe;
    if (zoomVal) zoomVal.textContent = `${Math.round(safe * 100)}%`;
  };

  const applyPan = (value: number) => {
    const safe = Number.isFinite(value) ? Math.min(Math.max(value, 0.01), 10) : 0.35;
    state.cameraControls.panSensitivity = safe;
    // Babylon fonctionne aussi à l'inverse pour le pan : plus panningSensibility est haut, plus le clic droit est lent.
    const panBase = 50;
    state.ctx.camera.panningSensibility = panBase / Math.max(safe, 0.01);
    if (panVal) panVal.textContent = `${Math.round(safe * 100)}%`;
  };

  const applySpeed = (value: number) => {
    const safe = Number.isFinite(value) ? Math.min(Math.max(value, 0.01), 50) : 1;
    state.cameraControls.keyboardSpeed = safe;
    if (speedVal) speedVal.textContent = `${safe.toFixed(1)} m/s`;
  };

  sens?.addEventListener('input', () => applySensitivity(parseFloat(sens.value)));
  zoom?.addEventListener('input', () => applyZoom(parseFloat(zoom.value)));
  pan?.addEventListener('input', () => applyPan(parseFloat(pan.value)));
  speed?.addEventListener('input', () => applySpeed(parseFloat(speed.value)));

  if (sens) applySensitivity(parseFloat(sens.value));
  if (zoom) applyZoom(parseFloat(zoom.value));
  if (pan) applyPan(parseFloat(pan.value));
  if (speed) applySpeed(parseFloat(speed.value));
}

function bindPerformanceControls(): void {
  const preset = document.getElementById('performance-preset') as HTMLSelectElement | null;
  const scale = document.getElementById('render-scale') as HTMLInputElement | null;
  const scaleVal = document.getElementById('val-render-scale');
  const adaptive = document.getElementById('toggle-adaptive-render') as HTMLInputElement | null;
  const lodMode = document.getElementById('mesh-lod-mode') as HTMLSelectElement | null;

  lodMode?.addEventListener('change', () => {
    updateMeshLodByCamera(true);
    updateLodHud();
  });

  const applyPreset = (name: string) => {
    let nextScale = state.performance.renderScale;
    let nextAdaptive = state.performance.adaptiveRender;
    let moving = state.performance.movingRenderScale;

    if (name === 'quality') {
      nextScale = 1.0;
      nextAdaptive = false;
      moving = 0.85;
    } else if (name === 'balanced') {
      nextScale = 0.85;
      nextAdaptive = true;
      moving = 0.62;
    } else if (name === 'performance') {
      nextScale = 0.70;
      nextAdaptive = true;
      moving = 0.50;
    } else if (name === 'huge') {
      nextScale = 0.55;
      nextAdaptive = true;
      moving = 0.45;
      // Sur de très gros fichiers, la grille coûte aussi en lisibilité/perfs.
      const gridToggle = document.getElementById('toggle-grid') as HTMLInputElement | null;
      if (gridToggle?.checked) {
        gridToggle.checked = false;
        state.ctx.grid.setEnabled(false);
      }
    }

    state.performance.renderScale = nextScale;
    state.performance.adaptiveRender = nextAdaptive;
    state.performance.movingRenderScale = moving;
    if (scale) scale.value = String(nextScale);
    if (adaptive) adaptive.checked = nextAdaptive;
    if (scaleVal) scaleVal.textContent = `${Math.round(nextScale * 100)}%`;
    applyRenderScale(nextScale);
  };

  preset?.addEventListener('change', () => applyPreset(preset.value));
  scale?.addEventListener('input', () => {
    const v = parseFloat(scale.value);
    state.performance.renderScale = v;
    if (scaleVal) scaleVal.textContent = `${Math.round(v * 100)}%`;
    applyRenderScale(v);
  });
  adaptive?.addEventListener('change', () => {
    state.performance.adaptiveRender = adaptive.checked;
    applyRenderScale(state.performance.renderScale);
  });

  // Valeur par défaut : équilibré.
  if (scaleVal) scaleVal.textContent = `${Math.round(state.performance.renderScale * 100)}%`;
  applyRenderScale(state.performance.renderScale);
}

function applyRenderScale(renderScale: number): void {
  const clamped = Math.min(1, Math.max(0.35, renderScale));
  const hardwareScale = 1 / clamped;
  if (Math.abs(state.performance.currentHardwareScale - hardwareScale) < 0.001) return;
  state.ctx.engine.setHardwareScalingLevel(hardwareScale);
  state.performance.currentHardwareScale = hardwareScale;
}

function cameraSignature(): string {
  const c = state.ctx.camera;
  // Signature volontairement arrondie : on veut détecter un vrai mouvement, pas du bruit numérique.
  return [
    c.alpha.toFixed(4), c.beta.toFixed(4), c.radius.toFixed(4),
    c.target.x.toFixed(4), c.target.y.toFixed(4), c.target.z.toFixed(4),
  ].join('|');
}

function updateAdaptiveRenderScale(): void {
  const perf = state.performance;
  if (!perf.adaptiveRender) return;

  const sig = cameraSignature();
  const now = performance.now();
  if (sig !== perf.lastCameraSignature) {
    perf.lastCameraSignature = sig;
    perf.lastCameraMoveTime = now;
    applyRenderScale(Math.min(perf.renderScale, perf.movingRenderScale));
    return;
  }

  // Quand la caméra est stable, on revient automatiquement à la qualité choisie.
  if (now - perf.lastCameraMoveTime > 240) {
    applyRenderScale(perf.renderScale);
  }
}

function updateKeyboardMovement(): void {
  const controls = state.cameraControls;
  const now = performance.now();
  const dt = Math.min((now - controls.lastMoveTime) / 1000, 0.05);
  controls.lastMoveTime = now;

  if (controls.pressed.size === 0) return;

  const camera = state.ctx.camera;
  const forward = camera.getTarget().subtract(camera.position);
  forward.y = 0;
  if (forward.lengthSquared() < 1e-8) return;
  forward.normalize();

  const right = Vector3.Cross(forward, Vector3.Up()).normalize();
  const move = Vector3.Zero();

  if (controls.pressed.has('forward')) move.addInPlace(forward);
  if (controls.pressed.has('backward')) move.subtractInPlace(forward);
  if (controls.pressed.has('right')) move.addInPlace(right);
  if (controls.pressed.has('left')) move.subtractInPlace(right);

  if (move.lengthSquared() < 1e-8) return;
  move.normalize().scaleInPlace(controls.keyboardSpeed * dt);

  // ArcRotateCamera : déplacer la target déplace aussi la caméra, ce qui donne un déplacement type FPS/jeu.
  camera.target.addInPlace(move);
}

function bindDropZone(kind: 'mesh' | 'splat' | 'auto'): void {
  const zone = document.querySelector<HTMLDivElement>(`.drop-zone[data-target="${kind}"]`);
  if (!zone) return;

  ['dragenter', 'dragover'].forEach((evt) => {
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('dragover');
    });
  });

  zone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) handleDroppedFile(file, kind);
  });
}

function bindTransformControls(): void {
  document.querySelectorAll<HTMLInputElement>('input[data-transform]').forEach((input) => {
    input.addEventListener('input', () => {
      const kind = input.dataset.transform as LayerKind;
      const transform = readTransformFromInputs(kind);
      setLayerTransform(kind, transform, false);
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-transform-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.kind as LayerKind;
      const preset = btn.dataset.transformPreset;
      if (preset === 'zup-yup') {
        setLayerTransform(kind, zUpToYUpTransform());
        toast(`${kind === 'mesh' ? 'Mesh' : 'Splats'} : rotation Z-up → Y-up appliquée.`);
      } else if (preset === 'reset') {
        setLayerTransform(kind, cloneTransform(DEFAULT_TRANSFORM));
        toast(`${kind === 'mesh' ? 'Mesh' : 'Splats'} : transformation réinitialisée.`);
      }
      updateBboxInfo();
    });
  });

  document.querySelectorAll<HTMLInputElement>('input[data-sel-field]').forEach((input) => {
    input.addEventListener('input', () => {
      const entry = getSelectedSceneObjectEntry();
      if (!entry) return;
      const transform = readSelectedObjectTransformFromInputs();
      applyTransformToAsset(entry.asset, transform);
      updateBboxInfo();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-sel-transform-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const entry = getSelectedSceneObjectEntry();
      if (!entry) {
        toast('Sélectionne d’abord un objet dans « Objets importés ».', 'warn');
        return;
      }
      const preset = btn.dataset.selTransformPreset;
      const t = preset === 'zup-yup' ? zUpToYUpTransform() : cloneTransform(DEFAULT_TRANSFORM);
      applyTransformToAsset(entry.asset, t);
      writeSelectedObjectTransformToInputs(t);
      updateBboxInfo();
      toast(`Objet sélectionné : ${preset === 'zup-yup' ? 'Z-up → Y-up appliqué' : 'transformation réinitialisée'}.`);
    });
  });

  updateSelectedObjectTransformUI();
}


type SimpleTransform = LayerTransform;

function getSelectedSceneObjectEntry(): SceneObjectEntry | null {
  if (state.selectedObjectUid == null) return null;
  return getSceneObjectEntries().find((e) => e.uid === state.selectedObjectUid) ?? null;
}

function transformFromAsset(asset: LoadedAsset): SimpleTransform {
  const node = asset.rootNode as TransformNode;
  const rot = node.rotationQuaternion ? node.rotationQuaternion.toEulerAngles() : node.rotation;
  const scale = (Math.abs(node.scaling.x) + Math.abs(node.scaling.y) + Math.abs(node.scaling.z)) / 3 || 1;
  return {
    px: round6(node.position.x),
    py: round6(node.position.y),
    pz: round6(node.position.z),
    rx: round6(radToDeg(rot.x)),
    ry: round6(radToDeg(rot.y)),
    rz: round6(radToDeg(rot.z)),
    scale: round6(scale),
  };
}

function applyTransformToAsset(asset: LoadedAsset, transform: SimpleTransform): void {
  const node = asset.rootNode as TransformNode;
  node.position.set(transform.px, transform.py, transform.pz);
  node.rotationQuaternion = null;
  node.rotation.set(degToRadLocal(transform.rx), degToRadLocal(transform.ry), degToRadLocal(transform.rz));
  node.scaling.setAll(Math.max(0.0001, transform.scale || 1));
  node.computeWorldMatrix(true);
  for (const mesh of asset.meshes) mesh.computeWorldMatrix(true);
}

function degToRadLocal(v: number): number {
  return (v * Math.PI) / 180;
}

function readSelectedObjectTransformFromInputs(): SimpleTransform {
  const get = (field: keyof SimpleTransform): number => {
    const input = document.querySelector<HTMLInputElement>(`input[data-sel-field="${field}"]`);
    const value = input ? parseFloat(input.value) : Number.NaN;
    if (!Number.isFinite(value)) return field === 'scale' ? 1 : 0;
    return field === 'scale' ? Math.max(0.0001, value) : value;
  };
  return { px: get('px'), py: get('py'), pz: get('pz'), rx: get('rx'), ry: get('ry'), rz: get('rz'), scale: get('scale') };
}

function writeSelectedObjectTransformToInputs(transform: SimpleTransform): void {
  for (const [field, value] of Object.entries(transform)) {
    const input = document.querySelector<HTMLInputElement>(`input[data-sel-field="${field}"]`);
    if (input) input.value = String(round6(Number(value)));
  }
}

function updateSelectedObjectTransformUI(): void {
  const entry = getSelectedSceneObjectEntry();
  const label = document.getElementById('selected-transform-name');
  const inputs = document.querySelectorAll<HTMLInputElement>('input[data-sel-field]');
  const buttons = document.querySelectorAll<HTMLButtonElement>('[data-sel-transform-preset]');
  if (!entry) {
    if (label) label.textContent = 'Sélectionne un objet dans « Objets importés » pour modifier uniquement celui-ci.';
    inputs.forEach((i) => { i.disabled = true; });
    buttons.forEach((b) => { b.disabled = true; });
    writeSelectedObjectTransformToInputs(cloneTransform(DEFAULT_TRANSFORM));
    return;
  }
  if (label) label.textContent = `${entry.kind === 'mesh' ? 'Mesh' : entry.kind === 'splat' ? 'GS' : 'Nuage'} · ${entry.label}`;
  inputs.forEach((i) => { i.disabled = false; });
  buttons.forEach((b) => { b.disabled = false; });
  writeSelectedObjectTransformToInputs(transformFromAsset(entry.asset));
}


function createObjectGizmo(scene: Scene): GizmoManager {
  const gizmo = new GizmoManager(scene);
  gizmo.positionGizmoEnabled = false;
  gizmo.rotationGizmoEnabled = false;
  gizmo.scaleGizmoEnabled = false;
  gizmo.boundingBoxGizmoEnabled = false;
  gizmo.usePointerToAttachGizmos = false;

  if (gizmo.gizmos.positionGizmo) gizmo.gizmos.positionGizmo.scaleRatio = 0.9;
  if (gizmo.gizmos.rotationGizmo) gizmo.gizmos.rotationGizmo.scaleRatio = 0.9;

  const onStart = () => {
    state.manipulator.isDragging = true;
    state.ctx.camera.detachControl();
  };
  const onEnd = () => {
    state.manipulator.isDragging = false;
    state.ctx.camera.attachControl(state.ctx.scene.getEngine().getRenderingCanvas() as HTMLCanvasElement, true);
  };

  gizmo.gizmos.positionGizmo?.onDragStartObservable.add(onStart);
  gizmo.gizmos.positionGizmo?.onDragEndObservable.add(onEnd);
  gizmo.gizmos.rotationGizmo?.onDragStartObservable.add(onStart);
  gizmo.gizmos.rotationGizmo?.onDragEndObservable.add(onEnd);

  return gizmo;
}

function bindObjectManipulatorControls(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-manip-select]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.manipSelect as LayerKind;
      if (!state.assets[kind]) {
        toast(kind === 'mesh' ? 'Charge un mesh avant de le manipuler.' : 'Charge des splats avant de les manipuler.', 'warn');
        return;
      }
      setManipulatorSelection(kind);
      if (state.manipulator.mode === 'none') setManipulatorMode('move');
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-manip-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.manipMode as AppState['manipulator']['mode'];
      setManipulatorMode(mode);
    });
  });
}

function setManipulatorSelection(kind: LayerKind | null): void {
  state.manipulator.selectedKind = kind;

  document.querySelectorAll<HTMLButtonElement>('[data-manip-select]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.manipSelect === kind);
  });

  const asset = kind ? state.assets[kind] : null;
  if (!asset) {
    state.manipulator.gizmo.attachToNode(null);
    state.manipulator.selectedKind = null;
    updateManipulatorStatus();
    return;
  }

  state.manipulator.gizmo.attachToNode(asset.rootNode as TransformNode);
  updateManipulatorStatus();
}

function setManipulatorMode(mode: AppState['manipulator']['mode']): void {
  state.manipulator.mode = mode;
  const gizmo = state.manipulator.gizmo;
  gizmo.positionGizmoEnabled = mode === 'move';
  gizmo.rotationGizmoEnabled = mode === 'rotate';
  gizmo.scaleGizmoEnabled = mode === 'scale';
  gizmo.boundingBoxGizmoEnabled = false;

  document.querySelectorAll<HTMLButtonElement>('[data-manip-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.manipMode === mode);
  });

  if (mode === 'none') {
    gizmo.attachToNode(null);
    state.manipulator.selectedKind = null;
    document.querySelectorAll<HTMLButtonElement>('[data-manip-select]').forEach((btn) => btn.classList.remove('active'));
  } else if (state.manipulator.selectedKind && state.assets[state.manipulator.selectedKind]) {
    gizmo.attachToNode(state.assets[state.manipulator.selectedKind]!.rootNode as TransformNode);
  }

  updateManipulatorStatus();
}

function updateManipulatorStatus(): void {
  const el = document.getElementById('manipulator-status');
  if (!el) return;
  const kind = state.manipulator.selectedKind;
  const mode = state.manipulator.mode;
  if (!kind || mode === 'none') {
    el.textContent = 'Aucun objet manipulé';
    return;
  }
  el.textContent = `${kind === 'mesh' ? 'Mesh' : 'Splats'} · ${mode === 'move' ? 'déplacement' : mode === 'rotate' ? 'rotation' : 'échelle'}`;
}

function syncTransformFromActiveGizmo(): void {
  const kind = state.manipulator.selectedKind;
  if (!kind || state.manipulator.mode === 'none') return;
  const asset = state.assets[kind];
  if (!asset) return;
  const node = asset.rootNode as TransformNode;
  const next: LayerTransform = {
    px: round6(node.position.x),
    py: round6(node.position.y),
    pz: round6(node.position.z),
    rx: round6(radToDeg(node.rotation.x)),
    ry: round6(radToDeg(node.rotation.y)),
    rz: round6(radToDeg(node.rotation.z)),
    scale: round6((node.scaling.x + node.scaling.y + node.scaling.z) / 3),
  };
  state.transforms[kind] = next;
  writeTransformToInputs(kind, next);
  updateBboxInfo();
}

function radToDeg(v: number): number {
  return (v * 180) / Math.PI;
}

function round6(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

function bindExportControls(): void {
  document.getElementById('btn-export-mesh-glb')!.addEventListener('click', async () => {
    try {
      setStatus('export GLB…');
      restoreHiddenMeshTrianglesBeforeExport();
      await enrichment.embedAttributesInAsset(state.assets.mesh);
      await downloadMeshGlb(state.ctx.scene, state.assets.mesh);
      setStatus('prêt');
      toast('Mesh GLB exporté.');
    } catch (e) {
      console.error(e);
      setStatus('erreur export');
      toast('Échec export GLB : ' + (e as Error).message, 'error', 6000);
    }
  });


  document.getElementById('btn-export-mesh-ply-mago')?.addEventListener('click', () => {
    try {
      setStatus('export PLY MAGO…');
      restoreHiddenMeshTrianglesBeforeExport();
      downloadMeshPlyMago(state.assets.mesh);
      setStatus('prêt');
      toast('Mesh PLY exporté en repère MAGO / CloudCompare / 3DR.');
    } catch (e) {
      console.error(e);
      setStatus('erreur export');
      toast('Échec export PLY MAGO : ' + (e as Error).message, 'error', 6000);
    }
  });

  document.getElementById('btn-export-mesh-obj-mago')?.addEventListener('click', () => {
    try {
      setStatus('export OBJ MAGO…');
      restoreHiddenMeshTrianglesBeforeExport();
      downloadMeshObjMago(state.assets.mesh);
      setStatus('prêt');
      toast('Mesh OBJ exporté en repère MAGO / CloudCompare / 3DR.');
    } catch (e) {
      console.error(e);
      setStatus('erreur export');
      toast('Échec export OBJ MAGO : ' + (e as Error).message, 'error', 6000);
    }
  });

  document.getElementById('btn-export-splat-ply-modified')?.addEventListener('click', () => {
    try {
      setStatus('export GS PLY modifié…');
      exportCurrentSplatsAligned();
      setStatus('prêt');
    } catch (e) {
      console.error(e);
      setStatus('erreur export');
      toast('Échec export GS PLY modifié : ' + (e as Error).message, 'error', 6000);
    }
  });

  document.getElementById('btn-export-config')!.addEventListener('click', () => {
    const config = buildSceneExportConfig();
    downloadText(JSON.stringify(config, null, 2), 'mago_scene_config.json');
    toast('Configuration JSON exportée.');
  });

  document.getElementById('btn-import-config')!.addEventListener('click', () => {
    (document.getElementById('file-config') as HTMLInputElement).click();
  });

  (document.getElementById('file-config') as HTMLInputElement).addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const config = JSON.parse(text) as SceneExportConfig;
      applySceneExportConfig(config);
      toast('Configuration JSON appliquée. Recharge les fichiers indiqués si besoin.');
    } catch (err) {
      console.error(err);
      toast('Impossible de lire cette configuration JSON.', 'error');
    }
  });

  document.getElementById('btn-export-package')!.addEventListener('click', async () => {
    try {
      setStatus('export ZIP…');
      restoreHiddenMeshTrianglesBeforeExport();
      await enrichment.embedAttributesInAsset(state.assets.mesh);
      const alignedSplatFile = state.assets.splat ? buildAlignedSplatFile('splats_aligned_baked.ply') : null;
      await downloadScenePackageZip({
        scene: state.ctx.scene,
        meshAsset: state.assets.mesh,
        splatAsset: state.assets.splat,
        originalMeshFile: state.originalFiles.mesh,
        originalSplatFile: state.originalFiles.splat,
        alignedSplatFile,
        config: buildSceneExportConfig(),
      });
      setStatus('prêt');
      toast('Package ZIP exporté.');
    } catch (e) {
      console.error(e);
      setStatus('erreur export');
      toast('Échec export ZIP : ' + (e as Error).message, 'error', 6000);
    }
  });
}

function setLayerTransform(kind: LayerKind, transform: LayerTransform, syncInputs = true): void {
  state.transforms[kind] = cloneTransform(transform);
  if (syncInputs) writeTransformToInputs(kind, state.transforms[kind]);
  applyLayerTransform(state.assets[kind], state.transforms[kind]);
  updateBboxInfo();
}

function buildSceneExportConfig(): SceneExportConfig {
  const c = state.ctx.camera;
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    app: 'MAGO Viewer',
    files: {
      mesh: state.assets.mesh?.fileName ?? null,
      splat: state.assets.splat?.fileName ?? null,
    },
    transforms: {
      mesh: cloneTransform(state.transforms.mesh),
      splat: cloneTransform(state.transforms.splat),
    },
    camera: {
      target: { x: c.target.x, y: c.target.y, z: c.target.z },
      alpha: c.alpha,
      beta: c.beta,
      radius: c.radius,
    },
    notes: 'Le package ZIP contient le mesh GLB transformé si possible, un PLY GS aligné/bake quand disponible, le PLY original, et ce JSON pour retrouver les transformations dans MAGO Viewer.',
  };
}

function applySceneExportConfig(config: SceneExportConfig): void {
  // Un mago_scene_config.json ne contient AUCUNE géométrie : uniquement les noms
  // de fichiers, leurs transformations et la caméra. Pour chaque type : si l'objet
  // est déjà chargé la transformation s'applique tout de suite, sinon elle est mise
  // en attente et sera consommée au chargement du fichier correspondant.
  const toReload: string[] = [];
  for (const kind of ['mesh', 'splat'] as const) {
    const tf = config.transforms?.[kind];
    if (!tf) continue;
    if (state.assets[kind]) {
      setLayerTransform(kind, tf);
    } else {
      state.pendingConfigTransforms[kind] = cloneTransform(tf);
      writeTransformToInputs(kind, tf);
      const fileName = config.files?.[kind];
      toReload.push(`${kind === 'mesh' ? 'mesh' : 'splats'}${fileName ? ` « ${fileName} »` : ''}`);
    }
  }

  if (config.camera) {
    const c = state.ctx.camera;
    c.target.set(config.camera.target.x, config.camera.target.y, config.camera.target.z);
    c.alpha = config.camera.alpha;
    c.beta = config.camera.beta;
    c.radius = config.camera.radius;
  }

  if (toReload.length > 0) {
    toast(
      `Configuration appliquée. Ce JSON ne contient pas la géométrie : recharge maintenant ${toReload.join(' et ')} ` +
      `(fichiers D'ORIGINE — pas les exports _ALIGNED, déjà cuits). Les transformations mémorisées s'appliqueront automatiquement.`,
      'info',
      12000,
    );
  } else {
    toast('Configuration appliquée aux objets chargés (transformations + caméra).');
  }
}


function clearAsset(kind: 'mesh' | 'splat'): void {
  if (kind === 'mesh') clearApSelectionMask();
  const asset = state.assets[kind];
  if (!asset) {
    toast(kind === 'mesh' ? 'Aucun mesh à supprimer.' : 'Aucun fichier de splats à supprimer.', 'warn');
    return;
  }

  if (state.manipulator.selectedKind === kind) setManipulatorSelection(null);
  const removedUid = (asset.rootNode as any).uniqueId;
  if (state.selectedObjectUid === removedUid) state.selectedObjectUid = null;
  unloadAsset(asset, state.ctx.scene);
  state.assets[kind] = null;
  state.originalFiles[kind] = null;

  const statusEl = document.getElementById(`status-${kind}`);
  const toggleEl = document.getElementById(`toggle-${kind}`) as HTMLInputElement | null;
  const countEl = document.getElementById(`count-${kind}`);
  const fileInput = document.getElementById(`file-${kind}`) as HTMLInputElement | null;

  if (statusEl) {
    statusEl.textContent = 'Aucun fichier';
    statusEl.className = 'drop-status';
  }
  if (toggleEl) {
    toggleEl.checked = false;
    toggleEl.disabled = true;
  }
  if (countEl) countEl.textContent = '—';
  if (fileInput) fileInput.value = '';
  if (kind === 'mesh') {
    state.selectedLayerId = null;
    clearMeshSelection();
    state.meshEditor.undoStack = [];
    state.meshEditor.hiddenTriangles = [];
    state.meshEditor.triangleCache.clear();
    state.meshEditor.selectionToken++;
    resetMeshLodState();
    updateMeshEditorStats();
    renderMeshSubLayerList();
    updateLodHud();
  }

  if (kind === 'splat') {
    state.splatEditor.data = null;
    state.splatEditor.baseMask = null;
    state.splatEditor.visibleMask = null;
    state.splatEditor.selectedMask = null;
    state.splatEditor.hiddenMask = null;
    state.splatEditor.lightOnly = false;
    state.splatEditor.lassoActive = false;
    state.splatEditor.restoreActive = false;
    state.splatEditor.combineNext = null;
    state.splatEditor.lassoPoints = [];
    clearLassoOverlay();
    updateSplatEditorStats();
  }

  renderSceneObjectList();
  updateBboxInfo();
  setStatus('prêt');
  toast(kind === 'mesh' ? 'Mesh supprimé de la scène.' : 'Splats supprimés de la scène.');
}


// =================================================================
//  MAGO TILES V42 HANDLING
// =================================================================

function zUpPointToViewer(p: Vector3): Vector3 {
  // Rotation X = -90° : X reste X, Z devient Y, Y devient -Z.
  return new Vector3(p.x, p.z, -p.y);
}

function bboxCenterAndRadiusViewer(bbox: number[]): { center: Vector3; radius: number } {
  const min = new Vector3(bbox[0], bbox[1], bbox[2]);
  const max = new Vector3(bbox[3], bbox[4], bbox[5]);
  const c = min.add(max).scale(0.5);
  const corners = [
    new Vector3(bbox[0], bbox[1], bbox[2]),
    new Vector3(bbox[3], bbox[1], bbox[2]),
    new Vector3(bbox[0], bbox[4], bbox[2]),
    new Vector3(bbox[3], bbox[4], bbox[2]),
    new Vector3(bbox[0], bbox[1], bbox[5]),
    new Vector3(bbox[3], bbox[1], bbox[5]),
    new Vector3(bbox[0], bbox[4], bbox[5]),
    new Vector3(bbox[3], bbox[4], bbox[5]),
  ].map(zUpPointToViewer);
  const vc = zUpPointToViewer(c);
  let r = 0;
  for (const p of corners) r = Math.max(r, Vector3.Distance(vc, p));
  return { center: vc, radius: Math.max(0.001, r) };
}

async function getFileHandleByRelativePath(rootHandle: any, relPath: string): Promise<any> {
  const clean = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = clean.split('/').filter(Boolean);
  let dir = rootHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i]);
  }
  return await dir.getFileHandle(parts[parts.length - 1]);
}

async function clearMagoTiles(): Promise<void> {
  for (const tile of state.magoTiles.tiles) {
    if (tile.asset) {
      unloadAsset(tile.asset, state.ctx.scene);
      tile.asset = null;
    }
    tile.currentLevel = null;
    tile.loading = false;
  }
  state.magoTiles.enabled = false;
  state.magoTiles.tiles = [];
  state.magoTiles.loadedCount = 0;
  updateMagoTilesHud();
}

async function loadMagoTilesFromDirectory(): Promise<void> {
  const w = window as any;
  if (!w.showDirectoryPicker) {
    toast('Ton navigateur ne supporte pas le chargement de dossier. Utilise Chrome ou Edge récent.', 'error', 7000);
    return;
  }

  try {
    const dirHandle = await w.showDirectoryPicker({ mode: 'read' });
    const sceneHandle = await dirHandle.getFileHandle('scene_tiles.json');
    const sceneFile = await sceneHandle.getFile();
    const sceneJson = JSON.parse(await sceneFile.text());

    if (sceneJson.format !== 'MAGO_TILES_V42' || !Array.isArray(sceneJson.tiles)) {
      throw new Error('scene_tiles.json non reconnu : format attendu MAGO_TILES_V42.');
    }

    await clearMagoTiles();

    const bbox = sceneJson.bbox as number[] | undefined;
    let sceneDiagonal = 1;
    if (bbox && bbox.length === 6) {
      const mn = new Vector3(bbox[0], bbox[1], bbox[2]);
      const mx = new Vector3(bbox[3], bbox[4], bbox[5]);
      sceneDiagonal = Vector3.Distance(zUpPointToViewer(mn), zUpPointToViewer(mx));
    }

    const levels = new Set<number>();
    const tiles: MagoTileRuntime[] = [];
    for (const raw of sceneJson.tiles) {
      if (!raw || !Array.isArray(raw.lods) || !Array.isArray(raw.bbox)) continue;
      const { center, radius } = bboxCenterAndRadiusViewer(raw.bbox);
      const lods = raw.lods
        .filter((l: any) => Number.isFinite(Number(l.level)) && typeof l.file === 'string')
        .map((l: any) => ({ level: Number(l.level), ratio: l.ratio, file: l.file, size_bytes: l.size_bytes ?? null }))
        .sort((a: MagoTileLodMeta, b: MagoTileLodMeta) => a.level - b.level);
      for (const l of lods) levels.add(l.level);
      tiles.push({
        id: String(raw.id ?? `tile_${raw.index ?? tiles.length}`),
        index: Number(raw.index ?? tiles.length),
        bbox: raw.bbox,
        center,
        radius,
        lods,
        currentLevel: null,
        loading: false,
        asset: null,
        failCount: 0,
      });
    }

    if (!tiles.length) throw new Error('Aucune tuile exploitable trouvée dans scene_tiles.json.');

    state.magoTiles = {
      enabled: true,
      name: String(sceneJson.name ?? 'MAGO Tiles'),
      rootHandle: dirHandle,
      tiles,
      availableLevels: Array.from(levels).sort((a, b) => a - b),
      sceneDiagonal: Math.max(1, sceneDiagonal),
      lastUpdate: 0,
      loadedCount: 0,
      maxConcurrentLoads: 2,
      maxResidentTiles: 6,
      maxResidentTriangles: 4_000_000,
      errorShown: false,
    };

    toast(`Scène MAGO Tiles chargée : ${tiles.length} tiles, LOD ${state.magoTiles.availableLevels.join(' / ')}.`, 'info', 6000);
    setStatus(`MAGO Tiles : ${tiles.length} tiles`);
    updateMagoTilesHud();

    // Charge rapidement un LOD global léger pour afficher quelque chose.
    updateMagoTilesByCamera(true);
  } catch (err: any) {
    console.error(err);
    toast(`Erreur MAGO Tiles : ${err?.message ?? err}`, 'error', 8000);
  }
}

function chooseMagoTileLevel(tile: MagoTileRuntime): number | null {
  if (!state.magoTiles.enabled || tile.lods.length === 0) return null;

  const levels = tile.lods.map((l) => l.level).sort((a, b) => a - b);
  const hi = levels[0];
  const mid = levels[Math.min(1, levels.length - 1)];
  const low = levels[Math.min(2, levels.length - 1)];
  const last = levels[levels.length - 1];

  // Boutons LOD existants du HUD : si niveau forcé, on le respecte aussi pour les tiles.
  const forced = getForcedLodLevel();
  if (forced != null) {
    const exact = tile.lods.find((l) => l.level === forced);
    if (exact) return exact.level;
    return nearestAvailableLod(forced, levels);
  }

  // Premier affichage : on montre toujours d'abord le LOD le plus léger pour
  // un premier rendu rapide. Le raffinement vers le HD se fait au tour suivant.
  if (tile.currentLevel == null) return last;

  const cam = state.ctx.camera;
  const d = Vector3.Distance(cam.position, tile.center);
  const r = Math.max(tile.radius, 0.001);
  const nd = d / r; // distance normalisée par le rayon de la tuile

  // Bandes de distance AVEC HYSTÉRÉSIS. Sans ça, la caméra qui tremble près
  // d'un seuil faisait recharger la tuile en boucle -> clignotement / disparitions.
  // On élargit la bande du niveau courant pour qu'il faille la dépasser nettement
  // avant de changer.
  const H = 0.35; // marge d'hystérésis (35 %)
  const T_HI = 2.0;  // sous ce ratio => niveau le plus détaillé
  const T_MID = 5.0; // sous ce ratio => niveau intermédiaire

  let wantHi = nd < T_HI;
  let wantMid = nd < T_MID;
  if (tile.currentLevel === hi) wantHi = nd < T_HI * (1 + H);
  if (tile.currentLevel === mid) wantMid = nd < T_MID * (1 + H);

  if (wantHi) return hi;
  if (wantMid) return mid;
  return low;
}

// Test sphère/frustum à partir du centre + rayon de la tuile (pas besoin que la
// tuile soit chargée). Sert à NE PAS investir de chargement HD pour des tuiles
// hors champ caméra : c'est ce qui rendait le viewer lourd sur de gros projets.
function tileInFrustum(tile: MagoTileRuntime): boolean {
  const planes = (state.ctx.scene as any).frustumPlanes;
  if (!planes || !planes.length) return true; // pas encore prêt -> on ne bloque rien
  const c = tile.center;
  const r = tile.radius * 1.2; // petite marge pour pré-charger en bord d'écran
  for (const p of planes) {
    const dist = p.normal.x * c.x + p.normal.y * c.y + p.normal.z * c.z + p.d;
    if (dist < -r) return false; // entièrement derrière ce plan -> hors champ
  }
  return true;
}

async function loadTileLevel(tile: MagoTileRuntime, level: number): Promise<void> {
  if (tile.loading || tile.currentLevel === level) return;
  const lod = tile.lods.find((l) => l.level === level);
  if (!lod || !state.magoTiles.rootHandle) return;

  tile.loading = true;
  try {
    const fh = await getFileHandleByRelativePath(state.magoTiles.rootHandle, lod.file);
    const file = await fh.getFile();
    const asset = await loadMesh(file, {
      scene: state.ctx.scene,
      onProgress: () => {},
    });

    applyLayerTransform(asset, zUpToYUpTransform());
    asset.rootNode.name = `__mago_tile_${tile.id}_LOD${level}`;
    for (const m of asset.meshes) {
      m.metadata = { ...(m.metadata ?? {}), magoTileId: tile.id, magoTileLevel: level };
      m.isPickable = true;
      // Les tiles sont destinées à la visualisation gros fichiers : on fige ce qui peut l'être
      // pour réduire le coût CPU pendant l'orbit/pan.
      try { m.freezeWorldMatrix(); } catch {}
      try { (m.material as any)?.freeze?.(); } catch {}
    }

    if (tile.asset) unloadAsset(tile.asset, state.ctx.scene);
    tile.asset = asset;
    tile.currentLevel = level;
    tile.failCount = 0;
  } catch (err) {
    console.error('Erreur chargement tile', tile.id, level, err);
    tile.failCount = (tile.failCount ?? 0) + 1;
    // Un échec ne doit plus être totalement silencieux (c'était la cause des
    // "tuiles qui ne s'affichent pas toutes"). On prévient une seule fois.
    if (!state.magoTiles.errorShown) {
      state.magoTiles.errorShown = true;
      toast(
        `Au moins une tuile n'a pas pu se charger (${tile.id} LOD${level}). ` +
        `Vérifie la console (F12) : souvent un GLB Draco + décodeur manquant.`,
        'error',
        8000,
      );
    }
  } finally {
    tile.loading = false;
    updateMagoTilesHud();
  }
}

// Décharge les tuiles résidentes les moins utiles quand on dépasse le budget
// mémoire. SANS ça, les tuiles s'accumulaient à l'infini -> saturation VRAM ->
// crash du process GPU de Chrome (écran blanc) et disparition de tout.
function evictMagoTilesIfNeeded(camPos: Vector3): void {
  const st = state.magoTiles;
  const tileBudget = Math.max(2, st.maxResidentTiles);
  const triBudget = Math.max(500_000, st.maxResidentTriangles);

  const resident = st.tiles.filter((t) => t.asset && !t.loading);
  let residentTris = 0;
  for (const t of resident) residentTris += t.asset?.triangleCount ?? 0;

  const over = () =>
    resident.filter((t) => t.asset).length > tileBudget || residentTris > triBudget;

  if (!over()) return;

  // Score d'évincabilité (grand = on évince en premier) :
  //  - tuile hors champ caméra fortement privilégiée pour l'éviction ;
  //  - sinon, la plus éloignée d'abord.
  const score = (t: MagoTileRuntime): number => {
    const d = Vector3.Distance(camPos, t.center);
    return d + (tileInFrustum(t) ? 0 : st.sceneDiagonal * 100.0);
  };
  resident.sort((a, b) => score(b) - score(a));

  for (const t of resident) {
    if (!over()) break;
    // On ne décharge jamais une tuile proche ET visible : c'est ce qu'on regarde.
    if (tileInFrustum(t) && Vector3.Distance(camPos, t.center) < t.radius * 3) continue;
    if (t.asset) {
      residentTris -= t.asset.triangleCount ?? 0;
      unloadAsset(t.asset, state.ctx.scene);
      t.asset = null;
      t.currentLevel = null;
    }
  }
  updateMagoTilesHud();
}

function updateMagoTilesByCamera(force = false): void {
  if (!state.magoTiles.enabled) return;
  const now = performance.now();
  // Throttle un peu plus réactif qu'avant (250 ms) pour un premier affichage plus rapide.
  if (!force && now - state.magoTiles.lastUpdate < 250) return;
  state.magoTiles.lastUpdate = now;

  const camPos = state.ctx.camera.position;

  // 1) Libérer la mémoire AVANT de charger du neuf.
  evictMagoTilesIfNeeded(camPos);

  const candidates: Array<{ tile: MagoTileRuntime; wanted: number; priority: number }> = [];

  for (const tile of state.magoTiles.tiles) {
    if (tile.loading) continue;
    // Tuile qui échoue en boucle : on arrête de la retenter pour ne pas bloquer
    // les slots de chargement des autres.
    if ((tile.failCount ?? 0) >= 3) continue;

    const inView = tileInFrustum(tile);
    let wanted = chooseMagoTileLevel(tile);
    if (wanted == null) continue;

    // Hors champ caméra : on n'investit JAMAIS dans le HD.
    // - tuile pas encore affichée -> on la charge au plus léger (pour quand on se retourne) ;
    // - tuile déjà affichée -> on la laisse telle quelle (pas de déchargement brutal).
    if (!inView) {
      if (tile.currentLevel != null) continue;
      wanted = tile.lods[tile.lods.length - 1].level; // le plus léger
    }

    if (wanted === tile.currentLevel) continue;

    const d = Vector3.Distance(camPos, tile.center);
    const initial = tile.currentLevel == null;
    const refiningToHeavy = wanted < (tile.currentLevel ?? 999);

    // Priorité (plus petit = plus urgent) :
    // 1) afficher d'abord TOUTES les tuiles visibles, même en léger ;
    // 2) ensuite raffiner les tuiles visibles proches ;
    // 3) les tuiles hors champ passent après tout le reste.
    let priority = d;
    if (initial) priority -= state.magoTiles.sceneDiagonal * 10.0;
    else if (refiningToHeavy) priority += 0;
    else priority += state.magoTiles.sceneDiagonal * 3.0;
    if (!inView) priority += state.magoTiles.sceneDiagonal * 50.0;

    candidates.push({ tile, wanted, priority });
  }

  candidates.sort((a, b) => a.priority - b.priority);

  let activeLoads = state.magoTiles.tiles.filter((t) => t.loading).length;
  for (const c of candidates) {
    if (activeLoads >= state.magoTiles.maxConcurrentLoads) break;
    activeLoads++;
    loadTileLevel(c.tile, c.wanted);
  }
}

function updateMagoTilesHud(): void {
  if (!state.magoTiles.enabled) return;
  const title = document.querySelector('#lod-hud .lod-title');
  const current = document.getElementById('lod-current');
  const detail = document.getElementById('lod-detail');
  const levelsDetail = document.getElementById('lod-levels-detail');
  const loaded = state.magoTiles.tiles.filter((t) => t.asset).length;
  const byLevel = new Map<number, number>();
  for (const t of state.magoTiles.tiles) {
    if (t.currentLevel != null) byLevel.set(t.currentLevel, (byLevel.get(t.currentLevel) ?? 0) + 1);
  }
  if (title) title.textContent = 'MAGO Tiles';
  if (current) current.textContent = `${loaded}/${state.magoTiles.tiles.length} tiles chargées`;
  if (detail) detail.textContent = `Scène tuilée · ${state.magoTiles.name} · mode visualisation`;
  if (levelsDetail) {
    const parts = Array.from(byLevel.entries()).sort((a, b) => a[0] - b[0]).map(([l, n]) => `LOD${l}: ${n}`);
    levelsDetail.textContent = parts.length ? parts.join(' · ') : 'Chargement des tuiles…';
  }
}

// =================================================================
//  FILE HANDLING
// =================================================================

async function handleFile(file: File, kind: 'mesh' | 'splat'): Promise<void> {
  // Si un objet principal de ce type existe déjà, on ajoute le nouveau comme objet
  // supplémentaire au lieu d'écraser le travail en cours. Pour remplacer, supprime
  // d'abord l'objet dans la liste.
  if (state.assets[kind]) {
    await handleAdditionalAssetFile(file, kind);
    return;
  }
  // L'UI "Import" compacte n'a plus de bloc status-mesh / status-splat dédié :
  // on retombe sur le status-auto partagé. On garde des accès tolérants au null
  // pour ne jamais faire planter le chargement (c'était la cause du "rien ne se passe").
  const statusEl =
    document.getElementById(`status-${kind}`) ?? document.getElementById('status-auto');
  const toggleEl = document.getElementById(`toggle-${kind}`) as HTMLInputElement | null;
  const countEl = document.getElementById(`count-${kind}`);

  if (statusEl) {
    statusEl.textContent = `${file.name} · chargement…`;
    statusEl.className = 'drop-status';
  }
  setStatus(`chargement ${kind}…`);
  showProgress(0, `Lecture ${file.name}`);

  // Dispose ancien asset
  const existing = state.assets[kind];
  if (existing) {
    if (kind === 'mesh') {
      clearMeshSelection();
      state.meshEditor.undoStack = [];
      state.meshEditor.hiddenTriangles = [];
      state.meshEditor.triangleCache.clear();
      state.meshEditor.selectionToken++;
      resetMeshLodState();
      updateMeshEditorStats();
    }
    unloadAsset(existing, state.ctx.scene);
    state.assets[kind] = null;
  }

  try {
    const loader = kind === 'mesh' ? loadMesh : loadSplats;
    const asset = await loader(file, {
      scene: state.ctx.scene,
      onProgress: (loaded, total) => {
        const pct = total > 0 ? (loaded / total) * 100 : 0;
        showProgress(pct, `${file.name} · ${formatBytes(loaded)}${total ? ' / ' + formatBytes(total) : ''}`);
      },
    });

    state.assets[kind] = asset;
    state.originalFiles[kind] = file;
    // La transformation d'un fichier appartient à CE fichier : on ne ré-applique
    // jamais silencieusement celle de l'objet précédent (c'était la cause des
    // exports cuits rechargés qui « partaient ailleurs »). Un nouveau fichier
    // reçoit la valeur par défaut (Z-up → Y-up), sauf si une configuration de
    // scène importée est en attente pour ce type.
    let pendingTf = state.pendingConfigTransforms[kind];
    state.pendingConfigTransforms[kind] = null;
    if (pendingTf && /aligned|bake|client_scene/i.test(file.name)) {
      toast(`« ${file.name} » semble déjà cuit (export aligné) : la transformation du scene_config est ignorée pour lui. Charge le fichier d'origine si tu voulais l'appliquer.`, 'warn', 9000);
      pendingTf = null;
    }
    // Convention MAGO : les exports splats cuits sont écrits en Z-up (comme les
    // exports mesh) — ils rechargent donc avec la conversion par défaut ci-dessous,
    // exactement comme un fichier d'origine. Ne PAS les charger « à l'identité ».
    state.transforms[kind] = pendingTf ?? zUpToYUpTransform();
    writeTransformToInputs(kind, state.transforms[kind]);
    applyLayerTransform(asset, state.transforms[kind]);

    if (kind === 'mesh') {
      clearMeshSelection();
      state.meshEditor.undoStack = [];
      state.meshEditor.hiddenTriangles = [];
      state.meshEditor.triangleCache.clear();
      state.meshEditor.selectionToken++;
      updateMeshEditorStats();
      setupMeshLodFromLoadedAsset(asset);
      applyMeshVisibilityFromState();
      // Prépare les centroïdes de triangles en arrière-plan : la première sélection mesh
      // est beaucoup plus rapide sur les gros GLB/PLY.
      warmMeshTriangleCacheAsync();
    }

    if (kind === 'splat') {
      const splatData = await initialiseSplatEditor(file);
      (asset as any).splatPlyData = splatData;
    }

    if (statusEl) {
      statusEl.textContent = `${file.name} · chargé`;
      statusEl.className = 'drop-status loaded';
    }
    if (toggleEl) {
      toggleEl.disabled = false;
      toggleEl.checked = true;
    }
    if (countEl) {
      countEl.textContent = kind === 'splat'
        ? `${formatNumber(asset.splatCount)} splats`
        : `${formatNumber(asset.triangleCount)} tris`;
    }

    if (kind === 'mesh') {
      applyMeshSettings();
      renderMeshSubLayerList();
      // Crée/retrouve le modèle d'enrichissement nommé d'après le fichier,
      // puis restaure les attributs éventuellement embarqués dans les extras du GLB.
      await enrichment.setModelFromFile(file.name);
      if (!isClientMode()) {
        const importedAttributes = await enrichment.importEmbeddedAttributes(asset);
        if (importedAttributes > 0) {
          toast(`${importedAttributes} attribut(s) sémantique(s) restauré(s) depuis le GLB.`);
        }
      } else {
        // En mode client, les valeurs affichées/éditées doivent venir de PostgreSQL.
        // On n'importe pas les extras du GLB, sinon une ancienne valeur embarquée
        // pourrait réécraser la BDD à chaque ouverture du lien client.
        console.info('[enrichment] Mode client : import des attributs GLB ignoré, BDD prioritaire.');
      }
    }

    // Recadrer systématiquement après un nouvel import : évite le cas où
    // un mesh supprimé puis réimporté est hors caméra ou loin du nuage.
    frameScene(state.ctx.camera, getAllAssets(), false);
    updateBboxInfo();
    renderSceneObjectList();

    hideProgress();
    setStatus('prêt');
    toast(`${kind === 'mesh' ? 'Mesh' : 'Splats'} chargé : ${file.name}`);
  } catch (err: any) {
    console.error(err);
    if (statusEl) {
      statusEl.textContent = `Erreur : ${err.message ?? err}`;
      statusEl.className = 'drop-status error';
    }
    setStatus('erreur');
    hideProgress();
    toast(`Échec du chargement : ${err.message ?? err}`, 'error', 6000);
  }
}


async function detectPlyContentKind(file: File): Promise<'splat' | 'mesh' | 'pointcloud'> {
  const maxBytes = Math.min(file.size, 1024 * 512);
  const buf = await file.slice(0, maxBytes).arrayBuffer();
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const end = text.toLowerCase().indexOf('end_header');
  const header = end >= 0 ? text.slice(0, end) : text;
  if (/property\s+\w+\s+f_dc_0/i.test(header) || /property\s+\w+\s+opacity/i.test(header)) return 'splat';
  const face = header.match(/element\s+face\s+(\d+)/i);
  if (face && Number(face[1]) > 0) return 'mesh';
  return 'pointcloud';
}

async function handleDroppedFile(file: File, target: 'mesh' | 'splat' | 'auto'): Promise<void> {
  if (target === 'mesh') return handleFile(file, 'mesh');
  if (target === 'splat') return handleFile(file, 'splat');
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'splat' || ext === 'spz') return handleFile(file, 'splat');
  if (ext === 'json' && file.name.toLowerCase() === 'scene_tiles.json') {
    toast('Pour charger une scène tuilée, clique sur + MAGO Tiles et sélectionne le dossier qui contient scene_tiles.json et tiles/.', 'warn', 6000);
    return;
  }
  if (ext === 'glb' || ext === 'gltf' || ext === 'obj') return handleFile(file, 'mesh');
  if (ext === 'ply') {
    const detected = await detectPlyContentKind(file);
    if (detected === 'splat') return handleFile(file, 'splat');
    if (detected === 'mesh') return handleFile(file, 'mesh');
    return handlePointCloudFile(file);
  }
  toast(`Format non reconnu : ${file.name}`, 'warn');
}

async function handleAdditionalAssetFile(file: File, kind: 'mesh' | 'splat'): Promise<void> {
  const statusEl = document.getElementById('status-auto') ?? document.getElementById(`status-${kind}`)!;
  statusEl.textContent = `${file.name} · ajout…`;
  setStatus(`ajout ${kind}…`);
  showProgress(0, `Lecture ${file.name}`);
  try {
    const loader = kind === 'mesh' ? loadMesh : loadSplats;
    const asset = await loader(file, {
      scene: state.ctx.scene,
      onProgress: (loaded, total) => {
        const pct = total > 0 ? (loaded / total) * 100 : 0;
        showProgress(pct, `${file.name} · ${formatBytes(loaded)}${total ? ' / ' + formatBytes(total) : ''}`);
      },
    });
    applyLayerTransform(asset, state.transforms[kind]);
    if (kind === 'splat') {
      await attachSplatPickingData(asset, file);
    }
    state.extraAssets.push(asset);
    state.selectedObjectUid = (asset.rootNode as any).uniqueId;
    statusEl.textContent = `${file.name} · ajouté`;
    frameScene(state.ctx.camera, getAllAssets(), false);
    hideProgress();
    setStatus('prêt');
    renderSceneObjectList();
    updateBboxInfo();
    toast(`${kind === 'mesh' ? 'Mesh' : 'Splats'} ajouté : ${file.name}`);
  } catch (err: any) {
    console.error(err);
    statusEl.textContent = `Erreur : ${err.message ?? err}`;
    hideProgress();
    setStatus('erreur');
    toast(`Échec de l'ajout : ${err.message ?? err}`, 'error', 6000);
  }
}

async function handlePointCloudFile(file: File): Promise<void> {
  const statusEl = document.getElementById('status-auto');
  if (statusEl) statusEl.textContent = `${file.name} · chargement nuage…`;
  setStatus('chargement nuage…');
  showProgress(0, `Lecture ${file.name}`);
  try {
    const asset = await loadPointCloud(file, {
      scene: state.ctx.scene,
      onProgress: (loaded, total) => {
        const pct = total > 0 ? (loaded / total) * 100 : 0;
        showProgress(pct, `${file.name} · ${formatBytes(loaded)}${total ? ' / ' + formatBytes(total) : ''}`);
      },
    });
    applyLayerTransform(asset as any, zUpToYUpTransform());
    (asset as any).sourceFile = file; // conservé pour la publication de la vue client
    state.extraAssets.push(asset);
    state.selectedObjectUid = (asset.rootNode as any).uniqueId;
    if (statusEl) statusEl.textContent = `${file.name} · nuage chargé`;
    frameScene(state.ctx.camera, getAllAssets(), false);
    hideProgress();
    setStatus('prêt');
    renderSceneObjectList();
    updateBboxInfo();
    frameScene(state.ctx.camera, getAllAssets(), false);
    toast(`Nuage chargé : ${file.name}`);
  } catch (err: any) {
    console.error(err);
    if (statusEl) statusEl.textContent = `Erreur : ${err.message ?? err}`;
    hideProgress();
    setStatus('erreur');
    toast(`Échec du chargement nuage : ${err.message ?? err}`, 'error', 6000);
  }
}

// =================================================================
//  ALIGNEMENT PAR POINT PICKING (STYLE CLOUDCOMPARE)
// =================================================================

function bindPointAlignmentControls(): void {
  const sourceSelect = document.getElementById('align-source-kind') as HTMLSelectElement | null;
  const targetSelect = document.getElementById('align-target-kind') as HTMLSelectElement | null;
  const applyCheck = document.getElementById('align-apply-source') as HTMLInputElement | null;
  const scaleModeSelect = document.getElementById('align-scale-mode') as HTMLSelectElement | null;
  const scaleManualInput = document.getElementById('align-scale-manual') as HTMLInputElement | null;
  const scaleManualRow = document.getElementById('align-scale-manual-row') as HTMLElement | null;
  const hideSourceCheck = document.getElementById('align-hide-source') as HTMLInputElement | null;
  const hideTargetCheck = document.getElementById('align-hide-target') as HTMLInputElement | null;
  const matrixFileInput = document.getElementById('file-align-matrix') as HTMLInputElement | null;

  const sync = () => {
    if (sourceSelect) state.alignment.sourceKind = sourceSelect.value as AlignableKind;
    if (targetSelect) state.alignment.targetKind = targetSelect.value as AlignableKind;
    if (applyCheck) state.alignment.applyToSource = applyCheck.checked;
    if (scaleModeSelect) state.alignment.scaleMode = scaleModeSelect.value as 'keep' | 'estimate' | 'manual';
    if (scaleManualInput) {
      const v = parseFloat(scaleManualInput.value);
      state.alignment.manualScale = Number.isFinite(v) && v > 1e-6 ? v : 1;
    }
    if (scaleManualRow) scaleManualRow.style.display = state.alignment.scaleMode === 'manual' ? '' : 'none';
    if (hideSourceCheck) state.alignment.hideSourceDuringPick = hideSourceCheck.checked;
    if (hideTargetCheck) state.alignment.hideTargetDuringPick = hideTargetCheck.checked;
    // Si le picking est déjà actif, applique tout de suite le masquage choisi.
    if (state.alignment.active) applyPickVisibility();
    updateAlignmentUI();
  };
  sourceSelect?.addEventListener('change', sync);
  targetSelect?.addEventListener('change', sync);
  applyCheck?.addEventListener('change', sync);
  scaleModeSelect?.addEventListener('change', sync);
  scaleManualInput?.addEventListener('change', sync);
  scaleManualInput?.addEventListener('input', sync);
  hideSourceCheck?.addEventListener('change', sync);
  hideTargetCheck?.addEventListener('change', sync);
  sync();

  document.getElementById('btn-align-toggle')?.addEventListener('click', () => {
    setPointAlignmentActive(!state.alignment.active);
  });
  document.getElementById('btn-align-undo')?.addEventListener('click', () => undoLastAlignmentStep());
  document.getElementById('btn-align-clear')?.addEventListener('click', () => clearPointAlignment());
  document.getElementById('btn-align-solve')?.addEventListener('click', () => solvePointAlignment(true));
  document.getElementById('btn-align-import-matrix')?.addEventListener('click', () => matrixFileInput?.click());
  matrixFileInput?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) await importAlignmentMatrixFile(file);
    input.value = '';
  });
  document.getElementById('btn-align-export-matrix')?.addEventListener('click', () => exportAlignmentMatrix());
  document.getElementById('btn-align-copy-matrix')?.addEventListener('click', () => copyAlignmentMatrix());

  const canvas = state.ctx.engine.getRenderingCanvas();
  canvas?.addEventListener('pointerdown', (ev) => {
    if (!state.alignment.active) return;
    if (ev.button !== 0) return;
    const target = ev.target as HTMLElement | null;
    if (target && target.closest('#tools-dropdown, #sidebar-left, #toolbar')) return;
    ev.preventDefault();
    ev.stopPropagation();
    handleAlignmentPick(ev);
  }, true);
}

/**
 * Applique (ou retire) le masquage temporaire de la source / référence pendant
 * le piquage des points, pour éviter que les deux objets superposés gênent.
 * L'objet que l'on s'apprête à cliquer reste TOUJOURS visible (sinon impossible
 * de le piquer) : le masquage ne concerne donc que l'autre objet selon l'étape.
 * On mémorise l'état de visibilité d'origine pour le restaurer ensuite.
 */
function applyPickVisibility(): void {
  const al = state.alignment;
  const source = getAlignmentAsset(al.sourceKind);
  const target = getAlignmentAsset(al.targetKind);

  // Étape courante : on s'apprête à cliquer SOURCE ou CIBLE ?
  const pickingSource = al.waitingFor === 'source';

  // On masque uniquement l'objet qui n'est PAS en cours de piquage,
  // et seulement si l'option correspondante est cochée.
  const shouldHideSource = al.hideSourceDuringPick && !pickingSource;
  const shouldHideTarget = al.hideTargetDuringPick && pickingSource;

  // Restaure d'abord tout objet précédemment masqué.
  restorePickVisibility();

  const backup = new Map<LoadedAsset, boolean>();
  if (source && shouldHideSource) {
    backup.set(source, isAssetTreeVisible(source));
    setAssetTreeVisible(source, false);
  }
  if (target && shouldHideTarget && target !== source) {
    backup.set(target, isAssetTreeVisible(target));
    setAssetTreeVisible(target, false);
  }
  al._pickVisBackup = backup;
  renderSceneObjectList();
}

/** Restaure la visibilité d'origine des objets masqués pendant le piquage. */
function restorePickVisibility(): void {
  const al = state.alignment;
  if (!al._pickVisBackup) return;
  for (const [asset, prev] of al._pickVisBackup) {
    setAssetTreeVisible(asset, prev);
  }
  al._pickVisBackup = undefined;
  renderSceneObjectList();
}

function setPointAlignmentActive(active: boolean): void {
  state.alignment.active = active;
  if (active) {
    setMeshSelectionActive(false);
    setLassoActive(false);
    if (state.measure.isActive()) toggleMeasure();
    state.alignment.waitingFor = state.alignment.currentSource ? 'target' : 'source';
    applyPickVisibility();
    toast('Alignement activé : clique un point SOURCE puis le point CIBLE correspondant. Minimum 3 paires pour une matrice rigide.', 'info', 6000);
  } else {
    restorePickVisibility();
    toast('Alignement désactivé.');
  }
  updateAlignmentUI();
}

function handleAlignmentPick(ev: PointerEvent): void {
  const al = state.alignment;
  const kind = al.waitingFor === 'source' ? al.sourceKind : al.targetKind;
  const picked = pickAlignmentPoint(kind, ev.clientX, ev.clientY, al.waitingFor);
  if (!picked) {
    toast(`Aucun point ${al.waitingFor === 'source' ? 'source' : 'cible'} détecté. Vérifie que le calque est visible.`, 'warn', 3000);
    return;
  }

  if (al.waitingFor === 'source') {
    if (al.currentSource) disposeAlignmentPickedPoint(al.currentSource);
    al.currentSource = picked;
    al.waitingFor = 'target';
    toast('Point source pris. Clique maintenant le point cible correspondant.');
  } else {
    if (!al.currentSource) {
      disposeAlignmentPickedPoint(picked);
      al.waitingFor = 'source';
      updateAlignmentUI();
      return;
    }
    al.pairs.push({ source: al.currentSource, target: picked });
    al.currentSource = null;
    al.waitingFor = 'source';
    toast(`Paire ${al.pairs.length} ajoutée.`);
  }
  al.lastMatrix = null;
  al.lastMatrixAppliedToSource = false;
  al.lastMatrixSourceUid = null;
  if (al.active) applyPickVisibility();
  updateAlignmentUI();
}

function getSelectedOrPrimaryAsset(kind: AlignableKind): LoadedAsset | null {
  const selected = state.selectedObjectUid != null
    ? getSceneObjectEntries().find((e) => e.uid === state.selectedObjectUid && e.kind === kind)?.asset ?? null
    : null;
  if (selected) return selected;
  if (kind === 'mesh') return state.assets.mesh ?? state.extraAssets.find((a) => a.kind === 'mesh') ?? null;
  if (kind === 'splat') return state.assets.splat ?? state.extraAssets.find((a) => a.kind === 'splat') ?? null;
  return state.extraAssets.find((a) => a.kind === 'pointcloud' && isAssetTreeVisible(a))
    ?? state.extraAssets.find((a) => a.kind === 'pointcloud')
    ?? null;
}

function getAlignmentAsset(kind: AlignableKind): LoadedAsset | null {
  return getSelectedOrPrimaryAsset(kind);
}

function pickAlignmentPoint(kind: AlignableKind, clientX: number, clientY: number, role: 'source' | 'target'): AlignmentPickedPoint | null {
  if (kind === 'splat') return pickSplatAlignmentPoint(clientX, clientY, role);
  const asset = getAlignmentAsset(kind);
  if (!asset) return null;
  if (asset.kind === 'pointcloud') return pickPointCloudAlignmentPoint(asset, clientX, clientY, role);
  return pickMeshAlignmentPoint(asset, kind, role);
}

function pickMeshAlignmentPoint(asset: LoadedAsset, kind: AlignableKind, role: 'source' | 'target'): AlignmentPickedPoint | null {
  const meshSet = new Set(asset.meshes);
  const pick = state.ctx.scene.pick(
    state.ctx.scene.pointerX,
    state.ctx.scene.pointerY,
    (m) => meshSet.has(m) && m.isEnabled() && m.isVisible && m.isPickable !== false
  );
  if (!pick?.hit || !pick.pickedPoint) return null;

  const root = asset.rootNode as TransformNode;
  const invRoot = root.getWorldMatrix().clone();
  invRoot.invert();
  const local = Vector3.TransformCoordinates(pick.pickedPoint, invRoot);
  return {
    kind,
    local,
    world: pick.pickedPoint.clone(),
    marker: createAlignmentMarker(pick.pickedPoint, role),
  };
}

/**
 * Convertit une position curseur (clientX/clientY, en pixels CSS) vers l'espace
 * pixels de rendu utilisé par viewport.toGlobal(getRenderWidth/Height).
 * Indispensable : avec setHardwareScalingLevel (render scale < 100%) ou un
 * devicePixelRatio ≠ 1, la taille CSS du canvas et sa résolution de rendu
 * diffèrent. Sans cette conversion, la projection des points (nuage/splats)
 * ne tombait jamais sous le seuil de tolérance et le clic semblait "ne rien faire".
 */
function clientToRenderPixels(clientX: number, clientY: number): { x: number; y: number; scaleX: number } | null {
  const canvas = state.ctx.engine.getRenderingCanvas();
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const scaleX = state.ctx.engine.getRenderWidth() / rect.width;
  const scaleY = state.ctx.engine.getRenderHeight() / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
    scaleX,
  };
}

function pickPointCloudAlignmentPoint(asset: LoadedAsset, clientX: number, clientY: number, role: 'source' | 'target'): AlignmentPickedPoint | null {
  const pointMesh = asset.meshes[0] as Mesh | undefined;
  if (!pointMesh) return null;
  const raw = pointMesh.getVerticesData('position');
  if (!raw || raw.length < 3) return null;

  const cursor = clientToRenderPixels(clientX, clientY);
  if (!cursor) return null;
  const x = cursor.x;
  const y = cursor.y;
  // Tolérance en pixels de rendu : un nuage est clairsemé, on accepte un rayon
  // un peu plus large (~22px CSS) pour faciliter le clic.
  const tol = 22 * Math.max(1, cursor.scaleX);
  const world = pointMesh.getWorldMatrix();
  const rootWorld = (asset.rootNode as TransformNode).getWorldMatrix();
  const invRoot = rootWorld.clone();
  invRoot.invert();
  const transform = state.ctx.scene.getTransformMatrix();
  const viewport = state.ctx.scene.activeCamera!.viewport.toGlobal(
    state.ctx.engine.getRenderWidth(),
    state.ctx.engine.getRenderHeight()
  );

  let bestLocal: Vector3 | null = null;
  let bestWorld: Vector3 | null = null;
  let bestD2 = tol * tol;
  const count = Math.floor(raw.length / 3);
  const step = count > 1500000 ? 3 : count > 700000 ? 2 : 1;
  for (let i = 0; i < count; i += step) {
    const localPoint = new Vector3(raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]);
    const worldPoint = Vector3.TransformCoordinates(localPoint, world);
    const screen = Vector3.Project(worldPoint, Matrix.Identity(), transform, viewport);
    if (screen.z < 0 || screen.z > 1) continue;
    const dx = screen.x - x;
    const dy = screen.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestWorld = worldPoint;
      bestLocal = Vector3.TransformCoordinates(worldPoint, invRoot);
    }
  }
  if (!bestLocal || !bestWorld) return null;
  return { kind: 'pointcloud', local: bestLocal, world: bestWorld, marker: createAlignmentMarker(bestWorld, role) };
}

function pickSplatAlignmentPoint(clientX: number, clientY: number, role: 'source' | 'target'): AlignmentPickedPoint | null {
  const asset = getAlignmentAsset('splat');
  if (!asset) return null;

  const data = ((asset as any).splatPlyData as SplatPlyData | null | undefined)
    ?? (asset === state.assets.splat ? state.splatEditor.data : null);
  if (!data) return null;

  const cursor = clientToRenderPixels(clientX, clientY);
  if (!cursor) return null;
  const x = cursor.x;
  const y = cursor.y;

  const root = asset.rootNode as TransformNode;
  root.computeWorldMatrix(true);
  const world = root.getWorldMatrix?.() ?? Matrix.Identity();
  const transform = state.ctx.scene.getTransformMatrix();
  const viewport = state.ctx.scene.activeCamera!.viewport.toGlobal(
    state.ctx.engine.getRenderWidth(),
    state.ctx.engine.getRenderHeight()
  );

  const tmp = Vector3.Zero();
  let best = -1;
  // Rayon volontairement plus large que pour un mesh : on clique sur des splats,
  // pas sur des triangles. Le facteur render scale est déjà inclus par clientToRenderPixels.
  let bestD2 = (30 * Math.max(1, cursor.scaleX)) ** 2;
  const visible = asset === state.assets.splat
    ? (state.splatEditor.visibleMask ?? state.splatEditor.baseMask)
    : null;
  const step = data.vertexCount > 5000000 ? 5 : data.vertexCount > 2500000 ? 3 : 1;

  for (let i = 0; i < data.vertexCount; i += step) {
    if (visible && !visible[i]) continue;
    tmp.set(data.x[i], data.y[i], data.z[i]);
    const worldPos = Vector3.TransformCoordinates(tmp, world);
    const screen = Vector3.Project(worldPos, Matrix.Identity(), transform, viewport);
    if (screen.z < 0 || screen.z > 1) continue;
    const dx = screen.x - x;
    const dy = screen.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = i;
    }
  }

  if (best < 0) return null;
  const local = new Vector3(data.x[best], data.y[best], data.z[best]);
  const worldPos = Vector3.TransformCoordinates(local, world);
  return { kind: 'splat', local, world: worldPos, marker: createAlignmentMarker(worldPos, role) };
}

function createAlignmentMarker(position: Vector3, role: 'source' | 'target'): Mesh {
  const marker = MeshBuilder.CreateSphere(`align_${role}_${Date.now()}`, { diameter: role === 'source' ? 0.055 : 0.075, segments: 12 }, state.ctx.scene);
  marker.position.copyFrom(position);
  marker.isPickable = false;
  const mat = new StandardMaterial(`mat_align_${role}_${Date.now()}`, state.ctx.scene);
  mat.emissiveColor = role === 'source' ? new Color3(1, 0.8, 0) : new Color3(0.0, 0.8, 1.0);
  mat.diffuseColor = mat.emissiveColor;
  marker.material = mat;
  return marker;
}

function disposeAlignmentPickedPoint(p: AlignmentPickedPoint): void {
  p.marker.dispose(false, true);
}

function clearPointAlignment(): void {
  const al = state.alignment;
  if (al.currentSource) disposeAlignmentPickedPoint(al.currentSource);
  for (const pair of al.pairs) {
    disposeAlignmentPickedPoint(pair.source);
    disposeAlignmentPickedPoint(pair.target);
  }
  al.currentSource = null;
  al.pairs = [];
  al.lastMatrix = null;
  al.lastMatrixAppliedToSource = false;
  al.lastMatrixSourceUid = null;
  (al as any).lastResidualStats = undefined;
  al.waitingFor = 'source';
  updateAlignmentUI();
  toast('Points d’alignement effacés.');
}

function undoLastAlignmentStep(): void {
  const al = state.alignment;
  if (al.currentSource) {
    disposeAlignmentPickedPoint(al.currentSource);
    al.currentSource = null;
    al.waitingFor = 'source';
  } else if (al.pairs.length > 0) {
    const pair = al.pairs.pop()!;
    disposeAlignmentPickedPoint(pair.source);
    disposeAlignmentPickedPoint(pair.target);
  }
  al.lastMatrix = null;
  al.lastMatrixAppliedToSource = false;
  al.lastMatrixSourceUid = null;
  (al as any).lastResidualStats = undefined;
  updateAlignmentUI();
}

function solvePointAlignment(showToast = true): number[][] | null {
  const al = state.alignment;
  if (al.pairs.length < 1) {
    toast('Ajoute au moins une paire source/cible.', 'warn');
    return null;
  }
  if (al.pairs.length > 1 && al.pairs.length < 3) {
    toast('Pour une rotation fiable, ajoute 3 paires. Avec 1 paire, seule une translation est calculée.', 'warn', 5000);
    return null;
  }

  // On calcule maintenant la transformation sur les coordonnées MONDE des points pickés.
  // C'est plus cohérent visuellement quand source/cible ont déjà des rotations, un Z-up→Y-up
  // automatique, ou des transformations manuelles. L'ancienne version travaillait en local
  // source/cible et pouvait produire une matrice correcte mathématiquement mais étrange à appliquer.
  const src = al.pairs.map((p) => p.source.world);
  const dst = al.pairs.map((p) => p.target.world);
  let matrix: number[][] | null;
  if (src.length === 1) {
    matrix = estimateTranslationMatrix(src[0], dst[0]);
  } else {
    // L'échelle est estimée par Umeyama uniquement en mode "estimate".
    matrix = estimateSimilarityUmeyama(src, dst, al.scaleMode === 'estimate');
    // En mode "manual", on impose le facteur saisi par-dessus la rotation rigide.
    if (matrix && al.scaleMode === 'manual') {
      matrix = reapplyManualScale(matrix, dst, al.manualScale);
    }
  }
  if (!matrix) {
    toast('Calcul impossible : les points sont peut-être alignés ou trop proches.', 'error', 5000);
    return null;
  }

  (al as any).lastResidualStats = computeAlignmentResidualStats(matrix, src, dst);
  const sourceUid = (getAlignmentAsset(al.sourceKind)?.rootNode as any)?.uniqueId ?? null;
  al.lastMatrix = matrix;
  al.lastMatrixSourceUid = sourceUid;
  if (al.applyToSource) {
    applyAlignmentMatrixToSource(matrix);
    al.lastMatrixAppliedToSource = true;
  } else {
    al.lastMatrixAppliedToSource = false;
  }
  updateAlignmentUI();
  if (showToast) {
    const sc = al.scaleMode === 'estimate' ? extractUniformScale(matrix)
      : al.scaleMode === 'manual' ? al.manualScale : 1;
    const scaleNote = al.scaleMode === 'keep' ? '' : ` · échelle ×${sc.toFixed(4)}`;
    toast('Matrice calculée' + (al.applyToSource ? ' et appliquée à la source.' : '.') + scaleNote);
  }
  return matrix;
}

/** Facteur d'échelle uniforme moyen extrait du bloc 3x3 d'une matrice. */
function extractUniformScale(m: number[][]): number {
  const cx = Math.hypot(m[0][0], m[1][0], m[2][0]);
  const cy = Math.hypot(m[0][1], m[1][1], m[2][1]);
  const cz = Math.hypot(m[0][2], m[1][2], m[2][2]);
  return (cx + cy + cz) / 3;
}

/**
 * Réimpose un facteur d'échelle uniforme manuel sur une matrice rigide.
 * On garde la rotation telle quelle, on multiplie par le facteur, puis on
 * recalcule la translation pour que le centroïde source reste aligné sur le
 * centroïde cible (sinon l'échelle déplacerait l'objet).
 */
function reapplyManualScale(rigid: number[][], dst: Vector3[], factor: number): number[][] {
  const s = Number.isFinite(factor) && factor > 1e-6 ? factor : 1;
  // Rotation pure normalisée à partir du bloc 3x3 (qui est déjà une rotation ici).
  const R = [
    [rigid[0][0], rigid[0][1], rigid[0][2]],
    [rigid[1][0], rigid[1][1], rigid[1][2]],
    [rigid[2][0], rigid[2][1], rigid[2][2]],
  ];
  // Centroïde cible
  const md = new Vector3(0, 0, 0);
  for (const d of dst) md.addInPlace(d);
  md.scaleInPlace(1 / dst.length);
  // On veut : pour le centroïde source ms, s·R·ms + t = md  ⇒ t = md - s·R·ms.
  // On retrouve ms depuis la matrice rigide d'origine : t0 = md - R·ms ⇒ R·ms = md - t0.
  const t0 = new Vector3(rigid[0][3], rigid[1][3], rigid[2][3]);
  const Rms = md.subtract(t0);              // = R·ms
  const sRms = Rms.scale(s);                // = s·R·ms
  const t = md.subtract(sRms);
  const sR = R.map((row) => row.map((v) => v * s));
  return [
    [sR[0][0], sR[0][1], sR[0][2], t.x],
    [sR[1][0], sR[1][1], sR[1][2], t.y],
    [sR[2][0], sR[2][1], sR[2][2], t.z],
    [0, 0, 0, 1],
  ];
}

function estimateTranslationMatrix(src: Vector3, dst: Vector3): number[][] {
  const d = dst.subtract(src);
  return [
    [1, 0, 0, d.x],
    [0, 1, 0, d.y],
    [0, 0, 1, d.z],
    [0, 0, 0, 1],
  ];
}

/**
 * Estimation de transformation par l'algorithme d'Umeyama (least-squares).
 * Calcule rotation + translation à partir de N paires (N ≥ 3), et en option
 * un facteur d'échelle uniforme (transformation de similarité). C'est la même
 * famille de méthode que l'alignement par points de CloudCompare.
 * - withScale=false → transformation rigide (rotation + translation), échelle = 1.
 * - withScale=true  → similarité (rotation + translation + échelle uniforme),
 *   utile quand le mesh et le nuage ne sont pas exactement à la même échelle.
 * Renvoie une matrice 4x4 (lignes) qui mappe les points source vers la cible.
 */
function estimateSimilarityUmeyama(src: Vector3[], dst: Vector3[], withScale: boolean): number[][] | null {
  const n = Math.min(src.length, dst.length);
  if (n < 3) return null;

  // Centroïdes
  const muSrc = new Vector3(0, 0, 0);
  const muDst = new Vector3(0, 0, 0);
  for (let i = 0; i < n; i++) { muSrc.addInPlace(src[i]); muDst.addInPlace(dst[i]); }
  muSrc.scaleInPlace(1 / n);
  muDst.scaleInPlace(1 / n);

  // Matrice de covariance H = (1/n) Σ (dst-µDst) (src-µSrc)^T  et variance source
  const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let srcVar = 0;
  for (let i = 0; i < n; i++) {
    const s = src[i].subtract(muSrc);
    const d = dst[i].subtract(muDst);
    srcVar += s.lengthSquared();
    const sa = s.asArray();
    const da = d.asArray();
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) H[r][c] += da[r] * sa[c];
  }
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) H[r][c] /= n;
  srcVar /= n;

  const svd = svd3x3(H);
  if (!svd) return null;
  const { U, S, V } = svd;

  // R = U * diag(1,1,d) * V^T, avec d = sign(det(U·V^T)) pour éviter une réflexion.
  const detUVt = det3(matMul3(U, transpose3(V)));
  const D = [[1, 0, 0], [0, 1, 0], [0, 0, detUVt < 0 ? -1 : 1]];
  const R = matMul3(matMul3(U, D), transpose3(V));

  // Échelle uniforme (Umeyama) : s = trace(D·S) / variance_source.
  let scale = 1;
  if (withScale) {
    const traceDS = S[0] * D[0][0] + S[1] * D[1][1] + S[2] * D[2][2];
    scale = srcVar > 1e-12 ? traceDS / srcVar : 1;
    if (!Number.isFinite(scale) || scale <= 1e-6) scale = 1;
  }

  // t = µDst - s·R·µSrc
  const sR = R.map((row) => row.map((v) => v * scale));
  const rotMu = applyRotationToVector(sR, muSrc);
  const t = muDst.subtract(rotMu);

  return [
    [sR[0][0], sR[0][1], sR[0][2], t.x],
    [sR[1][0], sR[1][1], sR[1][2], t.y],
    [sR[2][0], sR[2][1], sR[2][2], t.z],
    [0, 0, 0, 1],
  ];
}

// --- Petites primitives matricielles 3x3 ---
function transpose3(m: number[][]): number[][] {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}
function matMul3(a: number[][], b: number[][]): number[][] {
  const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
  }
  return r;
}
function det3(m: number[][]): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

/**
 * SVD d'une matrice 3x3 (H = U·diag(S)·V^T) via diagonalisation de Jacobi
 * sur H^T·H. Suffisant et stable pour l'alignement par points (3x3, faibles
 * dimensions). Renvoie U, S (valeurs singulières), V.
 */
function svd3x3(H: number[][]): { U: number[][]; S: number[]; V: number[][] } | null {
  const HtH = matMul3(transpose3(H), H);
  const eig = jacobiEigen3(HtH);
  if (!eig) return null;
  // Tri décroissant des valeurs propres
  const idx = [0, 1, 2].sort((a, b) => eig.values[b] - eig.values[a]);
  const S = idx.map((i) => Math.sqrt(Math.max(0, eig.values[i])));
  // V = colonnes = vecteurs propres triés
  const V = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let c = 0; c < 3; c++) {
    const vec = eig.vectors[idx[c]];
    V[0][c] = vec[0]; V[1][c] = vec[1]; V[2][c] = vec[2];
  }
  // U = H·V·diag(1/S) ; colonnes dégénérées complétées orthogonalement
  const HV = matMul3(H, V);
  const U = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let c = 0; c < 3; c++) {
    const s = S[c];
    if (s > 1e-9) {
      for (let r = 0; r < 3; r++) U[r][c] = HV[r][c] / s;
    } else {
      for (let r = 0; r < 3; r++) U[r][c] = 0;
    }
  }
  // Réorthonormalisation des colonnes de U (Gram-Schmidt) pour gérer les cas dégénérés
  orthonormalizeColumns(U);
  return { U, S, V };
}

function orthonormalizeColumns(M: number[][]): void {
  const col = (c: number) => new Vector3(M[0][c], M[1][c], M[2][c]);
  const setCol = (c: number, v: Vector3) => { M[0][c] = v.x; M[1][c] = v.y; M[2][c] = v.z; };
  let c0 = col(0);
  if (c0.lengthSquared() < 1e-12) c0 = new Vector3(1, 0, 0);
  c0.normalize();
  let c1 = col(1);
  c1 = c1.subtract(c0.scale(Vector3.Dot(c0, c1)));
  if (c1.lengthSquared() < 1e-12) c1 = Vector3.Cross(c0, new Vector3(0, 1, 0));
  c1.normalize();
  const c2 = Vector3.Cross(c0, c1);
  setCol(0, c0); setCol(1, c1); setCol(2, c2);
}

/** Diagonalisation de Jacobi pour matrice symétrique 3x3. */
function jacobiEigen3(A: number[][]): { values: number[]; vectors: number[][] } | null {
  const a = [
    [A[0][0], A[0][1], A[0][2]],
    [A[1][0], A[1][1], A[1][2]],
    [A[2][0], A[2][1], A[2][2]],
  ];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-12) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      if (Math.abs(a[p][q]) < 1e-15) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const cth = 1 / Math.sqrt(t * t + 1);
      const sth = t * cth;
      for (let i = 0; i < 3; i++) {
        const aip = a[i][p], aiq = a[i][q];
        a[i][p] = cth * aip - sth * aiq;
        a[i][q] = sth * aip + cth * aiq;
      }
      for (let i = 0; i < 3; i++) {
        const api = a[p][i], aqi = a[q][i];
        a[p][i] = cth * api - sth * aqi;
        a[q][i] = sth * api + cth * aqi;
      }
      for (let i = 0; i < 3; i++) {
        const vip = v[i][p], viq = v[i][q];
        v[i][p] = cth * vip - sth * viq;
        v[i][q] = sth * vip + cth * viq;
      }
    }
  }
  return {
    values: [a[0][0], a[1][1], a[2][2]],
    vectors: [
      [v[0][0], v[1][0], v[2][0]],
      [v[0][1], v[1][1], v[2][1]],
      [v[0][2], v[1][2], v[2][2]],
    ],
  };
}

function estimateRigidMatrixFromFirstThreePairs(src: Vector3[], dst: Vector3[]): number[][] | null {
  const sf = buildOrthonormalFrame(src[0], src[1], src[2]);
  const tf = buildOrthonormalFrame(dst[0], dst[1], dst[2]);
  if (!sf || !tf) return null;

  const sb = [sf.x, sf.y, sf.z];
  const tb = [tf.x, tf.y, tf.z];
  const R = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      R[i][j] = tb[0].asArray()[i] * sb[0].asArray()[j]
        + tb[1].asArray()[i] * sb[1].asArray()[j]
        + tb[2].asArray()[i] * sb[2].asArray()[j];
    }
  }
  const t = tf.o.subtract(applyRotationToVector(R, sf.o));
  return [
    [R[0][0], R[0][1], R[0][2], t.x],
    [R[1][0], R[1][1], R[1][2], t.y],
    [R[2][0], R[2][1], R[2][2], t.z],
    [0, 0, 0, 1],
  ];
}

function buildOrthonormalFrame(o: Vector3, p1: Vector3, p2: Vector3): { o: Vector3; x: Vector3; y: Vector3; z: Vector3 } | null {
  const x = p1.subtract(o);
  if (x.length() < 1e-8) return null;
  x.normalize();
  const tmp = p2.subtract(o);
  const z = Vector3.Cross(x, tmp);
  if (z.length() < 1e-8) return null;
  z.normalize();
  const y = Vector3.Cross(z, x);
  y.normalize();
  return { o, x, y, z };
}

function applyRotationToVector(R: number[][], v: Vector3): Vector3 {
  return new Vector3(
    R[0][0] * v.x + R[0][1] * v.y + R[0][2] * v.z,
    R[1][0] * v.x + R[1][1] * v.y + R[1][2] * v.z,
    R[2][0] * v.x + R[2][1] * v.y + R[2][2] * v.z,
  );
}


function parseMatrix4x4Text(text: string): number[][] | null {
  const nums = (text.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
  if (nums.length < 16) return null;
  const a = nums.slice(0, 16);
  return [
    [a[0], a[1], a[2], a[3]],
    [a[4], a[5], a[6], a[7]],
    [a[8], a[9], a[10], a[11]],
    [a[12], a[13], a[14], a[15]],
  ];
}

function multiplyMatrix4(a: number[][], b: number[][]): number[][] {
  const r = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j] + a[i][3] * b[3][j];
    }
  }
  return r;
}


function convertViewerMatrixToMagoMatrix(m: number[][]): number[][] {
  // Repère viewer Babylon -> repère MAGO/CloudCompare/3DR Z-up.
  // Même convention que les exports PLY/OBJ MAGO :
  //   Xm =  Xv
  //   Ym = -Zv
  //   Zm =  Yv
  // Si M_viewer mappe C(P_source_mago) vers C(P_target_mago), alors :
  //   M_mago = C^-1 · M_viewer · C
  const C = [
    [1, 0, 0, 0],
    [0, 0, 1, 0],
    [0, -1, 0, 0],
    [0, 0, 0, 1],
  ];
  const Cinv = [
    [1, 0, 0, 0],
    [0, 0, -1, 0],
    [0, 1, 0, 0],
    [0, 0, 0, 1],
  ];
  return multiplyMatrix4(multiplyMatrix4(Cinv, m), C);
}

function convertMagoMatrixToViewerMatrix(m: number[][]): number[][] {
  // Repère MAGO/CloudCompare Z-up -> repère viewer Babylon :
  // Xv = Xm, Yv = Zm, Zv = -Ym.
  // M_viewer = C · M_mago · C^-1 pour que C(Mp) = (C M C^-1)(Cp).
  const C = [
    [1, 0, 0, 0],
    [0, 0, 1, 0],
    [0, -1, 0, 0],
    [0, 0, 0, 1],
  ];
  const Cinv = [
    [1, 0, 0, 0],
    [0, 0, -1, 0],
    [0, 1, 0, 0],
    [0, 0, 0, 1],
  ];
  return multiplyMatrix4(multiplyMatrix4(C, m), Cinv);
}

async function importAlignmentMatrixFile(file: File): Promise<void> {
  try {
    const text = await file.text();
    const raw = parseMatrix4x4Text(text);
    if (!raw) {
      toast('Matrice invalide : il faut 16 nombres.', 'error', 5000);
      return;
    }
    const space = (document.getElementById('align-matrix-space') as HTMLSelectElement | null)?.value ?? 'mago';
    const matrix = space === 'viewer' ? raw : convertMagoMatrixToViewerMatrix(raw);
    state.alignment.lastMatrix = matrix;
    state.alignment.lastMatrixSourceUid = (getAlignmentAsset(state.alignment.sourceKind)?.rootNode as any)?.uniqueId ?? null;
    (state.alignment as any).lastResidualStats = state.alignment.pairs.length
      ? computeAlignmentResidualStats(matrix, state.alignment.pairs.map((p) => p.source.world), state.alignment.pairs.map((p) => p.target.world))
      : undefined;
    if (state.alignment.applyToSource) {
      applyAlignmentMatrixToSource(matrix);
      state.alignment.lastMatrixAppliedToSource = true;
    } else {
      state.alignment.lastMatrixAppliedToSource = false;
    }
    updateAlignmentUI();
    toast(`Matrice importée${space === 'mago' ? ' (convertie MAGO Z-up → viewer)' : ''}${state.alignment.applyToSource ? ' et appliquée à la source.' : '.'}`, 'info', 5000);
  } catch (err: any) {
    console.error(err);
    toast(`Échec import matrice : ${err?.message ?? err}`, 'error', 6000);
  }
}

function matrixArrayToBabylon(m: number[][]): Matrix {
  return Matrix.FromValues(
    m[0][0], m[1][0], m[2][0], 0,
    m[0][1], m[1][1], m[2][1], 0,
    m[0][2], m[1][2], m[2][2], 0,
    m[0][3], m[1][3], m[2][3], 1,
  );
}

function applyAlignmentMatrixToSource(matrix: number[][]): void {
  const sourceKind = state.alignment.sourceKind;
  const source = getAlignmentAsset(sourceKind);
  if (!source) return;

  const deltaWorld = matrixArrayToBabylon(matrix);
  const currentWorld = (source.rootNode as TransformNode).getWorldMatrix().clone();

  // La matrice est estimée en coordonnées monde viewer : pointWorldSource × M = pointWorldCible.
  // Le nouveau world root doit donc appliquer ce delta APRÈS le world courant.
  const newWorld = currentWorld.multiply(deltaWorld);
  const scale = Vector3.One();
  const rotation = Quaternion.Identity();
  const translation = Vector3.Zero();
  newWorld.decompose(scale, rotation, translation);
  const uniformScale = (Math.abs(scale.x) + Math.abs(scale.y) + Math.abs(scale.z)) / 3 || 1;

  const root = source.rootNode as TransformNode;
  root.position.copyFrom(translation);
  root.rotationQuaternion = rotation;
  root.scaling.setAll(uniformScale);
  root.computeWorldMatrix(true);
  for (const m of source.meshes) m.computeWorldMatrix(true);

  // Synchronise les champs historiques si on a réellement transformé l'asset principal.
  if (source === state.assets.mesh && sourceKind === 'mesh') {
    const e = rotation.toEulerAngles();
    state.transforms.mesh = { px: translation.x, py: translation.y, pz: translation.z, rx: radToDeg(e.x), ry: radToDeg(e.y), rz: radToDeg(e.z), scale: uniformScale };
    writeTransformToInputs('mesh', state.transforms.mesh);
  } else if (source === state.assets.splat && sourceKind === 'splat') {
    const e = rotation.toEulerAngles();
    state.transforms.splat = { px: translation.x, py: translation.y, pz: translation.z, rx: radToDeg(e.x), ry: radToDeg(e.y), rz: radToDeg(e.z), scale: uniformScale };
    writeTransformToInputs('splat', state.transforms.splat);
  }

  updateSelectedObjectTransformUI();
  updateBboxInfo();
  renderSceneObjectList();
}

function transformPointByMatrixArray(p: Vector3, m: number[][]): Vector3 {
  return new Vector3(
    p.x * m[0][0] + p.y * m[0][1] + p.z * m[0][2] + m[0][3],
    p.x * m[1][0] + p.y * m[1][1] + p.z * m[1][2] + m[1][3],
    p.x * m[2][0] + p.y * m[2][1] + p.z * m[2][2] + m[2][3],
  );
}

function computeAlignmentResidualStats(matrix: number[][], src: Vector3[], dst: Vector3[]): { rmse: number; max: number } {
  let sum2 = 0;
  let max = 0;
  const n = Math.min(src.length, dst.length);
  for (let i = 0; i < n; i++) {
    const pred = transformPointByMatrixArray(src[i], matrix);
    const d = pred.subtract(dst[i]).length();
    sum2 += d * d;
    if (d > max) max = d;
  }
  return { rmse: n ? Math.sqrt(sum2 / n) : 0, max };
}

function formatCloudCompareMatrix(matrix: number[][]): string {
  return matrix.map((row) => row.map((v) => Number.isFinite(v) ? v.toFixed(12) : '0.000000000000').join(' ')).join('\n') + '\n';
}

function babylonWorldMatrixToArray(world: Matrix): number[][] {
  // Reconstruit une matrice 4x4 en convention MAGO interne :
  // p' = M · p avec translation dans la dernière colonne.
  // On passe par les points de base pour éviter les ambiguïtés row/column-major Babylon.
  const origin = Vector3.TransformCoordinates(Vector3.Zero(), world);
  const ex = Vector3.TransformCoordinates(new Vector3(1, 0, 0), world).subtract(origin);
  const ey = Vector3.TransformCoordinates(new Vector3(0, 1, 0), world).subtract(origin);
  const ez = Vector3.TransformCoordinates(new Vector3(0, 0, 1), world).subtract(origin);
  return [
    [ex.x, ey.x, ez.x, origin.x],
    [ex.y, ey.y, ez.y, origin.y],
    [ex.z, ey.z, ez.z, origin.z],
    [0, 0, 0, 1],
  ];
}

function convertSourceRootWorldToMagoMatrix(world: Matrix): number[][] {
  // IMPORTANT : cette fonction exporte la transformation TOTALE de la source.
  // Les coordonnées locales de l'objet chargé sont les coordonnées brutes MAGO/RS Z-up.
  // La matrice monde Babylon les envoie vers le viewer Y-up. Pour produire une matrice
  // exploitable dans CloudCompare / MAGO Pipeline, on reconvertit seulement la sortie :
  //   M_total_Zup = viewerWorldToMago · M_root_world
  // Ainsi, le Z-up→Y-up automatique, les déplacements manuels, le gizmo, l'échelle et
  // l'alignement par points sont tous inclus dans la matrice exportée.
  const W = babylonWorldMatrixToArray(world);
  const viewerToMago = [
    [1, 0, 0, 0],
    [0, 0, -1, 0],
    [0, 1, 0, 0],
    [0, 0, 0, 1],
  ];
  return multiplyMatrix4(viewerToMago, W);
}

function getAlignmentMatrixForCloudCompare(): number[][] | null {
  const viewerMatrix = state.alignment.lastMatrix ?? solvePointAlignment(false);
  if (!viewerMatrix) return null;

  const source = getAlignmentAsset(state.alignment.sourceKind);
  if (!source) return convertViewerMatrixToMagoMatrix(viewerMatrix);

  const root = source.rootNode as any;
  if (typeof root.computeWorldMatrix === 'function') root.computeWorldMatrix(true);
  let world = (typeof root.getWorldMatrix === 'function' ? root.getWorldMatrix().clone() : Matrix.Identity()) as Matrix;

  // Si une matrice vient d'être calculée/importée mais n'a PAS été appliquée à la source,
  // on l'ajoute virtuellement à la transformation courante pour que l'export reste complet.
  // Si elle a déjà été appliquée, la matrice monde de la racine contient déjà ce delta :
  // on ne le remultiplie surtout pas.
  const sourceUid = (root as any)?.uniqueId ?? null;
  if (state.alignment.lastMatrix && !state.alignment.lastMatrixAppliedToSource && state.alignment.lastMatrixSourceUid === sourceUid) {
    world = world.multiply(matrixArrayToBabylon(state.alignment.lastMatrix));
  }

  return convertSourceRootWorldToMagoMatrix(world);
}

function exportAlignmentMatrix(): void {
  const matrix = getAlignmentMatrixForCloudCompare();
  if (!matrix) return;
  const src = getAlignmentAsset(state.alignment.sourceKind)?.fileName?.replace(/\.[^.]+$/, '') ?? 'source';
  const dst = getAlignmentAsset(state.alignment.targetKind)?.fileName?.replace(/\.[^.]+$/, '') ?? 'target';
  const name = `MAGO_align_${src}_to_${dst}_CloudCompare_ZUP_matrix.txt`.replace(/[\\/:*?"<>|]+/g, '_');
  downloadText(formatCloudCompareMatrix(matrix), name, 'text/plain');
  toast('Matrice complète exportée : transformations manuelles + alignement par points inclus.');
}

async function copyAlignmentMatrix(): Promise<void> {
  const matrix = getAlignmentMatrixForCloudCompare();
  if (!matrix) return;
  try {
    await navigator.clipboard.writeText(formatCloudCompareMatrix(matrix));
    toast('Matrice complète MAGO / CloudCompare copiée dans le presse-papiers.');
  } catch {
    toast('Copie impossible dans ce navigateur. Utilise Exporter matrice.', 'warn');
  }
}

function updateAlignmentUI(): void {
  const al = state.alignment;
  const btn = document.getElementById('btn-align-toggle');
  const status = document.getElementById('align-status');
  const count = document.getElementById('align-pair-count');
  const matrixBox = document.getElementById('align-matrix-preview') as HTMLTextAreaElement | null;
  const rmseEl = document.getElementById('align-rmse');
  const maxErrEl = document.getElementById('align-max-error');
  if (btn) {
    btn.classList.toggle('active', al.active);
    btn.textContent = al.active ? 'Désactiver picking' : 'Activer picking';
  }
  if (status) {
    const label = al.waitingFor === 'source' ? 'SOURCE' : 'CIBLE';
    status.textContent = al.active
      ? `Actif · prochain clic : ${label} (${al.waitingFor === 'source' ? al.sourceKind : al.targetKind})`
      : 'Inactif';
  }
  if (count) {
    count.textContent = `${al.pairs.length} paire${al.pairs.length > 1 ? 's' : ''}` + (al.currentSource ? ' · source en attente de cible' : '');
  }
  if (matrixBox) {
    matrixBox.value = al.lastMatrix
      ? formatCloudCompareMatrix(convertViewerMatrixToMagoMatrix(al.lastMatrix)).trimEnd()
      : '';
  }
  const stats = (al as any).lastResidualStats as { rmse: number; max: number } | undefined;
  if (rmseEl) rmseEl.textContent = stats ? `${stats.rmse.toFixed(4)} m` : '—';
  if (maxErrEl) maxErrEl.textContent = stats ? `${stats.max.toFixed(4)} m` : '—';
}

// =================================================================
//  MESH EDITOR / SELECTION ÉCRAN / SUPPRESSION TRIANGLES
// =================================================================

function bindMeshEditorControls(): void {
  const mode = document.getElementById('mesh-selection-mode') as HTMLSelectElement | null;
  const brush = document.getElementById('mesh-brush-size') as HTMLInputElement | null;
  const brushVal = document.getElementById('val-mesh-brush-size');

  const visibleOnly = document.getElementById('mesh-visible-only') as HTMLInputElement | null;

  const updateSettings = () => {
    if (mode) state.meshEditor.selectionMode = mode.value as AppState['meshEditor']['selectionMode'];
    if (brush) state.meshEditor.brushSize = parseFloat(brush.value);
    if (brushVal) brushVal.textContent = `${Math.round(state.meshEditor.brushSize)} px`;
    if (visibleOnly) state.meshEditor.visibleOnly = visibleOnly.checked;
    updateMeshEditorStats();
  };

  mode?.addEventListener('change', updateSettings);
  brush?.addEventListener('input', updateSettings);
  visibleOnly?.addEventListener('change', updateSettings);
  updateSettings();

  document.getElementById('btn-mesh-select')?.addEventListener('click', () => {
    setMeshSelectionActive(!state.meshEditor.active);
  });
  document.getElementById('btn-mesh-delete-selection')?.addEventListener('click', () => {
    deleteSelectedMeshTriangles();
  });
  document.getElementById('btn-mesh-hide-selection')?.addEventListener('click', () => {
    hideSelectedMeshTriangles();
  });
  document.getElementById('btn-mesh-unhide')?.addEventListener('click', () => {
    unhideAllMeshTriangles();
  });
  document.getElementById('btn-mesh-clear-selection')?.addEventListener('click', () => {
    clearMeshSelection();
    toast('Sélection mesh effacée.');
  });
  document.getElementById('btn-mesh-undo')?.addEventListener('click', () => {
    undoLastMeshEdit();
  });
  document.getElementById('btn-mesh-reclass')?.addEventListener('click', () => {
    const sel = document.getElementById('mesh-reclass-target') as HTMLSelectElement | null;
    reclassifySelectedTriangles(sel?.value ?? '');
  });
  ensureMeshCreateObjectControls();
  document.getElementById('btn-mesh-create-object')?.addEventListener('click', () => {
    createMeshObjectFromSelection();
  });
  refreshReclassTargets();
}


function setMeshSelectionActive(active: boolean): void {
  state.meshEditor.active = active;
  if (active) {
    // On évite les conflits : un seul outil de sélection écran actif à la fois.
    setLassoActive(false);
    lockMeshLodForEditing();
  }
  const btn = document.getElementById('btn-mesh-select');
  btn?.classList.toggle('active', active);
  const canvas = state.ctx.engine.getRenderingCanvas() as HTMLCanvasElement | null;
  if (active) {
    canvas?.classList.add('lasso-mode');
    toast('Sélection mesh active sur TOUS les LOD : clic gauche pour dessiner, Maj = ajouter, Ctrl = retirer. « Faces visibles uniquement » évite de traverser les murs.');
  } else {
    canvas?.classList.remove('lasso-mode');
    state.meshEditor.drawing = false;
    state.meshEditor.points = [];
    clearLassoOverlay();
    unlockMeshLodAfterEditing();
    toast('Sélection mesh désactivée.');
  }
}

function lockMeshLodForEditing(): void {
  const lod = state.meshLod;
  if (!lod.enabled || lod.groups.length === 0) return;
  const select = document.getElementById('mesh-lod-mode') as HTMLSelectElement | null;
  const previous = select?.value ?? 'auto';
  (lod as any).__magoEditPreviousLodMode = previous;

  const level = lod.currentLevel ?? chooseLodLevelForRadius(state.ctx.camera.radius);
  if (level == null) return;

  // Le problème venait de là : en zoomant pendant l’édition, le LOD auto changeait
  // de géométrie. On force donc temporairement le niveau affiché au moment où
  // l’utilisateur commence l’édition. Les suppressions restent ensuite propagées
  // aux autres LOD par la logique V7.
  lod.currentLevel = level;
  if (select) {
    select.value = String(level);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    applyMeshVisibilityFromState();
    updateLodHud();
  }
}

function unlockMeshLodAfterEditing(): void {
  const lod = state.meshLod;
  if (!lod.enabled || lod.groups.length === 0) return;
  const select = document.getElementById('mesh-lod-mode') as HTMLSelectElement | null;
  const previous = (lod as any).__magoEditPreviousLodMode as string | undefined;
  delete (lod as any).__magoEditPreviousLodMode;

  if (select && previous != null) {
    select.value = previous;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    updateMeshLodByCamera(true);
    updateLodHud();
  }
}

function hasSelectedMeshTriangles(): boolean {
  for (const set of state.meshEditor.selected.values()) {
    if (set.size > 0) return true;
  }
  return false;
}

function countSelectedMeshTriangles(): number {
  let n = 0;
  for (const set of state.meshEditor.selected.values()) n += set.size;
  return n;
}

function clearMeshSelection(): void {
  state.meshEditor.selected.clear();
  state.meshEditor.points = [];
  if (state.meshEditor.preview) {
    state.meshEditor.preview.dispose(false, true);
    state.meshEditor.preview = null;
  }
  updateMeshEditorStats();
  clearLassoOverlay();
}

function updateMeshEditorStats(): void {
  const total = document.getElementById('mesh-edit-total');
  const selected = document.getElementById('mesh-edit-selected');
  const undo = document.getElementById('btn-mesh-undo') as HTMLButtonElement | null;
  const createObjectBtn = document.getElementById('btn-mesh-create-object') as HTMLButtonElement | null;
  const tris = state.assets.mesh?.triangleCount ?? 0;
  const selectedTris = countSelectedMeshTriangles();
  if (total) total.textContent = state.assets.mesh ? `${formatNumber(tris)} triangles mesh` : '—';
  if (selected) selected.textContent = `${formatNumber(selectedTris)} triangles sélectionnés`;
  if (createObjectBtn) {
    createObjectBtn.disabled = selectedTris === 0;
    createObjectBtn.textContent = selectedTris > 0 ? `Créer objet (${formatNumber(selectedTris)} tris)` : 'Créer objet depuis sélection';
  }
  if (undo) {
    const n = state.meshEditor.undoStack.length;
    undo.disabled = n === 0;
    undo.textContent = n > 0 ? `Annuler dernière suppression · ${n}` : 'Annuler dernière suppression';
  }
  const hiddenEl = document.getElementById('mesh-edit-hidden');
  const unhideBtn = document.getElementById('btn-mesh-unhide') as HTMLButtonElement | null;
  const nHidden = countHiddenMeshTriangles();
  if (hiddenEl) hiddenEl.textContent = `${formatNumber(nHidden)} triangle${nHidden > 1 ? 's' : ''} masqué${nHidden > 1 ? 's' : ''} (protégés)`;
  if (unhideBtn) {
    unhideBtn.disabled = nHidden === 0;
    unhideBtn.textContent = nHidden > 0 ? `Réafficher faces masquées · ${formatNumber(nHidden)}` : 'Réafficher faces masquées';
  }
}

function getEditableMeshes(): Mesh[] {
  // L'édition mesh doit couvrir TOUS les niveaux LOD en même temps : les LOD non
  // affichés sont déjà chargés en mémoire (juste désactivés par le sélecteur LOD).
  // On les inclut donc dans la sélection/suppression/reclassement, ce qui garantit
  // qu'une zone nettoyée ne réapparaît jamais en zoomant/dézoomant ni côté client.
  // On respecte en revanche la visibilité voulue par l'utilisateur (calques, toggle global).
  const asset = state.assets.mesh;
  if (!asset) return [];
  const globalToggle = document.getElementById('toggle-mesh') as HTMLInputElement | null;
  const globalVisible = globalToggle?.checked ?? true;
  return asset.meshes.filter((m): m is Mesh => {
    if (!(m instanceof Mesh) || m.isDisposed() || (m.getTotalVertices?.() ?? 0) === 0) return false;
    if (m.isEnabled() && m.isVisible) return true;
    // Mesh masqué uniquement parce qu'il appartient à un autre niveau LOD.
    if (!globalVisible) return false;
    if (state.meshLod.meshLevel.has(m)) return getLayerVisibilityForMesh(m);
    return false;
  });
}

function finishMeshScreenSelection(): void {
  if (!state.assets.mesh) {
    toast('Aucun mesh chargé.', 'warn');
    return;
  }
  const ed = state.meshEditor;
  const minPts = ed.selectionMode === 'rectangle' || ed.selectionMode === 'circle' ? 2 : 4;
  if (ed.points.length < minPts) {
    toast('Sélection trop petite.', 'warn');
    clearLassoOverlay();
    return;
  }

  const token = ++state.meshEditor.selectionToken;
  const pts = ed.points.slice();
  const mode = ed.selectionMode;
  const brush = ed.brushSize;
  setStatus('sélection mesh…');

  setTimeout(async () => {
    try {
      // Sélection unifiée pour tous les modes (pinceau compris) : projection écran
      // sur TOUS les niveaux LOD + filtre d'occlusion basé sur la profondeur des
      // surfaces actuellement visibles. On retrouve la précision du picking (on ne
      // sélectionne pas à travers les murs) tout en restant cohérent entre LOD.
      const selected = await selectMeshTrianglesByScreenShapeAsync(pts, mode, brush, token);
      if (token !== state.meshEditor.selectionToken) return;
      const combine = state.meshEditor.combineNext ?? 'replace';
      state.meshEditor.combineNext = null;
      if (combine === 'add') {
        for (const [mesh, set] of selected.entries()) {
          const cur = state.meshEditor.selected.get(mesh) ?? new Set<number>();
          for (const tri of set) cur.add(tri);
          state.meshEditor.selected.set(mesh, cur);
        }
      } else if (combine === 'subtract') {
        for (const [mesh, set] of selected.entries()) {
          const cur = state.meshEditor.selected.get(mesh);
          if (!cur) continue;
          for (const tri of set) cur.delete(tri);
          if (cur.size === 0) state.meshEditor.selected.delete(mesh);
        }
      } else {
        state.meshEditor.selected = selected;
      }
      buildMeshSelectionPreview();
      updateMeshEditorStats();
      clearLassoOverlay();
      setStatus('prêt');
      const n = countSelectedMeshTriangles();
      toast(`${formatNumber(n)} triangles mesh sélectionnés. Ils sont surlignés en jaune avant suppression.`);
    } catch (err) {
      console.error(err);
      clearLassoOverlay();
      setStatus('erreur');
      toast('Erreur pendant la sélection mesh : ' + ((err as Error).message ?? err), 'error', 6000);
    }
  }, 20);
}

async function warmMeshTriangleCacheAsync(): Promise<void> {
  const meshes = getEditableMeshes();
  if (meshes.length === 0) return;
  setTimeout(async () => {
    const token = state.meshEditor.selectionToken;
    try {
      for (const mesh of meshes) {
        if (token !== state.meshEditor.selectionToken || mesh.isDisposed()) return;
        getMeshTriangleCache(mesh);
        // Laisse respirer le navigateur entre deux gros objets GLB.
        await nextFrame();
      }
    } catch (err) {
      console.warn('Préparation cache triangles ignorée :', err);
    }
  }, 200);
}

function invalidateMeshTriangleCache(mesh?: Mesh): void {
  if (!state?.meshEditor) return;
  if (mesh) state.meshEditor.triangleCache.delete(mesh);
  else state.meshEditor.triangleCache.clear();
}

function getMeshTriangleCache(mesh: Mesh): MeshTriangleCache {
  const positions = mesh.getVerticesData('position');
  if (!positions) throw new Error(`Mesh sans positions : ${mesh.name}`);
  const rawIndices = mesh.getIndices();
  const vertexCount = positions.length / 3;
  const indexCount = rawIndices && rawIndices.length > 0 ? rawIndices.length : vertexCount;

  const cached = state.meshEditor.triangleCache.get(mesh);
  if (
    cached &&
    cached.sourceIndexCount === indexCount &&
    cached.sourceVertexCount === vertexCount &&
    cached.triangleCount === Math.floor(indexCount / 3)
  ) {
    return cached;
  }

  let indices: ArrayLike<number>;
  if (rawIndices && rawIndices.length > 0) {
    indices = rawIndices;
  } else {
    const seq = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) seq[i] = i;
    indices = seq;
  }

  const triangleCount = Math.floor(indexCount / 3);
  const centroids = new Float32Array(triangleCount * 3);
  const vertices = new Float32Array(triangleCount * 9);
  for (let tri = 0; tri < triangleCount; tri++) {
    const i0 = indices[tri * 3] * 3;
    const i1 = indices[tri * 3 + 1] * 3;
    const i2 = indices[tri * 3 + 2] * 3;
    const o = tri * 3;
    const v = tri * 9;
    vertices[v] = positions[i0];
    vertices[v + 1] = positions[i0 + 1];
    vertices[v + 2] = positions[i0 + 2];
    vertices[v + 3] = positions[i1];
    vertices[v + 4] = positions[i1 + 1];
    vertices[v + 5] = positions[i1 + 2];
    vertices[v + 6] = positions[i2];
    vertices[v + 7] = positions[i2 + 1];
    vertices[v + 8] = positions[i2 + 2];
    centroids[o] = (positions[i0] + positions[i1] + positions[i2]) / 3;
    centroids[o + 1] = (positions[i0 + 1] + positions[i1 + 1] + positions[i2 + 1]) / 3;
    centroids[o + 2] = (positions[i0 + 2] + positions[i1 + 2] + positions[i2 + 2]) / 3;
  }

  const next: MeshTriangleCache = {
    mesh,
    indices,
    centroids,
    vertices,
    triangleCount,
    sourceIndexCount: indexCount,
    sourceVertexCount: vertexCount,
  };
  state.meshEditor.triangleCache.set(mesh, next);
  return next;
}

function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}


async function selectMeshTrianglesByExactPickingBrushAsync(
  points: Array<{ x: number; y: number }>,
  brushSize: number,
  token: number,
): Promise<Map<Mesh, Set<number>>> {
  const out = new Map<Mesh, Set<number>>();
  const scene = state.ctx.scene;
  const camera = scene.activeCamera;
  if (!camera || points.length === 0) return out;

  const editable = new Set<Mesh>(getEditableMeshes().filter((m) => m.isEnabled() && m.isVisible && !m.isDisposed()));
  if (editable.size === 0) return out;

  const path = densifyScreenPath(points, Math.max(3, Math.min(8, brushSize * 0.35)));
  const offsets = makeBrushOffsets(Math.max(1, brushSize), Math.max(3, Math.min(7, brushSize * 0.45)));
  let processed = 0;
  let lastYield = performance.now();

  const pickPredicate = (mesh: AbstractMesh) => editable.has(mesh as Mesh);

  for (const p of path) {
    if (token !== state.meshEditor.selectionToken) return out;

    for (const off of offsets) {
      const x = p.x + off.x;
      const y = p.y + off.y;
      const pick = scene.pick(x, y, pickPredicate, false, camera);
      if (pick?.hit && pick.pickedMesh && pick.faceId != null && pick.faceId >= 0) {
        const mesh = pick.pickedMesh as Mesh;
        if (editable.has(mesh)) {
          const set = out.get(mesh) ?? new Set<number>();
          set.add(pick.faceId);
          out.set(mesh, set);
        }
      }

      processed++;
      if (processed % 650 === 0) {
        const now = performance.now();
        if (now - lastYield > 18) {
          setStatus(`pinceau précis… ${formatNumber(processed)} rayons testés`);
          await nextFrame();
          lastYield = performance.now();
          if (token !== state.meshEditor.selectionToken) return out;
        }
      }
    }
  }

  return out;
}

function densifyScreenPath(
  points: Array<{ x: number; y: number }>,
  stepPx: number,
): Array<{ x: number; y: number }> {
  if (points.length <= 1) return points.slice();
  const out: Array<{ x: number; y: number }> = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(dist / stepPx));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

function makeBrushOffsets(radius: number, spacing: number): Array<{ x: number; y: number }> {
  const offsets: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
  const r = Math.max(1, radius);
  const step = Math.max(2, spacing);
  for (let y = -r; y <= r; y += step) {
    for (let x = -r; x <= r; x += step) {
      if (x === 0 && y === 0) continue;
      if (x * x + y * y <= r * r) offsets.push({ x, y });
    }
  }
  return offsets;
}


async function selectMeshTrianglesByScreenShapeAsync(
  points: Array<{ x: number; y: number }>,
  mode: AppState['meshEditor']['selectionMode'],
  brushSize: number,
  token: number
): Promise<Map<Mesh, Set<number>>> {
  const out = new Map<Mesh, Set<number>>();
  const scene = state.ctx.scene;
  const camera = scene.activeCamera;
  if (!camera) return out;

  const viewProj = scene.getTransformMatrix();
  const viewport = camera.viewport.toGlobal(
    scene.getEngine().getRenderWidth(),
    scene.getEngine().getRenderHeight()
  );

  const predicate = buildScreenSelectionPredicate(points, mode, brushSize);
  let processed = 0;
  let rejectedByBounds = 0;
  let lastYield = performance.now();
  const t0 = performance.now();

  const editable = getEditableMeshes();
  const projections = new Map<Mesh, { cache: MeshTriangleCache; proj: MeshScreenProjection }>();
  for (const mesh of editable) {
    if (token !== state.meshEditor.selectionToken) return out;
    const cache = getMeshTriangleCache(mesh);
    projections.set(mesh, { cache, proj: getMeshScreenProjection(cache, viewProj, viewport) });
  }

  // ---- Filtre d'occlusion : grille de profondeur des surfaces VISIBLES ----
  // Cellules écran de 6 px, limitées à la zone de la forme dessinée. Pour chaque
  // cellule on retient la profondeur minimale des triangles actuellement affichés.
  // Un triangle candidat (quel que soit son LOD) n'est retenu que s'il est proche
  // de cette surface visible : on ne sélectionne plus à travers les murs, et la
  // sélection sur les LOD cachés suit exactement la surface que tu vois.
  const useOcclusion = state.meshEditor.visibleOnly !== false;
  const CELL = 6;
  const gMinX = Math.floor(predicate.minX / CELL) - 1;
  const gMinY = Math.floor(predicate.minY / CELL) - 1;
  const gW = Math.max(1, Math.floor(predicate.maxX / CELL) + 2 - gMinX);
  const gH = Math.max(1, Math.floor(predicate.maxY / CELL) + 2 - gMinY);
  let depthGrid: Float32Array | null = null;
  if (useOcclusion && gW * gH <= 4_000_000) {
    depthGrid = new Float32Array(gW * gH).fill(Number.POSITIVE_INFINITY);
    for (const mesh of editable) {
      if (!mesh.isEnabled() || !mesh.isVisible) continue; // seules les surfaces affichées occultent
      const entry = projections.get(mesh)!;
      const { proj, cache } = entry;
      for (let tri = 0; tri < cache.triangleCount; tri++) {
        if (proj.visible[tri] === 0) continue;
        const sx = proj.x[tri];
        const sy = proj.y[tri];
        if (sx < predicate.minX - CELL || sx > predicate.maxX + CELL || sy < predicate.minY - CELL || sy > predicate.maxY + CELL) continue;
        const gx = Math.floor(sx / CELL) - gMinX;
        const gy = Math.floor(sy / CELL) - gMinY;
        if (gx < 0 || gy < 0 || gx >= gW || gy >= gH) continue;
        const idx = gy * gW + gx;
        const d = proj.depth[tri];
        if (d < depthGrid[idx]) depthGrid[idx] = d;
      }
      processed += cache.triangleCount;
      if (performance.now() - lastYield > 18) {
        setStatus(`analyse profondeur… ${formatNumber(processed)} tris`);
        await nextFrame();
        lastYield = performance.now();
        if (token !== state.meshEditor.selectionToken) return out;
      }
    }
  }

  const passesOcclusion = (sx: number, sy: number, d: number): boolean => {
    if (!depthGrid) return true;
    const gx = Math.floor(sx / CELL) - gMinX;
    const gy = Math.floor(sy / CELL) - gMinY;
    if (gx < 0 || gy < 0 || gx >= gW || gy >= gH) return true;
    // On tolère la cellule et ses 8 voisines (bords de triangles grossiers des LOD légers).
    let ref = Number.POSITIVE_INFINITY;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const nx = gx + ox, ny = gy + oy;
        if (nx < 0 || ny < 0 || nx >= gW || ny >= gH) continue;
        const v = depthGrid[ny * gW + nx];
        if (v < ref) ref = v;
      }
    }
    if (!Number.isFinite(ref)) return true;
    return d <= ref + Math.max(0.08, ref * 0.03);
  };

  for (const mesh of editable) {
    if (token !== state.meshEditor.selectionToken) return out;
    const entry = projections.get(mesh)!;
    const cache = entry.cache;
    const projected = entry.proj;
    const set = new Set<number>();

    for (let tri = 0; tri < cache.triangleCount; tri++) {
      if (projected.visible[tri] === 0) continue;
      const sx = projected.x[tri];
      const sy = projected.y[tri];

      // Rejet bbox ultra rapide avant les tests lasso/pinceau plus coûteux.
      if (sx < predicate.minX || sx > predicate.maxX || sy < predicate.minY || sy > predicate.maxY) {
        rejectedByBounds++;
      } else if (predicate.test(sx, sy) && passesOcclusion(sx, sy, projected.depth[tri])) {
        set.add(tri);
      }

      processed++;
      if (processed % MESH_SELECTION_CHUNK_SIZE === 0) {
        const now = performance.now();
        if (now - lastYield > 18) {
          setStatus(`sélection mesh… ${formatNumber(processed)} tris testés`);
          await nextFrame();
          lastYield = performance.now();
          if (token !== state.meshEditor.selectionToken) return out;
        }
      }
    }

    if (set.size > 0) out.set(mesh, set);
  }

  const dt = performance.now() - t0;
  if (dt > 800) {
    console.info(
      `[MAGO] Sélection mesh boostée : ${processed.toLocaleString()} triangles testés en ${dt.toFixed(0)} ms, ` +
      `${rejectedByBounds.toLocaleString()} rejetés par bbox. Les projections écran sont mises en cache si la caméra ne bouge pas.`
    );
  }
  return out;
}

type MeshScreenProjection = {
  x: Float32Array;
  y: Float32Array;
  visible: Uint8Array;
  depth: Float32Array; // profondeur vue (m) : sert au filtre d'occlusion
};

function getMeshScreenProjection(
  cache: MeshTriangleCache,
  viewProj: Matrix,
  viewport: { x: number; y: number; width: number; height: number }
): MeshScreenProjection {
  const combinedMatrix = cache.mesh.getWorldMatrix().multiply(viewProj);
  const combined = combinedMatrix.m;
  const key = makeProjectionKey(combined, viewport, cache.triangleCount);

  if (cache.screenKey === key && cache.screenX && cache.screenY && cache.screenVisible && cache.screenDepth) {
    return { x: cache.screenX, y: cache.screenY, visible: cache.screenVisible, depth: cache.screenDepth };
  }

  const sx = new Float32Array(cache.triangleCount);
  const sy = new Float32Array(cache.triangleCount);
  const visible = new Uint8Array(cache.triangleCount);
  const depth = new Float32Array(cache.triangleCount);
  const c = cache.centroids;

  for (let tri = 0; tri < cache.triangleCount; tri++) {
    const o = tri * 3;
    const x = c[o], y = c[o + 1], z = c[o + 2];
    const cx = x * combined[0] + y * combined[4] + z * combined[8] + combined[12];
    const cy = x * combined[1] + y * combined[5] + z * combined[9] + combined[13];
    const cz = x * combined[2] + y * combined[6] + z * combined[10] + combined[14];
    const cw = x * combined[3] + y * combined[7] + z * combined[11] + combined[15];
    if (cw === 0) continue;

    const invW = 1 / cw;
    const ndcX = cx * invW;
    const ndcY = cy * invW;
    const ndcZ = cz * invW;
    if (ndcZ < 0 || ndcZ > 1) continue;

    sx[tri] = viewport.x + (ndcX + 1) * 0.5 * viewport.width;
    sy[tri] = viewport.y + (1 - ndcY) * 0.5 * viewport.height;
    visible[tri] = 1;
    depth[tri] = cw; // caméra perspective : w = distance vue en mètres
  }

  cache.screenKey = key;
  cache.screenX = sx;
  cache.screenY = sy;
  cache.screenVisible = visible;
  cache.screenDepth = depth;
  return { x: sx, y: sy, visible, depth };
}

function makeProjectionKey(
  matrix: ArrayLike<number>,
  viewport: { x: number; y: number; width: number; height: number },
  triCount: number
): string {
  // Arrondi léger : si la caméra ne bouge pas visuellement, on réutilise le cache.
  let key = `${Math.round(viewport.width)}x${Math.round(viewport.height)}:${triCount}:`;
  for (let i = 0; i < 16; i++) key += matrix[i].toFixed(5) + ',';
  return key;
}

function buildScreenSelectionPredicate(
  points: Array<{ x: number; y: number }>,
  mode: AppState['meshEditor']['selectionMode'],
  brushSize: number
): ScreenSelectionPredicate {
  const boundsOf = (pts: Array<{ x: number; y: number }>, pad = 0) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
  };

  if (mode === 'rectangle') {
    const a = points[0], b = points[1];
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    return {
      minX, maxX, minY, maxY,
      test: (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY,
    };
  }

  if (mode === 'circle') {
    const a = points[0], b = points[1];
    const r = Math.hypot(b.x - a.x, b.y - a.y);
    const r2 = r * r;
    return {
      minX: a.x - r, maxX: a.x + r, minY: a.y - r, maxY: a.y + r,
      test: (x, y) => {
        const dx = x - a.x, dy = y - a.y;
        return dx * dx + dy * dy <= r2;
      },
    };
  }

  if (mode === 'brush') {
    // Un trait de pinceau peut contenir des centaines de points. On simplifie le chemin
    // pour éviter un test O(triangles × points) trop coûteux sur les gros meshes.
    const simplified: Array<{ x: number; y: number }> = [];
    for (const p of points) {
      const last = simplified[simplified.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= MESH_BRUSH_PATH_MIN_DISTANCE_PX) {
        simplified.push(p);
      }
    }
    if (simplified.length === 0 && points[0]) simplified.push(points[0]);
    const r2 = brushSize * brushSize;
    const b = boundsOf(simplified, brushSize);
    return {
      ...b,
      test: (x, y) => {
        for (const p of simplified) {
          const dx = x - p.x, dy = y - p.y;
          if (dx * dx + dy * dy <= r2) return true;
        }
        return false;
      },
    };
  }

  const b = boundsOf(points, 1);
  return {
    ...b,
    test: (x, y) => pointInPolygonLocal(x, y, points),
  };
}

function buildMeshSelectionPreview(): void {
  if (state.meshEditor.preview) {
    state.meshEditor.preview.dispose(false, true);
    state.meshEditor.preview = null;
  }

  const selectedCount = countSelectedMeshTriangles();
  const previewStride = selectedCount > MESH_SELECTION_PREVIEW_MAX_TRIANGLES
    ? Math.ceil(selectedCount / MESH_SELECTION_PREVIEW_MAX_TRIANGLES)
    : 1;

  const positionsOut: number[] = [];
  const indicesOut: number[] = [];
  let cursor = 0;
  let previewCounter = 0;

  for (const [mesh, tris] of state.meshEditor.selected.entries()) {
    // L'aperçu ne dessine que les triangles des meshes affichés : les niveaux LOD
    // cachés sont bien sélectionnés (et comptés), mais surligner leur géométrie
    // légèrement différente créerait des doublons jaunes flottants.
    if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible) continue;
    const positions = mesh.getVerticesData('position');
    if (!positions) continue;
    const rawIndices = mesh.getIndices();
    const vertexCount = positions.length / 3;
    const indices = rawIndices && rawIndices.length > 0 ? Array.from(rawIndices) : Array.from({ length: vertexCount }, (_, i) => i);
    const world = mesh.getWorldMatrix();

    for (const tri of tris) {
      previewCounter++;
      if (previewStride > 1 && previewCounter % previewStride !== 0) continue;
      for (let k = 0; k < 3; k++) {
        const idx = indices[tri * 3 + k] * 3;
        if (idx + 2 >= positions.length) continue;
        const p = Vector3.TransformCoordinates(new Vector3(positions[idx], positions[idx + 1], positions[idx + 2]), world);
        positionsOut.push(p.x, p.y, p.z);
        indicesOut.push(cursor++);
      }
    }
  }

  if (positionsOut.length === 0) return;
  const preview = new Mesh('__mago_mesh_selection_preview', state.ctx.scene);
  const vd = new VertexData();
  vd.positions = positionsOut;
  vd.indices = indicesOut;
  vd.applyToMesh(preview, true);
  const mat = new StandardMaterial('__mago_mesh_selection_yellow', state.ctx.scene);
  mat.diffuseColor = new Color3(1, 0.82, 0.02);
  mat.emissiveColor = new Color3(1, 0.55, 0.0);
  mat.alpha = 0.62;
  mat.backFaceCulling = false;
  (mat as any).disableDepthWrite = false;
  (mat as any).zOffset = -2;
  preview.material = mat;
  preview.isPickable = false;
  state.meshEditor.preview = preview;
  if (previewStride > 1) {
    toast(`Sélection très grande : aperçu jaune échantillonné (1 triangle sur ${previewStride}), mais la suppression reste complète.`, 'warn', 4500);
  }
}

function deleteSelectedMeshTriangles(confirmBefore = true): void {
  if (!state.assets.mesh) return toast('Aucun mesh chargé.', 'warn');
  const n = countSelectedMeshTriangles();
  if (n === 0) return toast('Aucune sélection mesh à supprimer.', 'warn');

  // La sélection couvre désormais TOUS les niveaux LOD directement (projection
  // écran appliquée à chaque niveau). Plus besoin de l'expansion géométrique par
  // région monde, qui était imprécise (triangles manqués ou en trop sur les LOD
  // grossiers) et provoquait les zones qui réapparaissaient au zoom.
  const deletionMap = cloneMeshTriangleMap(state.meshEditor.selected);
  const nTotal = countMeshTriangleMap(deletionMap);
  const lodLevels = new Set<number>();
  for (const mesh of deletionMap.keys()) {
    const lvl = state.meshLod.meshLevel.get(mesh);
    if (lvl != null) lodLevels.add(lvl);
  }

  const message = lodLevels.size > 1
    ? `Supprimer ${formatNumber(nTotal)} triangles répartis sur ${lodLevels.size} niveaux de LOD ?\n\nLa zone supprimée ne réapparaîtra ni au zoom ni dans la vue client.`
    : `Supprimer ${formatNumber(nTotal)} triangles du mesh ?`;
  if (confirmBefore && !confirm(message)) return;

  const undoMeshes: Array<{ mesh: Mesh; indices: number[] }> = [];
  for (const [mesh, tris] of deletionMap.entries()) {
    const rawIndices = mesh.getIndices();
    const positions = mesh.getVerticesData('position');
    if (!positions) continue;
    const vertexCount = positions.length / 3;
    const indices = rawIndices && rawIndices.length > 0 ? Array.from(rawIndices) : Array.from({ length: vertexCount }, (_, i) => i);
    undoMeshes.push({ mesh, indices: indices.slice() });

    const next: number[] = [];
    for (let tri = 0; tri < indices.length / 3; tri++) {
      if (tris.has(tri)) continue;
      next.push(indices[tri * 3], indices[tri * 3 + 1], indices[tri * 3 + 2]);
    }
    mesh.setIndices(next);
    invalidateMeshTriangleCache(mesh);
    try { mesh.refreshBoundingInfo(); } catch {}
  }

  state.meshEditor.undoStack.push({ label: `suppression mesh (${formatNumber(nTotal)} tris, tous LOD)`, meshes: undoMeshes });
  if (state.meshEditor.undoStack.length > 20) state.meshEditor.undoStack.shift();
  clearMeshSelection();
  recomputeMeshTriangleCounts();
  refreshMeshLodTriangleCounts();
  applyMeshVisibilityFromState();
  renderMeshSubLayerList();
  updateLodHud();
  updateBboxInfo();
  updateMeshEditorStats();
  toast(lodLevels.size > 1
    ? `${formatNumber(nTotal)} triangles supprimés sur ${lodLevels.size} niveaux de LOD.`
    : `${formatNumber(nTotal)} triangles supprimés.`);
}


function countHiddenMeshTriangles(): number {
  let n = 0;
  for (const item of state.meshEditor.hiddenTriangles) {
    if (!item.mesh.isDisposed()) n += Math.floor(item.triplets.length / 3);
  }
  return n;
}

function hideSelectedMeshTriangles(): void {
  if (!state.assets.mesh) return toast('Aucun mesh chargé.', 'warn');
  const nSel = countSelectedMeshTriangles();
  if (nSel === 0) return toast('Aucune sélection mesh à masquer.', 'warn');

  // Même couverture que la suppression : la sélection porte déjà sur TOUS les
  // niveaux LOD, donc la zone masquée disparaît quel que soit le zoom.
  const map = cloneMeshTriangleMap(state.meshEditor.selected);
  let total = 0;
  for (const [mesh, tris] of map.entries()) {
    if (mesh.isDisposed() || tris.size === 0) continue;
    const rawIndices = mesh.getIndices();
    const positions = mesh.getVerticesData('position');
    if (!positions) continue;
    const vertexCount = positions.length / 3;
    const indices = rawIndices && rawIndices.length > 0 ? Array.from(rawIndices) : Array.from({ length: vertexCount }, (_, i) => i);

    // On retire les triangles du buffer d'indices (invisibles ET non piquables),
    // mais on garde leurs triplets de sommets : les sommets ne sont jamais touchés
    // par l'édition, donc la ré-injection au réaffichage est exacte au bit près.
    const triplets: number[] = [];
    const next: number[] = [];
    for (let tri = 0; tri < indices.length / 3; tri++) {
      const a = indices[tri * 3], b = indices[tri * 3 + 1], c = indices[tri * 3 + 2];
      if (tris.has(tri)) triplets.push(a, b, c);
      else next.push(a, b, c);
    }
    if (triplets.length === 0) continue;
    mesh.setIndices(next);
    invalidateMeshTriangleCache(mesh);
    try { mesh.refreshBoundingInfo(); } catch {}
    state.meshEditor.hiddenTriangles.push({ mesh, triplets });
    total += triplets.length / 3;
  }

  clearMeshSelection();
  recomputeMeshTriangleCounts();
  refreshMeshLodTriangleCounts();
  updateLodHud();
  updateMeshEditorStats();
  toast(`${formatNumber(total)} triangles masqués : invisibles, insélectionnables et protégés de la suppression. Nettoie derrière, puis « Réafficher faces masquées ». Les exports réafficheront tout automatiquement.`, 'info', 8000);
}

function unhideAllMeshTriangles(silent = false): number {
  const stash = state.meshEditor.hiddenTriangles;
  if (stash.length === 0) {
    if (!silent) toast('Aucune face masquée à réafficher.', 'warn');
    return 0;
  }
  let restored = 0;
  for (const item of stash) {
    const mesh = item.mesh;
    if (mesh.isDisposed()) continue;
    const raw = mesh.getIndices();
    const next = raw && raw.length > 0 ? Array.from(raw) : [];
    // Dédoublonnage : un Ctrl+Z intermédiaire peut avoir restauré une partie des
    // triplets via un snapshot d'undo antérieur au masquage. On ne ré-injecte que
    // ce qui manque, jamais deux fois le même triangle.
    const existing = new Set<string>();
    for (let t = 0; t < next.length / 3; t++) existing.add(`${next[t * 3]},${next[t * 3 + 1]},${next[t * 3 + 2]}`);
    for (let t = 0; t < item.triplets.length / 3; t++) {
      const a = item.triplets[t * 3], b = item.triplets[t * 3 + 1], c = item.triplets[t * 3 + 2];
      if (existing.has(`${a},${b},${c}`)) continue;
      next.push(a, b, c);
      restored++;
    }
    mesh.setIndices(next);
    invalidateMeshTriangleCache(mesh);
    try { mesh.refreshBoundingInfo(); } catch {}
  }
  state.meshEditor.hiddenTriangles = [];
  recomputeMeshTriangleCounts();
  refreshMeshLodTriangleCounts();
  applyMeshVisibilityFromState();
  updateLodHud();
  updateBboxInfo();
  updateMeshEditorStats();
  if (!silent) toast(`${formatNumber(restored)} triangles réaffichés.`);
  return restored;
}

/** Garde-fou export : les faces masquées ne sont PAS supprimées, elles doivent
 *  donc figurer dans tous les exports. On les réaffiche automatiquement. */
function restoreHiddenMeshTrianglesBeforeExport(): void {
  const n = unhideAllMeshTriangles(true);
  if (n > 0) toast(`${formatNumber(n)} faces masquées réaffichées automatiquement avant export (masquer ≠ supprimer).`, 'info', 6000);
}

function countMeshTriangleMap(map: Map<Mesh, Set<number>>): number {
  let n = 0;
  for (const set of map.values()) n += set.size;
  return n;
}

function cloneMeshTriangleMap(map: Map<Mesh, Set<number>>): Map<Mesh, Set<number>> {
  const out = new Map<Mesh, Set<number>>();
  for (const [mesh, set] of map.entries()) out.set(mesh, new Set(set));
  return out;
}

function findMeshLodGroup(mesh: Mesh): MeshLodGroup | null {
  for (const group of state.meshLod.groups) {
    for (const meshes of group.levels.values()) {
      if (meshes.includes(mesh)) return group;
    }
  }
  return null;
}

function expandMeshDeletionAcrossLodLevels(selected: Map<Mesh, Set<number>>): Map<Mesh, Set<number>> {
  const out = cloneMeshTriangleMap(selected);
  if (!state.meshLod.enabled || state.meshLod.groups.length === 0) return out;

  for (const [mesh, tris] of selected.entries()) {
    if (tris.size === 0) continue;
    const group = findMeshLodGroup(mesh);
    if (!group) continue;

    const region = buildSelectedTriangleWorldRegion(mesh, tris);
    if (!region) continue;

    for (const meshes of group.levels.values()) {
      for (const other of meshes) {
        if (other === mesh || other.isDisposed()) continue;
        const matches = findTrianglesMatchingWorldRegion(other, region, tris.size, mesh);
        if (matches.size === 0) continue;
        const set = out.get(other) ?? new Set<number>();
        for (const tri of matches) set.add(tri);
        out.set(other, set);
      }
    }
  }
  return out;
}

type SelectedTriangleWorldRegion = {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  samples: Float32Array;
  normals: Float32Array;
  tolerance: number;
  normalCos: number;
};

function buildSelectedTriangleWorldRegion(mesh: Mesh, tris: Set<number>): SelectedTriangleWorldRegion | null {
  const cache = getMeshTriangleCache(mesh);
  if (tris.size === 0) return null;

  const world = mesh.getWorldMatrix();
  const samples: number[] = [];
  const normals: number[] = [];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  // On limite le nombre d'échantillons pour garder une suppression fluide
  // sur les très gros plafonds/murs.
  const stride = Math.max(1, Math.ceil(tris.size / 3500));
  let seen = 0;
  for (const tri of tris) {
    seen++;
    if (stride > 1 && seen % stride !== 0) continue;
    const c = getTriangleWorldCentroidAndNormal(cache, tri, world);
    if (!c) continue;
    samples.push(c.x, c.y, c.z);
    normals.push(c.nx, c.ny, c.nz);
    minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); minZ = Math.min(minZ, c.z);
    maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y); maxZ = Math.max(maxZ, c.z);
  }

  if (samples.length === 0) return null;
  const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
  const diag = Math.sqrt(dx * dx + dy * dy + dz * dz);

  // Tolérance volontairement bornée :
  // - assez grande pour retrouver la même zone sur un LOD plus grossier ;
  // - assez petite pour éviter de manger un plafond entier ou un mur voisin.
  const tolerance = Math.max(0.018, Math.min(0.10, diag * 0.045));
  const pad = tolerance * 2.2;

  return {
    minX: minX - pad, minY: minY - pad, minZ: minZ - pad,
    maxX: maxX + pad, maxY: maxY + pad, maxZ: maxZ + pad,
    samples: new Float32Array(samples),
    normals: new Float32Array(normals),
    tolerance,
    normalCos: Math.cos(42 * Math.PI / 180),
  };
}

function findTrianglesMatchingWorldRegion(
  mesh: Mesh,
  region: SelectedTriangleWorldRegion,
  sourceSelectedCount: number,
  sourceMesh: Mesh,
): Set<number> {
  const out = new Set<number>();
  const cache = getMeshTriangleCache(mesh);
  const world = mesh.getWorldMatrix();
  const tol2 = region.tolerance * region.tolerance;

  for (let tri = 0; tri < cache.triangleCount; tri++) {
    const c = getTriangleWorldCentroidAndNormal(cache, tri, world);
    if (!c) continue;
    if (c.x < region.minX || c.x > region.maxX || c.y < region.minY || c.y > region.maxY || c.z < region.minZ || c.z > region.maxZ) continue;

    for (let i = 0; i < region.samples.length; i += 3) {
      const ni = i; // normals and samples share the same stride.
      const nx = region.normals[ni], ny = region.normals[ni + 1], nz = region.normals[ni + 2];
      const dot = Math.abs(c.nx * nx + c.ny * ny + c.nz * nz);
      if (dot < region.normalCos) continue;
      const dx = c.x - region.samples[i];
      const dy = c.y - region.samples[i + 1];
      const dz = c.z - region.samples[i + 2];
      if (dx * dx + dy * dy + dz * dz <= tol2) {
        out.add(tri);
        break;
      }
    }
  }

  // Sécurité anti-catastrophe : si la correspondance veut supprimer une part
  // énorme d'un autre LOD alors que la sélection source est petite, on ignore
  // ce LOD au lieu de refaire le problème "moitié du plafond supprimée".
  const sourceTriCount = Math.max(1, getMeshTriangleCache(sourceMesh).triangleCount);
  const targetTriCount = Math.max(1, cache.triangleCount);
  const sourceRatio = sourceSelectedCount / sourceTriCount;
  const targetRatio = out.size / targetTriCount;
  const tooMuch = targetRatio > Math.max(0.35, sourceRatio * 8 + 0.08);
  if (tooMuch) {
    console.warn(`[MAGO] Suppression LOD ignorée par sécurité pour ${mesh.name}: ${out.size}/${targetTriCount} triangles.`);
    return new Set<number>();
  }

  return out;
}

function getTriangleWorldCentroidAndNormal(
  cache: MeshTriangleCache,
  tri: number,
  world: Matrix,
): { x: number; y: number; z: number; nx: number; ny: number; nz: number } | null {
  if (tri < 0 || tri >= cache.triangleCount) return null;
  const o = tri * 9;
  const v = cache.vertices;
  const p0 = Vector3.TransformCoordinates(new Vector3(v[o], v[o + 1], v[o + 2]), world);
  const p1 = Vector3.TransformCoordinates(new Vector3(v[o + 3], v[o + 4], v[o + 5]), world);
  const p2 = Vector3.TransformCoordinates(new Vector3(v[o + 6], v[o + 7], v[o + 8]), world);
  const x = (p0.x + p1.x + p2.x) / 3;
  const y = (p0.y + p1.y + p2.y) / 3;
  const z = (p0.z + p1.z + p2.z) / 3;
  const ax = p1.x - p0.x, ay = p1.y - p0.y, az = p1.z - p0.z;
  const bx = p2.x - p0.x, by = p2.y - p0.y, bz = p2.z - p0.z;
  let nx = ay * bz - az * by;
  let ny = az * bx - ax * bz;
  let nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz);
  if (!Number.isFinite(len) || len < 1e-12) return null;
  nx /= len; ny /= len; nz /= len;
  return { x, y, z, nx, ny, nz };
}

function refreshMeshLodTriangleCounts(): void {
  const lod = state.meshLod;
  if (!lod.groups.length) return;
  lod.availableLevels = Array.from(new Set(lod.availableLevels)).sort((a, b) => a - b);
  for (const group of lod.groups) {
    group.triangleCounts.clear();
    for (const [level, meshes] of group.levels.entries()) {
      let tris = 0;
      for (const mesh of meshes) {
        if (!mesh.isDisposed()) tris += Math.floor((mesh.getTotalIndices?.() ?? 0) / 3);
      }
      group.triangleCounts.set(level, tris);
    }
  }
}


// Reclasse les triangles sélectionnés vers une autre classe : ils sont détachés
// de leur pièce d'origine et deviennent une nouvelle pièce (texture conservée)
// rattachée à la couche de la classe cible. Annulable.
function reclassifySelectedTriangles(targetClassKey: string): void {
  if (!state.assets.mesh) return toast('Aucun mesh chargé.', 'warn');
  if (!targetClassKey) return toast('Choisis une classe cible.', 'warn');
  const n = countSelectedMeshTriangles();
  if (n === 0) return toast('Aucune sélection mesh à reclasser.', 'warn');

  const asset = state.assets.mesh;
  const targetLayer = (asset.meshLayers ?? []).find((l) => l.classKey === targetClassKey);
  const targetName = targetLayer?.name ?? targetClassKey;
  if (!confirm(`Reclasser ${formatNumber(n)} triangles vers « ${targetName} » ?`)) return;

  const undoMeshes: Array<{ mesh: Mesh; indices: number[] }> = [];
  const created: Mesh[] = [];

  for (const [mesh, tris] of state.meshEditor.selected.entries()) {
    if (tris.size === 0) continue;
    if ((mesh.metadata as any)?.magoClassKey === targetClassKey) continue; // déjà dans la classe cible
    const rawIndices = mesh.getIndices();
    const positions = mesh.getVerticesData('position');
    if (!positions) continue;
    const vertexCount = positions.length / 3;
    const indices = rawIndices && rawIndices.length > 0
      ? Array.from(rawIndices)
      : Array.from({ length: vertexCount }, (_, i) => i);
    undoMeshes.push({ mesh, indices: indices.slice() });

    // 1. nouvelle pièce = clone EXACT de la source (même matériau, mêmes attributs
    //    de rendu) restreint aux seuls triangles sélectionnés -> apparence identique.
    //    Le nom = la classe cible : à la réimport, le loader regroupe par nom de nœud,
    //    donc c'est ce qui fait persister le reclassement dans le GLB exporté.
    // Les clones issus d'un mesh LODx doivent rester dans le système LOD, sinon
    // les pièces reclassées des 3-4 niveaux s'affichent toutes en même temps.
    const srcLevel = state.meshLod.meshLevel.get(mesh);
    const pieceName = srcLevel != null ? `${targetClassKey}_LOD${srcLevel}` : targetClassKey;
    const piece = mesh.clone(pieceName, mesh.parent, true) as Mesh;
    piece.makeGeometryUnique(); // géométrie indépendante : ne pas impacter la source
    if (srcLevel != null) state.meshLod.meshLevel.set(piece, srcLevel);
    const pieceIdx: number[] = [];
    for (const tri of tris) {
      pieceIdx.push(indices[tri * 3], indices[tri * 3 + 1], indices[tri * 3 + 2]);
    }
    piece.setIndices(pieceIdx);
    piece.metadata = { ...(mesh.metadata ?? {}), magoClassKey: targetClassKey };
    try { piece.refreshBoundingInfo(); } catch {}
    created.push(piece);

    // 2. retirer ces triangles de la pièce source
    const next: number[] = [];
    for (let tri = 0; tri < indices.length / 3; tri++) {
      if (tris.has(tri)) continue;
      next.push(indices[tri * 3], indices[tri * 3 + 1], indices[tri * 3 + 2]);
    }
    mesh.setIndices(next);
    invalidateMeshTriangleCache(mesh);
    try { mesh.refreshBoundingInfo(); } catch {}
  }

  if (created.length === 0) return toast('La sélection est déjà dans cette classe.', 'warn');

  // 3. rattacher les nouvelles pièces à l'asset + à la couche cible
  let layer = (asset.meshLayers ?? []).find((l) => l.classKey === targetClassKey);
  if (!layer && asset.meshLayers) {
    layer = { id: `mesh-layer-reclass-${targetClassKey}`, name: targetName, classKey: targetClassKey, meshes: [], visible: true, triangleCount: 0 };
    asset.meshLayers.push(layer);
  }
  for (const piece of created) {
    asset.meshes.push(piece);
    layer?.meshes.push(piece);
  }

  state.meshEditor.undoStack.push({ label: `reclassement → ${targetName} (${formatNumber(n)} tris)`, meshes: undoMeshes, created });
  if (state.meshEditor.undoStack.length > 20) state.meshEditor.undoStack.shift();
  clearMeshSelection();
  recomputeMeshTriangleCounts();
  renderMeshSubLayerList();
  updateBboxInfo();
  updateMeshEditorStats();
  toast(`${formatNumber(n)} triangles reclassés vers « ${targetName} ».`);
}


/** Ajoute, sans dépendre du HTML, le bouton métier qui transforme une sélection de triangles en nouvel objet. */
function ensureMeshCreateObjectControls(): void {
  if (document.getElementById('btn-mesh-create-object')) return;

  const anchor =
    document.getElementById('btn-mesh-reclass') ||
    document.getElementById('btn-mesh-delete-selection') ||
    document.getElementById('mesh-edit-selected');
  const host = anchor?.parentElement;
  if (!host) return;

  const block = document.createElement('div');
  block.className = 'mesh-create-object-block';
  block.style.marginTop = '8px';
  block.style.paddingTop = '8px';
  block.style.borderTop = '1px solid rgba(255,255,255,0.08)';
  block.innerHTML = `
    <button id="btn-mesh-create-object" class="btn secondary" type="button" disabled style="width:100%;">
      Créer objet depuis sélection
    </button>
    <div class="hint" style="margin-top:6px; font-size:11px; opacity:.75; line-height:1.35;">
      Détache les triangles sélectionnés et crée une nouvelle instance dans la même classe.
      Utile pour séparer deux tables ou objets collés.
    </div>
  `;
  host.appendChild(block);
}

function sanitizeMagoKeyToken(value: string): string {
  return (value || 'objet')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'objet';
}

function nextManualInstanceIndexForClass(classId: string): number {
  const layers = state.assets.mesh?.meshLayers ?? [];
  let maxIndex = 0;
  for (const layer of layers) {
    if (layerClassId(layer) !== classId) continue;
    if (typeof layer.instanceIndex === 'number') maxIndex = Math.max(maxIndex, layer.instanceIndex);
    const raw = `${layer.classKey || ''} ${layer.name || ''} ${layer.instanceName || ''}`;
    const matches = Array.from(raw.matchAll(/(?:inst[_\s-]*|objet\s*|table\s*|chaise\s*)(\d+)/gi));
    for (const m of matches) maxIndex = Math.max(maxIndex, Number(m[1]));
  }
  return maxIndex + 1;
}

function buildManualInstanceKey(sourceLayer: MeshSubLayer | null, classId: string, className: string, index: number): string {
  const pad = String(index).padStart(3, '0');
  const sourceKey = sourceLayer?.classKey || sourceLayer?.name || '';
  const cleaned = sourceKey
    .replace(/_LOD\d+.*$/i, '')
    .replace(/_inst_\d+$/i, '')
    .replace(/_manual_\d+$/i, '');
  if (/^class_/.test(cleaned)) return `${cleaned}_inst_${pad}`;
  return `class_${classId}_${sanitizeMagoKeyToken(className)}_inst_${pad}`;
}

/**
 * Crée une nouvelle instance à partir des triangles sélectionnés.
 * Les triangles sont retirés de l'objet source et ajoutés à un nouvel objet de la même classe.
 * C'est volontairement manuel : parfait pour séparer deux tables collées après le pipeline automatique.
 */
function createMeshObjectFromSelection(): void {
  if (!state.assets.mesh) return toast('Aucun mesh chargé.', 'warn');
  const n = countSelectedMeshTriangles();
  if (n === 0) return toast('Aucune sélection mesh.', 'warn');
  if (!confirm(`Créer un nouvel objet à partir de ${formatNumber(n)} triangles sélectionnés ?\n\nLes triangles seront retirés de l’objet actuel et déplacés dans une nouvelle instance.`)) return;

  const asset = state.assets.mesh;
  const undoMeshes: Array<{ mesh: Mesh; indices: number[] }> = [];
  const created: Mesh[] = [];
  const createdLayerIds: string[] = [];
  const expandedClasses = new Set<string>();

  for (const [mesh, tris] of Array.from(state.meshEditor.selected.entries())) {
    if (tris.size === 0) continue;
    const rawIndices = mesh.getIndices();
    const positions = mesh.getVerticesData('position');
    if (!positions) continue;
    const vertexCount = positions.length / 3;
    const indices = rawIndices && rawIndices.length > 0
      ? Array.from(rawIndices)
      : Array.from({ length: vertexCount }, (_, i) => i);

    const sourceLayer = findLayerForMesh(mesh);
    const classId = sourceLayer ? layerClassId(sourceLayer) : parseMagoLayer((mesh.metadata as any)?.magoClassKey || mesh.name).classId;
    const className = sourceLayer ? layerClassName(sourceLayer) : parseMagoLayer((mesh.metadata as any)?.magoClassKey || mesh.name).className;
    const nextIndex = nextManualInstanceIndexForClass(classId);
    const instanceKey = buildManualInstanceKey(sourceLayer, classId, className, nextIndex);
    const instanceName = `${className} ${nextIndex}`;
    const layerId = `mesh-layer-manual-${instanceKey}-${Date.now()}-${created.length}`;

    undoMeshes.push({ mesh, indices: indices.slice() });

    const piece = mesh.clone(instanceKey, mesh.parent, true) as Mesh;
    piece.name = instanceKey;
    piece.id = instanceKey;
    piece.makeGeometryUnique();
    const pieceIdx: number[] = [];
    for (const tri of tris) {
      pieceIdx.push(indices[tri * 3], indices[tri * 3 + 1], indices[tri * 3 + 2]);
    }
    piece.setIndices(pieceIdx);
    piece.metadata = {
      ...(mesh.metadata ?? {}),
      magoClassKey: instanceKey,
      magoClassId: classId,
      magoClassName: className,
      magoInstanceName: instanceName,
      magoManualObject: true,
    };
    try { piece.refreshBoundingInfo(); } catch {}

    const next: number[] = [];
    for (let tri = 0; tri < indices.length / 3; tri++) {
      if (tris.has(tri)) continue;
      next.push(indices[tri * 3], indices[tri * 3 + 1], indices[tri * 3 + 2]);
    }
    mesh.setIndices(next);
    invalidateMeshTriangleCache(mesh);
    try { mesh.refreshBoundingInfo(); } catch {}

    const newLayer: MeshSubLayer = {
      id: layerId,
      name: instanceName,
      classKey: instanceKey,
      classId,
      className,
      instanceName,
      instanceIndex: nextIndex,
      meshes: [piece],
      visible: true,
      triangleCount: Math.floor(pieceIdx.length / 3),
    };

    asset.meshes.push(piece);
    if (!asset.meshLayers) asset.meshLayers = [];
    asset.meshLayers.push(newLayer);
    created.push(piece);
    createdLayerIds.push(layerId);
    expandedClasses.add(classId);
  }

  if (created.length === 0) return toast('Aucun objet créé à partir de cette sélection.', 'warn');

  for (const cid of expandedClasses) meshTreeExpandedClasses.add(cid);
  state.selectedLayerId = createdLayerIds[createdLayerIds.length - 1] ?? state.selectedLayerId;
  state.meshEditor.undoStack.push({ label: `création objet (${formatNumber(n)} tris)`, meshes: undoMeshes, created, createdLayers: createdLayerIds });
  if (state.meshEditor.undoStack.length > 20) state.meshEditor.undoStack.shift();

  clearMeshSelection();
  recomputeMeshTriangleCounts();
  renderMeshSubLayerList();
  renderSceneObjectList();
  updateBboxInfo();
  updateMeshEditorStats();
  toast(`${created.length} nouvel objet créé depuis la sélection.`);
}

// Remplit le menu déroulant des classes cibles avec les classes présentes.
function refreshReclassTargets(): void {
  const sel = document.getElementById('mesh-reclass-target') as HTMLSelectElement | null;
  if (!sel) return;
  const previous = sel.value;
  const layers = state.assets.mesh?.meshLayers ?? [];
  sel.innerHTML = '';
  for (const layer of layers) {
    const o = document.createElement('option');
    o.value = layer.classKey;
    o.textContent = layer.name;
    sel.appendChild(o);
  }
  if (previous && layers.some((l) => l.classKey === previous)) sel.value = previous;
}

function undoLastMeshEdit(): void {
  const snap = state.meshEditor.undoStack.pop();
  if (!snap) return toast('Rien à annuler pour le mesh.', 'warn');
  for (const item of snap.meshes) {
    if (!item.mesh.isDisposed()) {
      item.mesh.setIndices(item.indices.slice());
      invalidateMeshTriangleCache(item.mesh);
      try { item.mesh.refreshBoundingInfo(); } catch {}
    }
  }
  // Reclassement : retirer les pièces créées
  if (snap.created && snap.created.length) {
    const asset = state.assets.mesh;
    if (asset && snap.createdLayers && snap.createdLayers.length) {
      const ids = new Set(snap.createdLayers);
      asset.meshLayers = (asset.meshLayers ?? []).filter((l) => !ids.has(l.id));
    }
    for (const piece of snap.created) {
      if (asset) {
        asset.meshes = asset.meshes.filter((m) => m !== piece);
        for (const layer of asset.meshLayers ?? []) {
          layer.meshes = layer.meshes.filter((m) => m !== piece);
        }
      }
      invalidateMeshTriangleCache(piece);
      try { piece.dispose(); } catch {}
    }
  }
  clearMeshSelection();
  recomputeMeshTriangleCounts();
  refreshMeshLodTriangleCounts();
  applyMeshVisibilityFromState();
  renderMeshSubLayerList();
  updateLodHud();
  updateBboxInfo();
  updateMeshEditorStats();
  toast(`Annulation : ${snap.label}.`);
}

function recomputeMeshTriangleCounts(): void {
  const asset = state.assets.mesh;
  if (!asset) return;
  asset.triangleCount = Math.floor(asset.meshes.reduce((sum, m) => sum + (m.getTotalIndices?.() ?? 0), 0) / 3);
  for (const layer of asset.meshLayers ?? []) {
    layer.triangleCount = Math.floor(layer.meshes.reduce((sum, m) => sum + (m.getTotalIndices?.() ?? 0), 0) / 3);
  }
  const countEl = document.getElementById('count-mesh');
  if (countEl) countEl.textContent = `${formatNumber(asset.triangleCount)} tris`;
}

function pointInPolygonLocal(x: number, y: number, poly: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// =================================================================
//  SPLAT EDITOR / LASSO / WHITE FILTER
// =================================================================

function bindSplatEditorControls(): void {
  const lightness = document.getElementById('splat-lightness') as HTMLInputElement | null;
  const neutrality = document.getElementById('splat-neutrality') as HTMLInputElement | null;
  const lightnessVal = document.getElementById('val-splat-lightness');
  const neutralityVal = document.getElementById('val-splat-neutrality');
  const mode = document.getElementById('splat-selection-mode') as HTMLSelectElement | null;
  const brush = document.getElementById('splat-brush-size') as HTMLInputElement | null;
  const brushVal = document.getElementById('val-splat-brush-size');
  const sorK = document.getElementById('splat-sor-k') as HTMLInputElement | null;
  const sorKVal = document.getElementById('val-splat-sor-k');
  const sorSigma = document.getElementById('splat-sor-sigma') as HTMLInputElement | null;
  const sorSigmaVal = document.getElementById('val-splat-sor-sigma');
  const meshDist = document.getElementById('splat-mesh-dist') as HTMLInputElement | null;
  const meshDistVal = document.getElementById('val-splat-mesh-dist');

  const updateSettings = () => {
    if (lightness) state.splatEditor.settings.lightnessMin = parseFloat(lightness.value);
    if (neutrality) state.splatEditor.settings.neutralityMin = parseFloat(neutrality.value);
    if (mode) state.splatEditor.selectionMode = mode.value as AppState['splatEditor']['selectionMode'];
    if (brush) state.splatEditor.brushSize = parseFloat(brush.value);
    if (lightnessVal) lightnessVal.textContent = `${Math.round(state.splatEditor.settings.lightnessMin * 100)}%`;
    if (neutralityVal) neutralityVal.textContent = `${Math.round(state.splatEditor.settings.neutralityMin * 100)}%`;
    if (brushVal) brushVal.textContent = `${Math.round(state.splatEditor.brushSize)} px`;
    if (sorK) state.splatEditor.sor.k = Math.max(1, Math.round(parseFloat(sorK.value)));
    if (sorSigma) state.splatEditor.sor.nSigma = parseFloat(sorSigma.value);
    if (sorKVal) sorKVal.textContent = String(state.splatEditor.sor.k);
    if (sorSigmaVal) sorSigmaVal.textContent = state.splatEditor.sor.nSigma.toFixed(1);
    if (meshDist) state.splatEditor.meshDist.maxDistance = parseFloat(meshDist.value) / 100; // cm → m
    if (meshDistVal) meshDistVal.textContent = `${Math.round(state.splatEditor.meshDist.maxDistance * 100)} cm`;
    updateSplatEditorStats();
  };

  lightness?.addEventListener('input', updateSettings);
  neutrality?.addEventListener('input', updateSettings);
  mode?.addEventListener('change', updateSettings);
  brush?.addEventListener('input', updateSettings);
  sorK?.addEventListener('input', updateSettings);
  sorSigma?.addEventListener('input', updateSettings);
  meshDist?.addEventListener('input', updateSettings);
  updateSettings();

  document.getElementById('btn-splat-light-preview')?.addEventListener('click', async () => {
    await setLightOnlyPreview(true);
  });
  document.getElementById('btn-splat-show-all')?.addEventListener('click', async () => {
    await setLightOnlyPreview(false);
  });
  document.getElementById('btn-splat-delete-light')?.addEventListener('click', async () => {
    await deleteVisibleLightSplats();
  });
  document.getElementById('btn-splat-lasso')?.addEventListener('click', () => {
    setLassoActive(!state.splatEditor.lassoActive);
  });
  document.getElementById('btn-splat-delete-selection')?.addEventListener('click', async () => {
    await deleteSelectedSplats();
  });
  document.getElementById('btn-splat-sor-detect')?.addEventListener('click', async () => {
    await detectSplatOutliersSor();
  });
  document.getElementById('btn-splat-meshdist-detect')?.addEventListener('click', async () => {
    await detectSplatsFarFromMesh();
  });
  document.getElementById('btn-splat-hide-selection')?.addEventListener('click', async () => {
    await hideSelectedSplats();
  });
  document.getElementById('btn-splat-unhide')?.addEventListener('click', async () => {
    await unhideAllSplats();
  });
  document.getElementById('btn-splat-clear-selection')?.addEventListener('click', () => {
    state.splatEditor.selectedMask = null;
    state.splatEditor.lassoPoints = [];
    clearLassoOverlay();
    updateSplatEditorStats();
    toast('Sélection effacée.');
  });
  document.getElementById('btn-splat-undo')?.addEventListener('click', () => {
    void undoLastSplatEdit();
  });
  document.getElementById('btn-splat-restore-zone')?.addEventListener('click', () => {
    setSplatRestoreActive(!state.splatEditor.restoreActive);
  });
  document.getElementById('btn-splat-export-current')?.addEventListener('click', () => {
    exportCurrentSplats();
  });
  document.getElementById('btn-splat-export-aligned')?.addEventListener('click', () => {
    exportCurrentSplatsAligned();
  });
  document.getElementById('btn-splat-reset-filter')?.addEventListener('click', async () => {
    await resetSplatFilter();
  });

  bindLassoCanvasEvents();
}

async function initialiseSplatEditor(file: File): Promise<SplatPlyData | null> {
  try {
    const data = await parseSplatPly(file);
    const baseMask = createFullMask(data.vertexCount);
    state.splatEditor.data = data;
    state.splatEditor.baseMask = baseMask;
    state.splatEditor.visibleMask = baseMask;
    state.splatEditor.selectedMask = null;
    state.splatEditor.hiddenMask = null;
    state.splatEditor.lightOnly = false;
    state.splatEditor.undoStack = [];
    updateSplatEditorStats();
    toast(`Édition splats prête : ${formatNumber(data.vertexCount)} splats analysés.`);
    return data;
  } catch (e) {
    console.warn(e);
    state.splatEditor.data = null;
    state.splatEditor.baseMask = null;
    state.splatEditor.visibleMask = null;
    state.splatEditor.selectedMask = null;
    state.splatEditor.hiddenMask = null;
    state.splatEditor.undoStack = [];
    updateSplatEditorStats((e as Error).message);
    toast(`Edition splats indisponible : ${(e as Error).message}`, 'warn', 7000);
    return null;
  }
}

async function attachSplatPickingData(asset: LoadedAsset, file: File): Promise<void> {
  try {
    (asset as any).splatPlyData = await parseSplatPly(file);
  } catch (e) {
    (asset as any).splatPlyData = null;
    console.warn('Piquage splats indisponible pour cet asset :', e);
  }
}

function computeSplatVisibleMask(): Uint8Array {
  // Visible = baseMask (∩ filtre blancs/clairs si actif) − splats masqués (isolation).
  const ed = state.splatEditor;
  let mask = ed.lightOnly ? buildLightMask(ed.data!, ed.settings, ed.baseMask!) : ed.baseMask!;
  if (ed.hiddenMask) mask = subtractMask(mask, ed.hiddenMask);
  return mask;
}

function countHiddenSplats(): number {
  const ed = state.splatEditor;
  if (!ed.hiddenMask || !ed.baseMask) return 0;
  // Seuls les splats masqués encore présents dans le fichier comptent.
  return countMask(intersectMasks(ed.hiddenMask, ed.baseMask));
}

async function hideSelectedSplats(): Promise<void> {
  const ed = state.splatEditor;
  if (!ed.data || !ed.baseMask) return toast('Aucun PLY de splats éditable chargé.', 'warn');
  if (!ed.selectedMask) return toast('Aucune sélection à masquer. Sélectionne d’abord (lasso, rectangle, rond ou pinceau).', 'warn');
  const visible = ed.visibleMask ?? ed.baseMask;
  const toHide = intersectMasks(visible, ed.selectedMask);
  const n = countMask(toHide);
  if (n === 0) return toast('La sélection ne contient aucun splat visible.', 'warn');
  pushSplatUndo(`masquage sélection (${formatNumber(n)})`);
  ed.hiddenMask = ed.hiddenMask ? unionMasks(ed.hiddenMask, toHide) : toHide;
  const nextVisible = computeSplatVisibleMask();
  // updateExportFile=false : masquer n'est PAS supprimer, les exports gardent tout.
  await reloadSplatsFromMask(nextVisible, 'splats_isolation_preview.ply', false);
  ed.visibleMask = nextVisible;
  ed.selectedMask = null;
  ed.lassoPoints = [];
  clearLassoOverlay();
  updateSplatEditorStats();
  toast(`${formatNumber(n)} splats masqués : invisibles, insélectionnables et protégés de la suppression. Nettoie les splats flottants derrière, puis « Réafficher splats masqués ».`, 'info', 8000);
}

async function unhideAllSplats(): Promise<void> {
  const ed = state.splatEditor;
  if (!ed.data || !ed.baseMask) return toast('Aucun PLY de splats éditable chargé.', 'warn');
  const n = countHiddenSplats();
  if (n === 0) return toast('Aucun splat masqué à réafficher.', 'warn');
  pushSplatUndo(`réaffichage splats masqués (${formatNumber(n)})`);
  ed.hiddenMask = null;
  const nextVisible = computeSplatVisibleMask();
  await reloadSplatsFromMask(nextVisible, ed.lightOnly ? 'splats_clairs_preview.ply' : ed.data.fileName, false);
  ed.visibleMask = nextVisible;
  ed.selectedMask = null;
  clearLassoOverlay();
  updateSplatEditorStats();
  toast(`${formatNumber(n)} splats réaffichés.`);
}

async function detectSplatOutliersSor(): Promise<void> {
  const ed = state.splatEditor;
  if (!ed.data || !ed.baseMask) return toast('Charge un fichier de splats PLY avant de lancer le SOR.', 'warn');
  if (ed.sor.running) return toast('Détection SOR déjà en cours…', 'warn');

  ed.sor.running = true;
  const btn = document.getElementById('btn-splat-sor-detect') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  try {
    setStatus('SOR…');
    showProgress(0, 'SOR : analyse des voisinages');
    // Candidats = ce qui est affiché (respecte isolation + filtre blancs/clairs).
    // Voisins = tout ce qui existe encore dans le fichier : un splat masqué reste
    // un voisin physique valide, sinon on sur-détecterait le long des zones isolées.
    const candidates = ed.visibleMask ?? ed.baseMask;
    const outliers = await buildSorOutlierMask({
      data: ed.data,
      neighborMask: ed.baseMask,
      candidateMask: candidates,
      k: ed.sor.k,
      nSigma: ed.sor.nSigma,
      onProgress: (done, total) => showProgress((done / total) * 100, `SOR : ${formatNumber(done)} / ${formatNumber(total)} splats`),
    });
    const n = countMask(outliers);
    ed.selectedMask = n > 0 ? outliers : null;
    ed.lassoPoints = [];
    updateSplatEditorStats();
    clearLassoOverlay();
    if (n > 0) {
      drawSelectionHighlightOverlay();
      toast(`SOR : ${formatNumber(n)} flotteurs détectés et surlignés en jaune (k=${ed.sor.k}, seuil ${ed.sor.nSigma.toFixed(1)}σ). Vérifie visuellement puis « Supprimer sélection surlignée » — ou baisse le seuil pour détecter plus.`, 'info', 9000);
    } else {
      toast(`SOR : aucun flotteur détecté avec k=${ed.sor.k} et seuil ${ed.sor.nSigma.toFixed(1)}σ. Baisse le seuil (n·σ) pour une détection plus agressive.`, 'info', 7000);
    }
  } catch (e) {
    console.error(e);
    toast('Échec SOR : ' + (e as Error).message, 'error', 7000);
  } finally {
    ed.sor.running = false;
    if (btn) btn.disabled = false;
    hideProgress();
    setStatus('prêt');
  }
}

function collectMeshWorldTriangles(): { positions: Float32Array; indices: Uint32Array; triCount: number } | null {
  const asset = state.assets.mesh;
  if (!asset) return null;

  // Référence géométrique = LOD le plus fin disponible (les LOD grossiers sont des
  // décimations de la même surface : inutile de les dupliquer dans la grille).
  let finest = Infinity;
  for (const mesh of asset.meshes) {
    const lvl = state.meshLod.meshLevel.get(mesh as Mesh);
    if (lvl != null && lvl < finest) finest = lvl;
  }
  const useMesh = (m: Mesh): boolean => {
    if (m.isDisposed() || (m.getTotalVertices?.() ?? 0) === 0) return false;
    const lvl = state.meshLod.meshLevel.get(m);
    return lvl == null || !Number.isFinite(finest) || lvl === finest;
  };

  // Les faces masquées (isolation) appartiennent toujours à la surface : on les
  // ré-injecte dans la référence pour ne pas flagger les splats qui les longent.
  const hiddenByMesh = new Map<Mesh, number[]>();
  for (const item of state.meshEditor.hiddenTriangles) {
    if (item.mesh.isDisposed()) continue;
    const arr = hiddenByMesh.get(item.mesh) ?? [];
    arr.push(...item.triplets);
    hiddenByMesh.set(item.mesh, arr);
  }

  let vTotal = 0, iTotal = 0;
  const parts: Array<{ mesh: Mesh; pos: Float32Array; idx: number[] }> = [];
  for (const m of asset.meshes) {
    if (!(m instanceof Mesh) || !useMesh(m)) continue;
    const pos = m.getVerticesData('position') as Float32Array | null;
    if (!pos) continue;
    const raw = m.getIndices();
    const idx = raw && raw.length > 0 ? Array.from(raw) : Array.from({ length: pos.length / 3 }, (_, i) => i);
    const hidden = hiddenByMesh.get(m);
    if (hidden) idx.push(...hidden);
    if (idx.length === 0) continue;
    parts.push({ mesh: m, pos, idx });
    vTotal += pos.length / 3;
    iTotal += idx.length;
  }
  if (iTotal === 0) return null;

  const positions = new Float32Array(vTotal * 3);
  const indices = new Uint32Array(iTotal);
  let vOff = 0, iOff = 0;
  const tmp = Vector3.Zero();
  for (const part of parts) {
    part.mesh.computeWorldMatrix(true);
    const world = part.mesh.getWorldMatrix();
    const nv = part.pos.length / 3;
    for (let v = 0; v < nv; v++) {
      tmp.set(part.pos[v * 3], part.pos[v * 3 + 1], part.pos[v * 3 + 2]);
      const w = Vector3.TransformCoordinates(tmp, world);
      positions[(vOff + v) * 3] = w.x;
      positions[(vOff + v) * 3 + 1] = w.y;
      positions[(vOff + v) * 3 + 2] = w.z;
    }
    for (let k2 = 0; k2 < part.idx.length; k2++) indices[iOff + k2] = part.idx[k2] + vOff;
    vOff += nv;
    iOff += part.idx.length;
  }
  return { positions, indices, triCount: Math.floor(iTotal / 3) };
}

async function detectSplatsFarFromMesh(): Promise<void> {
  const ed = state.splatEditor;
  if (!ed.data || !ed.baseMask) return toast('Charge un fichier de splats PLY avant de lancer le filtre.', 'warn');
  if (!state.assets.mesh) return toast('Charge le mesh de référence : ce filtre mesure la distance des splats à sa surface.', 'warn');
  if (!state.assets.splat) return toast('Aucun objet splats dans la scène.', 'warn');
  if (ed.meshDist.running) return toast('Filtre distance au mesh déjà en cours…', 'warn');

  ed.meshDist.running = true;
  const btn = document.getElementById('btn-splat-meshdist-detect') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  try {
    setStatus('distance au mesh…');
    showProgress(0, 'Distance au mesh : préparation des triangles');
    // Laisse le navigateur afficher la barre avant la collecte (synchrone).
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const tris = collectMeshWorldTriangles();
    if (!tris) {
      toast('Impossible de récupérer les triangles du mesh.', 'error');
      return;
    }

    const node = state.assets.splat.rootNode as TransformNode;
    node.computeWorldMatrix(true);
    const splatWorld = node.getWorldMatrix();

    const candidates = ed.visibleMask ?? ed.baseMask;
    const dCm = ed.meshDist.maxDistance * 100;
    const outliers = await buildFarFromMeshMask({
      data: ed.data,
      candidateMask: candidates,
      splatWorldMatrix: splatWorld,
      meshPositions: tris.positions,
      meshIndices: tris.indices,
      maxDistance: ed.meshDist.maxDistance,
      onProgress: (done, total) => showProgress((done / total) * 100, `Distance au mesh : ${formatNumber(done)} / ${formatNumber(total)} splats`),
    });
    const n = countMask(outliers);
    ed.selectedMask = n > 0 ? outliers : null;
    ed.lassoPoints = [];
    updateSplatEditorStats();
    clearLassoOverlay();
    if (n > 0) {
      drawSelectionHighlightOverlay();
      toast(`${formatNumber(n)} splats à plus de ${dCm.toFixed(0)} cm du mesh (${formatNumber(tris.triCount)} triangles de référence), surlignés en jaune. Vérifie que le GS est bien recalé sur le mesh, puis « Supprimer sélection surlignée ».`, 'info', 9000);
    } else {
      toast(`Aucun splat à plus de ${dCm.toFixed(0)} cm du mesh. Baisse la distance pour un nettoyage plus serré.`, 'info', 7000);
    }
  } catch (e) {
    console.error(e);
    toast('Échec filtre distance au mesh : ' + (e as Error).message, 'error', 7000);
  } finally {
    ed.meshDist.running = false;
    if (btn) btn.disabled = false;
    hideProgress();
    setStatus('prêt');
  }
}

async function setLightOnlyPreview(enabled: boolean): Promise<void> {
  const ed = state.splatEditor;
  if (!ed.data || !ed.baseMask) {
    toast('Charge un fichier de splats PLY avant d’utiliser ce filtre.', 'warn');
    return;
  }
  ed.lightOnly = enabled;
  const mask = computeSplatVisibleMask();
  await reloadSplatsFromMask(mask, enabled ? 'splats_clairs_preview.ply' : ed.data.fileName, false);
  ed.visibleMask = mask;
  ed.selectedMask = null;
  updateSplatEditorStats();
  toast(enabled ? 'Aperçu : seuls les splats blancs/clairs sont affichés.' : 'Tous les splats restants sont affichés.');
}

async function deleteVisibleLightSplats(): Promise<void> {
  const ed = state.splatEditor;
  if (!ed.data || !ed.baseMask) return toast('Aucun PLY de splats éditable chargé.', 'warn');
  let light = buildLightMask(ed.data, ed.settings, ed.baseMask);
  // Les splats masqués (isolation) sont protégés : jamais supprimés tant qu'ils sont masqués.
  if (ed.hiddenMask) light = subtractMask(light, ed.hiddenMask);
  const n = countMask(light);
  if (n === 0) return toast('Aucun splat clair (visible) à supprimer avec ces seuils.', 'warn');
  if (!confirm(`Supprimer ${formatNumber(n)} splats blancs/clairs du fichier courant ?` + (countHiddenSplats() > 0 ? `\n\n(${formatNumber(countHiddenSplats())} splats masqués sont protégés et ne seront pas touchés.)` : ''))) return;
  pushSplatUndo(`suppression blancs/clairs (${formatNumber(n)})`);
  ed.baseMask = subtractMask(ed.baseMask, light);
  const nextVisible = computeSplatVisibleMask();
  await reloadSplatsFromMask(nextVisible, 'splats_sans_clairs.ply', true);
  ed.visibleMask = nextVisible;
  ed.selectedMask = null;
  updateSplatEditorStats();
  toast(`${formatNumber(n)} splats blancs/clairs supprimés.`);
}

function hasSelectedSplats(): boolean {
  const ed = state.splatEditor;
  return !!(ed.data && ed.baseMask && ed.selectedMask && countMask(intersectMasks(ed.baseMask, ed.selectedMask)) > 0);
}

async function deleteSelectedSplats(confirmBefore = true): Promise<void> {
  const ed = state.splatEditor;
  if (!ed.data || !ed.baseMask || !ed.selectedMask) return toast('Aucune sélection à supprimer.', 'warn');
  let selectionInBase = intersectMasks(ed.baseMask, ed.selectedMask);
  // Ceinture + bretelles : la sélection écran ignore déjà les splats masqués
  // (visibleMask), mais on les retire explicitement de toute suppression.
  if (ed.hiddenMask) selectionInBase = subtractMask(selectionInBase, ed.hiddenMask);
  const n = countMask(selectionInBase);
  if (n === 0) return toast('La sélection ne contient aucun splat visible.', 'warn');
  if (confirmBefore && !confirm(`Supprimer ${formatNumber(n)} splats sélectionnés ?`)) return;
  pushSplatUndo(`suppression sélection (${formatNumber(n)})`);
  ed.baseMask = subtractMask(ed.baseMask, selectionInBase);
  const nextVisible = computeSplatVisibleMask();
  await reloadSplatsFromMask(nextVisible, 'splats_lasso_filtered.ply', true);
  ed.visibleMask = nextVisible;
  ed.selectedMask = null;
  clearLassoOverlay();
  updateSplatEditorStats();
  toast(`${formatNumber(n)} splats supprimés.`);
}


function pushSplatUndo(label: string): void {
  const ed = state.splatEditor;
  if (!ed.baseMask) return;
  ed.undoStack.push({
    baseMask: ed.baseMask.slice(),
    visibleMask: ed.visibleMask ? ed.visibleMask.slice() : null,
    hiddenMask: ed.hiddenMask ? ed.hiddenMask.slice() : null,
    lightOnly: ed.lightOnly,
    label,
  });
  // On limite volontairement l'historique pour éviter de garder trop de gros masques en RAM.
  // 20 opérations suffisent largement pour un nettoyage manuel sans alourdir Chrome.
  if (ed.undoStack.length > 20) ed.undoStack.shift();
  updateUndoButton();
}

async function undoLastSplatEdit(): Promise<void> {
  const ed = state.splatEditor;
  if (!ed.data || ed.undoStack.length === 0) {
    toast('Rien à annuler pour les splats.', 'warn');
    return;
  }

  const snap = ed.undoStack.pop()!;
  ed.baseMask = snap.baseMask;
  ed.lightOnly = snap.lightOnly;
  ed.hiddenMask = snap.hiddenMask;
  const nextVisible = snap.visibleMask ?? computeSplatVisibleMask();
  ed.visibleMask = nextVisible;
  ed.selectedMask = null;
  ed.lassoPoints = [];

  await reloadSplatsFromMask(nextVisible, 'splats_undo.ply', true);
  clearLassoOverlay();
  updateSplatEditorStats();
  toast(`Ctrl+Z : annulation de « ${snap.label} ».`);
}

function updateUndoButton(): void {
  const btn = document.getElementById('btn-splat-undo') as HTMLButtonElement | null;
  if (!btn) return;
  const n = state.splatEditor.undoStack.length;
  btn.disabled = n === 0;
  btn.textContent = n > 0 ? `Annuler dernière suppression (Ctrl+Z) · ${n}` : 'Annuler dernière suppression (Ctrl+Z)';
}

async function resetSplatFilter(): Promise<void> {
  const ed = state.splatEditor;
  if (!ed.data) return toast('Aucun PLY de splats éditable chargé.', 'warn');
  if (ed.baseMask) pushSplatUndo('restauration origine');
  ed.baseMask = createFullMask(ed.data.vertexCount);
  ed.visibleMask = ed.baseMask;
  ed.selectedMask = null;
  ed.hiddenMask = null;
  ed.lightOnly = false;
  await reloadSplatsFromMask(ed.baseMask, ed.data.fileName, true);
  clearLassoOverlay();
  updateSplatEditorStats();
  toast('Filtrage des splats réinitialisé.');
}

async function reloadSplatsFromMask(mask: Uint8Array, name: string, updateExportFile: boolean): Promise<void> {
  const ed = state.splatEditor;
  if (!ed.data) throw new Error('Aucune donnée splat éditable.');
  const currentTransform = cloneTransform(state.transforms.splat);
  const file = buildPlyBlobFromMask(ed.data, mask, name);

  if (state.assets.splat) {
    unloadAsset(state.assets.splat, state.ctx.scene);
    state.assets.splat = null;
  }

  showProgress(0, `Rechargement ${name}`);
  const asset = await loadSplats(file, { scene: state.ctx.scene });
  state.assets.splat = asset;
  applyLayerTransform(asset, currentTransform);
  if (updateExportFile) state.originalFiles.splat = file;

  const toggleEl = document.getElementById('toggle-splat') as HTMLInputElement | null;
  const countEl = document.getElementById('count-splat');
  const statusEl = document.getElementById('status-splat') ?? document.getElementById('status-auto');
  if (toggleEl) {
    toggleEl.disabled = false;
    toggleEl.checked = true;
  }
  if (countEl) countEl.textContent = `${formatNumber(asset.splatCount || countMask(mask))} splats`;
  if (statusEl) {
    statusEl.textContent = `${name} · chargé`;
    statusEl.className = 'drop-status loaded';
  }
  hideProgress();
  updateBboxInfo();
}

function exportCurrentSplats(): void {
  const ed = state.splatEditor;
  if (!ed.data || !ed.baseMask) return toast('Aucun PLY de splats éditable chargé.', 'warn');
  const file = buildPlyBlobFromMask(ed.data, ed.baseMask, 'mago_splats_filtered.ply');
  downloadFileObject(file);
  toast('PLY des splats filtrés exporté. Attention : cet export ne bake pas le déplacement/rotation/échelle du viewer.');
}

function exportCurrentSplatsAligned(): void {
  const file = buildAlignedSplatFile('mago_splats_filtered_ALIGNED.ply');
  if (!file) return;
  downloadFileObject(file);
  toast('PLY GS aligné exporté en repère MAGO Z-up : rechargeable tel quel dans le viewer (et lisible dans CloudCompare/3DR), alignement et suppressions cuits dedans.', 'info', 8000);
}

function buildAlignedSplatFile(fileName = 'mago_splats_ALIGNED.ply'): File | null {
  const ed = state.splatEditor;
  if (!ed.data || !ed.baseMask) {
    toast('Aucun PLY de splats éditable chargé.', 'warn');
    return null;
  }
  const asset = state.assets.splat;
  if (!asset) {
    toast('Aucun objet splats chargé dans la scène.', 'warn');
    return null;
  }
  const node = asset.rootNode as TransformNode;
  node.computeWorldMatrix(true);
  const world = node.getWorldMatrix().clone();

  // On cuit l'export en repère MAGO **Z-up**, comme les autres exports du viewer.
  // Le viewer applique Z-up → Y-up (rx = -90°) par défaut à tout fichier chargé :
  // si on cuisait le monde viewer (Y-up) tel quel, l'export rechargé subirait la
  // conversion une fois de trop et basculerait de 90° (viewer local, vue client,
  // CloudCompare…). En composant l'inverse de la transformation par défaut, le PLY
  // exporté redevient un fichier Z-up ordinaire : rechargement exact garanti.
  const defaultLoad = Matrix.RotationX(-Math.PI / 2); // Z-up -> Y-up, la conversion par défaut du viewer
  const bake = world.multiply(Matrix.Invert(defaultLoad));
  return buildTransformedPlyBlobFromMask(ed.data, ed.baseMask, bake, fileName);
}

function downloadFileObject(file: File): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function updateSplatEditorStats(error?: string): void {
  updateUndoButton();
  const ed = state.splatEditor;
  const totalEl = document.getElementById('splat-edit-total');
  const visibleEl = document.getElementById('splat-edit-visible');
  const selectedEl = document.getElementById('splat-edit-selected');
  const lightEl = document.getElementById('splat-edit-light');
  if (!totalEl || !visibleEl || !selectedEl || !lightEl) return;

  const hiddenElReset = document.getElementById('splat-edit-hidden');
  const unhideBtnReset = document.getElementById('btn-splat-unhide') as HTMLButtonElement | null;
  const resetHiddenUi = () => {
    if (hiddenElReset) hiddenElReset.textContent = '—';
    if (unhideBtnReset) { unhideBtnReset.disabled = true; unhideBtnReset.textContent = 'Réafficher splats masqués'; }
  };
  if (error) {
    totalEl.textContent = 'édition indisponible';
    visibleEl.textContent = error;
    selectedEl.textContent = '—';
    lightEl.textContent = '—';
    resetHiddenUi();
    return;
  }
  if (!ed.data || !ed.baseMask) {
    totalEl.textContent = '—';
    visibleEl.textContent = '—';
    selectedEl.textContent = '—';
    lightEl.textContent = '—';
    resetHiddenUi();
    return;
  }
  const light = buildLightMask(ed.data, ed.settings, ed.baseMask);
  totalEl.textContent = `${formatNumber(ed.data.vertexCount)} splats origine`;
  visibleEl.textContent = `${formatNumber(countMask(ed.visibleMask ?? ed.baseMask))} affichés`;
  selectedEl.textContent = ed.selectedMask ? `${formatNumber(countMask(ed.selectedMask))} sélectionnés` : '0 sélectionné';
  lightEl.textContent = `${formatNumber(countMask(light))} blancs/clairs détectés`;
  const hiddenEl = document.getElementById('splat-edit-hidden');
  const nHidden = countHiddenSplats();
  if (hiddenEl) hiddenEl.textContent = `${formatNumber(nHidden)} masqué${nHidden > 1 ? 's' : ''} (protégés)`;
  const unhideBtn = document.getElementById('btn-splat-unhide') as HTMLButtonElement | null;
  if (unhideBtn) {
    unhideBtn.disabled = nHidden === 0;
    unhideBtn.textContent = nHidden > 0 ? `Réafficher splats masqués · ${formatNumber(nHidden)}` : 'Réafficher splats masqués';
  }
}

function bindLassoCanvasEvents(): void {
  const canvas = state.ctx.engine.getRenderingCanvas() as HTMLCanvasElement | null;
  const overlay = document.getElementById('lasso-canvas') as HTMLCanvasElement | null;
  if (!canvas || !overlay) return;

  const resizeOverlay = () => {
    const rect = canvas.getBoundingClientRect();
    overlay.width = Math.max(1, Math.round(rect.width * window.devicePixelRatio));
    overlay.height = Math.max(1, Math.round(rect.height * window.devicePixelRatio));
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  };
  resizeOverlay();
  window.addEventListener('resize', resizeOverlay);

  const pos = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const startDrawing = (e: PointerEvent) => {
    const meshActive = state.meshEditor.active;
    const splatActive = state.splatEditor.lassoActive;
    if ((!meshActive && !splatActive) || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    resizeOverlay();

    if (meshActive) {
      state.meshEditor.drawing = true;
      state.meshEditor.points = [pos(e)];
    } else {
      state.splatEditor.lassoDrawing = true;
      state.splatEditor.lassoPoints = [pos(e)];
    }

    try { canvas.setPointerCapture(e.pointerId); } catch { /* noop */ }
    drawSelectionShapeOverlay();
  };

  const moveDrawing = (e: PointerEvent) => {
    const meshActive = state.meshEditor.active && state.meshEditor.drawing;
    const splatActive = state.splatEditor.lassoActive && state.splatEditor.lassoDrawing;
    if (!meshActive && !splatActive) return;
    e.preventDefault();
    e.stopPropagation();
    const p = pos(e);

    if (meshActive) {
      const mode = state.meshEditor.selectionMode;
      if (mode === 'rectangle' || mode === 'circle') {
        state.meshEditor.points = [state.meshEditor.points[0], p];
      } else {
        state.meshEditor.points.push(p);
      }
    } else {
      const mode = state.splatEditor.selectionMode;
      if (mode === 'rectangle' || mode === 'circle') {
        state.splatEditor.lassoPoints = [state.splatEditor.lassoPoints[0], p];
      } else {
        state.splatEditor.lassoPoints.push(p);
      }
    }
    drawSelectionShapeOverlay();
  };

  const stopDrawing = (e: PointerEvent) => {
    const meshActive = state.meshEditor.active && state.meshEditor.drawing;
    const splatActive = state.splatEditor.lassoActive && state.splatEditor.lassoDrawing;
    if (!meshActive && !splatActive) return;
    e.preventDefault();
    e.stopPropagation();
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }

    if (meshActive) {
      state.meshEditor.drawing = false;
      // Maj = ajouter à la sélection existante, Ctrl/Alt = retirer, sinon remplacer.
      state.meshEditor.combineNext = e.shiftKey ? 'add' : (e.ctrlKey || e.altKey) ? 'subtract' : 'replace';
      finishMeshScreenSelection();
    } else {
      state.splatEditor.lassoDrawing = false;
      // Maj = ajouter à la sélection existante, Ctrl/Alt = retirer, sinon remplacer.
      state.splatEditor.combineNext = e.shiftKey ? 'add' : (e.ctrlKey || e.altKey) ? 'subtract' : 'replace';
      finishScreenSelection();
    }
  };

  // Capture phase : évite que la caméra orbitale tourne quand on dessine une sélection.
  // Le zoom molette reste disponible car on ne bloque pas wheel.
  canvas.addEventListener('pointerdown', startDrawing, true);
  canvas.addEventListener('pointermove', moveDrawing, true);
  canvas.addEventListener('pointerup', stopDrawing, true);
  canvas.addEventListener('pointercancel', stopDrawing, true);
}

function setLassoActive(active: boolean): void {
  if (active) {
    state.meshEditor.active = false;
    state.meshEditor.drawing = false;
    document.getElementById('btn-mesh-select')?.classList.remove('active');
    state.splatEditor.restoreActive = false;
    document.getElementById('btn-splat-restore-zone')?.classList.remove('active');
  }
  state.splatEditor.lassoActive = active;
  const btn = document.getElementById('btn-splat-lasso');
  btn?.classList.toggle('active', active);
  const canvas = state.ctx.engine.getRenderingCanvas() as HTMLCanvasElement | null;
  if (active) {
    canvas?.classList.add('lasso-mode');
    toast('Sélection active : dessine au clic gauche. Maj = ajouter à la sélection, Ctrl = soustraire. La molette reste disponible pour zoomer.');
  } else {
    canvas?.classList.remove('lasso-mode');
    state.splatEditor.lassoDrawing = false;
    state.splatEditor.restoreActive = false;
    document.getElementById('btn-splat-restore-zone')?.classList.remove('active');
    state.splatEditor.lassoPoints = [];
    drawSelectionHighlightOverlay();
    toast('Sélection désactivée.');
  }
}

function setSplatRestoreActive(active: boolean): void {
  const ed = state.splatEditor;
  if (active) {
    if (!ed.data || !ed.baseMask) return toast('Charge un fichier de splats PLY avant de restaurer.', 'warn');
    if (countMask(invertMask(ed.baseMask)) === 0) return toast('Aucun splat supprimé : rien à restaurer.', 'warn');
    state.meshEditor.active = false;
    state.meshEditor.drawing = false;
    document.getElementById('btn-mesh-select')?.classList.remove('active');
    document.getElementById('btn-splat-lasso')?.classList.remove('active');
  }
  ed.restoreActive = active;
  ed.lassoActive = active; // réutilise la machinerie de dessin écran
  ed.lassoDrawing = false;
  ed.lassoPoints = [];
  document.getElementById('btn-splat-restore-zone')?.classList.toggle('active', active);
  const canvas = state.ctx.engine.getRenderingCanvas() as HTMLCanvasElement | null;
  canvas?.classList.toggle('lasso-mode', active);
  if (active) {
    toast('Restauration active : dessine (lasso/rectangle/rond/pinceau) sur une zone où des splats ont été supprimés — un mur troué par exemple — pour les faire revenir. Le mode reste actif pour enchaîner les retouches.', 'info', 8000);
  } else {
    drawSelectionHighlightOverlay();
    toast('Restauration désactivée.');
  }
}

async function restoreDeletedSplatsInZone(): Promise<void> {
  const ed = state.splatEditor;
  if (!ed.data || !ed.baseMask || !state.assets.splat) return;
  const deleted = invertMask(ed.baseMask);
  if (countMask(deleted) === 0) {
    toast('Plus aucun splat supprimé à restaurer.', 'warn');
    return;
  }
  setStatus('restauration zone…');
  setTimeout(async () => {
    // Même projection écran que la sélection, mais sur le masque des SUPPRIMÉS :
    // seuls les splats absents du fichier courant sont candidats à la restauration.
    const args = {
      data: ed.data!,
      visibleMask: deleted,
      asset: state.assets.splat!,
      scene: state.ctx.scene,
    };
    let picked: Uint8Array;
    if (ed.selectionMode === 'rectangle') {
      picked = selectByScreenRectangle({ ...args, start: ed.lassoPoints[0], end: ed.lassoPoints[1] });
    } else if (ed.selectionMode === 'circle') {
      picked = selectByScreenCircle({ ...args, start: ed.lassoPoints[0], end: ed.lassoPoints[1] });
    } else if (ed.selectionMode === 'brush') {
      picked = selectByScreenBrush({ ...args, path: ed.lassoPoints, radius: ed.brushSize });
    } else {
      picked = selectByScreenLasso({ ...args, polygon: ed.lassoPoints });
    }
    const n = countMask(picked);
    ed.lassoPoints = [];
    if (n === 0) {
      clearLassoOverlay();
      setStatus('prêt');
      toast('Aucun splat supprimé dans cette zone.', 'warn');
      return;
    }
    pushSplatUndo(`restauration zone (${formatNumber(n)})`);
    ed.baseMask = unionMasks(ed.baseMask!, picked);
    const nextVisible = computeSplatVisibleMask();
    await reloadSplatsFromMask(nextVisible, 'splats_restauration.ply', true);
    ed.visibleMask = nextVisible;
    ed.selectedMask = null;
    clearLassoOverlay();
    updateSplatEditorStats();
    setStatus('prêt');
    toast(`${formatNumber(n)} splats restaurés dans la zone.`);
  }, 20);
}

function finishScreenSelection(): void {
  const ed = state.splatEditor;
  if (!ed.data || !ed.visibleMask || !state.assets.splat) {
    toast('Aucun splat éditable chargé.', 'warn');
    return;
  }
  const minPts = ed.selectionMode === 'rectangle' || ed.selectionMode === 'circle' ? 2 : 4;
  if (ed.lassoPoints.length < minPts) {
    toast('Sélection trop petite.', 'warn');
    drawSelectionHighlightOverlay();
    return;
  }
  if (ed.restoreActive) {
    void restoreDeletedSplatsInZone();
    return;
  }
  setStatus('sélection écran…');
  // Laisse le navigateur dessiner la forme avant le calcul potentiellement lourd.
  setTimeout(() => {
    let selected: Uint8Array;
    const args = {
      data: ed.data!,
      visibleMask: ed.visibleMask!,
      asset: state.assets.splat!,
      scene: state.ctx.scene,
    };
    if (ed.selectionMode === 'rectangle') {
      selected = selectByScreenRectangle({ ...args, start: ed.lassoPoints[0], end: ed.lassoPoints[1] });
    } else if (ed.selectionMode === 'circle') {
      selected = selectByScreenCircle({ ...args, start: ed.lassoPoints[0], end: ed.lassoPoints[1] });
    } else if (ed.selectionMode === 'brush') {
      selected = selectByScreenBrush({ ...args, path: ed.lassoPoints, radius: ed.brushSize });
    } else {
      selected = selectByScreenLasso({ ...args, polygon: ed.lassoPoints });
    }
    // Maj = ajouter, Ctrl/Alt = soustraire, sinon remplacer (aligné sur le mesh).
    const combine = ed.combineNext ?? 'replace';
    ed.combineNext = null;
    if (combine === 'add' && ed.selectedMask) {
      selected = unionMasks(ed.selectedMask, selected);
    } else if (combine === 'subtract' && ed.selectedMask) {
      selected = subtractMask(ed.selectedMask, selected);
    }
    ed.selectedMask = countMask(selected) > 0 ? selected : null;
    updateSplatEditorStats();
    setStatus('prêt');
    drawSelectionHighlightOverlay();
    const nSel = ed.selectedMask ? countMask(ed.selectedMask) : 0;
    toast(combine === 'subtract'
      ? `Sélection réduite : ${formatNumber(nSel)} splats surlignés.`
      : `${formatNumber(nSel)} splats sélectionnés. Maj = ajouter, Ctrl = soustraire, puis supprime ou masque.`);
  }, 20);
}

function drawSelectionShapeOverlay(): void {
  const overlay = document.getElementById('lasso-canvas') as HTMLCanvasElement | null;
  if (!overlay) return;
  const ctx = overlay.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!state.meshEditor.active) drawSelectionHighlightOverlay(false);

  const meshActive = state.meshEditor.active && state.meshEditor.drawing;
  const pts = meshActive ? state.meshEditor.points : state.splatEditor.lassoPoints;
  const mode = meshActive ? state.meshEditor.selectionMode : state.splatEditor.selectionMode;
  const brushSize = meshActive ? state.meshEditor.brushSize : state.splatEditor.brushSize;
  if (pts.length < 1) return;

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.fillStyle = meshActive ? 'rgba(255, 210, 0, 0.18)' : 'rgba(255, 255, 255, 0.12)';
  ctx.strokeStyle = meshActive ? 'rgba(255, 210, 0, 0.98)' : 'rgba(255, 255, 255, 0.95)';
  ctx.lineWidth = 2;

  if (mode === 'rectangle' && pts.length >= 2) {
    const a = pts[0], b = pts[1];
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
  } else if (mode === 'circle' && pts.length >= 2) {
    const a = pts[0], b = pts[1];
    const r = Math.hypot(b.x - a.x, b.y - a.y);
    ctx.beginPath();
    ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (mode === 'brush') {
    ctx.strokeStyle = meshActive ? 'rgba(255, 210, 0, 0.55)' : 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = brushSize * 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.strokeStyle = meshActive ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 210, 0, 0.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  } else if (pts.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawSelectionHighlightOverlay(clearFirst = true): void {
  const overlay = document.getElementById('lasso-canvas') as HTMLCanvasElement | null;
  const ed = state.splatEditor;
  if (!overlay || !ed.data || !ed.selectedMask || !state.assets.splat) return;
  const ctx = overlay.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  if (clearFirst) ctx.clearRect(0, 0, overlay.width, overlay.height);

  const selectedCount = countMask(ed.selectedMask);
  if (selectedCount === 0) return;
  const maxDots = 15000;
  const stride = Math.max(1, Math.ceil(selectedCount / maxDots));
  let seen = 0;

  const world = (state.assets.splat.rootNode as any).getWorldMatrix?.() ?? Matrix.Identity();
  const transform = state.ctx.scene.getTransformMatrix();
  const viewport = state.ctx.scene.activeCamera!.viewport.toGlobal(
    state.ctx.engine.getRenderWidth(),
    state.ctx.engine.getRenderHeight()
  );
  const tmp = Vector3.Zero();

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.fillStyle = 'rgba(255, 210, 0, 0.95)';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.lineWidth = 1;
  for (let i = 0; i < ed.data.vertexCount; i++) {
    if (!ed.selectedMask[i]) continue;
    seen++;
    if (seen % stride !== 0) continue;
    tmp.set(ed.data.x[i], ed.data.y[i], ed.data.z[i]);
    const worldPos = Vector3.TransformCoordinates(tmp, world);
    const screen = Vector3.Project(worldPos, Matrix.Identity(), transform, viewport);
    if (screen.z < 0 || screen.z > 1) continue;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function clearLassoOverlay(): void {
  const overlay = document.getElementById('lasso-canvas') as HTMLCanvasElement | null;
  const ctx = overlay?.getContext('2d');
  if (overlay && ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);
}



function bindLodHudControls(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-lod-force]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const value = btn.dataset.lodForce ?? 'auto';
      const select = document.getElementById('mesh-lod-mode') as HTMLSelectElement | null;
      if (select) {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        updateMeshLodByCamera(true);
        updateLodHud();
      }
    });
  });
}

// =================================================================
//  LOD MESH AUTOMATIQUE
// =================================================================

function parseLodName(name: string): { baseName: string; level: number | null } {
  // Babylon ne reprend pas toujours exactement le nom du node Blender.
  // Selon l'export GLB, un mesh peut s'appeler par exemple :
  //   class_009_wall_LOD2
  //   class_009_wall_LOD2_mesh
  //   class_009_wall_LOD2_mesh_primitive0
  //   class_009_wall_LOD2.001
  // L'ancienne détection ne trouvait que le cas où LOD2 était tout à la fin,
  // donc le viewer pouvait ne voir que LOD0/LOD1 alors que le GLB contenait bien LOD2.
  let n = (name || '').replace(/^.*:/, '').trim() || 'Objet';
  n = n.replace(/\s*\(\d+\)$/g, '').replace(/\.\d{3,}$/g, '');

  const numeric = n.match(/^(.*?)[_\-. ]?lod[_\-. ]?(\d+)(?:[_\-. ]?(?:mesh|node|primitive)(?:[_\-. ]?\d+)?)?$/i);
  if (numeric) {
    return { baseName: cleanupLodBaseName(numeric[1]), level: Number(numeric[2]) };
  }

  // Fallback plus permissif : LOD peut être suivi d'un suffixe technique non prévu.
  const looseNumeric = n.match(/^(.*?)[_\-. ]?lod[_\-. ]?(\d+)(?:\b|[_\-. ])/i);
  if (looseNumeric) {
    return { baseName: cleanupLodBaseName(looseNumeric[1]), level: Number(looseNumeric[2]) };
  }

  const word = n.match(/^(.*?)[_\-. ]?(high|fine|hd|medium|med|mid|low|coarse)(?:[_\-. ]?(?:mesh|node|primitive)(?:[_\-. ]?\d+)?)?$/i);
  if (word) {
    const label = word[2].toLowerCase();
    const level = label === 'high' || label === 'fine' || label === 'hd' ? 0 :
      label === 'medium' || label === 'med' || label === 'mid' ? 1 : 2;
    return { baseName: cleanupLodBaseName(word[1]), level };
  }

  return { baseName: cleanupLodBaseName(n), level: null };
}

function cleanupLodBaseName(value: string): string {
  let n = value.trim();
  n = n.replace(/[_\-. ]?(?:mesh|node|primitive)(?:[_\-. ]?\d+)?$/i, '');
  return n || value || 'Objet';
}

function resetMeshLodState(): void {
  state.meshLod.groups = [];
  state.meshLod.meshLevel.clear();
  state.meshLod.availableLevels = [];
  state.meshLod.sceneDiagonal = 1;
  state.meshLod.currentLevel = null;
  state.meshLod.currentLabel = 'LOD unique';
  state.meshLod.lastRadius = -1;
}

function setupMeshLodFromLoadedAsset(asset: LoadedAsset): void {
  resetMeshLodState();

  const rawGroups = new Map<string, MeshLodGroup>();
  for (const raw of asset.meshes) {
    if (!(raw instanceof Mesh)) continue;
    const hasGeometry = (raw.getTotalVertices?.() ?? 0) > 0 || (raw.getTotalIndices?.() ?? 0) > 0;
    if (!hasGeometry) continue;

    const parsed = parseLodName(raw.name || 'Objet');
    if (parsed.level == null) continue;

    const key = parsed.baseName.toLowerCase();
    let group = rawGroups.get(key);
    if (!group) {
      group = {
        baseName: parsed.baseName,
        levels: new Map<number, Mesh[]>(),
        triangleCounts: new Map<number, number>(),
        currentLevel: parsed.level,
      };
      rawGroups.set(key, group);
    }

    const list = group.levels.get(parsed.level) ?? [];
    list.push(raw);
    group.levels.set(parsed.level, list);
    const tri = Math.floor((raw.getTotalIndices?.() ?? 0) / 3);
    group.triangleCounts.set(parsed.level, (group.triangleCounts.get(parsed.level) ?? 0) + tri);
    state.meshLod.meshLevel.set(raw, parsed.level);
  }

  state.meshLod.groups = Array.from(rawGroups.values()).filter((g) => g.levels.size >= 2);
  if (state.meshLod.groups.length === 0) {
    state.meshLod.currentLabel = 'LOD unique';
    updateLodHud();
    return;
  }

  // On ne garde dans le système LOD que les meshes appartenant à un groupe complet.
  const validMeshes = new Set<Mesh>();
  const levels = new Set<number>();
  for (const g of state.meshLod.groups) {
    for (const [level, meshes] of g.levels) {
      levels.add(level);
      for (const m of meshes) validMeshes.add(m);
    }
  }
  for (const m of Array.from(state.meshLod.meshLevel.keys())) {
    if (!validMeshes.has(m)) state.meshLod.meshLevel.delete(m);
  }

  state.meshLod.availableLevels = Array.from(levels).sort((a, b) => a - b);
  state.meshLod.sceneDiagonal = estimateSceneDiagonal([asset]);
  const selected = chooseLodLevelForRadius(state.ctx.camera.radius);
  state.meshLod.currentLevel = selected;
  applyMeshVisibilityFromState();
  state.meshLod.currentLabel = makeLodLabel(selected);
  updateLodHud();
  toast(`LOD détectés : ${state.meshLod.availableLevels.map((l) => 'LOD' + l).join(', ')}. Passage automatique selon le zoom.`);
}

function estimateSceneDiagonal(assets: LoadedAsset[]): number {
  const bb = computeSceneBounds(assets);
  if (!bb) return 10;
  const e = bb.boundingBox.extendSizeWorld.scale(2);
  const diag = Math.sqrt(e.x * e.x + e.y * e.y + e.z * e.z);
  return Number.isFinite(diag) && diag > 0.01 ? diag : 10;
}

function chooseLodLevelForRadius(radius: number): number | null {
  const levels = state.meshLod.availableLevels;
  if (levels.length === 0) return null;

  if (state.meshEditor.active && state.meshLod.currentLevel != null) return state.meshLod.currentLevel;

  // Si l'utilisateur force un niveau depuis le HUD ou Scène > Performance,
  // on respecte ce choix sans tenir compte du zoom.
  const forced = getForcedLodLevel();
  if (forced != null) return nearestAvailableLod(forced, levels);

  const diag = Math.max(0.001, state.meshLod.sceneDiagonal);

  // Seuils corrigés : l'ancienne logique passait trop vite en LOD1, même
  // quand la caméra était collée au modèle. Ici, proche = toujours LOD0.
  // Le LOD2 n'arrive que pour une vraie vue globale / dézoomée.
  const nearLimit = Math.max(0.001, state.ctx.camera.lowerRadiusLimit ?? diag * 0.03);
  const r = Math.max(radius, nearLimit);

  let desiredIndex = 0;
  if (r <= diag * 0.35) desiredIndex = 0;        // proche : HD
  else if (r <= diag * 0.90) desiredIndex = 1;   // inspection globale : moyen
  else desiredIndex = 2;                         // vue large : léger

  return nearestAvailableLod(desiredIndex, levels);
}

function getForcedLodLevel(): number | null {
  const select = document.getElementById('mesh-lod-mode') as HTMLSelectElement | null;
  if (!select || select.value === 'auto') return null;
  const v = Number(select.value);
  return Number.isFinite(v) ? v : null;
}

function nearestAvailableLod(desired: number, levels: number[]): number {
  let best = levels[0];
  let bestDist = Math.abs(best - desired);
  for (const l of levels) {
    const d = Math.abs(l - desired);
    if (d < bestDist || (d === bestDist && l < best)) {
      best = l;
      bestDist = d;
    }
  }
  return best;
}

function makeLodLabel(level: number | null): string {
  if (level == null || state.meshLod.groups.length === 0) return 'LOD unique';
  const visibleTris = countVisibleMeshTriangles();
  const lodTris = state.meshLod.groups.reduce((sum, group) => sum + (group.triangleCounts.get(level) ?? 0), 0);
  const tri = visibleTris > 0 ? visibleTris : lodTris;
  const detail = level === 0 ? 'HD proche' : level === 1 ? 'moyen' : level === 2 ? 'léger' : 'très léger';
  return `LOD${level} · ${detail} · ${formatNumber(tri)} tris visibles`;
}

function countVisibleMeshTriangles(): number {
  const asset = state.assets.mesh;
  if (!asset) return 0;

  let tris = 0;
  for (const raw of asset.meshes) {
    if (!(raw instanceof Mesh)) continue;
    if (!raw.isVisible) continue;
    if (typeof raw.isEnabled === 'function' && !raw.isEnabled()) continue;

    const indices = raw.getTotalIndices?.() ?? 0;
    if (indices > 0) {
      tris += Math.floor(indices / 3);
      continue;
    }

    const vertices = raw.getTotalVertices?.() ?? 0;
    if (vertices > 0) tris += Math.floor(vertices / 3);
  }
  return tris;
}

function updateMeshLodByCamera(force = false): void {
  const lod = state.meshLod;
  if (!lod.enabled || lod.groups.length === 0) return;

  // Pendant l’édition mesh, la géométrie affichée doit rester strictement stable.
  // Sinon le zoom peut basculer LOD0/LOD1/LOD2 et faire apparaître/disparaître
  // des triangles sous le pinceau ou le lasso.
  if (state.meshEditor.active && lod.currentLevel != null) {
    applyMeshVisibilityFromState();
    updateLodHud();
    return;
  }

  const radius = state.ctx.camera.radius;
  if (!force && Math.abs(radius - lod.lastRadius) < Math.max(0.05, radius * 0.035)) return;
  lod.lastRadius = radius;

  const selected = chooseLodLevelForRadius(radius);
  if (selected == null || (!force && selected === lod.currentLevel)) return;

  lod.currentLevel = selected;
  applyMeshVisibilityFromState();
  lod.currentLabel = makeLodLabel(selected);
  updateLodHud();
}

function updateLodHud(): void {
  if (state.magoTiles?.enabled) {
    updateMagoTilesHud();
    return;
  }
  const current = document.getElementById('lod-current');
  const detail = document.getElementById('lod-detail');
  if (!current || !detail) return;

  const lod = state.meshLod;
  if (lod.groups.length === 0) {
    current.textContent = 'LOD unique';
    detail.textContent = 'aucun groupe LOD détecté';
    return;
  }

  const title = document.querySelector('#lod-hud .lod-title');
  const forced = getForcedLodLevel();
  if (title) title.textContent = forced == null ? 'LOD auto' : `LOD forcé ${forced}`;

  current.textContent = makeLodLabel(lod.currentLevel);
  lod.currentLabel = current.textContent;
  const levels = lod.availableLevels.map((l) => `LOD${l}`).join(' / ');
  const activeMeshes = countVisibleMeshObjects();
  const diag = Math.max(0.001, lod.sceneDiagonal);
  const ratio = state.ctx.camera.radius / diag;
  const mode = forced == null ? 'auto' : `forcé LOD${forced}`;
  detail.textContent = `${lod.groups.length} groupe(s) LOD · ${activeMeshes} objet(s) affiché(s) · ${levels} · ${mode} · zoom ${(ratio).toFixed(2)}`;

  document.querySelectorAll<HTMLButtonElement>('[data-lod-force]').forEach((btn) => {
    const value = btn.dataset.lodForce ?? 'auto';
    btn.classList.toggle('active', forced == null ? value === 'auto' : value === String(forced));
  });

  const levelDetail = document.getElementById('lod-levels-detail');
  if (levelDetail) {
    const items = lod.availableLevels.map((l) => {
      const tris = lod.groups.reduce((sum, group) => sum + (group.triangleCounts.get(l) ?? 0), 0);
      return `L${l}:${formatNumber(tris)}`;
    });
    levelDetail.textContent = items.join(' · ');
  }
}

function countVisibleMeshObjects(): number {
  const asset = state.assets.mesh;
  if (!asset) return 0;
  let count = 0;
  for (const raw of asset.meshes) {
    if (!(raw instanceof Mesh)) continue;
    if (!raw.isVisible) continue;
    if (typeof raw.isEnabled === 'function' && !raw.isEnabled()) continue;
    count++;
  }
  return count;
}

// =================================================================
//  VISIBILITY & MESH SETTINGS
// =================================================================

function setMeshVisible(visible: boolean): void {
  const asset = state.assets.mesh;
  if (!asset) return;
  const globalToggle = document.getElementById('toggle-mesh') as HTMLInputElement | null;
  if (globalToggle) globalToggle.checked = visible;
  applyMeshVisibilityFromState();
}

function setMeshSubLayerVisible(layerId: string, visible: boolean): void {
  const asset = state.assets.mesh;
  if (!asset?.meshLayers) return;
  const layer = asset.meshLayers.find((l) => l.id === layerId);
  if (!layer) return;
  layer.visible = visible;
  applyMeshVisibilityFromState();
  updateMeshLayerSummary();
  updateBboxInfo();
}

function setAllMeshSubLayersVisible(visible: boolean): void {
  const asset = state.assets.mesh;
  if (!asset?.meshLayers || asset.meshLayers.length === 0) {
    toast('Aucune sous-couche mesh détectée.', 'warn');
    return;
  }
  for (const layer of asset.meshLayers) layer.visible = visible;
  applyMeshVisibilityFromState();
  renderMeshSubLayerList();
  updateBboxInfo();
  toast(visible ? 'Toutes les sous-couches mesh sont affichées.' : 'Toutes les sous-couches mesh sont masquées.');
}

function soloMeshSubLayer(layerId: string): void {
  const asset = state.assets.mesh;
  if (!asset?.meshLayers) return;
  const globalToggle = document.getElementById('toggle-mesh') as HTMLInputElement | null;
  if (globalToggle) {
    globalToggle.checked = true;
    globalToggle.disabled = false;
  }
  for (const layer of asset.meshLayers) layer.visible = layer.id === layerId;
  applyMeshVisibilityFromState();
  renderMeshSubLayerList();
  updateBboxInfo();
}


/** Retire définitivement une ou plusieurs sous-couches du mesh chargé.
 * Les meshes Babylon correspondants sont détruits et retirés de l'asset :
 * ils disparaissent donc de l'arbre, de la scène et des exports suivants.
 */
async function deleteMeshSubLayers(layerIds: string[], labelForToast: string): Promise<void> {
  const asset = state.assets.mesh;
  if (!asset?.meshLayers || layerIds.length === 0) return;

  const ids = new Set(layerIds);
  const removedLayers = asset.meshLayers.filter((l) => ids.has(l.id));
  if (removedLayers.length === 0) return;

  // Synchronisation BDD : chaque instance supprimée disparaît aussi de PostgreSQL.
  for (const layer of removedLayers) {
    try { await enrichment.deleteObjectKey(layer.classKey); }
    catch (error) { console.warn('[MAGO] Suppression BDD impossible pour', layer.classKey, error); }
  }

  const meshesToDelete = new Set<AbstractMesh>();
  for (const layer of removedLayers) {
    for (const mesh of layer.meshes) meshesToDelete.add(mesh);
  }

  // Nettoyage des sélections / caches avant destruction.
  for (const mesh of meshesToDelete) {
    if (mesh instanceof Mesh) {
      state.meshEditor.selected.delete(mesh);
      state.meshEditor.triangleCache.delete(mesh);
      state.meshLod.meshLevel.delete(mesh);
    }
    try { mesh.dispose(false, false); } catch (error) {
      console.warn('[MAGO] Impossible de détruire un mesh de couche :', mesh.name, error);
    }
  }

  asset.meshes = asset.meshes.filter((m) => !meshesToDelete.has(m));
  asset.meshLayers = asset.meshLayers.filter((l) => !ids.has(l.id));
  asset.triangleCount = Math.floor(asset.meshes.reduce((sum, m) => sum + (m.getTotalIndices?.() ?? 0), 0) / 3);

  if (state.selectedLayerId && ids.has(state.selectedLayerId)) state.selectedLayerId = null;

  // Reconstruit les groupes LOD pour ne garder aucune référence vers les meshes supprimés.
  setupMeshLodFromLoadedAsset(asset);
  applyMeshVisibilityFromState();
  renderMeshSubLayerList();
  renderSceneObjectList();
  updateBboxInfo();
  updateLodHud();
  toast(`${labelForToast} supprimé${removedLayers.length > 1 ? 's' : ''} définitivement de la scène.`);
}

async function deleteMeshSubLayer(layerId: string): Promise<void> {
  const layer = state.assets.mesh?.meshLayers?.find((l) => l.id === layerId);
  if (!layer) return;
  const name = layerInstanceName(layer);
  if (!window.confirm(`Supprimer définitivement « ${name} » de la scène et des prochains exports ?`)) return;
  await deleteMeshSubLayers([layerId], `Objet « ${name} »`);
}

async function deleteMeshClass(classId: string): Promise<void> {
  const layers = state.assets.mesh?.meshLayers ?? [];
  const targets = layers.filter((l) => layerClassId(l) === classId);
  if (targets.length === 0) return;
  const className = layerClassName(targets[0]);
  if (!window.confirm(`Supprimer définitivement toute la classe « ${className} » (${targets.length} objet${targets.length > 1 ? 's' : ''}) de la scène et des prochains exports ?`)) return;
  try { await enrichment.deleteClassKey(classId); }
  catch (error) { console.warn('[MAGO] Suppression BDD de classe impossible :', classId, error); }
  meshTreeExpandedClasses.delete(classId);
  await deleteMeshSubLayers(targets.map((l) => l.id), `Classe « ${className} »`);
}


type SceneObjectEntry = {
  uid: number;
  label: string;
  kind: LoadedAsset['kind'];
  asset: LoadedAsset;
  primary: boolean;
};

function getSceneObjectEntries(): SceneObjectEntry[] {
  const out: SceneObjectEntry[] = [];
  if (state.assets.mesh) out.push({ uid: (state.assets.mesh.rootNode as any).uniqueId, label: state.assets.mesh.fileName, kind: 'mesh', asset: state.assets.mesh, primary: true });
  if (state.assets.splat) out.push({ uid: (state.assets.splat.rootNode as any).uniqueId, label: state.assets.splat.fileName, kind: 'splat', asset: state.assets.splat, primary: true });
  for (const a of state.extraAssets) out.push({ uid: (a.rootNode as any).uniqueId, label: a.fileName, kind: a.kind, asset: a, primary: false });
  return out;
}

function setAssetTreeVisible(asset: LoadedAsset, visible: boolean): void {
  asset.rootNode.setEnabled(visible);
  for (const m of asset.meshes) m.setEnabled(visible);
}

/**
 * Bascule le mode « arrière-plan » d'un asset : visibility = 0 sur tous ses
 * meshes → exclus du rendu par Babylon (_evaluateActiveMeshes ignore les
 * visibility 0) mais isVisible reste true → tous les prédicats de pick du
 * viewer (sélection de couche, mesures, alignement) continuent de fonctionner.
 * Indépendant de la case « Afficher/masquer » (setEnabled) et du slider
 * d'opacité (material.alpha).
 */
function setAssetBackground(asset: LoadedAsset, on: boolean): void {
  asset.background = on;
  for (const m of asset.meshes) m.visibility = on ? 0 : 1;
  // Re-révèle immédiatement la sélection courante (liseré) si besoin.
  applyLayerHighlight();
}

function isAssetTreeVisible(asset: LoadedAsset): boolean {
  return asset.rootNode.isEnabled();
}

function formatAssetCount(asset: LoadedAsset): string {
  if (asset.kind === 'mesh') return `${formatNumber(asset.triangleCount)} tris`;
  if (asset.kind === 'splat') return `${formatNumber(asset.splatCount)} splats`;
  return `${formatNumber(asset.splatCount)} pts`;
}

function renderSceneObjectList(): void {
  const wrap = document.getElementById('scene-object-list');
  const empty = document.getElementById('scene-object-empty');
  if (!wrap || !empty) return;
  const entries = getSceneObjectEntries();
  wrap.innerHTML = '';
  empty.style.display = entries.length ? 'none' : 'block';

  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'scene-object-row' + (state.selectedObjectUid === e.uid ? ' selected' : '');
    row.dataset.uid = String(e.uid);
    const kindLabel = e.kind === 'mesh' ? 'Mesh' : e.kind === 'splat' ? 'GS' : 'Nuage';
    row.innerHTML = `
      <label class="scene-object-check" title="Afficher / masquer">
        <input type="checkbox" ${isAssetTreeVisible(e.asset) ? 'checked' : ''} data-object-visible="${e.uid}" />
        <span>${kindLabel}</span>
      </label>
      <button class="scene-object-name" data-object-select="${e.uid}" title="${escapeHtml(e.label)}">${escapeHtml(e.label)}</button>
      <span class="scene-object-count">${formatAssetCount(e.asset)}</span>
      ${e.kind === 'mesh'
        ? `<button class="btn-mini bg-toggle${e.asset.background ? ' active' : ''}" data-object-background="${e.uid}"
             title="Arrière-plan : mesh invisible à l'écran mais toujours sélectionnable (liseré, mesures, enrichissement)">AP</button>`
        : '<span class="bg-toggle-spacer"></span>'}
      <button class="btn-mini danger-soft" data-object-delete="${e.uid}" title="Supprimer">×</button>
    `;
    wrap.appendChild(row);
  }

  wrap.querySelectorAll<HTMLInputElement>('input[data-object-visible]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const uid = Number(cb.dataset.objectVisible);
      const entry = getSceneObjectEntries().find((x) => x.uid === uid);
      if (entry) setAssetTreeVisible(entry.asset, cb.checked);
      updateBboxInfo();
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>('button[data-object-select]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedObjectUid = Number(btn.dataset.objectSelect);
      renderSceneObjectList();
      updateSelectedObjectTransformUI();
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>('button[data-object-background]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // Verrouillé côté client : l'état est fixé à la publication (scene.json).
      if (isClientMode()) return;
      const uid = Number(btn.dataset.objectBackground);
      const entry = getSceneObjectEntries().find((x) => x.uid === uid);
      if (!entry || entry.kind !== 'mesh') return;
      setAssetBackground(entry.asset, !entry.asset.background);
      renderSceneObjectList();
      toast(
        entry.asset.background
          ? `« ${entry.label} » en arrière-plan : invisible mais sélectionnable.`
          : `« ${entry.label} » de nouveau affiché.`,
        'info',
        2500,
      );
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>('button[data-object-delete]').forEach((btn) => {
    btn.addEventListener('click', () => deleteSceneObject(Number(btn.dataset.objectDelete)));
  });
}

function deleteSelectedSceneObject(): void {
  if (state.selectedObjectUid == null) return;
  deleteSceneObject(state.selectedObjectUid);
}

function deleteSceneObject(uid: number): void {
  const entries = getSceneObjectEntries();
  const entry = entries.find((x) => x.uid === uid);
  if (!entry) return;
  if (entry.primary && entry.kind === 'mesh') {
    clearAsset('mesh');
    state.selectedObjectUid = null;
    renderSceneObjectList();
    updateSelectedObjectTransformUI();
  } else if (entry.primary && entry.kind === 'splat') {
    clearAsset('splat');
    state.selectedObjectUid = null;
    renderSceneObjectList();
    updateSelectedObjectTransformUI();
  } else {
    unloadAsset(entry.asset, state.ctx.scene);
    state.extraAssets = state.extraAssets.filter((a) => (a.rootNode as any).uniqueId !== uid);
    if (state.selectedObjectUid === uid) state.selectedObjectUid = null;
    renderSceneObjectList();
    updateSelectedObjectTransformUI();
    updateBboxInfo();
    toast(`Objet supprimé : ${entry.label}`);
  }
}

function getLayerVisibilityForMesh(mesh: Mesh): boolean {
  const layers = state.assets.mesh?.meshLayers ?? [];
  if (layers.length === 0) return true;
  const layer = layers.find((l) => l.meshes.includes(mesh));
  return layer ? layer.visible : true;
}

function isMeshAllowedByCurrentLod(mesh: Mesh): boolean {
  const lod = state.meshLod;
  if (!lod.enabled || lod.groups.length === 0 || lod.currentLevel == null) return true;
  const meshLevel = lod.meshLevel.get(mesh);
  if (meshLevel == null) return true;
  return meshLevel === lod.currentLevel;
}

function applyMeshVisibilityFromState(): void {
  const asset = state.assets.mesh;
  if (!asset) return;
  const globalToggle = document.getElementById('toggle-mesh') as HTMLInputElement | null;
  const globalVisible = globalToggle?.checked ?? true;

  for (const raw of asset.meshes) {
    if (!(raw instanceof Mesh)) {
      raw.isVisible = globalVisible;
      continue;
    }
    const layerVisible = getLayerVisibilityForMesh(raw);
    raw.isVisible = globalVisible && layerVisible && isMeshAllowedByCurrentLod(raw);
  }
  // Le liseré ne doit entourer que des meshes visibles → on resynchronise après tout changement.
  applyLayerHighlight();
}

/** Couleur du liseré de sélection des calques (rouge, équivalent du contour de Blender). */
const LAYER_SELECTION_COLOR = new Color3(1, 0.12, 0.12);
/**
 * Largeur du liseré, en unités monde (mètres). Le contour est rendu en espace objet,
 * il grossit/rétrécit donc avec l'objet : pas d'effet « plaque rouge » au dézoom,
 * contrairement à une surbrillance écran. Ajuste cette valeur pour un trait plus/moins fin.
 */
const LAYER_OUTLINE_WIDTH = 0.01;

/** Coupe le liseré sur tous les meshes du mesh courant (évite les références obsolètes). */
function clearAllLayerOutlines(): void {
  clearApSelectionMask();
  for (const m of state.assets.mesh?.meshes ?? []) {
    m.renderOutline = false;
    m.visibility = state.assets.mesh?.background ? 0 : m.visibility;
  }
}

/**
 * Opacité de la sélection quand le mesh est en mode « arrière-plan » :
 * l'élément sélectionné réapparaît en semi-transparent avec son liseré rouge,
 * par-dessus les splats. 0 = seul le liseré (silhouette pleine), 1 = opaque.
 */
const BACKGROUND_SELECTION_VISIBILITY = 0.0015;

/**
 * Applique (ou retire) le liseré rouge autour des meshes du calque sélectionné.
 * Source de vérité unique : state.selectedLayerId. On ne surligne que les meshes
 * réellement visibles afin que la surbrillance suive le LOD / la visibilité.
 *
 * Mode « arrière-plan » (asset.background) : tous les meshes de l'asset sont
 * resynchronisés à visibility = 0 (invisibles mais pickables), puis les meshes
 * du calque sélectionné sont révélés en semi-transparence pour que le liseré
 * soit rendu (Babylon ne dessine pas le contour d'un mesh non rendu).
 */
function applyLayerHighlight(): void {
  clearAllLayerOutlines();

  const asset = state.assets.mesh;
  if (!asset) return;

  if (asset.background) {
    for (const m of asset.meshes) m.visibility = 0;
  }

  const id = state.selectedLayerId;
  if (id == null) return;
  const layer = asset.meshLayers?.find((l) => l.id === id);
  if (!layer) return;

  const selectedMeshes = layer.meshes.filter((m) => m.isEnabled() && m.isVisible);

  if (asset.background) {
    setApSelectionMaskMeshes(selectedMeshes);
    return;
  }

  for (const m of selectedMeshes) {
    m.outlineColor = LAYER_SELECTION_COLOR;
    m.outlineWidth = LAYER_OUTLINE_WIDTH;
    m.renderOutline = true;
  }
}

/** Sélectionne / désélectionne un calque (re-clic = désélection) et rafraîchit le liseré. */
function setSelectedMeshSubLayer(layerId: string): void {
  state.selectedLayerId = state.selectedLayerId === layerId ? null : layerId;
  renderMeshSubLayerList();
}

/* ============================================================
   Arbre Objet ▸ Classe ▸ Instance (V48)
   ============================================================ */

let meshTreeObjectExpanded = true;
const meshTreeExpandedClasses = new Set<string>();

interface MeshClassGroup {
  classId: string;
  className: string;
  layers: MeshSubLayer[];
  triangleCount: number;
}

/** Identité de classe d'une couche (champ stocké, ou parsing de repli). */
function layerClassId(l: MeshSubLayer): string {
  return l.classId ?? parseMagoLayer(l.classKey || l.name).classId;
}
function layerClassName(l: MeshSubLayer): string {
  return l.className ?? parseMagoLayer(l.classKey || l.name).className;
}
function layerInstanceName(l: MeshSubLayer): string {
  return l.instanceName ?? l.name;
}

/** Regroupe les couches (1 par instance) en classes, triées pour un affichage stable. */
function getMeshClassGroups(layers: MeshSubLayer[]): MeshClassGroup[] {
  const map = new Map<string, MeshClassGroup>();
  for (const l of layers) {
    const cid = layerClassId(l);
    let g = map.get(cid);
    if (!g) {
      g = { classId: cid, className: layerClassName(l), layers: [], triangleCount: 0 };
      map.set(cid, g);
    }
    g.layers.push(l);
    g.triangleCount += l.triangleCount;
  }
  const groups = Array.from(map.values());
  groups.sort((a, b) => a.className.localeCompare(b.className, 'fr'));
  for (const g of groups) {
    g.layers.sort((a, b) => {
      const ai = a.instanceIndex ?? 0;
      const bi = b.instanceIndex ?? 0;
      if (ai !== bi) return ai - bi;
      return layerInstanceName(a).localeCompare(layerInstanceName(b), 'fr');
    });
  }
  return groups;
}

function classVisibilityState(group: MeshClassGroup): 'all' | 'none' | 'some' {
  const vis = group.layers.filter((l) => l.visible).length;
  if (vis === 0) return 'none';
  if (vis === group.layers.length) return 'all';
  return 'some';
}

function setMeshClassVisible(classId: string, visible: boolean): void {
  const asset = state.assets.mesh;
  if (!asset?.meshLayers) return;
  for (const l of asset.meshLayers) if (layerClassId(l) === classId) l.visible = visible;
  applyMeshVisibilityFromState();
  updateMeshLayerSummary();
  updateBboxInfo();
  renderMeshSubLayerList();
}

function soloMeshClass(classId: string): void {
  const asset = state.assets.mesh;
  if (!asset?.meshLayers) return;
  const globalToggle = document.getElementById('toggle-mesh') as HTMLInputElement | null;
  if (globalToggle) { globalToggle.checked = true; globalToggle.disabled = false; }
  for (const l of asset.meshLayers) l.visible = layerClassId(l) === classId;
  meshTreeExpandedClasses.add(classId);
  applyMeshVisibilityFromState();
  updateBboxInfo();
  renderMeshSubLayerList();
}

function setMeshObjectVisible(visible: boolean): void {
  const globalToggle = document.getElementById('toggle-mesh') as HTMLInputElement | null;
  if (globalToggle) { globalToggle.checked = visible; globalToggle.disabled = false; }
  applyMeshVisibilityFromState();
  updateBboxInfo();
}

const TWISTY_OPEN = '▾';
const TWISTY_CLOSED = '▸';

function renderMeshSubLayerList(): void {
  const wrap = document.getElementById('mesh-sub-layer-list');
  const empty = document.getElementById('mesh-sub-layer-empty');
  const search = (document.getElementById('mesh-layer-search') as HTMLInputElement | null)?.value.trim().toLowerCase() ?? '';
  if (!wrap || !empty) return;

  const asset = state.assets.mesh;
  const layers = asset?.meshLayers ?? [];
  wrap.innerHTML = '';

  if (!asset || layers.length === 0) {
    empty.textContent = asset ? 'Aucune sous-couche nommée détectée.' : 'Charge un GLB/mesh pour voir ses couches.';
    empty.style.display = 'block';
    updateMeshLayerSummary();
    return;
  }

  // Filtre : on garde les instances dont le nom d'instance ou de classe matche.
  const matches = (l: MeshSubLayer) =>
    !search ||
    layerInstanceName(l).toLowerCase().includes(search) ||
    layerClassName(l).toLowerCase().includes(search);

  const filteredLayers = layers.filter(matches);
  let groups = getMeshClassGroups(filteredLayers);

  empty.style.display = groups.length === 0 ? 'block' : 'none';
  empty.textContent = groups.length === 0 ? 'Aucune couche ne correspond au filtre.' : '';

  const globalToggle = document.getElementById('toggle-mesh') as HTMLInputElement | null;
  const objectVisible = globalToggle?.checked ?? true;
  const objExpanded = meshTreeObjectExpanded || !!search; // une recherche force l'ouverture

  const tree = document.createElement('div');
  tree.className = 'mago-tree';

  // ----- Niveau 1 : l'objet importé (le GLB/mesh actif) -----
  const objRow = document.createElement('div');
  objRow.className = 'mago-tree-row level-object';
  objRow.innerHTML = `
    <button class="tree-twisty" data-toggle-object title="Replier / déplier">${objExpanded ? TWISTY_OPEN : TWISTY_CLOSED}</button>
    <label class="tree-check" title="Afficher / masquer l'objet">
      <input type="checkbox" ${objectVisible ? 'checked' : ''} data-object-visible />
    </label>
    <span class="tree-name tree-object-name" title="${escapeHtml(asset.fileName)}">${escapeHtml(asset.fileName)}</span>
    <span class="tree-count">${formatNumber(asset.triangleCount)} tris · ${groups.length} classe${groups.length > 1 ? 's' : ''}</span>
  `;
  tree.appendChild(objRow);

  if (objExpanded) {
    for (const g of groups) {
      const expanded = meshTreeExpandedClasses.has(g.classId) || !!search;
      const vstate = classVisibilityState(g);

      // ----- Niveau 2 : la classe -----
      const classRow = document.createElement('div');
      classRow.className = 'mago-tree-row level-class';
      classRow.innerHTML = `
        <button class="tree-twisty" data-toggle-class="${escapeHtml(g.classId)}" title="Déplier les objets de cette classe">${expanded ? TWISTY_OPEN : TWISTY_CLOSED}</button>
        <label class="tree-check" title="Afficher / masquer toute la classe">
          <input type="checkbox" ${vstate === 'all' ? 'checked' : ''} data-class-visible="${escapeHtml(g.classId)}" />
        </label>
        <button class="tree-name tree-class-name" data-class-toggle="${escapeHtml(g.classId)}" title="${escapeHtml(g.className)}">${escapeHtml(g.className)}</button>
        <span class="tree-count">${formatNumber(g.triangleCount)} tris · ${g.layers.length} obj.</span>
        <button class="btn-mini btn-solo-layer" data-solo-class="${escapeHtml(g.classId)}" title="N'afficher que cette classe">Solo</button>
        <button class="btn-mini btn-attr-layer" data-attr-class="${escapeHtml(g.classId)}" title="Attributs de la classe">Attributs</button>
        <button class="btn-mini danger-soft" data-delete-class="${escapeHtml(g.classId)}" title="Supprimer définitivement toute la classe">×</button>
      `;
      tree.appendChild(classRow);

      // indéterminé si visibilité partielle (à poser après insertion DOM)
      if (vstate === 'some') {
        const cb = classRow.querySelector<HTMLInputElement>('input[data-class-visible]');
        if (cb) cb.indeterminate = true;
      }

      // ----- Niveau 3 : les instances individuelles -----
      if (expanded) {
        for (const l of g.layers) {
          const instRow = document.createElement('div');
          instRow.className = 'mago-tree-row level-instance' + (state.selectedLayerId === l.id ? ' selected' : '');
          instRow.innerHTML = `
            <span class="tree-twisty-spacer"></span>
            <label class="tree-check" title="Afficher / masquer cet objet">
              <input type="checkbox" ${l.visible ? 'checked' : ''} data-layer-id="${l.id}" />
            </label>
            <button class="tree-name tree-instance-name" data-layer-select="${l.id}" title="${escapeHtml(layerInstanceName(l))} — clic pour entourer en rouge">${escapeHtml(layerInstanceName(l))}</button>
            <span class="tree-count">${formatNumber(l.triangleCount)} tris</span>
            <button class="btn-mini btn-solo-layer" data-solo-layer="${l.id}" title="N'afficher que cet objet">Solo</button>
            <button class="btn-mini btn-attr-layer" data-attr-layer="${l.id}" title="Attributs de cet objet">Attributs</button>
            <button class="btn-mini danger-soft" data-delete-layer="${l.id}" title="Supprimer définitivement cet objet">×</button>
          `;
          tree.appendChild(instRow);
        }
      }
    }
  }

  wrap.appendChild(tree);

  // ----- Câblage des évènements -----
  objRow.querySelector<HTMLButtonElement>('button[data-toggle-object]')?.addEventListener('click', () => {
    meshTreeObjectExpanded = !meshTreeObjectExpanded;
    renderMeshSubLayerList();
  });
  objRow.querySelector<HTMLInputElement>('input[data-object-visible]')?.addEventListener('change', (e) => {
    setMeshObjectVisible((e.target as HTMLInputElement).checked);
  });

  wrap.querySelectorAll<HTMLButtonElement>('button[data-toggle-class]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cid = btn.dataset.toggleClass!;
      if (meshTreeExpandedClasses.has(cid)) meshTreeExpandedClasses.delete(cid);
      else meshTreeExpandedClasses.add(cid);
      renderMeshSubLayerList();
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>('button[data-class-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cid = btn.dataset.classToggle!;
      if (meshTreeExpandedClasses.has(cid)) meshTreeExpandedClasses.delete(cid);
      else meshTreeExpandedClasses.add(cid);
      renderMeshSubLayerList();
    });
  });
  wrap.querySelectorAll<HTMLInputElement>('input[data-class-visible]').forEach((cb) => {
    cb.addEventListener('change', () => setMeshClassVisible(cb.dataset.classVisible!, cb.checked));
  });
  wrap.querySelectorAll<HTMLButtonElement>('button[data-solo-class]').forEach((btn) => {
    btn.addEventListener('click', () => soloMeshClass(btn.dataset.soloClass!));
  });
  wrap.querySelectorAll<HTMLButtonElement>('button[data-attr-class]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const g = groups.find((x) => x.classId === btn.dataset.attrClass);
      if (g) void enrichment.openForClassKey(g.classId, g.className);
    });
  });

  wrap.querySelectorAll<HTMLButtonElement>('button[data-delete-class]').forEach((btn) => {
    btn.addEventListener('click', () => { void deleteMeshClass(btn.dataset.deleteClass!); });
  });

  wrap.querySelectorAll<HTMLInputElement>('input[data-layer-id]').forEach((cb) => {
    cb.addEventListener('change', () => setMeshSubLayerVisible(cb.dataset.layerId!, cb.checked));
  });
  wrap.querySelectorAll<HTMLButtonElement>('button[data-layer-select]').forEach((btn) => {
    btn.addEventListener('click', () => setSelectedMeshSubLayer(btn.dataset.layerSelect!));
  });
  wrap.querySelectorAll<HTMLButtonElement>('button[data-solo-layer]').forEach((btn) => {
    btn.addEventListener('click', () => soloMeshSubLayer(btn.dataset.soloLayer!));
  });
  wrap.querySelectorAll<HTMLButtonElement>('button[data-attr-layer]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const layer = (state.assets.mesh?.meshLayers ?? []).find((l) => l.id === btn.dataset.attrLayer);
      if (layer) void enrichment.openForObjectKey(layer.classKey, layerClassId(layer), layerInstanceName(layer));
    });
  });

  wrap.querySelectorAll<HTMLButtonElement>('button[data-delete-layer]').forEach((btn) => {
    btn.addEventListener('click', () => { void deleteMeshSubLayer(btn.dataset.deleteLayer!); });
  });

  updateMeshLayerSummary();
  refreshReclassTargets();
  applyLayerHighlight();
}

function updateMeshLayerSummary(): void {
  const el = document.getElementById('mesh-sub-layer-summary');
  if (!el) return;
  const layers = state.assets.mesh?.meshLayers ?? [];
  if (layers.length === 0) {
    el.textContent = '—';
    return;
  }
  const visible = layers.filter((l) => l.visible).length;
  const classCount = getMeshClassGroups(layers).length;
  el.textContent = `${visible}/${layers.length} objets · ${classCount} classe${classCount > 1 ? 's' : ''}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[ch] ?? ch));
}

function setSplatVisible(visible: boolean): void {
  const asset = state.assets.splat;
  if (!asset) return;
  for (const m of asset.meshes) m.isVisible = visible;
}

function applyMeshSettings(): void {
  const asset = state.assets.mesh;
  if (!asset) return;

  for (const m of asset.meshes) {
    if (!m.material) continue;

    const mat = m.material;
    // Wireframe : mode exclusif, sans arêtes Babylon par-dessus.
    (mat as any).wireframe = state.meshMode === 'wireframe';
    // Backface : dans cette version l'option UI est retirée, on garde deux faces par défaut.
    (mat as any).backFaceCulling = !state.meshBackface;

    // Opacité
    if (mat instanceof StandardMaterial) {
      mat.alpha = state.meshOpacity;
    } else if (mat instanceof PBRMaterial) {
      mat.alpha = state.meshOpacity;
    } else {
      (mat as any).alpha = state.meshOpacity;
    }

    // Edges
    if (state.meshMode === 'edges') {
      m.enableEdgesRendering(0.95);
      m.edgesWidth = 2.0;
      m.edgesColor = new Color4(0, 0, 0, 0.6);
    } else {
      m.disableEdgesRendering();
    }
  }
}

// =================================================================
//  MEASURE TOOL UI
// =================================================================

function updateMeasureModeHint(mode: MeasureMode): void {
  const label = document.querySelector<HTMLElement>('#btn-measure .btn-label');
  const finish = document.getElementById('btn-measure-finish-area') as HTMLButtonElement | null;
  const hint = document.querySelector<HTMLElement>('#tools-dropdown .tool-section-body .panel-hint');

  const modeText =
    mode === 'distance' ? 'Distance : clique 2 points sur le mesh.' :
    'Surface : clique chaque sommet du contour sur le mesh, puis “Fermer surface”.';

  if (!state.measure.isActive() && label) label.textContent = 'Activer (touche M)';
  if (finish) finish.style.display = mode === 'area' ? 'block' : 'none';
  if (hint) hint.textContent = modeText;
}

function toggleMeasure(): void {
  const btn = document.getElementById('btn-measure')!;
  const pill = document.getElementById('pill-status');
  const newState = !state.measure.isActive();
  state.measure.setActive(newState);

  if (newState) {
    btn.classList.add('active');
    const mode = state.measure.getMode();
    const text =
      mode === 'distance' ? 'Mesure active — clique 2 points' :
      'Surface active — clique le contour';
    btn.querySelector('.btn-label')!.textContent = text;
    if (pill) {
      pill.textContent = 'mesure';
      pill.classList.add('active');
    }
  } else {
    btn.classList.remove('active');
    btn.querySelector('.btn-label')!.textContent = 'Activer (touche M)';
    if (pill) {
      pill.textContent = 'prêt';
      pill.classList.remove('active');
    }
  }
}

function updateMeasureUI(res: MeasurementResult | null): void {
  const dist = document.getElementById('measure-dist')!;
  const dx = document.getElementById('measure-dx')!;
  const dy = document.getElementById('measure-dy')!;
  const dz = document.getElementById('measure-dz')!;
  const area = document.getElementById('measure-area');
  const points = document.getElementById('measure-points');

  if (!res) {
    dist.textContent = '—';
    dx.textContent = '—';
    dy.textContent = '—';
    dz.textContent = '—';
    if (area) area.textContent = '—';
    if (points) points.textContent = '—';
    return;
  }

  dist.textContent = res.distance !== undefined ? `${res.distance.toFixed(3)} m` : '—';
  dx.textContent = res.delta ? `${res.delta.x.toFixed(3)} m` : '—';
  dy.textContent = res.delta ? `${res.delta.y.toFixed(3)} m` : '—';
  dz.textContent = res.delta ? `${res.delta.z.toFixed(3)} m` : '—';
  if (area) area.textContent = res.area !== undefined ? `${res.area.toFixed(3)} m²` : '—';
  if (points) points.textContent = `${res.points.length}`;
}

// =================================================================
//  CAMERA & BBOX INFO
// =================================================================

function updateCameraInfo(): void {
  const c = state.ctx.camera;
  document.getElementById('cam-target')!.textContent = formatVec3(c.target);
  document.getElementById('cam-alpha')!.textContent = `${(c.alpha * 180 / Math.PI).toFixed(1)}°`;
  document.getElementById('cam-beta')!.textContent = `${(c.beta * 180 / Math.PI).toFixed(1)}°`;
  document.getElementById('cam-radius')!.textContent = `${c.radius.toFixed(2)} m`;
}

function updateBboxInfo(): void {
  const bb = computeSceneBounds(getAllAssets());
  const sizeEl = document.getElementById('bbox-size')!;
  const centerEl = document.getElementById('bbox-center')!;
  if (!bb) {
    sizeEl.textContent = '—';
    centerEl.textContent = '—';
    return;
  }
  const ext = bb.boundingBox.extendSizeWorld.scale(2);
  sizeEl.textContent = formatVec3(ext);
  centerEl.textContent = formatVec3(bb.boundingBox.centerWorld);
}

// =================================================================
//  HELPERS
// =================================================================

/**
 * Déplace l'objet pour que le centre de sa boîte englobante coïncide avec
 * l'origine de la scène (0,0,0) — là où se trouvent les axes de couleur.
 * Cible : l'objet sélectionné dans la scène, sinon le mesh principal, sinon les splats.
 */
function centerAssetAtOrigin(): void {
  let asset: LoadedAsset | null = null;
  if (state.selectedObjectUid != null) {
    asset = getAllAssets().find((a) => (a.rootNode as any).uniqueId === state.selectedObjectUid) ?? null;
  }
  asset = asset ?? state.assets.mesh ?? state.assets.splat;
  if (!asset) {
    toast('Aucun objet chargé à centrer.', 'warn');
    return;
  }

  // Boîte englobante monde = union des bounding boxes des meshes de l'asset.
  const min = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  const max = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
  let found = false;
  for (const m of asset.meshes) {
    if (!m || m.isDisposed() || (m.getTotalVertices?.() ?? 0) === 0) continue;
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    min.minimizeInPlace(bb.minimumWorld);
    max.maximizeInPlace(bb.maximumWorld);
    found = true;
  }
  if (!found) {
    toast('Impossible de calculer la boîte englobante de cet objet.', 'warn');
    return;
  }

  const center = min.add(max).scale(0.5);
  const root = asset.rootNode as TransformNode;
  root.computeWorldMatrix(true);
  root.setAbsolutePosition(root.getAbsolutePosition().subtract(center));
  root.computeWorldMatrix(true);
  for (const m of asset.meshes) m.computeWorldMatrix(true);

  // Synchronise le panneau Transformations si c'est le mesh ou le splat principal.
  const syncKind: LayerKind | null =
    asset === state.assets.mesh ? 'mesh' : asset === state.assets.splat ? 'splat' : null;
  if (syncKind) {
    state.transforms[syncKind] = {
      ...state.transforms[syncKind],
      px: root.position.x,
      py: root.position.y,
      pz: root.position.z,
    };
    writeTransformToInputs(syncKind, state.transforms[syncKind]);
  }

  updateSelectedObjectTransformUI();
  updateBboxInfo();
  renderSceneObjectList();
  toast(`Objet centré sur l'origine (décalage appliqué : ${(-center.x).toFixed(3)}, ${(-center.y).toFixed(3)}, ${(-center.z).toFixed(3)}).`);
}

function getAllAssets(): LoadedAsset[] {
  const out: LoadedAsset[] = [];
  if (state.assets.mesh) out.push(state.assets.mesh);
  if (state.assets.splat) out.push(state.assets.splat);
  out.push(...state.extraAssets);
  return out;
}

function setAxesVisible(visible: boolean): void {
  state.ctx.axesViewer.xAxis.setEnabled(visible);
  state.ctx.axesViewer.yAxis.setEnabled(visible);
  state.ctx.axesViewer.zAxis.setEnabled(visible);
  const btn = document.getElementById('btn-toggle-gizmo');
  btn?.classList.toggle('active', visible);
}

function setStatus(text: string): void {
  const pill = document.getElementById('pill-status');
  if (pill && !state.measure.isActive()) {
    pill.textContent = text;
  }
}

function showProgress(pct: number, label: string): void {
  const wrap = document.getElementById('canvas-progress')!;
  const bar = document.getElementById('canvas-progress-bar')!;
  const lbl = document.getElementById('canvas-progress-label')!;
  wrap.classList.add('active');
  bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  lbl.textContent = label;
}

function hideProgress(): void {
  const wrap = document.getElementById('canvas-progress')!;
  wrap.classList.remove('active');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}

function hexToColor4(hex: string): Color4 {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return new Color4(r, g, b, 1);
}

// =================================================================
//  GO
// =================================================================

document.addEventListener('DOMContentLoaded', bootstrap);


function isLocalViewerOrigin(origin: string): boolean {
  try {
    const h = new URL(origin).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch { return false; }
}

async function getDefaultClientPublicBaseUrl(): Promise<string> {
  let configured = '';
  try {
    const res = await fetch('/api/admin/client-access/config');
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      configured = String(body?.public_base_url ?? '').trim();
    }
  } catch {}

  const localOrigin = location.origin.replace(/\/+$/, '');
  if (configured && !isLocalViewerOrigin(configured)) return configured.replace(/\/+$/, '');
  return localOrigin;
}

async function ensureClientPublicTunnelBaseUrl(): Promise<string> {
  const res = await fetch('/api/admin/public-tunnel/ensure', { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Tunnel public impossible (HTTP ${res.status})`);
  const url = String(body?.public_base_url ?? '').trim().replace(/\/+$/, '');
  if (!url || isLocalViewerOrigin(url)) throw new Error('Le tunnel public n’a pas renvoyé une adresse externe valide.');
  return url;
}


async function publishCurrentMeshForClient(
  modelId: number,
  sceneName: string,
): Promise<{ bytes?: number; manifest?: any; published: string[] }> {
  if (!state.assets.mesh) {
    throw new Error("Aucun mesh chargé : la vue client ne peut pas afficher de scène.");
  }
  const published: string[] = [];

  // ---- 1. Mesh (réinitialise le manifeste côté serveur) ----
  toast('Publication du mesh…');
  restoreHiddenMeshTrianglesBeforeExport();
  await enrichment.embedAttributesInAsset(state.assets.mesh);
  const glb = await exportMeshGlb(state.ctx.scene, state.assets.mesh, 'client_scene_mesh');
  const res = await fetch(
    `/api/admin/client-scene/publish?model_id=${encodeURIComponent(String(modelId))}&name=${encodeURIComponent(sceneName || 'Vue client MAGO')}` +
      `&mesh_background=${state.assets.mesh.background ? '1' : '0'}`,
    { method: 'POST', headers: { 'Content-Type': 'model/gltf-binary' }, body: glb },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Publication scène impossible (HTTP ${res.status})`);
  published.push(`mesh (${formatBytes(glb.size)})`);

  const publishAsset = async (kind: 'splat' | 'cloud', file: File): Promise<void> => {
    const r = await fetch(
      `/api/admin/client-scene/publish-asset?model_id=${encodeURIComponent(String(modelId))}` +
        `&kind=${kind}&filename=${encodeURIComponent(file.name)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file },
    );
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b?.error ?? `Publication ${kind} impossible (HTTP ${r.status})`);
  };

  // ---- 2. Splats : PLY avec alignement + suppressions cuits dedans ----
  if (state.assets.splat) {
    toast('Publication des splats (alignement inclus)…');
    let splatFile: File | null = null;
    if (state.splatEditor.data && state.splatEditor.baseMask) {
      splatFile = buildAlignedSplatFile('client_scene_splats.ply');
    }
    if (!splatFile && state.originalFiles.splat) {
      // Repli : format non éditable (.splat/.spz…) → fichier d'origine tel quel.
      splatFile = state.originalFiles.splat;
      const node = state.assets.splat.rootNode as TransformNode;
      node.computeWorldMatrix(true);
      if (!node.getWorldMatrix().isIdentity()) {
        toast('Splats publiés au format d’origine : l’alignement fait dans le viewer ne sera pas visible côté client (recharge un PLY pour le cuire).', 'warn', 8000);
      }
    }
    if (splatFile) {
      await publishAsset('splat', splatFile);
      published.push(`splats (${formatBytes(splatFile.size)})`);
    } else {
      toast('Splats présents mais impossibles à exporter : scène publiée sans splats.', 'warn', 7000);
    }
  }

  // ---- 3. Nuage de points : premier nuage chargé, fichier d'origine ----
  const cloudAsset = state.extraAssets.find((a) => a.kind === 'pointcloud' && (a as any).sourceFile) as any;
  if (cloudAsset?.sourceFile) {
    toast('Publication du nuage de points…');
    await publishAsset('cloud', cloudAsset.sourceFile as File);
    published.push(`nuage (${formatBytes((cloudAsset.sourceFile as File).size)})`);
  } else if (state.extraAssets.some((a) => a.kind === 'pointcloud')) {
    toast('Nuage présent mais fichier source indisponible (chargé avant ce patch ?) : recharge le PLY puis republie.', 'warn', 8000);
  }

  return { ...body, published };
}

async function openCreateClientViewDialog(): Promise<void> {
  const model = enrichment.getModelInfo();
  if (model.id == null) {
    toast("Aucun modèle actif en base. Charge d'abord un mesh avec l'API démarrée.", 'warn', 5000);
    return;
  }

  let publicBaseUrl = '';
  try {
    toast('Démarrage automatique du tunnel public Cloudflare…');
    publicBaseUrl = await ensureClientPublicTunnelBaseUrl();
    toast('Tunnel public prêt. Création de la vue client possible.');
  } catch (e: any) {
    console.warn('Tunnel public automatique indisponible', e);
    publicBaseUrl = await getDefaultClientPublicBaseUrl();
    toast(`Tunnel automatique indisponible : ${e?.message ?? e}`, 'error', 7000);
  }

  const existing = document.getElementById('mago-client-create-modal');
  existing?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'mago-client-create-modal';
  overlay.innerHTML = `
    <div class="mcc-backdrop"></div>
    <form class="mcc-card" id="mcc-form">
      <div class="mcc-head">
        <div>
          <div class="mcc-title">Créer vue client</div>
          <div class="mcc-sub">Modèle actif : <strong>${escapeHtml(model.name || 'Sans nom')}</strong> · id ${model.id}</div>
        </div>
        <button type="button" class="mcc-close" id="mcc-close" title="Fermer">×</button>
      </div>
      <label>Nom de la scène (visible par le client)
        <input id="mcc-name" type="text" autocomplete="off" placeholder="ex. Salle C10" value="${escapeHtml(model.name || '')}" required />
      </label>
      <label>Identifiant client
        <input id="mcc-user" type="text" autocomplete="off" placeholder="ex. dupont" required />
      </label>
      <label>Mot de passe
        <input id="mcc-pass" type="text" autocomplete="off" placeholder="ex. MotDePasse#2026" required />
      </label>
      <label>Date et heure d'expiration
        <input id="mcc-exp" type="datetime-local" required />
      </label>
      <label>Adresse publique automatiquement utilisée
        <input id="mcc-public-url" type="url" autocomplete="off" placeholder="https://xxxxx.trycloudflare.com" value="${escapeHtml(publicBaseUrl)}" required />
      </label>
      <p class="mcc-hint">MAGO démarre automatiquement le tunnel Cloudflare quand tu cliques sur « Créer vue client ». La création publie toute la scène côté serveur : le mesh, les splats (avec leur alignement et tes suppressions) et le nuage de points s'ils sont chargés. Le client voit la même scène que toi après connexion. Garde ton PC et MAGO Viewer ouverts tant que le lien doit fonctionner.</p>
      <div class="mcc-actions">
        <button type="button" class="btn-secondary" id="mcc-cancel">Annuler</button>
        <button type="submit" class="btn-action">Créer l'accès</button>
      </div>
      <div class="mcc-result" id="mcc-result"></div>
    </form>
  `;
  document.body.appendChild(overlay);
  injectClientCreateStyles();

  const close = () => overlay.remove();
  overlay.querySelector('#mcc-close')?.addEventListener('click', close);
  overlay.querySelector('#mcc-cancel')?.addEventListener('click', close);
  overlay.querySelector('.mcc-backdrop')?.addEventListener('click', close);

  const exp = overlay.querySelector('#mcc-exp') as HTMLInputElement;
  exp.value = defaultExpiryLocalValue();

  const form = overlay.querySelector('#mcc-form') as HTMLFormElement;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const identifiant = (overlay.querySelector('#mcc-user') as HTMLInputElement).value.trim();
    const mot_de_passe = (overlay.querySelector('#mcc-pass') as HTMLInputElement).value.trim();
    const date_expiration = (overlay.querySelector('#mcc-exp') as HTMLInputElement).value.replace('T', ' ');
    const public_base_url = (overlay.querySelector('#mcc-public-url') as HTMLInputElement).value.trim().replace(/\/+$/, '');
    const result = overlay.querySelector('#mcc-result') as HTMLElement;

    if (isLocalViewerOrigin(public_base_url)) {
      result.textContent = 'Erreur : pour un client hors réseau, remplace localhost par l’adresse Cloudflare ou un domaine public.';
      toast('Lien public invalide : localhost ne marche pas chez un client externe.', 'error', 7000);
      return;
    }

    result.textContent = 'Publication du mesh côté serveur…';

    try {
      const sceneName = (overlay.querySelector('#mcc-name') as HTMLInputElement).value.trim()
        || model.name || 'Vue client MAGO';
      const published = await publishCurrentMeshForClient(Number(model.id), sceneName);
      result.textContent = 'Mesh publié. Création de l’accès client…';

      const res = await fetch('/api/admin/client-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model_id: model.id,
          identifiant,
          mot_de_passe,
          date_expiration,
          public_base_url,
          active: true,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);

      const link = body.lien_client ?? body.lien ?? `${public_base_url}/?client=1&m=${model.id}`;
      result.innerHTML = `
        <div><strong>Vue client créée.</strong></div>
        <div>Scène publiée : <code>${escapeHtml((published?.published ?? []).join(' + ') || String(published?.bytes ?? '') + ' octets')}</code></div>
        <div>Lien : <code>${escapeHtml(link)}</code></div>
        <div>Identifiant : <code>${escapeHtml(identifiant)}</code></div>
        <div>Mot de passe : <code>${escapeHtml(mot_de_passe)}</code></div>
        <div>Expiration : <code>${escapeHtml(date_expiration)}</code></div>
      `;
      try { await navigator.clipboard.writeText(link); toast(`Vue client créée (${(published?.published ?? []).join(' + ')}), lien copié.`); }
      catch { toast(`Vue client créée : ${(published?.published ?? []).join(' + ')}.`); }
    } catch (e: any) {
      result.textContent = `Erreur : ${e.message ?? e}`;
      toast(`Création vue client impossible : ${e.message ?? e}`, 'error', 6000);
    }
  });
}

function defaultExpiryLocalValue(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 2);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let clientCreateStylesInjected = false;
function injectClientCreateStyles(): void {
  if (clientCreateStylesInjected) return;
  clientCreateStylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    #mago-client-create-modal { position: fixed; inset: 0; z-index: 9999; }
    #mago-client-create-modal .mcc-backdrop { position:absolute; inset:0; background:rgba(5,8,14,.72); backdrop-filter: blur(4px); }
    #mago-client-create-modal .mcc-card { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:min(460px, calc(100vw - 32px)); background:#171b22; border:1px solid #344050; border-radius:14px; padding:22px; box-shadow:0 20px 70px rgba(0,0,0,.45); color:#e9f0ff; }
    #mago-client-create-modal .mcc-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:18px; }
    #mago-client-create-modal .mcc-title { font-size:20px; font-weight:800; }
    #mago-client-create-modal .mcc-sub, #mago-client-create-modal .mcc-hint { color:#a9b6c9; font-size:12px; line-height:1.45; }
    #mago-client-create-modal .mcc-close { background:transparent; border:0; color:#dbe8ff; font-size:24px; cursor:pointer; }
    #mago-client-create-modal label { display:block; margin:12px 0; color:#c7d6ea; font-size:13px; }
    #mago-client-create-modal input { width:100%; margin-top:7px; box-sizing:border-box; background:#10141b; border:1px solid #3c4a5c; border-radius:8px; color:#f3f7ff; padding:11px 12px; outline:none; }
    #mago-client-create-modal input:focus { border-color:#7dd8c8; box-shadow:0 0 0 2px rgba(125,216,200,.18); }
    #mago-client-create-modal .mcc-actions { display:flex; gap:10px; justify-content:flex-end; margin-top:18px; }
    #mago-client-create-modal .mcc-result { margin-top:14px; font-size:12px; color:#cce9e2; line-height:1.6; }
    #mago-client-create-modal code { color:#fff; background:#0f131a; border:1px solid #2c3542; padding:2px 5px; border-radius:5px; }
  `;
  document.head.appendChild(style);
}

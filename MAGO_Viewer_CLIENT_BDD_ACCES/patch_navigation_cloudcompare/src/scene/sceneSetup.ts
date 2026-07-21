import {
  ArcRotateCamera,
  AxesViewer,
  Color3,
  Color4,
  Engine,
  HemisphericLight,
  DirectionalLight,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';

export interface SceneContext {
  engine: Engine;
  scene: Scene;
  camera: ArcRotateCamera;
  axesViewer: AxesViewer;
  grid: Mesh;
}

/**
 * CrÃ©e la scÃ¨ne Babylon avec camÃ©ra, lumiÃ¨res et helpers (grille + repÃ¨re XYZ).
 * Tout est paramÃ©trÃ© pour visualiser des intÃ©rieurs scannÃ©s Ã  l'Ã©chelle mÃ©trique.
 */
export function createSceneContext(canvas: HTMLCanvasElement): SceneContext {
  const engine = new Engine(canvas, true, {
    // preserveDrawingBuffer=false amÃ©liore les performances. Les captures utilisent un render target dÃ©diÃ©.
    preserveDrawingBuffer: false,
    stencil: false,
    antialias: true,
    powerPreference: 'high-performance',
  });

  const scene = new Scene(engine);
  // Babylon fonctionne naturellement en repÃ¨re main gauche.
  // Ne pas forcer useRightHandedSystem ici : avec les Gaussian Splats Babylon,
  // cela inverse gauche/droite dans la scÃ¨ne client/Ã©diteur.
  scene.useRightHandedSystem = false;
  scene.clearColor = new Color4(14 / 255, 15 / 255, 17 / 255, 1.0);
  scene.ambientColor = new Color3(0.4, 0.4, 0.4);
  // Ã‰vite du picking permanent au survol ; les outils utilisent leur propre logique au clic.
  (scene as any).skipPointerMovePicking = true;

  // CamÃ©ra orbitale : alpha (azimut), beta (Ã©lÃ©vation), radius (distance)
  const camera = new ArcRotateCamera(
    'cam',
    Math.PI / 4,      // alpha
    Math.PI / 3,      // beta (vue plongeante)
    8,                // radius
    Vector3.Zero(),
    scene
  );
  camera.attachControl(canvas, true);
  try {
    const inputs = camera.inputs as any;
    inputs?.removeByType?.('ArcRotateCameraMouseWheelInput');
    if (inputs?.attached?.mousewheel) inputs.remove(inputs.attached.mousewheel);
  } catch { /* noop */ }
  camera.wheelDeltaPercentage = 0; // zoom molette natif dÃ©sactivÃ© : zoom orbital MAGO gÃ©rÃ© dans main.ts
  camera.pinchDeltaPercentage = 0.012; // ajustÃ© par le slider Vitesse zoom
  camera.minZ = 0.001;
  camera.maxZ = 100000;
  // Zoom trÃ¨s libre : utile pour inspecter des gros meshes / dÃ©tails trÃ¨s proches.
  camera.lowerRadiusLimit = 0;
  camera.upperRadiusLimit = Number.MAX_SAFE_INTEGER;
  camera.panningSensibility = 50;
  camera.angularSensibilityX = 1000;
  camera.angularSensibilityY = 1000;
  camera.inertia = 0.72;

  // LumiÃ¨re ambiante hÃ©misphÃ©rique douce
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.7;
  hemi.groundColor = new Color3(0.4, 0.42, 0.45);

  // LumiÃ¨re directionnelle principale pour la dÃ©finition
  const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, -0.3), scene);
  sun.intensity = 0.55;

  // Grille au sol â€” utile pour Ã©valuer les distances et l'Ã©chelle
  const grid = MeshBuilder.CreateGround('grid', { width: 20, height: 20, subdivisions: 20 }, scene);
  const gridMat = new StandardMaterial('gridMat', scene);
  gridMat.wireframe = true;
  gridMat.emissiveColor = new Color3(0.18, 0.20, 0.23);
  gridMat.diffuseColor = new Color3(0, 0, 0);
  gridMat.specularColor = new Color3(0, 0, 0);
  gridMat.disableLighting = true;
  grid.material = gridMat;
  grid.isPickable = false;
  // DÃ©calage minuscule pour Ã©viter le z-fighting avec un sol scannÃ© Ã  z=0
  grid.position.y = -0.001;

  // RepÃ¨re XYZ (axes)
  const axesViewer = new AxesViewer(scene, 1.5);

  return { engine, scene, camera, axesViewer, grid };
}

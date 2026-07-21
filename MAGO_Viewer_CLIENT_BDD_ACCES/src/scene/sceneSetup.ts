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
 * Crée la scène Babylon avec caméra, lumières et helpers (grille + repère XYZ).
 * Tout est paramétré pour visualiser des intérieurs scannés à l'échelle métrique.
 */
export function createSceneContext(canvas: HTMLCanvasElement): SceneContext {
  const engine = new Engine(canvas, true, {
    // preserveDrawingBuffer=false améliore les performances. Les captures utilisent un render target dédié.
    preserveDrawingBuffer: false,
    stencil: true,
    antialias: true,
    powerPreference: 'high-performance',
  });

  const scene = new Scene(engine);
  // Cohérence avec les données LiDAR / CloudCompare / Blender : repère main droite.
  // Évite les inversions gauche/droite dans le viewer.
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(14 / 255, 15 / 255, 17 / 255, 1.0);
  scene.ambientColor = new Color3(0.4, 0.4, 0.4);
  // Évite du picking permanent au survol ; les outils utilisent leur propre logique au clic.
  (scene as any).skipPointerMovePicking = true;

  // Caméra orbitale : alpha (azimut), beta (élévation), radius (distance)
  const camera = new ArcRotateCamera(
    'cam',
    Math.PI / 4,      // alpha
    Math.PI / 3,      // beta (vue plongeante)
    8,                // radius
    Vector3.Zero(),
    scene
  );
  camera.attachControl(canvas, true);
  camera.wheelDeltaPercentage = 0.012;
  camera.pinchDeltaPercentage = 0.012;
  camera.minZ = 0.001;
  camera.maxZ = 100000;
  // Zoom très libre : utile pour inspecter des gros meshes / détails très proches.
  camera.lowerRadiusLimit = 0.001;
  camera.upperRadiusLimit = 100000;
  camera.panningSensibility = 140;
  camera.angularSensibilityX = 1000;
  camera.angularSensibilityY = 1000;

  // Lumière ambiante hémisphérique douce
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.7;
  hemi.groundColor = new Color3(0.4, 0.42, 0.45);

  // Lumière directionnelle principale pour la définition
  const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, -0.3), scene);
  sun.intensity = 0.55;

  // Grille au sol — utile pour évaluer les distances et l'échelle
  const grid = MeshBuilder.CreateGround('grid', { width: 20, height: 20, subdivisions: 20 }, scene);
  const gridMat = new StandardMaterial('gridMat', scene);
  gridMat.wireframe = true;
  gridMat.emissiveColor = new Color3(0.18, 0.20, 0.23);
  gridMat.diffuseColor = new Color3(0, 0, 0);
  gridMat.specularColor = new Color3(0, 0, 0);
  gridMat.disableLighting = true;
  grid.material = gridMat;
  grid.isPickable = false;
  // Décalage minuscule pour éviter le z-fighting avec un sol scanné à z=0
  grid.position.y = -0.001;

  // Repère XYZ (axes)
  const axesViewer = new AxesViewer(scene, 1.5);

  return { engine, scene, camera, axesViewer, grid };
}

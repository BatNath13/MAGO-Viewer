import {
  ArcRotateCamera,
  BoundingInfo,
  Mesh,
  Scene,
  Tools,
  Vector3,
} from '@babylonjs/core';
import type { LoadedAsset } from '../types';

/**
 * Calcule la bounding box englobante de tous les assets chargés.
 * Retourne null si aucun asset.
 */
export function computeSceneBounds(assets: LoadedAsset[]): BoundingInfo | null {
  let min: Vector3 | null = null;
  let max: Vector3 | null = null;

  for (const asset of assets) {
    for (const m of asset.meshes) {
      if (!m.isVisible) continue;
      if (!m.getBoundingInfo) continue;
      const bb = m.getBoundingInfo().boundingBox;
      const wmin = bb.minimumWorld;
      const wmax = bb.maximumWorld;
      if (!min) {
        min = wmin.clone();
        max = wmax.clone();
      } else {
        min = Vector3.Minimize(min, wmin);
        max = Vector3.Maximize(max!, wmax);
      }
    }
  }

  if (!min || !max) return null;
  return new BoundingInfo(min, max);
}

/**
 * Recadre la caméra pour englober tous les assets visibles.
 * Optionnellement laisse le `alpha`/`beta` actuels intacts.
 */
export function frameScene(
  camera: ArcRotateCamera,
  assets: LoadedAsset[],
  keepAngles = false
): void {
  const bounds = computeSceneBounds(assets);
  if (!bounds) return;

  const center = bounds.boundingBox.centerWorld;
  const extent = bounds.boundingBox.extendSizeWorld;
  const maxDim = Math.max(extent.x, extent.y, extent.z) * 2;

  // Distance basée sur le FOV pour que tout rentre
  const fov = camera.fov;
  const dist = (maxDim * 0.55) / Math.tan(fov / 2);

  camera.target = center.clone();
  camera.radius = Math.max(dist, 0.5);
  camera.lowerRadiusLimit = 0.001;
  camera.upperRadiusLimit = Math.max(maxDim * 200, 100000);

  if (!keepAngles) {
    camera.alpha = Math.PI / 4;
    camera.beta = Math.PI / 3;
  }
}

/**
 * Vues prédéfinies type CAO : top, front, side, iso.
 */
export function applyPredefinedView(
  camera: ArcRotateCamera,
  view: 'top' | 'front' | 'side' | 'iso'
): void {
  switch (view) {
    case 'top':
      camera.alpha = -Math.PI / 2;
      camera.beta = 0.01; // un poil > 0 pour éviter le gimbal lock
      break;
    case 'front':
      camera.alpha = -Math.PI / 2;
      camera.beta = Math.PI / 2;
      break;
    case 'side':
      camera.alpha = 0;
      camera.beta = Math.PI / 2;
      break;
    case 'iso':
      camera.alpha = Math.PI / 4;
      camera.beta = Math.PI / 3;
      break;
  }
}

/**
 * Capture d'écran à la résolution actuelle.
 * Utilise Tools.CreateScreenshotUsingRenderTargetAsync pour la haute résolution.
 */
export async function captureScreenshot(scene: Scene, scale = 2): Promise<void> {
  const engine = scene.getEngine();
  const camera = scene.activeCamera;
  if (!camera) return;

  const width = engine.getRenderWidth();
  const height = engine.getRenderHeight();

  // Capture à scale × résolution actuelle pour de l'export HD
  const data = await Tools.CreateScreenshotUsingRenderTargetAsync(
    engine,
    camera,
    { width: width * scale, height: height * scale },
    'image/png'
  );

  // data est une dataURL — on déclenche un download
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const a = document.createElement('a');
  a.href = data;
  a.download = `mago-viewer_${ts}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * Formate un Vector3 pour affichage compact.
 */
export function formatVec3(v: Vector3, decimals = 2): string {
  return `${v.x.toFixed(decimals)}, ${v.y.toFixed(decimals)}, ${v.z.toFixed(decimals)}`;
}

export function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

import { AbstractMesh, Matrix, Scene, Vector3, VertexBuffer } from '@babylonjs/core';
import { GLTF2Export } from '@babylonjs/serializers/glTF';
import JSZip from 'jszip';
import type { LoadedAsset, SceneExportConfig } from '../types';

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadText(text: string, fileName: string, type = 'application/json'): void {
  downloadBlob(new Blob([text], { type }), fileName);
}

export async function exportMeshGlb(scene: Scene, meshAsset: LoadedAsset | null, fileBase = 'marble_mesh'): Promise<Blob> {
  if (!meshAsset) {
    throw new Error('Aucun mesh chargé à exporter.');
  }

  const meshRoot = meshAsset.rootNode as any;

  // Le viewer affiche tous les meshes MAGO/CloudCompare avec une rotation X de -90°
  // (Z-up source -> Y-up Babylon). Si cette rotation d'affichage est écrite dans le
  // GLB, elle est appliquée une deuxième fois lors du réimport. On neutralise donc
  // UNIQUEMENT cette rotation pendant la sérialisation, sans cloner les meshes et
  // sans modifier la hiérarchie, les noms, les classes ou les LOD.
  const savedRotationX = meshRoot.rotation?.x ?? 0;
  const savedQuaternion = meshRoot.rotationQuaternion ?? null;

  try {
    // Les transformations MAGO standard utilisent les angles d'Euler sur la racine.
    // +90° annule seulement la conversion d'affichage -90° déjà présente.
    if (meshRoot.rotationQuaternion) {
      meshRoot.rotation = meshRoot.rotationQuaternion.toEulerAngles();
      meshRoot.rotationQuaternion = null;
    }
    meshRoot.rotation.x += Math.PI / 2;
    meshRoot.computeWorldMatrix(true);
    for (const mesh of meshAsset.meshes) mesh.computeWorldMatrix(true);

    const gltfData = await GLTF2Export.GLBAsync(scene, fileBase, {
      shouldExportNode: (node: any) => belongsToRoot(node, meshRoot),
      metadataSelector: (metadata: any) => metadata?.gltf?.extras,
    } as any);

    const glb = findFirstBlob((gltfData as any).glTFFiles);
    if (!glb) {
      throw new Error("L'export GLB n'a pas produit de fichier binaire.");
    }
    return glb;
  } finally {
    // Restauration exacte de la scène affichée, même si l'export échoue.
    if (savedQuaternion) {
      meshRoot.rotationQuaternion = savedQuaternion;
    } else {
      meshRoot.rotationQuaternion = null;
      meshRoot.rotation.x = savedRotationX;
    }
    meshRoot.computeWorldMatrix(true);
    for (const mesh of meshAsset.meshes) mesh.computeWorldMatrix(true);
  }

}

export async function downloadMeshGlb(scene: Scene, meshAsset: LoadedAsset | null): Promise<void> {
  const raw = meshAsset?.fileName ?? 'mesh';
  const base = (raw
    .replace(/\.[^.]+$/i, '')      // enlève l'extension
    .replace(/\s*\(\d+\)$/i, '')   // enlève le "(1)" ajouté par le navigateur
    .replace(/_enrichi$/i, '')     // évite _enrichi_enrichi lors des ré-exports
    .trim()) || 'mesh';
  const fileBase = `${base}_enrichi`;
  const glb = await exportMeshGlb(scene, meshAsset, fileBase);
  downloadBlob(glb, `${fileBase}.glb`);
}

export async function downloadScenePackageZip(options: {
  scene: Scene;
  meshAsset: LoadedAsset | null;
  splatAsset: LoadedAsset | null;
  originalMeshFile: File | null;
  originalSplatFile: File | null;
  alignedSplatFile?: File | null;
  config: SceneExportConfig;
}): Promise<void> {
  const zip = new JSZip();
  zip.file('scene_config.json', JSON.stringify(options.config, null, 2));

  if (options.meshAsset) {
    try {
      const glb = await exportMeshGlb(options.scene, options.meshAsset, 'mesh_transformed');
      zip.file('mesh_transformed.glb', glb);
    } catch (err) {
      if (options.originalMeshFile) {
        zip.file(`original_${safeFileName(options.originalMeshFile.name)}`, options.originalMeshFile);
      }
      zip.file('EXPORT_MESH_WARNING.txt', String((err as Error).message ?? err));
    }
  }

  if (options.alignedSplatFile) {
    zip.file(`splats_ALIGNED_${safeFileName(options.alignedSplatFile.name)}`, options.alignedSplatFile);
  }

  if (options.originalSplatFile) {
    zip.file(`splats_original_${safeFileName(options.originalSplatFile.name)}`, options.originalSplatFile);
  } else if (options.splatAsset && !options.alignedSplatFile) {
    zip.file('SPLATS_WARNING.txt', 'Splats chargés, mais le fichier original n\'est plus disponible dans le navigateur. Recharge le PLY splats puis réexporte le package.');
  }

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  downloadBlob(blob, 'marble_scene_package.zip');
}


// -----------------------------------------------------------------------------
// Export mesh MAGO / CloudCompare / 3DR
// -----------------------------------------------------------------------------
// Le viewer affiche les données en repère Babylon/Y-up. Les données MAGO,
// CloudCompare, 3DR et RealityScan sont utilisées en repère géomètre Z-up.
// Conversion validée sur tes bbox :
//   X_mago =  X_viewer
//   Y_mago = -Z_viewer
//   Z_mago =  Y_viewer
// Important : on transforme d'abord les vertices en coordonnées monde VIEWER
// (donc avec alignement manuel/gizmo/points), puis on convertit vers MAGO.

type ExportVertex = { x: number; y: number; z: number; r: number; g: number; b: number };
type ExportFace = [number, number, number];

function viewerWorldToMago(p: Vector3): Vector3 {
  return new Vector3(p.x, -p.z, p.y);
}

function isRenderableMesh(m: AbstractMesh): boolean {
  if (!m || m.isDisposed()) return false;
  if (!m.isEnabled() || !m.isVisible) return false;
  const positions = m.getVerticesData(VertexBuffer.PositionKind);
  return !!positions && positions.length >= 9;
}

function collectMeshGeometryMago(meshAsset: LoadedAsset | null): { vertices: ExportVertex[]; faces: ExportFace[] } {
  if (!meshAsset) throw new Error('Aucun mesh chargé à exporter.');

  const vertices: ExportVertex[] = [];
  const faces: ExportFace[] = [];
  const tmp = Vector3.Zero();

  for (const mesh of meshAsset.meshes) {
    if (!isRenderableMesh(mesh)) continue;
    mesh.computeWorldMatrix(true);
    const world = mesh.getWorldMatrix();
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!positions) continue;
    const colors = mesh.getVerticesData(VertexBuffer.ColorKind);
    const rawIndices = mesh.getIndices();

    // Si pas d'indices, on considère les vertices par triplets.
    const indices: number[] | ArrayLike<number> = rawIndices && rawIndices.length >= 3
      ? rawIndices
      : Array.from({ length: Math.floor(positions.length / 3) }, (_, i) => i);

    const localToExport = new Map<number, number>();
    const getExportIndex = (localIndex: number): number => {
      const cached = localToExport.get(localIndex);
      if (cached != null) return cached;
      const pi = localIndex * 3;
      if (pi + 2 >= positions.length) return -1;

      tmp.set(positions[pi], positions[pi + 1], positions[pi + 2]);
      const worldPos = Vector3.TransformCoordinates(tmp, world);
      const mago = viewerWorldToMago(worldPos);

      let r = 200, g = 204, b = 210;
      if (colors && localIndex * 4 + 2 < colors.length) {
        r = Math.round(clamp01(colors[localIndex * 4]) * 255);
        g = Math.round(clamp01(colors[localIndex * 4 + 1]) * 255);
        b = Math.round(clamp01(colors[localIndex * 4 + 2]) * 255);
      }

      const outIndex = vertices.length;
      vertices.push({ x: mago.x, y: mago.y, z: mago.z, r, g, b });
      localToExport.set(localIndex, outIndex);
      return outIndex;
    };

    for (let i = 0; i + 2 < indices.length; i += 3) {
      const a = getExportIndex(indices[i] as number);
      const b = getExportIndex(indices[i + 1] as number);
      const c = getExportIndex(indices[i + 2] as number);
      if (a >= 0 && b >= 0 && c >= 0 && a !== b && b !== c && a !== c) faces.push([a, b, c]);
    }
  }

  if (vertices.length === 0 || faces.length === 0) {
    throw new Error('Aucune géométrie mesh visible/exportable trouvée. Vérifie que le mesh est affiché.');
  }
  return { vertices, faces };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

export function exportMeshPlyMago(meshAsset: LoadedAsset | null, fileName = 'mesh_MAGO_ALIGNED.ply'): Blob {
  const { vertices, faces } = collectMeshGeometryMago(meshAsset);
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    'comment Exported by MAGO Viewer in MAGO/CloudCompare Z-up coordinates',
    `element vertex ${vertices.length}`,
    'property float x',
    'property float y',
    'property float z',
    'property uchar red',
    'property uchar green',
    'property uchar blue',
    `element face ${faces.length}`,
    'property list uchar int vertex_indices',
    'end_header',
    '',
  ].join('\n');
  const headerBytes = new TextEncoder().encode(header);
  const rowSize = 3 * 4 + 3;
  const faceSize = 1 + 3 * 4;
  const out = new Uint8Array(headerBytes.length + vertices.length * rowSize + faces.length * faceSize);
  out.set(headerBytes, 0);
  const view = new DataView(out.buffer);
  let off = headerBytes.length;
  for (const v of vertices) {
    view.setFloat32(off, v.x, true); off += 4;
    view.setFloat32(off, v.y, true); off += 4;
    view.setFloat32(off, v.z, true); off += 4;
    view.setUint8(off++, v.r);
    view.setUint8(off++, v.g);
    view.setUint8(off++, v.b);
  }
  for (const f of faces) {
    view.setUint8(off++, 3);
    view.setInt32(off, f[0], true); off += 4;
    view.setInt32(off, f[1], true); off += 4;
    view.setInt32(off, f[2], true); off += 4;
  }
  return new Blob([out], { type: 'application/octet-stream' });
}

export function downloadMeshPlyMago(meshAsset: LoadedAsset | null): void {
  const blob = exportMeshPlyMago(meshAsset);
  downloadBlob(blob, 'mesh_MAGO_ALIGNED.ply');
}

export function exportMeshObjMago(meshAsset: LoadedAsset | null): Blob {
  const { vertices, faces } = collectMeshGeometryMago(meshAsset);
  const lines: string[] = [
    '# Exported by MAGO Viewer in MAGO/CloudCompare Z-up coordinates',
    '# Vertex colors are written as OBJ extended v x y z r g b (0..1).',
  ];
  for (const v of vertices) {
    lines.push(`v ${fmt(v.x)} ${fmt(v.y)} ${fmt(v.z)} ${fmt(v.r / 255)} ${fmt(v.g / 255)} ${fmt(v.b / 255)}`);
  }
  for (const f of faces) lines.push(`f ${f[0] + 1} ${f[1] + 1} ${f[2] + 1}`);
  return new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
}

export function downloadMeshObjMago(meshAsset: LoadedAsset | null): void {
  const blob = exportMeshObjMago(meshAsset);
  downloadBlob(blob, 'mesh_MAGO_ALIGNED.obj');
}

function fmt(v: number): string {
  return Number.isFinite(v) ? v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') : '0';
}

function belongsToRoot(node: any, root: any): boolean {
  let current = node;
  while (current) {
    if (current === root) return true;
    current = current.parent;
  }
  return false;
}

function findFirstBlob(files: Record<string, Blob | string> | undefined): Blob | null {
  if (!files) return null;
  for (const value of Object.values(files)) {
    if (value instanceof Blob) return value;
  }
  return null;
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

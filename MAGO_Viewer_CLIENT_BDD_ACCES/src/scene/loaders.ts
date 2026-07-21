import {
  AbstractMesh,
  Color3,
  DracoCompression,
  GaussianSplattingMesh,
  ImportMeshAsync,
  Mesh,
  Scene,
  SceneLoader,
  StandardMaterial,
  SubMesh,
  TransformNode,
  Vector3,
  VertexData,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF';
import '@babylonjs/loaders/OBJ';
import '@babylonjs/loaders/SPLAT';

// =================================================================
//  DÉCODEUR DRACO LOCAL
// -----------------------------------------------------------------
// Les GLB de tuiles MAGO sont compressés Draco par le pipeline. Sans cette
// config, Babylon va chercher le WASM sur cdn.babylonjs.com à chaque tuile :
//   - lent (réseau) ;
//   - échecs silencieux quand le réseau bloque le CDN -> tuiles fantômes.
// Les fichiers sont servis localement depuis public/draco/. Le décodage tourne
// dans un worker, donc il ne fige plus le rendu.
// =================================================================
DracoCompression.Configuration = {
  decoder: {
    wasmUrl: 'draco/draco_wasm_wrapper.js',
    wasmBinaryUrl: 'draco/draco_decoder.wasm',
    fallbackUrl: 'draco/draco_decoder.js',
  },
};
// Pool de workers borné : décodage Draco parallèle sans saturer le CPU.
try {
  (DracoCompression as any).DefaultNumWorkers = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
} catch {}

import type { LoadedAsset, MeshSubLayer } from '../types';
import { cleanPlyHeaderFromFile } from '../utils/plyCleaner';

// Canari de version : si cette ligne n'apparaît pas dans la console (F12) au
// démarrage, c'est que le serveur sert une AUTRE copie du projet que celle-ci.
console.info('[MAGO loaders] lecteur PLY chunké v3 (subMeshes Firefox) — build 2026-07-09');

interface LoadOptions {
  scene: Scene;
  onProgress?: (loaded: number, total: number) => void;
}

type PlyFaceProp =
  | { isList: true; countType: string; itemType: string; name: string }
  | { isList: false; type: string; name: string };


async function readPlyHeader(file: File): Promise<string[]> {
  const maxBytes = Math.min(file.size, 1024 * 256);
  const text = await file.slice(0, maxBytes).text();
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((l) => l.trim() === 'end_header');
  return end >= 0 ? lines.slice(0, end + 1) : lines;
}

async function assertPlyLooksLikeMesh(file: File): Promise<void> {
  const header = await readPlyHeader(file);
  const faceLine = header.find((l) => /^element\s+face\s+\d+/i.test(l.trim()));
  const vertexLine = header.find((l) => /^element\s+vertex\s+\d+/i.test(l.trim()));
  const vertexCount = vertexLine ? Number(vertexLine.trim().split(/\s+/)[2]) : NaN;
  const faceCount = faceLine ? Number(faceLine.trim().split(/\s+/)[2]) : 0;

  if (!faceLine || !Number.isFinite(faceCount) || faceCount <= 0) {
    const n = Number.isFinite(vertexCount) ? ` (${vertexCount.toLocaleString('fr-FR')} points)` : '';
    throw new Error(
      `Ce PLY ressemble à un nuage de points${n}, pas à un mesh : aucune face n'a été trouvée dans l'en-tête. ` +
      `Charge plutôt un PLY/GLB avec faces dans le slot Mesh, ou un fichier 3DGS dans le slot Gaussian Splats.`
    );
  }
}


function normalizeGlbLayerName(name: string): string {
  let n = name.trim();

  // Suffixes courants générés par Blender/glTF/Babylon quand un objet est découpé.
  n = n.replace(/\s*\(\d+\)$/g, '');
  n = n.replace(/\.\d{3,}$/g, '');
  n = n.replace(/[_\-. ]?primitive[_\-. ]?\d+$/i, '');
  n = n.replace(/[_\-. ]?mesh[_\-. ]?\d+$/i, '');
  n = n.replace(/[_\-. ]?node[_\-. ]?\d+$/i, '');

  // LOD exportés depuis Blender/MAGO : on les regroupe comme une seule couche logique.
  // Exemple : class_009_wall_LOD0, class_009_wall_LOD1, class_009_wall_LOD2
  // doivent apparaître comme une seule ligne "class_009_wall" dans les calques.
  n = n.replace(/[_\-. ]?lod[_\-. ]?\d+$/i, '');
  n = n.replace(/[_\-. ]?(high|medium|med|mid|low|coarse|fine)$/i, '');

  // Cas fréquent dans ton export : class_001_covering_ceiling, class_009_wall, etc.
  // On garde le nom de classe complet mais on enlève les suffixes techniques éventuels.
  const classMatch = n.match(/^(class_[a-z]?\d+_[a-z0-9]+(?:_[a-z0-9]+)*)/i);
  if (classMatch) n = classMatch[1];

  return n || name || 'Objet';
}

/**
 * Carte d'affichage label -> nom FR (intérieur + extérieur MAGO).
 * Étends-la librement ; toute classe absente retombe sur un nom dérivé du slug.
 */
export const MAGO_CLASS_DISPLAY: Record<number, string> = {
  [-1]: 'Inconnu',
  1: 'Plafond', 7: 'Sol', 9: 'Mur',
  100: 'Mur', 101: 'Plafond', 102: 'Sol',
  103: 'Porte', 104: 'Fenêtre', 156: 'Plafond incliné',
  110: 'Élément 110', 112: 'Élément 112',
  113: 'Électricité', 114: 'Équipement CVC', 116: 'Équipement plafond',
  117: 'Mobilier', 118: 'Chaise', 119: 'Table', 152: 'Bruit',
  // Extérieur (3DR Outdoor TLS / cabinet)
  2: 'Sol / Terrain', 4: 'Végétation', 6: 'Bâtiment / Façade',
  65: 'Mobilier urbain', 66: 'Véhicules',
  73: 'Sol / Trottoir', 91: 'Véhicules', 92: 'Végétation',
  96: 'Toiture', 98: 'Façade', 144: 'Toiture inclinée', 145: 'Toiture plate', 157: 'Mur extérieur',
};

export interface ParsedMagoLayer {
  classId: string;
  label: number | null;
  className: string;
  instanceIndex: number | null;
  instanceName: string;
}

function prettifySlug(slug: string, label: number | null): string {
  if (label != null && MAGO_CLASS_DISPLAY[label]) return MAGO_CLASS_DISPLAY[label];
  // slug du type "class_4" (label non mappé) -> "Classe 4"
  const m = slug.match(/^class_?(\d+)$/i);
  if (m) return `Classe ${parseInt(m[1], 10)}`;
  const s = slug.replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Objet';
}

/**
 * Parse un nom logique de couche (déjà nettoyé des suffixes LOD/primitive) en
 * classe + instance. Tolère :
 *   class_118_chair_inst_002   -> classe "Chaise", instance 2
 *   class_004_vegetation_inst_001 -> classe "Végétation", instance 1
 *   class_009_wall             -> classe "Mur", non instanciée
 *   STRUCTURE_ONLY / autres    -> nom tel quel, non instancié
 */
export function parseMagoLayer(logicalName: string): ParsedMagoLayer {
  const name = (logicalName || '').trim();

  let m = name.match(/^class_(m001|\d+)_(.+?)_inst_(\d+)$/i);
  if (m) {
    const label = m[1].toLowerCase() === 'm001' ? -1 : parseInt(m[1], 10);
    const slug = m[2];
    const className = prettifySlug(slug, label);
    const inst = parseInt(m[3], 10);
    return {
      classId: `class_${m[1]}_${slug}`,
      label,
      className,
      instanceIndex: inst,
      instanceName: `${className} ${inst}`,
    };
  }

  m = name.match(/^class_(m001|\d+)_(.+)$/i);
  if (m) {
    const label = m[1].toLowerCase() === 'm001' ? -1 : parseInt(m[1], 10);
    const className = prettifySlug(m[2], label);
    return { classId: name, label, className, instanceIndex: null, instanceName: className };
  }

  // STRUCTURE_ONLY ou nom libre (OBJ/PLY) : une "classe" à part entière.
  const display = name === 'STRUCTURE_ONLY' ? 'Structure (mur/sol/plafond)' : name || 'Objet';
  return { classId: name || 'objet', label: null, className: display, instanceIndex: null, instanceName: display };
}

/**
 * Charge un mesh (.glb / .gltf / .obj / .ply) dans la scène.
 * Pour les PLY, on nettoie l'en-tête CloudCompare (obj_info) avant le parsing.
 */
export async function loadMesh(file: File, opts: LoadOptions): Promise<LoadedAsset> {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';

  // Les PLY/OBJ mesh sont chargés avec des lecteurs MAGO dédiés.
  // Objectif : rester robuste avec les exports RealityScan / CloudCompare / 3DR,
  // sans dépendre de loaders Babylon trop sensibles aux variantes de header/MTL.
  if (ext === 'ply') {
    await assertPlyLooksLikeMesh(file);
    return loadPlyMeshCustom(file, opts);
  }
  if (ext === 'obj') {
    return loadObjMeshCustom(file, opts);
  }

  const toLoad = file;
  const url = URL.createObjectURL(toLoad);
  // Babylon utilise des "plugin extensions" qui doivent être préfixées par "."
  const pluginExt = '.' + ext;

  try {
    const result = await ImportMeshAsync(url, opts.scene, {
      pluginExtension: pluginExt,
      onProgress: (evt) => {
        if (opts.onProgress) opts.onProgress(evt.loaded, evt.lengthComputable ? evt.total : 0);
      },
    });

    // On regroupe tous les meshes chargés sous un TransformNode "racine"
    // pour pouvoir les manipuler ensemble (toggle, opacity, etc.)
    const root = new TransformNode(`__mesh_root_${file.name}`, opts.scene);
    let totalTriangles = 0;

    for (const m of result.meshes) {
      if (m.parent == null) {
        m.parent = root;
      }
      const ic = m.getTotalIndices?.() ?? 0;
      totalTriangles += Math.floor(ic / 3);
    }

    // Si pas de matériau (cas typique des PLY mesh), on en applique un par défaut
    // qui respecte les couleurs vertex s'il y en a.
    for (const m of result.meshes) {
      if (m.material == null) {
        const mat = new StandardMaterial(`mat_${m.name}`, opts.scene);
        mat.diffuseColor = new Color3(0.78, 0.80, 0.82);
        mat.specularColor = new Color3(0.05, 0.05, 0.05);
        mat.backFaceCulling = false;
        m.material = mat;
      }
    }

    // Sous-couches affichables/masquables.
    // IMPORTANT : Babylon peut découper UN objet Blender en dizaines/centaines de meshes
    // techniques (primitives glTF, splits par matériau, splits de buffers, suffixes .001...).
    // Le viewer doit donc regrouper ces meshes par nom logique, sinon une classe
    // "class_001_covering_ceiling" devient artificiellement 100 couches côté UI.
    const groups = new Map<string, { name: string; meshes: AbstractMesh[]; triangleCount: number }>();

    result.meshes
      .filter((m) => {
        const hasGeometry = (m.getTotalVertices?.() ?? 0) > 0 || (m.getTotalIndices?.() ?? 0) > 0;
        return hasGeometry && !m.name.startsWith('__');
      })
      .forEach((m, i) => {
        const raw = (m.name || `Objet ${i + 1}`).replace(/^.*:/, '').trim() || `Objet ${i + 1}`;
        const logicalName = normalizeGlbLayerName(raw);
        // Clé de jointure avec la base d'enrichissement, lisible au clic 3D.
        try {
          const parsedMeta = parseMagoLayer(logicalName);
          m.metadata = {
            ...(m.metadata ?? {}),
            magoClassKey: parsedMeta.classId,
            magoObjectKey: logicalName,
          };
        } catch {}
        const key = logicalName.toLowerCase();
        const ic = m.getTotalIndices?.() ?? 0;
        const tri = Math.floor(ic / 3);
        const group = groups.get(key) ?? { name: logicalName, meshes: [], triangleCount: 0 };
        group.meshes.push(m);
        group.triangleCount += tri;
        groups.set(key, group);
      });

    const meshLayers: MeshSubLayer[] = Array.from(groups.values())
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
      .map((g, i) => {
        const parsed = parseMagoLayer(g.name);
        return {
          id: `mesh-layer-${i}`,
          name: parsed.instanceName,
          classKey: g.name,
          meshes: g.meshes,
          visible: true,
          triangleCount: g.triangleCount,
          classId: parsed.classId,
          className: parsed.className,
          instanceIndex: parsed.instanceIndex,
          instanceName: parsed.instanceName,
        };
      });

    return {
      kind: 'mesh',
      rootNode: root as unknown as AbstractMesh,
      fileName: file.name,
      meshes: result.meshes,
      triangleCount: totalTriangles,
      splatCount: 0,
      meshLayers,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Charge un fichier Gaussian Splatting (.ply, .splat, .spz).
 * Babylon.js 8 supporte nativement ces formats via le SPLAT loader.
 */
export async function loadSplats(file: File, opts: LoadOptions): Promise<LoadedAsset> {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  const url = URL.createObjectURL(file);
  const pluginExt = '.' + ext;

  try {
    // SceneLoader.ImportMeshAsync est aussi compatible avec les splats
    const result = await ImportMeshAsync(url, opts.scene, {
      pluginExtension: pluginExt,
      onProgress: (evt) => {
        if (opts.onProgress) opts.onProgress(evt.loaded, evt.lengthComputable ? evt.total : 0);
      },
    });

    // Trouver le GaussianSplattingMesh dans les meshes retournés
    let splatMesh: GaussianSplattingMesh | null = null;
    for (const m of result.meshes) {
      if (m instanceof GaussianSplattingMesh) {
        splatMesh = m;
        break;
      }
    }

    if (!splatMesh) {
      throw new Error(
        "Le fichier ne contient pas de Gaussian Splatting reconnaissable. " +
        "Vérifie que c'est bien un PLY au format 3DGS (f_dc_*, opacity, scale_*, rot_*)."
      );
    }

    // Les splats ne sont pas pickable par défaut, et c'est mieux pour la mesure
    // de pointer sur le mesh structurel, donc on laisse comme ça.
    splatMesh.isPickable = false;

    const splatCount = (splatMesh as any).splatCount ?? 0;

    return {
      kind: 'splat',
      rootNode: splatMesh,
      fileName: file.name,
      meshes: [splatMesh],
      triangleCount: 0,
      splatCount,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Décharge proprement un asset (libère mémoire et GPU).
 */
export function unloadAsset(asset: LoadedAsset, scene: Scene): void {
  for (const m of asset.meshes) {
    m.dispose(false, true);
  }
  // Le TransformNode racine si présent
  if (asset.rootNode && 'dispose' in asset.rootNode) {
    try { (asset.rootNode as any).dispose(); } catch { /* noop */ }
  }
}

// -----------------------------------------------------------------------------
// Nuages de points PLY simples (ASCII ou binary_little_endian)
// -----------------------------------------------------------------------------
type PlyProp = { name: string; type: string };

function plyTypeSize(t: string): number {
  const k = t.toLowerCase();
  if (k === 'char' || k === 'uchar' || k === 'int8' || k === 'uint8') return 1;
  if (k === 'short' || k === 'ushort' || k === 'int16' || k === 'uint16') return 2;
  if (k === 'int' || k === 'uint' || k === 'float' || k === 'float32' || k === 'int32' || k === 'uint32') return 4;
  if (k === 'double' || k === 'float64') return 8;
  return 4;
}

function readScalar(view: DataView, offset: number, type: string): number {
  const t = type.toLowerCase();
  if (t === 'char' || t === 'int8') return view.getInt8(offset);
  if (t === 'uchar' || t === 'uint8') return view.getUint8(offset);
  if (t === 'short' || t === 'int16') return view.getInt16(offset, true);
  if (t === 'ushort' || t === 'uint16') return view.getUint16(offset, true);
  if (t === 'int' || t === 'int32') return view.getInt32(offset, true);
  if (t === 'uint' || t === 'uint32') return view.getUint32(offset, true);
  if (t === 'double' || t === 'float64') return view.getFloat64(offset, true);
  return view.getFloat32(offset, true);
}

async function readPlyHeaderDetailed(file: File): Promise<{
  headerText: string;
  headerBytes: number;
  format: 'ascii' | 'binary_little_endian' | 'binary_big_endian' | 'unknown';
  vertexCount: number;
  faceCount: number;
  vertexProps: PlyProp[];
  faceProps: PlyFaceProp[];
}> {
  const maxBytes = Math.min(file.size, 1024 * 512);
  const buf = await file.slice(0, maxBytes).arrayBuffer();
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const marker = 'end_header';
  const idx = text.indexOf(marker);
  if (idx < 0) throw new Error('Header PLY incomplet : end_header introuvable.');
  const endLine = text.indexOf('\n', idx);
  const headerText = text.slice(0, endLine >= 0 ? endLine + 1 : idx + marker.length);
  const headerBytes = new TextEncoder().encode(headerText).length;
  const lines = headerText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let format: any = 'unknown';
  let vertexCount = 0;
  let faceCount = 0;
  let currentElement = '';
  const vertexProps: PlyProp[] = [];
  const faceProps: PlyFaceProp[] = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts[0] === 'format') format = parts[1];
    if (parts[0] === 'element') {
      currentElement = parts[1];
      if (parts[1] === 'vertex') vertexCount = Number(parts[2]) || 0;
      if (parts[1] === 'face') faceCount = Number(parts[2]) || 0;
      continue;
    }
    if (parts[0] === 'property' && currentElement === 'vertex' && parts[1] !== 'list') {
      vertexProps.push({ type: parts[1], name: parts[2] });
    }
    if (parts[0] === 'property' && currentElement === 'face') {
      if (parts[1] === 'list') {
        faceProps.push({ isList: true, countType: parts[2], itemType: parts[3], name: parts[4] });
      } else {
        faceProps.push({ isList: false, type: parts[1], name: parts[2] });
      }
    }
  }
  return { headerText, headerBytes, format, vertexCount, faceCount, vertexProps, faceProps };
}


function pickVertexColorHelpers(info: Awaited<ReturnType<typeof readPlyHeaderDetailed>>) {
  const propIndex = new Map(info.vertexProps.map((p, i) => [p.name.toLowerCase(), i]));
  const findProp = (...names: string[]): number | undefined => {
    for (const n of names) {
      const idx = propIndex.get(n.toLowerCase());
      if (idx != null) return idx;
    }
    return undefined;
  };
  const ir = findProp('red', 'r', 'diffuse_red', 'color_red', 'scalar_red');
  const ig = findProp('green', 'g', 'diffuse_green', 'color_green', 'scalar_green');
  const ib = findProp('blue', 'b', 'diffuse_blue', 'color_blue', 'scalar_blue');
  const iclass = findProp('scalar_classification', 'classification', 'class', 'label');

  const normalizeColor = (v: number, propIndex?: number): number => {
    if (!Number.isFinite(v)) return 0.78;
    const type = propIndex != null ? info.vertexProps[propIndex].type.toLowerCase() : '';
    if (type.includes('float') || type.includes('double')) return Math.max(0, Math.min(1, v <= 1.0 ? v : v / 255));
    return Math.max(0, Math.min(1, v / 255));
  };
  const classColor = (cls: number): [number, number, number] => {
    const palette: Record<number, [number, number, number]> = {
      1: [0.70, 0.85, 1.00],
      7: [0.75, 0.75, 0.75],
      9: [0.95, 0.72, 0.45],
      103: [0.55, 0.85, 0.55],
      104: [0.55, 0.75, 1.00],
      117: [1.00, 0.65, 0.90],
    };
    return palette[Math.round(cls)] ?? [0.82, 0.82, 0.82];
  };
  return { findProp, ir, ig, ib, iclass, normalizeColor, classColor };
}


class DynamicIndexBuilder {
  private chunks: Uint32Array[] = [];
  private current: Uint32Array;
  private offset = 0;
  public length = 0;

  constructor(private chunkSize = 1_500_000) {
    this.current = new Uint32Array(this.chunkSize);
  }

  push(a: number, b: number, c: number): void {
    this.pushOne(a); this.pushOne(b); this.pushOne(c);
  }

  private pushOne(v: number): void {
    if (this.offset >= this.current.length) {
      this.chunks.push(this.current);
      this.current = new Uint32Array(this.chunkSize);
      this.offset = 0;
    }
    this.current[this.offset++] = v >>> 0;
    this.length++;
  }

  toArray(): Uint32Array {
    const out = new Uint32Array(this.length);
    let dst = 0;
    for (const c of this.chunks) {
      out.set(c, dst);
      dst += c.length;
    }
    out.set(this.current.subarray(0, this.offset), dst);
    return out;
  }
}

function makeSimpleMeshAsset(file: File, opts: LoadOptions, mesh: Mesh, triangleCount: number, layerName?: string): LoadedAsset {
  const root = new TransformNode(`__mesh_root_${file.name}`, opts.scene);
  mesh.parent = root;
  const layerName2 = layerName ?? file.name.replace(/\.[^.]+$/i, '');
  try { mesh.metadata = { ...(mesh.metadata ?? {}), magoClassKey: layerName2 }; } catch {}
  const meshLayers: MeshSubLayer[] = [{
    id: 'mesh-layer-0',
    name: layerName2,
    classKey: layerName2,
    meshes: [mesh],
    visible: true,
    triangleCount,
  }];
  return {
    kind: 'mesh',
    rootNode: root as unknown as AbstractMesh,
    fileName: file.name,
    meshes: [mesh],
    triangleCount,
    splatCount: 0,
    meshLayers,
  };
}

function applyDefaultVertexMaterial(mesh: Mesh, file: File, scene: Scene, useVertexColors: boolean): void {
  const mat = new StandardMaterial(`mat_${file.name}`, scene);
  mat.diffuseColor = new Color3(0.78, 0.80, 0.82);
  mat.specularColor = new Color3(0.02, 0.02, 0.02);
  mat.backFaceCulling = false;
  if (useVertexColors) {
    // En Babylon 8, l'affichage des couleurs par sommet est piloté par le MESH
    // (mesh.useVertexColors), pas par une propriété du StandardMaterial.
    // Sans éclairage, il faut aussi un emissive blanc sinon la surface reste sombre :
    // c'est exactement la recette qui marche déjà pour les nuages de points.
    mat.disableLighting = true;
    mat.diffuseColor = Color3.White();
    mat.emissiveColor = Color3.White();
    mesh.useVertexColors = true;
    mesh.hasVertexAlpha = false;
  }
  mesh.material = mat;
}

/** Lecteur OBJ robuste : v/vt/vn/f, faces n-gones, indices négatifs, groupes et commentaires inline. */
async function loadObjMeshCustom(file: File, opts: LoadOptions): Promise<LoadedAsset> {
  // Important : on lit directement le texte pour éviter les soucis de .mtl manquant / chemins relatifs.
  // Le but ici est d'avoir au minimum une géométrie fiable même avec un OBJ RealityScan/CloudCompare exporté seul.
  const rawText = await file.text();
  const text = rawText.replace(/\\\r?\n/g, ' '); // OBJ autorise les lignes continuées avec "\\".
  const vertexPositions: number[] = [];
  const vertexColorsByVertex: Array<[number, number, number] | null> = [];
  const positions: number[] = [];
  const colors: number[] = [];
  const indices = new DynamicIndexBuilder();
  const vertexMap = new Map<string, number>();
  let hasColors = false;
  let skippedFaces = 0;

  const parseObjNumber = (value: string): number => {
    // Tolère les exports qui utilisent accidentellement une virgule décimale.
    const n = Number(value.replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  };

  const parseIndex = (token: string): number => {
    const raw = token.split('/')[0];
    if (!raw) return -1;
    const n = Number(raw);
    if (!Number.isFinite(n) || n === 0) return -1;
    return n > 0 ? n - 1 : (vertexPositions.length / 3) + n;
  };

  const getOutVertex = (token: string): number => {
    const key = token.split('/')[0];
    const cached = vertexMap.get(key);
    if (cached != null) return cached;
    const vi = parseIndex(token);
    if (vi < 0 || vi * 3 + 2 >= vertexPositions.length) return -1;
    const outIndex = positions.length / 3;
    positions.push(vertexPositions[vi * 3], vertexPositions[vi * 3 + 1], vertexPositions[vi * 3 + 2]);
    const c = vertexColorsByVertex[vi];
    colors.push(c ? c[0] : 0.78, c ? c[1] : 0.80, c ? c[2] : 0.82, 1);
    vertexMap.set(key, outIndex);
    return outIndex;
  };

  const lines = text.split(/\r?\n/);
  for (const lineRaw of lines) {
    const line = lineRaw.replace(/#.*/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v' && parts.length >= 4) {
      vertexPositions.push(parseObjNumber(parts[1]), parseObjNumber(parts[2]), parseObjNumber(parts[3]));
      if (parts.length >= 7) {
        hasColors = true;
        const r0 = parseObjNumber(parts[4]), g0 = parseObjNumber(parts[5]), b0 = parseObjNumber(parts[6]);
        const norm = Math.max(r0, g0, b0) > 1.0 ? 255 : 1;
        vertexColorsByVertex.push([
          Math.max(0, Math.min(1, r0 / norm)),
          Math.max(0, Math.min(1, g0 / norm)),
          Math.max(0, Math.min(1, b0 / norm)),
        ]);
      } else {
        vertexColorsByVertex.push(null);
      }
    } else if (parts[0] === 'f' && parts.length >= 4) {
      const face = parts.slice(1).map(getOutVertex).filter((v) => v >= 0);
      if (face.length < 3) {
        skippedFaces++;
        continue;
      }
      for (let k = 1; k < face.length - 1; k++) indices.push(face[0], face[k], face[k + 1]);
    }
  }

  if (positions.length === 0 || indices.length === 0) {
    throw new Error(`OBJ invalide ou vide : aucun triangle lisible. Vertices lus : ${Math.floor(vertexPositions.length / 3).toLocaleString('fr-FR')}, faces ignorées : ${skippedFaces.toLocaleString('fr-FR')}.`);
  }

  const mesh = new Mesh(`mesh_${file.name}`, opts.scene);
  const indexArray = indices.toArray();
  const normalArray = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, indexArray as any, normalArray as any);
  const vd = new VertexData();
  vd.positions = new Float32Array(positions) as any;
  vd.indices = indexArray as any;
  vd.normals = normalArray as any;
  if (hasColors) vd.colors = new Float32Array(colors) as any;
  vd.applyToMesh(mesh, true);
  ensureDrawableSubMeshes(mesh);
  mesh.refreshBoundingInfo(true);
  mesh.alwaysSelectAsActiveMesh = true;
  applyDefaultVertexMaterial(mesh, file, opts.scene, hasColors);
  return makeSimpleMeshAsset(file, opts, mesh, Math.floor(indices.length / 3), file.name.replace(/\.obj$/i, ''));
}

/**
 * Lecteur PLY mesh robuste pour CloudCompare / 3DR / Blender / RealityScan.
 *
 * Version non-bloquante : sur les gros exports (LOD0 RealityScan à 8–10 M de
 * faces, 200–300 Mo), l'ancienne implémentation lisait le fichier deux fois,
 * allouait un tableau par sommet et parsait tout d'un bloc → 20 à 60 s de
 * thread principal gelé, barre de progression figée à 0 %, dialogue Chrome
 * « la page ne répond pas ». D'où les fichiers qui « ne s'affichent pas ».
 *
 * Corrections :
 *  - une seule lecture du fichier, avec progression (FileReader) ;
 *  - lecture directe des seules propriétés utiles (x/y/z + couleurs/classe),
 *    sans allocation par sommet ni par face ;
 *  - parsing découpé en tranches avec rendu entre chaque tranche
 *    (la barre de progression et l'UI restent vivantes) ;
 *  - onProgress réellement appelé (octets traités / taille fichier).
 */

/** Rend la main au navigateur pour qu'il puisse peindre entre deux tranches. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Lit le fichier entier en ArrayBuffer avec progression.
 * FileReader émet des évènements progress pendant la lecture disque, ce que
 * file.arrayBuffer() ne permet pas. Fallback silencieux hors navigateur.
 */
function readFileWithProgress(file: File, onBytes?: (loaded: number) => void): Promise<ArrayBuffer> {
  if (typeof FileReader === 'undefined') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => { if (e.lengthComputable && onBytes) onBytes(e.loaded); };
    reader.onerror = () => reject(reader.error ?? new Error(`Lecture impossible : ${file.name}`));
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Firefox plafonne chaque draw call WebGL à 30 000 000 d'indices
 * (préférence `webgl.max-vert-ids-per-draw`) : au-delà, le draw est
 * silencieusement ignoré — le mesh est chargé, visible, dans le frustum,
 * mais jamais dessiné. Un LOD0 à 10 004 732 triangles (30 014 196 indices)
 * dépasse ce plafond de 0,05 % et disparaît donc sous Firefox alors qu'il
 * s'affiche sous Chrome.
 *
 * Solution : découper le RENDU en plusieurs SubMeshes Babylon. La géométrie
 * et les buffers GPU restent uniques et partagés ; seul le drawElements est
 * émis en plusieurs passes, chacune sous le plafond. Les tranches sont
 * réparties uniformément et alignées sur des triangles complets.
 *
 * À rappeler après toute reconstruction d'indices sur un mesh de plus de
 * MAX_INDICES_PER_DRAW indices (applyToMesh / setIndices réinitialisent
 * les subMeshes à un seul bloc).
 */
const MAX_INDICES_PER_DRAW = 24_000_000; // marge sous le plafond Firefox (30 M)

export function ensureDrawableSubMeshes(mesh: Mesh, maxIndicesPerDraw = MAX_INDICES_PER_DRAW): void {
  const totalIndices = mesh.getTotalIndices();
  if (totalIndices <= maxIndicesPerDraw) return;
  const totalVertices = mesh.getTotalVertices();
  const chunkCount = Math.ceil(totalIndices / maxIndicesPerDraw);
  // Répartition uniforme, arrondie au triangle supérieur.
  const perChunk = Math.ceil(totalIndices / chunkCount / 3) * 3;
  mesh.subMeshes = [];
  for (let start = 0; start < totalIndices; start += perChunk) {
    const count = Math.min(perChunk, totalIndices - start);
    // Le constructeur enregistre lui-même le SubMesh dans mesh.subMeshes.
    new SubMesh(0, 0, totalVertices, start, count, mesh);
  }
}

/** Lecteur PLY mesh robuste pour CloudCompare / 3DR / Blender. */
async function loadPlyMeshCustom(file: File, opts: LoadOptions): Promise<LoadedAsset> {
  const cleaned = await cleanPlyHeaderFromFile(file);
  const info = await readPlyHeaderDetailed(cleaned);
  if (info.vertexCount <= 0) throw new Error('PLY mesh invalide : aucun vertex.');
  if (info.faceCount <= 0) throw new Error('PLY mesh invalide : aucune face.');

  const { findProp, ir, ig, ib, iclass, normalizeColor, classColor } = pickVertexColorHelpers(info);
  const ix = findProp('x'), iy = findProp('y'), iz = findProp('z');
  if (ix == null || iy == null || iz == null) throw new Error('PLY mesh invalide : propriétés x/y/z introuvables.');

  // Pondération de la progression : lecture 40 %, sommets 40 %, faces 20 %.
  // On rapporte des octets (loaded/total) car c'est ce que l'UI affiche.
  const total = cleaned.size;
  const report = (fraction: number): void => {
    opts.onProgress?.(Math.min(total, Math.round(fraction * total)), total);
  };
  report(0);

  const positions = new Float32Array(info.vertexCount * 3);
  const colors = new Float32Array(info.vertexCount * 4);
  const hasExplicitColors = ir != null && ig != null && ib != null;
  const defaultColor: [number, number, number] = [0.78, 0.80, 0.82];

  const indices = new DynamicIndexBuilder();

  // Nombre d'éléments traités entre deux redditions du thread principal.
  // ~500 k sommets ≈ 60 ms de travail : l'UI reste fluide sans ralentir le parsing.
  const CHUNK = 500_000;

  if (info.format === 'ascii') {
    const text = await cleaned.text();
    report(0.4);
    const bodyStart = text.indexOf('end_header') + 'end_header'.length;
    const lines = text.slice(bodyStart).trimStart().split(/\r?\n/);
    for (let i = 0; i < info.vertexCount && i < lines.length; i++) {
      const vals = lines[i].trim().split(/\s+/).map(Number);
      positions[i * 3] = vals[ix] || 0;
      positions[i * 3 + 1] = vals[iy] || 0;
      positions[i * 3 + 2] = vals[iz] || 0;
      let r = ir != null ? normalizeColor(vals[ir], ir) : defaultColor[0];
      let g = ig != null ? normalizeColor(vals[ig], ig) : defaultColor[1];
      let b = ib != null ? normalizeColor(vals[ib], ib) : defaultColor[2];
      if (!hasExplicitColors && iclass != null) [r, g, b] = classColor(vals[iclass]);
      colors[i * 4] = r; colors[i * 4 + 1] = g; colors[i * 4 + 2] = b; colors[i * 4 + 3] = 1;
      if (i % CHUNK === CHUNK - 1) {
        report(0.4 + 0.4 * (i / info.vertexCount));
        await yieldToBrowser();
      }
    }
    for (let f = 0; f < info.faceCount; f++) {
      const line = lines[info.vertexCount + f];
      if (!line) continue;
      const vals = line.trim().split(/\s+/).map(Number);
      const n = vals[0] | 0;
      for (let k = 2; k < n; k++) {
        indices.push(vals[1], vals[k], vals[k + 1]);
      }
      if (f % CHUNK === CHUNK - 1) {
        report(0.8 + 0.2 * (f / info.faceCount));
        await yieldToBrowser();
      }
    }
  } else if (info.format === 'binary_little_endian') {
    const buffer = await readFileWithProgress(cleaned, (loaded) => report(0.4 * (loaded / total)));
    report(0.4);
    const view = new DataView(buffer);
    const dataStart = info.headerBytes;

    // Offsets par propriété dans le stride d'un sommet. On ne lit ensuite QUE
    // les propriétés utiles (x/y/z, couleurs, classe) : les normales et autres
    // champs sont simplement sautés, sans allocation par sommet.
    const offsets: number[] = [];
    let stride = 0;
    for (const p of info.vertexProps) { offsets.push(stride); stride += plyTypeSize(p.type); }
    const offX = offsets[ix], offY = offsets[iy], offZ = offsets[iz];
    const tX = info.vertexProps[ix].type, tY = info.vertexProps[iy].type, tZ = info.vertexProps[iz].type;

    for (let i = 0; i < info.vertexCount; i++) {
      const base = dataStart + i * stride;
      positions[i * 3] = readScalar(view, base + offX, tX);
      positions[i * 3 + 1] = readScalar(view, base + offY, tY);
      positions[i * 3 + 2] = readScalar(view, base + offZ, tZ);
      let r = defaultColor[0], g = defaultColor[1], b = defaultColor[2];
      if (hasExplicitColors) {
        r = normalizeColor(readScalar(view, base + offsets[ir!], info.vertexProps[ir!].type), ir!);
        g = normalizeColor(readScalar(view, base + offsets[ig!], info.vertexProps[ig!].type), ig!);
        b = normalizeColor(readScalar(view, base + offsets[ib!], info.vertexProps[ib!].type), ib!);
      } else if (iclass != null) {
        [r, g, b] = classColor(readScalar(view, base + offsets[iclass], info.vertexProps[iclass].type));
      }
      colors[i * 4] = r; colors[i * 4 + 1] = g; colors[i * 4 + 2] = b; colors[i * 4 + 3] = 1;
      if (i % CHUNK === CHUNK - 1) {
        report(0.4 + 0.4 * (i / info.vertexCount));
        await yieldToBrowser();
      }
    }

    let off = dataStart + info.vertexCount * stride;
    const faceListProp = info.faceProps.find((p) => p.isList) as Extract<PlyFaceProp, { isList: true }> | undefined;
    if (!faceListProp) throw new Error('PLY mesh invalide : aucune propriété list pour les faces.');

    for (let f = 0; f < info.faceCount; f++) {
      for (const fp of info.faceProps) {
        if (fp.isList) {
          const count = readScalar(view, off, fp.countType) | 0;
          off += plyTypeSize(fp.countType);
          const itemSize = plyTypeSize(fp.itemType);
          if (fp === faceListProp || /vertex|indice|index/i.test(fp.name)) {
            // Triangulation en éventail au fil de la lecture, sans tableau intermédiaire.
            if (count >= 3) {
              const first = readScalar(view, off, fp.itemType) | 0;
              let prev = readScalar(view, off + itemSize, fp.itemType) | 0;
              for (let k = 2; k < count; k++) {
                const cur = readScalar(view, off + k * itemSize, fp.itemType) | 0;
                indices.push(first, prev, cur);
                prev = cur;
              }
            }
          }
          off += count * itemSize;
        } else {
          off += plyTypeSize(fp.type);
        }
      }
      if (f % CHUNK === CHUNK - 1) {
        report(0.8 + 0.2 * (f / info.faceCount));
        await yieldToBrowser();
      }
    }
  } else {
    throw new Error(`Format PLY mesh non supporté : ${info.format}. Convertis en ASCII ou binary_little_endian.`);
  }
  report(1);

  const mesh = new Mesh(`mesh_${file.name}`, opts.scene);
  const vd = new VertexData();
  vd.positions = positions as any;
  vd.indices = indices.toArray() as any;
  vd.colors = colors as any;
  vd.applyToMesh(mesh, true);
  ensureDrawableSubMeshes(mesh);

  mesh.refreshBoundingInfo(true);
  applyDefaultVertexMaterial(mesh, file, opts.scene, true);
  const triangleCount = Math.floor(indices.length / 3);
  return makeSimpleMeshAsset(file, opts, mesh, triangleCount, file.name.replace(/\.ply$/i, ''));
}

/**
 * Charge un PLY de nuage de points comme objet Babylon en rendu points.
 * C'est volontairement un rendu de visualisation : pour les PLY énormes on échantillonne
 * automatiquement afin d'éviter de bloquer Chrome.
 */
export async function loadPointCloud(file: File, opts: LoadOptions): Promise<LoadedAsset> {
  const info = await readPlyHeaderDetailed(file);
  if (info.vertexCount <= 0) throw new Error('Aucun vertex détecté dans le PLY.');
  const maxPoints = 2_000_000;
  const step = Math.max(1, Math.ceil(info.vertexCount / maxPoints));
  const outCount = Math.ceil(info.vertexCount / step);
  const positions = new Float32Array(outCount * 3);
  const colors = new Float32Array(outCount * 4);

  const propIndex = new Map(info.vertexProps.map((p, i) => [p.name.toLowerCase(), i]));
  const findProp = (...names: string[]): number | undefined => {
    for (const n of names) {
      const idx = propIndex.get(n.toLowerCase());
      if (idx != null) return idx;
    }
    return undefined;
  };
  const ix = findProp('x'), iy = findProp('y'), iz = findProp('z');
  if (ix == null || iy == null || iz == null) throw new Error('PLY point cloud invalide : propriétés x/y/z introuvables.');

  // CloudCompare / 3DR / Blender n'utilisent pas toujours les mêmes noms.
  // On accepte les variantes les plus fréquentes et on gère aussi les couleurs float 0..1.
  const ir = findProp('red', 'r', 'diffuse_red', 'color_red', 'scalar_red');
  const ig = findProp('green', 'g', 'diffuse_green', 'color_green', 'scalar_green');
  const ib = findProp('blue', 'b', 'diffuse_blue', 'color_blue', 'scalar_blue');
  const iclass = findProp('scalar_classification', 'classification', 'class', 'label');

  const normalizeColor = (v: number, propIndex?: number): number => {
    if (!Number.isFinite(v)) return 0.85;
    const type = propIndex != null ? info.vertexProps[propIndex].type.toLowerCase() : '';
    if (type.includes('float') || type.includes('double')) {
      return Math.max(0, Math.min(1, v <= 1.0 ? v : v / 255));
    }
    return Math.max(0, Math.min(1, v / 255));
  };

  const classColor = (cls: number): [number, number, number] => {
    const palette: Record<number, [number, number, number]> = {
      1: [0.70, 0.85, 1.00],   // ceiling
      7: [0.75, 0.75, 0.75],   // floor
      9: [0.95, 0.72, 0.45],   // wall
      103: [0.55, 0.85, 0.55],
      104: [0.55, 0.75, 1.00],
      117: [1.00, 0.65, 0.90],
    };
    return palette[Math.round(cls)] ?? [0.90, 0.90, 0.90];
  };

  if (info.format === 'ascii') {
    const text = await file.text();
    const body = text.slice(text.indexOf('end_header') + 'end_header'.length).trimStart().split(/\r?\n/);
    let j = 0;
    for (let i = 0; i < info.vertexCount && i < body.length; i += step) {
      const vals = body[i].trim().split(/\s+/).map(Number);
      positions[j * 3] = vals[ix] || 0;
      positions[j * 3 + 1] = vals[iy] || 0;
      positions[j * 3 + 2] = vals[iz] || 0;
      let r = ir != null ? normalizeColor(vals[ir], ir) : 0.85;
      let g = ig != null ? normalizeColor(vals[ig], ig) : 0.85;
      let b = ib != null ? normalizeColor(vals[ib], ib) : 0.85;
      if ((ir == null || ig == null || ib == null) && iclass != null) {
        [r, g, b] = classColor(vals[iclass]);
      }
      colors[j * 4] = r; colors[j * 4 + 1] = g; colors[j * 4 + 2] = b; colors[j * 4 + 3] = 1;
      j++;
    }
  } else if (info.format === 'binary_little_endian') {
    const buffer = await file.arrayBuffer();
    const view = new DataView(buffer, info.headerBytes);
    const offsets: number[] = [];
    let stride = 0;
    for (const p of info.vertexProps) { offsets.push(stride); stride += plyTypeSize(p.type); }
    let j = 0;
    for (let i = 0; i < info.vertexCount; i += step) {
      const base = i * stride;
      const vx = readScalar(view, base + offsets[ix], info.vertexProps[ix].type);
      const vy = readScalar(view, base + offsets[iy], info.vertexProps[iy].type);
      const vz = readScalar(view, base + offsets[iz], info.vertexProps[iz].type);
      positions[j * 3] = vx; positions[j * 3 + 1] = vy; positions[j * 3 + 2] = vz;
      let r = ir != null ? normalizeColor(readScalar(view, base + offsets[ir], info.vertexProps[ir].type), ir) : 0.85;
      let g = ig != null ? normalizeColor(readScalar(view, base + offsets[ig], info.vertexProps[ig].type), ig) : 0.85;
      let b = ib != null ? normalizeColor(readScalar(view, base + offsets[ib], info.vertexProps[ib].type), ib) : 0.85;
      if ((ir == null || ig == null || ib == null) && iclass != null) {
        [r, g, b] = classColor(readScalar(view, base + offsets[iclass], info.vertexProps[iclass].type));
      }
      colors[j * 4] = r; colors[j * 4 + 1] = g; colors[j * 4 + 2] = b; colors[j * 4 + 3] = 1;
      j++;
    }
  } else {
    throw new Error(`Format PLY non supporté pour les nuages : ${info.format}. Convertis en ASCII ou binary_little_endian.`);
  }

  const mesh = new Mesh(`pointcloud_${file.name}`, opts.scene);
  const vd = new VertexData();
  vd.positions = positions as any;
  vd.colors = colors as any;
  vd.applyToMesh(mesh, true);
  const mat = new StandardMaterial(`mat_pointcloud_${file.name}`, opts.scene);
  mat.pointsCloud = true;
  mat.pointSize = 1.0;
  mat.disableLighting = true;
  mat.diffuseColor = Color3.White();
  mat.emissiveColor = Color3.White();
  (mat as any).useVertexColor = true;
  (mat as any).useVertexColors = true;
  mesh.hasVertexAlpha = true;
  mesh.material = mat;
  mesh.alwaysSelectAsActiveMesh = true;

  const root = new TransformNode(`__pointcloud_root_${file.name}`, opts.scene);
  mesh.parent = root;

  return {
    kind: 'pointcloud',
    rootNode: root as any,
    fileName: file.name,
    meshes: [mesh],
    triangleCount: 0,
    splatCount: outCount,
  };
}

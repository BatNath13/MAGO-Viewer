import { Matrix, Quaternion, Scene, Vector3 } from '@babylonjs/core';
import type { LoadedAsset, LayerTransform } from '../types';

export interface SplatPlyData {
  fileName: string;
  format: 'binary_little_endian' | 'ascii';
  headerLines: string[];
  headerText: string;
  vertexCount: number;
  properties: PlyProperty[];
  vertexStart: number;
  rowSize: number;
  binaryBuffer?: ArrayBuffer;
  asciiLines?: string[];
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

interface PlyProperty {
  name: string;
  type: string;
  byteSize: number;
  offset: number;
}

export interface SplatFilterSettings {
  lightnessMin: number;
  neutralityMin: number;
}

const SH_C0 = 0.28209479177387814;

const TYPE_INFO: Record<string, { byteSize: number; read: (view: DataView, offset: number) => number; write: (view: DataView, offset: number, value: number) => void }> = {
  char: { byteSize: 1, read: (v, o) => v.getInt8(o), write: (v, o, x) => v.setInt8(o, clampInt(x, -128, 127)) },
  int8: { byteSize: 1, read: (v, o) => v.getInt8(o), write: (v, o, x) => v.setInt8(o, clampInt(x, -128, 127)) },
  uchar: { byteSize: 1, read: (v, o) => v.getUint8(o), write: (v, o, x) => v.setUint8(o, clampInt(x, 0, 255)) },
  uint8: { byteSize: 1, read: (v, o) => v.getUint8(o), write: (v, o, x) => v.setUint8(o, clampInt(x, 0, 255)) },
  short: { byteSize: 2, read: (v, o) => v.getInt16(o, true), write: (v, o, x) => v.setInt16(o, clampInt(x, -32768, 32767), true) },
  int16: { byteSize: 2, read: (v, o) => v.getInt16(o, true), write: (v, o, x) => v.setInt16(o, clampInt(x, -32768, 32767), true) },
  ushort: { byteSize: 2, read: (v, o) => v.getUint16(o, true), write: (v, o, x) => v.setUint16(o, clampInt(x, 0, 65535), true) },
  uint16: { byteSize: 2, read: (v, o) => v.getUint16(o, true), write: (v, o, x) => v.setUint16(o, clampInt(x, 0, 65535), true) },
  int: { byteSize: 4, read: (v, o) => v.getInt32(o, true), write: (v, o, x) => v.setInt32(o, clampInt(x, -2147483648, 2147483647), true) },
  int32: { byteSize: 4, read: (v, o) => v.getInt32(o, true), write: (v, o, x) => v.setInt32(o, clampInt(x, -2147483648, 2147483647), true) },
  uint: { byteSize: 4, read: (v, o) => v.getUint32(o, true), write: (v, o, x) => v.setUint32(o, clampInt(x, 0, 4294967295), true) },
  uint32: { byteSize: 4, read: (v, o) => v.getUint32(o, true), write: (v, o, x) => v.setUint32(o, clampInt(x, 0, 4294967295), true) },
  float: { byteSize: 4, read: (v, o) => v.getFloat32(o, true), write: (v, o, x) => v.setFloat32(o, x, true) },
  float32: { byteSize: 4, read: (v, o) => v.getFloat32(o, true), write: (v, o, x) => v.setFloat32(o, x, true) },
  double: { byteSize: 8, read: (v, o) => v.getFloat64(o, true), write: (v, o, x) => v.setFloat64(o, x, true) },
  float64: { byteSize: 8, read: (v, o) => v.getFloat64(o, true), write: (v, o, x) => v.setFloat64(o, x, true) },
};

export async function parseSplatPly(file: File): Promise<SplatPlyData> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const headerEnd = findHeaderEnd(bytes);
  if (headerEnd < 0) throw new Error('Header PLY introuvable.');

  const headerText = new TextDecoder().decode(bytes.slice(0, headerEnd));
  const headerLines = headerText.trimEnd().split(/\r?\n/);

  if (headerLines[0]?.trim() !== 'ply') throw new Error('Ce fichier ne commence pas par un header PLY valide.');

  const formatLine = headerLines.find((l) => l.startsWith('format ')) ?? '';
  const format = formatLine.includes('binary_little_endian')
    ? 'binary_little_endian'
    : formatLine.includes('ascii')
      ? 'ascii'
      : null;
  if (!format) throw new Error(`Format PLY non supporté pour l'édition : ${formatLine || 'inconnu'}.`);

  let vertexCount = 0;
  const properties: PlyProperty[] = [];
  let inVertex = false;
  let offset = 0;

  for (const raw of headerLines) {
    const line = raw.trim();
    if (line.startsWith('element ')) {
      const parts = line.split(/\s+/);
      inVertex = parts[1] === 'vertex';
      if (inVertex) vertexCount = parseInt(parts[2], 10);
      continue;
    }
    if (inVertex && line.startsWith('property ')) {
      const parts = line.split(/\s+/);
      if (parts[1] === 'list') {
        throw new Error("PLY avec propriété 'list' dans les vertices non supporté pour l'édition splats.");
      }
      const type = parts[1];
      const name = parts[2];
      const info = TYPE_INFO[type];
      if (!info) throw new Error(`Type PLY non supporté : ${type}`);
      properties.push({ name, type, byteSize: info.byteSize, offset });
      offset += info.byteSize;
    }
  }

  if (!vertexCount || properties.length === 0) {
    throw new Error('Aucun élément vertex exploitable trouvé dans le PLY.');
  }

  const propIndex = new Map(properties.map((p, i) => [p.name, i]));
  for (const req of ['x', 'y', 'z']) {
    if (!propIndex.has(req)) throw new Error(`Propriété ${req} introuvable dans le PLY.`);
  }

  const x = new Float32Array(vertexCount);
  const y = new Float32Array(vertexCount);
  const z = new Float32Array(vertexCount);
  const r = new Float32Array(vertexCount);
  const g = new Float32Array(vertexCount);
  const b = new Float32Array(vertexCount);

  if (format === 'binary_little_endian') {
    const view = new DataView(buffer);
    const rowSize = offset;
    for (let i = 0; i < vertexCount; i++) {
      const base = headerEnd + i * rowSize;
      x[i] = readBinary(view, properties, propIndex.get('x')!, base);
      y[i] = readBinary(view, properties, propIndex.get('y')!, base);
      z[i] = readBinary(view, properties, propIndex.get('z')!, base);
      const rgb = readColorBinary(view, properties, propIndex, base);
      r[i] = rgb[0]; g[i] = rgb[1]; b[i] = rgb[2];
    }
    return { fileName: file.name, format, headerLines, headerText, vertexCount, properties, vertexStart: headerEnd, rowSize, binaryBuffer: buffer, x, y, z, r, g, b };
  }

  const bodyText = new TextDecoder().decode(bytes.slice(headerEnd));
  const asciiLines = bodyText.trimEnd().split(/\r?\n/).slice(0, vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const vals = asciiLines[i].trim().split(/\s+/).map(Number);
    x[i] = vals[propIndex.get('x')!];
    y[i] = vals[propIndex.get('y')!];
    z[i] = vals[propIndex.get('z')!];
    const rgb = readColorAscii(vals, propIndex);
    r[i] = rgb[0]; g[i] = rgb[1]; b[i] = rgb[2];
  }
  return { fileName: file.name, format, headerLines, headerText, vertexCount, properties, vertexStart: headerEnd, rowSize: 0, asciiLines, x, y, z, r, g, b };
}

export function buildLightMask(data: SplatPlyData, settings: SplatFilterSettings, baseMask?: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.vertexCount);
  const minLight = settings.lightnessMin;
  const minNeutrality = settings.neutralityMin;

  for (let i = 0; i < data.vertexCount; i++) {
    if (baseMask && !baseMask[i]) continue;
    const rr = data.r[i], gg = data.g[i], bb = data.b[i];
    const lightness = (rr + gg + bb) / 3;
    const spread = Math.max(rr, gg, bb) - Math.min(rr, gg, bb);
    const neutrality = 1 - spread;
    if (lightness >= minLight && neutrality >= minNeutrality) out[i] = 1;
  }
  return out;
}

export function createFullMask(count: number): Uint8Array {
  const mask = new Uint8Array(count);
  mask.fill(1);
  return mask;
}

export function countMask(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i] ? 1 : 0;
  return n;
}

export function intersectMasks(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] && b[i] ? 1 : 0;
  return out;
}

export function invertMask(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 0 : 1;
  return out;
}

export function unionMasks(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] || b[i] ? 1 : 0;
  return out;
}

export function subtractMask(base: Uint8Array, remove: Uint8Array): Uint8Array {
  const out = new Uint8Array(base.length);
  for (let i = 0; i < base.length; i++) out[i] = base[i] && !remove[i] ? 1 : 0;
  return out;
}

export interface SorSettings {
  /** Nombre de voisins pour la distance moyenne (CloudCompare : 6 par défaut). */
  k: number;
  /** Seuil = moyenne + nSigma * écart-type (CloudCompare : 1.0 par défaut). */
  nSigma: number;
}

/**
 * SOR (Statistical Outlier Removal) façon CloudCompare, adapté aux splats.
 *
 * Pour chaque splat candidat, on calcule la distance moyenne à ses k plus
 * proches voisins via une grille spatiale uniforme (CSR : counts + cellPoints),
 * puis on marque comme flotteur tout splat dont cette distance dépasse
 * μ + nSigma·σ (statistiques globales sur les candidats).
 *
 * - neighborMask : pool des voisins (typiquement baseMask, tout ce qui existe
 *   encore dans le fichier — un splat masqué reste un voisin physique valide).
 * - candidateMask : splats testés et marquables (typiquement visibleMask,
 *   ce qui respecte l'isolation et le filtre blancs/clairs).
 * - Les splats sans k voisins dans un rayon raisonnable (16 cellules) sont
 *   marqués flotteurs d'office : ils sont extrêmement isolés.
 *
 * Calcul asynchrone par tranches pour ne pas bloquer le thread UI ;
 * onProgress est appelé entre chaque tranche.
 */
export async function buildSorOutlierMask(args: {
  data: SplatPlyData;
  neighborMask: Uint8Array;
  candidateMask: Uint8Array;
  k: number;
  nSigma: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<Uint8Array> {
  const { data, neighborMask, candidateMask, nSigma, onProgress } = args;
  const k = Math.max(1, Math.floor(args.k));
  const N = data.vertexCount;
  const out = new Uint8Array(N);
  const xs = data.x, ys = data.y, zs = data.z;

  // ---- Pool de voisins ----
  let nbrCount = 0;
  for (let i = 0; i < N; i++) if (neighborMask[i]) nbrCount++;
  if (nbrCount <= k) return out; // trop peu de points pour des statistiques

  const nbrIdx = new Int32Array(nbrCount);
  {
    let w = 0;
    for (let i = 0; i < N; i++) if (neighborMask[i]) nbrIdx[w++] = i;
  }

  // ---- Bounding box des voisins ----
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let n = 0; n < nbrCount; n++) {
    const i = nbrIdx[n];
    const x = xs[i], y = ys[i], z = zs[i];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const ex = Math.max(maxX - minX, 0), ey = Math.max(maxY - minY, 0), ez = Math.max(maxZ - minZ, 0);

  // ---- Taille de cellule : occupation moyenne ≈ 1 point/cellule, mémoire plafonnée ----
  const eps = 1e-9;
  let vol = 1, effDims = 0;
  if (ex > eps) { vol *= ex; effDims++; }
  if (ey > eps) { vol *= ey; effDims++; }
  if (ez > eps) { vol *= ez; effDims++; }
  let cell = effDims > 0 ? Math.pow(vol / nbrCount, 1 / effDims) : 1;
  if (!Number.isFinite(cell) || cell <= 0) cell = 1;

  const MAX_CELLS = 4_000_000;
  let dimx = 1, dimy = 1, dimz = 1, totalCells = 1;
  for (;;) {
    dimx = Math.max(1, Math.ceil(ex / cell) || 1);
    dimy = Math.max(1, Math.ceil(ey / cell) || 1);
    dimz = Math.max(1, Math.ceil(ez / cell) || 1);
    totalCells = dimx * dimy * dimz;
    if (totalCells <= MAX_CELLS) break;
    cell *= 1.4;
  }

  const cellIndexOf = (i: number): number => {
    let cx = Math.floor((xs[i] - minX) / cell); if (cx < 0) cx = 0; else if (cx >= dimx) cx = dimx - 1;
    let cy = Math.floor((ys[i] - minY) / cell); if (cy < 0) cy = 0; else if (cy >= dimy) cy = dimy - 1;
    let cz = Math.floor((zs[i] - minZ) / cell); if (cz < 0) cz = 0; else if (cz >= dimz) cz = dimz - 1;
    return cx + dimx * (cy + dimy * cz);
  };

  // ---- Grille CSR : counts (préfixes) + cellPoints ----
  const counts = new Uint32Array(totalCells + 1);
  for (let n = 0; n < nbrCount; n++) counts[cellIndexOf(nbrIdx[n]) + 1]++;
  for (let c = 0; c < totalCells; c++) counts[c + 1] += counts[c];
  const cellPoints = new Int32Array(nbrCount);
  {
    const cursor = counts.slice(0, totalCells);
    for (let n = 0; n < nbrCount; n++) {
      const i = nbrIdx[n];
      cellPoints[cursor[cellIndexOf(i)]++] = i;
    }
  }

  // ---- Candidats ----
  let candCount = 0;
  for (let i = 0; i < N; i++) if (candidateMask[i]) candCount++;
  if (candCount === 0) return out;
  const candList = new Int32Array(candCount);
  {
    let w = 0;
    for (let i = 0; i < N; i++) if (candidateMask[i]) candList[w++] = i;
  }

  // ---- kNN par anneaux de cellules (distance de Chebyshev croissante) ----
  const MAX_RING = 16;
  const kD2 = new Float64Array(k); // k plus petites distances², triées croissant
  const meanDist = new Float32Array(candCount); // -1 = voisins insuffisants
  const CHUNK = 8192;
  const cell2 = cell * cell;

  for (let start = 0; start < candCount; start += CHUNK) {
    const end = Math.min(candCount, start + CHUNK);
    for (let ci = start; ci < end; ci++) {
      const i = candList[ci];
      const px = xs[i], py = ys[i], pz = zs[i];
      let cx = Math.floor((px - minX) / cell); if (cx < 0) cx = 0; else if (cx >= dimx) cx = dimx - 1;
      let cy = Math.floor((py - minY) / cell); if (cy < 0) cy = 0; else if (cy >= dimy) cy = dimy - 1;
      let cz = Math.floor((pz - minZ) / cell); if (cz < 0) cz = 0; else if (cz >= dimz) cz = dimz - 1;

      let found = 0;
      for (let r = 0; r <= MAX_RING; r++) {
        // Tout point d'un anneau ≥ r est à au moins (r-1)·cell : si les k voisins
        // courants sont déjà plus proches, inutile de continuer.
        if (r > 0 && found === k && kD2[k - 1] <= (r - 1) * (r - 1) * cell2) break;
        const x0 = Math.max(0, cx - r), x1 = Math.min(dimx - 1, cx + r);
        const y0 = Math.max(0, cy - r), y1 = Math.min(dimy - 1, cy + r);
        const z0 = Math.max(0, cz - r), z1 = Math.min(dimz - 1, cz + r);
        for (let gz = z0; gz <= z1; gz++) {
          const dzAbs = Math.abs(gz - cz);
          for (let gy = y0; gy <= y1; gy++) {
            const dyAbs = Math.abs(gy - cy);
            const chebYZ = dzAbs > dyAbs ? dzAbs : dyAbs;
            for (let gx = x0; gx <= x1; gx++) {
              const dxAbs = Math.abs(gx - cx);
              // Anneau uniquement : Chebyshev exactement r (l'intérieur est déjà traité).
              if ((dxAbs > chebYZ ? dxAbs : chebYZ) !== r) continue;
              const c = gx + dimx * (gy + dimy * gz);
              const pEnd = counts[c + 1];
              for (let p = counts[c]; p < pEnd; p++) {
                const j = cellPoints[p];
                if (j === i) continue;
                const dx = xs[j] - px, dy = ys[j] - py, dz = zs[j] - pz;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (found < k) {
                  // insertion triée
                  let q = found++;
                  while (q > 0 && kD2[q - 1] > d2) { kD2[q] = kD2[q - 1]; q--; }
                  kD2[q] = d2;
                } else if (d2 < kD2[k - 1]) {
                  let q = k - 1;
                  while (q > 0 && kD2[q - 1] > d2) { kD2[q] = kD2[q - 1]; q--; }
                  kD2[q] = d2;
                }
              }
            }
          }
        }
      }

      if (found === k) {
        let sum = 0;
        for (let q = 0; q < k; q++) sum += Math.sqrt(kD2[q]);
        meanDist[ci] = sum / k;
      } else {
        meanDist[ci] = -1; // isolé au-delà de MAX_RING cellules : flotteur d'office
      }
    }
    onProgress?.(end, candCount);
    if (end < candCount) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  // ---- Statistiques globales et seuillage : μ + nSigma·σ ----
  let sum = 0, nStat = 0;
  for (let ci = 0; ci < candCount; ci++) {
    const d = meanDist[ci];
    if (d >= 0) { sum += d; nStat++; }
  }
  if (nStat === 0) return out; // aucun voisinage exploitable : on ne marque rien
  const mu = sum / nStat;
  let varSum = 0;
  for (let ci = 0; ci < candCount; ci++) {
    const d = meanDist[ci];
    if (d >= 0) { const e = d - mu; varSum += e * e; }
  }
  const sigma = Math.sqrt(varSum / nStat);
  const threshold = mu + nSigma * sigma;

  for (let ci = 0; ci < candCount; ci++) {
    const d = meanDist[ci];
    if (d < 0 || d > threshold) out[candList[ci]] = 1;
  }
  return out;
}

/**
 * Filtre "distance au mesh" : marque comme flotteur tout splat candidat situé
 * à plus de maxDistance (mètres, en coordonnées monde) de la surface du mesh.
 *
 * Contrairement au SOR, ce critère est robuste pour le Gaussian Splatting :
 * la densité de positions des splats ne suit pas la surface (gros splats
 * espacés sur les zones planes/sans texture, amas denses de flotteurs), mais
 * la distance à un mesh recalé est une vérité géométrique.
 *
 * - meshPositions / meshIndices : soupe de triangles du mesh EN MONDE.
 * - splatWorldMatrix : matrice monde du nœud racine des splats (les positions
 *   du PLY sont locales, on les projette en monde à la volée).
 * - Grille uniforme sur les triangles (CSR, une entrée par paire triangle/cellule),
 *   cellule ≥ maxDistance : il suffit alors d'examiner les 27 cellules autour du
 *   splat, avec sortie anticipée dès qu'un triangle est à ≤ maxDistance.
 * - Distance point-triangle exacte (algorithme d'Ericson, régions barycentriques).
 */
export async function buildFarFromMeshMask(args: {
  data: SplatPlyData;
  candidateMask: Uint8Array;
  splatWorldMatrix: Matrix;
  meshPositions: Float32Array;
  meshIndices: Uint32Array;
  maxDistance: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<Uint8Array> {
  const { data, candidateMask, splatWorldMatrix, meshPositions, meshIndices, maxDistance, onProgress } = args;
  const N = data.vertexCount;
  const out = new Uint8Array(N);
  const triCount = Math.floor(meshIndices.length / 3);
  if (triCount === 0 || maxDistance <= 0) return out;

  const m = splatWorldMatrix.m;
  const xs = data.x, ys = data.y, zs = data.z;
  const d2max = maxDistance * maxDistance;

  // ---- Bounding box du mesh (les triangles définissent la grille) ----
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < meshPositions.length; v += 3) {
    const x = meshPositions[v], y = meshPositions[v + 1], z = meshPositions[v + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return out;

  // ---- Taille de cellule : ≥ maxDistance, ajustée pour tenir en mémoire ----
  const MAX_CELLS = 8_000_000;
  const MAX_PAIRS = 40_000_000;
  let cell = maxDistance;
  let dimx = 1, dimy = 1, dimz = 1;
  const computeDims = () => {
    dimx = Math.max(1, Math.ceil((maxX - minX) / cell) || 1);
    dimy = Math.max(1, Math.ceil((maxY - minY) / cell) || 1);
    dimz = Math.max(1, Math.ceil((maxZ - minZ) / cell) || 1);
    return dimx * dimy * dimz;
  };
  while (computeDims() > MAX_CELLS) cell *= 1.4;

  const clampCell = (v: number, dim: number): number => (v < 0 ? 0 : v >= dim ? dim - 1 : v);
  const cellX = (x: number) => clampCell(Math.floor((x - minX) / cell), dimx);
  const cellY = (y: number) => clampCell(Math.floor((y - minY) / cell), dimy);
  const cellZ = (z: number) => clampCell(Math.floor((z - minZ) / cell), dimz);

  // ---- CSR triangles → cellules couvertes par leur AABB (2 passes + cap mémoire) ----
  let totalCells = dimx * dimy * dimz;
  let counts!: Uint32Array;
  let pairs!: Int32Array;
  for (;;) {
    totalCells = dimx * dimy * dimz;
    counts = new Uint32Array(totalCells + 1);
    let nPairs = 0;
    for (let t = 0; t < triCount; t++) {
      const ia = meshIndices[t * 3] * 3, ib = meshIndices[t * 3 + 1] * 3, ic = meshIndices[t * 3 + 2] * 3;
      const tminX = Math.min(meshPositions[ia], meshPositions[ib], meshPositions[ic]);
      const tmaxX = Math.max(meshPositions[ia], meshPositions[ib], meshPositions[ic]);
      const tminY = Math.min(meshPositions[ia + 1], meshPositions[ib + 1], meshPositions[ic + 1]);
      const tmaxY = Math.max(meshPositions[ia + 1], meshPositions[ib + 1], meshPositions[ic + 1]);
      const tminZ = Math.min(meshPositions[ia + 2], meshPositions[ib + 2], meshPositions[ic + 2]);
      const tmaxZ = Math.max(meshPositions[ia + 2], meshPositions[ib + 2], meshPositions[ic + 2]);
      const x0 = cellX(tminX), x1 = cellX(tmaxX);
      const y0 = cellY(tminY), y1 = cellY(tmaxY);
      const z0 = cellZ(tminZ), z1 = cellZ(tmaxZ);
      const span = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
      nPairs += span;
      for (let gz = z0; gz <= z1; gz++)
        for (let gy = y0; gy <= y1; gy++)
          for (let gx = x0; gx <= x1; gx++) counts[gx + dimx * (gy + dimy * gz) + 1]++;
    }
    if (nPairs > MAX_PAIRS) { cell *= 1.4; computeDims(); continue; }
    for (let c = 0; c < totalCells; c++) counts[c + 1] += counts[c];
    pairs = new Int32Array(nPairs);
    const cursor = counts.slice(0, totalCells);
    for (let t = 0; t < triCount; t++) {
      const ia = meshIndices[t * 3] * 3, ib = meshIndices[t * 3 + 1] * 3, ic = meshIndices[t * 3 + 2] * 3;
      const tminX = Math.min(meshPositions[ia], meshPositions[ib], meshPositions[ic]);
      const tmaxX = Math.max(meshPositions[ia], meshPositions[ib], meshPositions[ic]);
      const tminY = Math.min(meshPositions[ia + 1], meshPositions[ib + 1], meshPositions[ic + 1]);
      const tmaxY = Math.max(meshPositions[ia + 1], meshPositions[ib + 1], meshPositions[ic + 1]);
      const tminZ = Math.min(meshPositions[ia + 2], meshPositions[ib + 2], meshPositions[ic + 2]);
      const tmaxZ = Math.max(meshPositions[ia + 2], meshPositions[ib + 2], meshPositions[ic + 2]);
      const x0 = cellX(tminX), x1 = cellX(tmaxX);
      const y0 = cellY(tminY), y1 = cellY(tmaxY);
      const z0 = cellZ(tminZ), z1 = cellZ(tmaxZ);
      for (let gz = z0; gz <= z1; gz++)
        for (let gy = y0; gy <= y1; gy++)
          for (let gx = x0; gx <= x1; gx++) pairs[cursor[gx + dimx * (gy + dimy * gz)]++] = t;
    }
    break;
  }

  // La cellule peut avoir grossi au-delà de maxDistance : le rayon de recherche
  // en cellules reste ceil(maxDistance / cell) = 1 tant que cell ≥ maxDistance.
  const ring = Math.max(1, Math.ceil(maxDistance / cell));

  // ---- Candidats ----
  let candCount = 0;
  for (let i = 0; i < N; i++) if (candidateMask[i]) candCount++;
  if (candCount === 0) return out;
  const candList = new Int32Array(candCount);
  {
    let w = 0;
    for (let i = 0; i < N; i++) if (candidateMask[i]) candList[w++] = i;
  }

  // Dédoublonnage des triangles vus par requête (un triangle couvre plusieurs cellules).
  const stamp = new Int32Array(triCount).fill(-1);

  const CHUNK = 8192;
  for (let start = 0; start < candCount; start += CHUNK) {
    const end = Math.min(candCount, start + CHUNK);
    for (let ci = start; ci < end; ci++) {
      const i = candList[ci];
      const lx = xs[i], ly = ys[i], lz = zs[i];
      // Local → monde via la matrice du nœud splats.
      const px = lx * m[0] + ly * m[4] + lz * m[8] + m[12];
      const py = lx * m[1] + ly * m[5] + lz * m[9] + m[13];
      const pz = lx * m[2] + ly * m[6] + lz * m[10] + m[14];

      // Splat à plus de maxDistance de la bbox du mesh : flotteur direct.
      const gapX = Math.max(minX - px, px - maxX, 0);
      const gapY = Math.max(minY - py, py - maxY, 0);
      const gapZ = Math.max(minZ - pz, pz - maxZ, 0);
      if (gapX * gapX + gapY * gapY + gapZ * gapZ > d2max) { out[i] = 1; continue; }

      const cx = cellX(px), cy = cellY(py), cz = cellZ(pz);
      const x0 = Math.max(0, cx - ring), x1 = Math.min(dimx - 1, cx + ring);
      const y0 = Math.max(0, cy - ring), y1 = Math.min(dimy - 1, cy + ring);
      const z0 = Math.max(0, cz - ring), z1 = Math.min(dimz - 1, cz + ring);

      let near = false;
      for (let gz = z0; gz <= z1 && !near; gz++) {
        for (let gy = y0; gy <= y1 && !near; gy++) {
          for (let gx = x0; gx <= x1 && !near; gx++) {
            const c = gx + dimx * (gy + dimy * gz);
            const pEnd = counts[c + 1];
            for (let p = counts[c]; p < pEnd; p++) {
              const t = pairs[p];
              if (stamp[t] === ci) continue;
              stamp[t] = ci;
              const ia = meshIndices[t * 3] * 3, ib = meshIndices[t * 3 + 1] * 3, ic = meshIndices[t * 3 + 2] * 3;
              const d2 = pointTriangleDist2(
                px, py, pz,
                meshPositions[ia], meshPositions[ia + 1], meshPositions[ia + 2],
                meshPositions[ib], meshPositions[ib + 1], meshPositions[ib + 2],
                meshPositions[ic], meshPositions[ic + 1], meshPositions[ic + 2],
              );
              if (d2 <= d2max) { near = true; break; }
            }
          }
        }
      }
      if (!near) out[i] = 1;
    }
    onProgress?.(end, candCount);
    if (end < candCount) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return out;
}

/** Distance² point → triangle (Ericson, "Real-Time Collision Detection", §5.1.5). */
function pointTriangleDist2(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz; // sommet A

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz; // sommet B

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { // arête AB
    const v = d1 / (d1 - d3);
    const qx = apx - v * abx, qy = apy - v * aby, qz = apz - v * abz;
    return qx * qx + qy * qy + qz * qz;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz; // sommet C

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { // arête AC
    const w = d2 / (d2 - d6);
    const qx = apx - w * acx, qy = apy - w * acy, qz = apz - w * acz;
    return qx * qx + qy * qy + qz * qz;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { // arête BC
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const qx = bpx - w * (cx - bx), qy = bpy - w * (cy - by), qz = bpz - w * (cz - bz);
    return qx * qx + qy * qy + qz * qz;
  }

  // Intérieur de la face
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  const qx = apx - (v * abx + w * acx), qy = apy - (v * aby + w * acy), qz = apz - (v * abz + w * acz);
  return qx * qx + qy * qy + qz * qz;
}

export function buildPlyBlobFromMask(data: SplatPlyData, mask: Uint8Array, fileName = 'filtered_splats.ply'): File {
  const kept = countMask(mask);
  const newHeaderLines = data.headerLines.map((line) => {
    if (line.trim().startsWith('element vertex ')) return `element vertex ${kept}`;
    return line;
  });
  const header = newHeaderLines.join('\n') + '\n';

  if (data.format === 'binary_little_endian') {
    const source = new Uint8Array(data.binaryBuffer!);
    const out = new Uint8Array(header.length + kept * data.rowSize);
    out.set(new TextEncoder().encode(header), 0);
    let dst = header.length;
    for (let i = 0; i < data.vertexCount; i++) {
      if (!mask[i]) continue;
      const src = data.vertexStart + i * data.rowSize;
      out.set(source.subarray(src, src + data.rowSize), dst);
      dst += data.rowSize;
    }
    return new File([out], fileName, { type: 'application/octet-stream' });
  }

  const lines: string[] = [header.trimEnd()];
  for (let i = 0; i < data.vertexCount; i++) {
    if (mask[i]) lines.push(data.asciiLines![i]);
  }
  return new File([lines.join('\n') + '\n'], fileName, { type: 'text/plain' });
}


export function buildTransformedPlyBlobFromMask(
  data: SplatPlyData,
  mask: Uint8Array,
  worldMatrix: Matrix,
  fileName = 'mago_splats_aligned.ply',
): File {
  const kept = countMask(mask);
  const newHeaderLines = data.headerLines.map((line) => {
    if (line.trim().startsWith('element vertex ')) return `element vertex ${kept}`;
    return line;
  });
  const header = newHeaderLines.join('\n') + '\n';
  const headerBytes = new TextEncoder().encode(header);
  const propIndex = new Map(data.properties.map((p, i) => [p.name, i]));
  const ix = propIndex.get('x');
  const iy = propIndex.get('y');
  const iz = propIndex.get('z');
  if (ix == null || iy == null || iz == null) throw new Error('PLY splats invalide : propriétés x/y/z introuvables.');

  const scale = new Vector3(1, 1, 1);
  const rotation = Quaternion.Identity();
  const translation = new Vector3();
  worldMatrix.decompose(scale, rotation, translation);
  const uniformScale = Math.max(1e-12, (Math.abs(scale.x) + Math.abs(scale.y) + Math.abs(scale.z)) / 3);
  const logScale = Math.log(uniformScale);
  const hasRotation = ['rot_0', 'rot_1', 'rot_2', 'rot_3'].every((n) => propIndex.has(n));
  const hasLogScale = ['scale_0', 'scale_1', 'scale_2'].every((n) => propIndex.has(n));

  const transformValues = (vals: number[]): number[] => {
    const out = vals.slice();
    const p = Vector3.TransformCoordinates(new Vector3(vals[ix], vals[iy], vals[iz]), worldMatrix);
    out[ix] = p.x; out[iy] = p.y; out[iz] = p.z;

    if (hasLogScale) {
      for (const n of ['scale_0', 'scale_1', 'scale_2']) out[propIndex.get(n)!] = (out[propIndex.get(n)!] || 0) + logScale;
    }

    if (hasRotation) {
      // Convention GraphDECO / 3DGS : rot_0 = w, rot_1 = x, rot_2 = y, rot_3 = z.
      const local = new Quaternion(
        vals[propIndex.get('rot_1')!] || 0,
        vals[propIndex.get('rot_2')!] || 0,
        vals[propIndex.get('rot_3')!] || 0,
        vals[propIndex.get('rot_0')!] || 1,
      );
      const q = rotation.multiply(local);
      q.normalize();
      out[propIndex.get('rot_0')!] = q.w;
      out[propIndex.get('rot_1')!] = q.x;
      out[propIndex.get('rot_2')!] = q.y;
      out[propIndex.get('rot_3')!] = q.z;
    }
    return out;
  };

  if (data.format === 'binary_little_endian') {
    const source = new Uint8Array(data.binaryBuffer!);
    const out = new Uint8Array(headerBytes.length + kept * data.rowSize);
    out.set(headerBytes, 0);
    const sourceView = new DataView(data.binaryBuffer!);
    const outView = new DataView(out.buffer);
    let dst = headerBytes.length;
    for (let i = 0; i < data.vertexCount; i++) {
      if (!mask[i]) continue;
      const src = data.vertexStart + i * data.rowSize;
      out.set(source.subarray(src, src + data.rowSize), dst);
      const vals = data.properties.map((_, pi) => readBinary(sourceView, data.properties, pi, src));
      const next = transformValues(vals);
      for (let pi = 0; pi < data.properties.length; pi++) {
        writeBinary(outView, data.properties, pi, dst, next[pi]);
      }
      dst += data.rowSize;
    }
    return new File([out], fileName, { type: 'application/octet-stream' });
  }

  const lines: string[] = [header.trimEnd()];
  for (let i = 0; i < data.vertexCount; i++) {
    if (!mask[i]) continue;
    const vals = data.asciiLines![i].trim().split(/\s+/).map(Number);
    const next = transformValues(vals);
    lines.push(next.map((v, pi) => formatAsciiValue(v, data.properties[pi].type)).join(' '));
  }
  return new File([lines.join('\n') + '\n'], fileName, { type: 'text/plain' });
}


export function selectByScreenLasso(args: {
  data: SplatPlyData;
  visibleMask: Uint8Array;
  asset: LoadedAsset;
  scene: Scene;
  polygon: Array<{ x: number; y: number }>;
}): Uint8Array {
  const { data, visibleMask, asset, scene, polygon } = args;
  const selected = new Uint8Array(data.vertexCount);
  if (polygon.length < 3) return selected;

  const mask = buildScreenMask(scene, (ctx) => {
    ctx.beginPath();
    ctx.moveTo(polygon[0].x, polygon[0].y);
    for (let i = 1; i < polygon.length; i++) ctx.lineTo(polygon[i].x, polygon[i].y);
    ctx.closePath();
    ctx.fill();
  });
  selectByScreenMask(data, visibleMask, asset, scene, mask, selected);
  return selected;
}

export function selectByScreenRectangle(args: {
  data: SplatPlyData;
  visibleMask: Uint8Array;
  asset: LoadedAsset;
  scene: Scene;
  start: { x: number; y: number };
  end: { x: number; y: number };
}): Uint8Array {
  const { data, visibleMask, asset, scene, start, end } = args;
  const selected = new Uint8Array(data.vertexCount);
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);

  // Rectangle : chemin ultra rapide, pas besoin de créer un masque canvas.
  selectByProjectedPointFast(data, visibleMask, asset, scene, (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY, selected);
  return selected;
}

export function selectByScreenCircle(args: {
  data: SplatPlyData;
  visibleMask: Uint8Array;
  asset: LoadedAsset;
  scene: Scene;
  start: { x: number; y: number };
  end: { x: number; y: number };
}): Uint8Array {
  const { data, visibleMask, asset, scene, start, end } = args;
  const selected = new Uint8Array(data.vertexCount);
  const radius = Math.hypot(end.x - start.x, end.y - start.y);
  const r2 = radius * radius;

  // Cercle : chemin ultra rapide analytique.
  selectByProjectedPointFast(data, visibleMask, asset, scene, (x, y) => {
    const dx = x - start.x;
    const dy = y - start.y;
    return dx * dx + dy * dy <= r2;
  }, selected);
  return selected;
}

export function selectByScreenBrush(args: {
  data: SplatPlyData;
  visibleMask: Uint8Array;
  asset: LoadedAsset;
  scene: Scene;
  path: Array<{ x: number; y: number }>;
  radius: number;
}): Uint8Array {
  const { data, visibleMask, asset, scene, path, radius } = args;
  const selected = new Uint8Array(data.vertexCount);
  if (path.length === 0) return selected;

  // Firefox souffre beaucoup si on teste chaque splat contre chaque point du tracé.
  // On rasterise donc le pinceau dans un masque 2D, puis chaque splat ne fait qu'un accès pixel O(1).
  const simplifiedPath = simplifyScreenPath(path, Math.max(2, radius * 0.35));
  const mask = buildScreenMask(scene, (ctx) => {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, radius * 2);
    ctx.beginPath();
    ctx.moveTo(simplifiedPath[0].x, simplifiedPath[0].y);
    for (let i = 1; i < simplifiedPath.length; i++) ctx.lineTo(simplifiedPath[i].x, simplifiedPath[i].y);
    ctx.stroke();
  });
  selectByScreenMask(data, visibleMask, asset, scene, mask, selected);
  return selected;
}

interface ScreenMask {
  width: number;
  height: number;
  alpha: Uint8ClampedArray;
}

function buildScreenMask(scene: Scene, draw: (ctx: CanvasRenderingContext2D) => void): ScreenMask {
  const engine = scene.getEngine();
  const width = Math.max(1, Math.floor(engine.getRenderWidth()));
  const height = Math.max(1, Math.floor(engine.getRenderHeight()));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  draw(ctx);
  return { width, height, alpha: ctx.getImageData(0, 0, width, height).data };
}

function selectByScreenMask(
  data: SplatPlyData,
  visibleMask: Uint8Array,
  asset: LoadedAsset,
  scene: Scene,
  mask: ScreenMask,
  selected: Uint8Array
): void {
  projectAndSelect(data, visibleMask, asset, scene, selected, (x, y) => {
    const ix = x | 0;
    const iy = y | 0;
    if (ix < 0 || iy < 0 || ix >= mask.width || iy >= mask.height) return false;
    return mask.alpha[(iy * mask.width + ix) * 4 + 3] > 0;
  });
}

function selectByProjectedPointFast(
  data: SplatPlyData,
  visibleMask: Uint8Array,
  asset: LoadedAsset,
  scene: Scene,
  predicate: (x: number, y: number) => boolean,
  selected: Uint8Array
): void {
  projectAndSelect(data, visibleMask, asset, scene, selected, predicate);
}

function projectAndSelect(
  data: SplatPlyData,
  visibleMask: Uint8Array,
  asset: LoadedAsset,
  scene: Scene,
  selected: Uint8Array,
  predicate: (x: number, y: number) => boolean
): void {
  const camera = scene.activeCamera;
  if (!camera) return;

  const engine = scene.getEngine();
  const viewport = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
  const world = (asset.rootNode as any).getWorldMatrix?.() ?? Matrix.Identity();
  const final = world.multiply(scene.getTransformMatrix());
  const m = final.m;

  // Projection manuelle : évite Vector3.Project + allocations pour chaque splat.
  for (let i = 0; i < data.vertexCount; i++) {
    if (!visibleMask[i]) continue;
    const x = data.x[i];
    const y = data.y[i];
    const z = data.z[i];

    const tx = x * m[0] + y * m[4] + z * m[8] + m[12];
    const ty = x * m[1] + y * m[5] + z * m[9] + m[13];
    const tz = x * m[2] + y * m[6] + z * m[10] + m[14];
    const tw = x * m[3] + y * m[7] + z * m[11] + m[15];
    if (tw === 0) continue;

    const ndcX = tx / tw;
    const ndcY = ty / tw;
    const ndcZ = tz / tw;
    if (ndcZ < 0 || ndcZ > 1 || ndcX < -1.05 || ndcX > 1.05 || ndcY < -1.05 || ndcY > 1.05) continue;

    const sx = viewport.x + (ndcX + 1) * 0.5 * viewport.width;
    const sy = viewport.y + (1 - ndcY) * 0.5 * viewport.height;
    if (predicate(sx, sy)) selected[i] = 1;
  }
}

function simplifyScreenPath(path: Array<{ x: number; y: number }>, minStep: number): Array<{ x: number; y: number }> {
  if (path.length <= 2) return path;
  const out: Array<{ x: number; y: number }> = [path[0]];
  let last = path[0];
  const min2 = minStep * minStep;
  for (let i = 1; i < path.length - 1; i++) {
    const p = path[i];
    const dx = p.x - last.x;
    const dy = p.y - last.y;
    if (dx * dx + dy * dy >= min2) {
      out.push(p);
      last = p;
    }
  }
  out.push(path[path.length - 1]);
  return out;
}

function findHeaderEnd(bytes: Uint8Array): number {
  const marker = new TextEncoder().encode('end_header');
  for (let i = 0; i < bytes.length - marker.length; i++) {
    let ok = true;
    for (let j = 0; j < marker.length; j++) {
      if (bytes[i + j] !== marker[j]) { ok = false; break; }
    }
    if (!ok) continue;
    let k = i + marker.length;
    if (bytes[k] === 13 && bytes[k + 1] === 10) return k + 2;
    if (bytes[k] === 10) return k + 1;
  }
  return -1;
}

function readBinary(view: DataView, properties: PlyProperty[], propIdx: number, base: number): number {
  const p = properties[propIdx];
  return TYPE_INFO[p.type].read(view, base + p.offset);
}

function readColorBinary(view: DataView, properties: PlyProperty[], propIndex: Map<string, number>, base: number): [number, number, number] {
  if (propIndex.has('red') && propIndex.has('green') && propIndex.has('blue')) {
    return [
      normalizeRgb(readBinary(view, properties, propIndex.get('red')!, base)),
      normalizeRgb(readBinary(view, properties, propIndex.get('green')!, base)),
      normalizeRgb(readBinary(view, properties, propIndex.get('blue')!, base)),
    ];
  }
  if (propIndex.has('f_dc_0') && propIndex.has('f_dc_1') && propIndex.has('f_dc_2')) {
    return [
      clamp01(0.5 + SH_C0 * readBinary(view, properties, propIndex.get('f_dc_0')!, base)),
      clamp01(0.5 + SH_C0 * readBinary(view, properties, propIndex.get('f_dc_1')!, base)),
      clamp01(0.5 + SH_C0 * readBinary(view, properties, propIndex.get('f_dc_2')!, base)),
    ];
  }
  return [0.5, 0.5, 0.5];
}

function readColorAscii(vals: number[], propIndex: Map<string, number>): [number, number, number] {
  if (propIndex.has('red') && propIndex.has('green') && propIndex.has('blue')) {
    return [normalizeRgb(vals[propIndex.get('red')!]), normalizeRgb(vals[propIndex.get('green')!]), normalizeRgb(vals[propIndex.get('blue')!])];
  }
  if (propIndex.has('f_dc_0') && propIndex.has('f_dc_1') && propIndex.has('f_dc_2')) {
    return [
      clamp01(0.5 + SH_C0 * vals[propIndex.get('f_dc_0')!]),
      clamp01(0.5 + SH_C0 * vals[propIndex.get('f_dc_1')!]),
      clamp01(0.5 + SH_C0 * vals[propIndex.get('f_dc_2')!]),
    ];
  }
  return [0.5, 0.5, 0.5];
}

function normalizeRgb(v: number): number {
  return v > 1 ? clamp01(v / 255) : clamp01(v);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function pointInPolygon(x: number, y: number, poly: Array<{ x: number; y: number }>): boolean {
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


function writeBinary(view: DataView, props: PlyProperty[], propIdx: number, rowBase: number, value: number): void {
  const p = props[propIdx];
  const info = TYPE_INFO[p.type];
  if (!info) throw new Error(`Type PLY non supporté en écriture : ${p.type}`);
  info.write(view, rowBase + p.offset, Number.isFinite(value) ? value : 0);
}

function clampInt(value: number, min: number, max: number): number {
  const v = Math.round(Number.isFinite(value) ? value : 0);
  return Math.max(min, Math.min(max, v));
}

function formatAsciiValue(value: number, type: string): string {
  const t = type.toLowerCase();
  if (t.includes('float') || t.includes('double')) return Number.isFinite(value) ? Number(value).toPrecision(9) : '0';
  return String(clampInt(value, -2147483648, 4294967295));
}

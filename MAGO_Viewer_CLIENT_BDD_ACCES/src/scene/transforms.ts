import { TransformNode, Vector3 } from '@babylonjs/core';
import type { LoadedAsset, LayerKind, LayerTransform } from '../types';

export const DEFAULT_TRANSFORM: LayerTransform = {
  px: 0,
  py: 0,
  pz: 0,
  rx: 0,
  ry: 0,
  rz: 0,
  scale: 1,
};

export function cloneTransform(t: LayerTransform = DEFAULT_TRANSFORM): LayerTransform {
  return { ...DEFAULT_TRANSFORM, ...t };
}

export function zUpToYUpTransform(): LayerTransform {
  return { ...DEFAULT_TRANSFORM, rx: -90 };
}

export function applyLayerTransform(asset: LoadedAsset | null, transform: LayerTransform): void {
  if (!asset) return;
  const node = asset.rootNode as TransformNode;
  // PIÈGE Babylon : si un rotationQuaternion est posé sur le nœud (c'est le cas
  // après un alignement par points), node.rotation (Euler) est silencieusement
  // IGNORÉ — les champs du panneau Transformations semblaient alors « ne rien
  // faire ». On purge le quaternion pour que les valeurs saisies s'appliquent.
  node.rotationQuaternion = null;
  node.position = new Vector3(transform.px, transform.py, transform.pz);
  node.rotation = new Vector3(
    degToRad(transform.rx),
    degToRad(transform.ry),
    degToRad(transform.rz),
  );
  node.scaling = new Vector3(transform.scale, transform.scale, transform.scale);
  node.computeWorldMatrix(true);
  for (const mesh of asset.meshes) {
    mesh.computeWorldMatrix(true);
  }
}

export function readTransformFromInputs(kind: LayerKind): LayerTransform {
  const get = (field: keyof LayerTransform): number => {
    const input = document.querySelector<HTMLInputElement>(`input[data-transform="${kind}"][data-field="${field}"]`);
    const value = input ? parseFloat(input.value) : Number.NaN;
    if (!Number.isFinite(value)) return field === 'scale' ? 1 : 0;
    if (field === 'scale') return Math.max(0.0001, value);
    return value;
  };

  return {
    px: get('px'),
    py: get('py'),
    pz: get('pz'),
    rx: get('rx'),
    ry: get('ry'),
    rz: get('rz'),
    scale: get('scale'),
  };
}

export function writeTransformToInputs(kind: LayerKind, transform: LayerTransform): void {
  for (const [field, value] of Object.entries(transform)) {
    const input = document.querySelector<HTMLInputElement>(`input[data-transform="${kind}"][data-field="${field}"]`);
    if (input) input.value = String(roundForInput(value));
  }
}

function degToRad(v: number): number {
  return (v * Math.PI) / 180;
}

function roundForInput(v: number): number {
  return Math.round(v * 1000000) / 1000000;
}

import type { AbstractMesh, GaussianSplattingMesh, Mesh, Scene, TransformNode, Vector3 } from '@babylonjs/core';

export interface MeshSubLayer {
  id: string;
  name: string;
  classKey: string;
  meshes: AbstractMesh[];
  visible: boolean;
  triangleCount: number;
  /** Clé de regroupement de la classe (sans l'instance), ex "class_118_chair". */
  classId?: string;
  /** Nom d'affichage de la classe, ex "Chaise". */
  className?: string;
  /** Index d'instance (1-based) ou null si la classe n'est pas instanciée. */
  instanceIndex?: number | null;
  /** Nom d'affichage de l'instance, ex "Chaise 2". */
  instanceName?: string;
}

export interface LoadedAsset {
  kind: 'mesh' | 'splat' | 'pointcloud';
  rootNode: AbstractMesh | Mesh | GaussianSplattingMesh | TransformNode;
  fileName: string;
  meshes: AbstractMesh[];
  triangleCount: number;
  splatCount: number;
  meshLayers?: MeshSubLayer[];
  /**
   * Mode « arrière-plan » : l'objet n'est plus rendu à l'écran (visibility = 0)
   * mais reste pickable (isVisible reste true) → sélection, liseré, mesures et
   * enrichissement continuent de fonctionner. Typique : mesh caché derrière les
   * splats après recalage. Persisté dans scene.json à la publication client.
   */
  background?: boolean;
}

export interface MeasurementPoint {
  position: Vector3;
  pickedMesh: AbstractMesh | null;
}

export type MeshRenderMode = 'solid' | 'wireframe' | 'edges';

export type LayerKind = 'mesh' | 'splat';
export type AlignableKind = LayerKind | 'pointcloud';

export interface LayerTransform {
  px: number;
  py: number;
  pz: number;
  rx: number;
  ry: number;
  rz: number;
  scale: number;
}

export interface SceneExportConfig {
  version: 1;
  createdAt: string;
  app: 'MAGO Viewer';
  files: {
    mesh: string | null;
    splat: string | null;
  };
  transforms: Record<LayerKind, LayerTransform>;
  camera: {
    target: { x: number; y: number; z: number };
    alpha: number;
    beta: number;
    radius: number;
  };
  notes: string;
}

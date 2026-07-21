import {
  AbstractMesh,
  Color3,
  LinesMesh,
  MeshBuilder,
  Observer,
  PointerEventTypes,
  PointerInfo,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';

export type MeasureMode = 'distance' | 'area';

export interface MeasurementResult {
  mode: MeasureMode;
  points: Vector3[];
  pointA?: Vector3;
  pointB?: Vector3;
  distance?: number;
  delta?: Vector3;
  area?: number;
}

/**
 * Outil de mesure robuste :
 * - distance : 2 points
 * - area : contour 3D par clics successifs, surface calculée par triangulation.
 *
 * IMPORTANT : on utilise l'observer Babylon POINTERPICK au lieu d'un listener DOM
 * manuel. C'est plus fiable avec l'ArcRotateCamera, les DPI Windows, le canvas
 * redimensionné et les menus flottants.
 */
export class MeasureTool {
  private scene: Scene;
  private active = false;
  private mode: MeasureMode = 'distance';
  private points: Vector3[] = [];
  private markers: AbstractMesh[] = [];
  private lines: LinesMesh[] = [];
  private listeners: ((r: MeasurementResult | null) => void)[] = [];
  private pointerObserver: Observer<PointerInfo> | null = null;
  private areaClosed = false;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  setMode(mode: MeasureMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.clear();
  }

  getMode(): MeasureMode {
    return this.mode;
  }

  setActive(active: boolean): void {
    this.active = active;
    const canvas = this.scene.getEngine().getRenderingCanvas();
    if (canvas) canvas.style.cursor = active ? 'crosshair' : 'default';

    if (active && !this.pointerObserver) {
      this.pointerObserver = this.scene.onPointerObservable.add((pointerInfo) => {
        this.onPointerPick(pointerInfo);
      }, PointerEventTypes.POINTERPICK);
    }

    if (!active && this.pointerObserver) {
      this.scene.onPointerObservable.remove(this.pointerObserver);
      this.pointerObserver = null;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  onChange(listener: (r: MeasurementResult | null) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  clear(): void {
    this.points = [];
    this.areaClosed = false;
    this.disposeVisuals();
    this.notify(null);
  }

  /** Supprime le dernier point cliqué, pratique si le clic est parti au mauvais endroit. */
  undoLastPoint(): void {
    if (this.points.length === 0) return;
    this.points.pop();
    this.areaClosed = false;
    this.rebuildVisuals();
    this.notify(this.points.length > 0 ? this.buildResult() : null);
  }

  /** Ferme la surface en reliant le dernier point au premier et notifie la surface courante. */
  finishArea(): void {
    if (this.mode !== 'area' || this.points.length < 3) return;
    this.areaClosed = true;
    this.rebuildLines(true);
    this.notify(this.buildResult());
  }

  dispose(): void {
    this.setActive(false);
    this.disposeVisuals();
    this.listeners = [];
  }

  private onPointerPick(pointerInfo: PointerInfo): void {
    if (!this.active) return;

    const evt = pointerInfo.event as PointerEvent | undefined;
    if (evt && evt.button !== 0) return;

    const pickInfo = pointerInfo.pickInfo;
    if (!pickInfo || !pickInfo.hit || !pickInfo.pickedPoint || !pickInfo.pickedMesh) return;

    const mesh = pickInfo.pickedMesh;
    if (!this.isValidMeasureTarget(mesh)) return;

    this.addPoint(pickInfo.pickedPoint, mesh);
  }

  private isValidMeasureTarget(mesh: AbstractMesh): boolean {
    if (!mesh.isEnabled() || !mesh.isVisible || !mesh.isPickable) return false;

    // On évite explicitement les aides visuelles de mesure, grilles, gizmos, splats, etc.
    const n = mesh.name.toLowerCase();
    if (n.includes('measure_marker') || n.includes('measure_line')) return false;
    if (n.includes('grid') || n.includes('axis') || n.includes('gizmo')) return false;
    if (n.includes('splat')) return false;

    return true;
  }

  private addPoint(point: Vector3, _mesh: AbstractMesh | null): void {
    const maxPoints = this.mode === 'distance' ? 2 : Number.POSITIVE_INFINITY;
    if (this.points.length >= maxPoints) {
      this.clear();
    }

    this.areaClosed = false;
    this.points.push(point.clone());
    this.rebuildVisuals();
    this.notify(this.buildResult());
  }

  private buildResult(): MeasurementResult {
    const points = this.points.map((p) => p.clone());
    const result: MeasurementResult = { mode: this.mode, points };

    if (points.length >= 2) {
      const a = points[0];
      const b = points[1];
      const delta = b.subtract(a);
      result.pointA = a.clone();
      result.pointB = b.clone();
      result.delta = delta;
      result.distance = delta.length();
    }

    if (this.mode === 'area' && points.length >= 3) {
      result.area = this.computeArea(points);
    }

    return result;
  }

  private computeArea(points: Vector3[]): number {
    // Triangulation en éventail depuis le premier point. Adapté aux surfaces approximativement planes.
    if (points.length < 3) return 0;
    const origin = points[0];
    let area = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const v1 = points[i].subtract(origin);
      const v2 = points[i + 1].subtract(origin);
      area += Vector3.Cross(v1, v2).length() * 0.5;
    }
    return area;
  }

  private rebuildVisuals(): void {
    this.disposeVisuals();
    const color = new Color3(1.0, 0.78, 0.08);
    for (const p of this.points) {
      this.markers.push(this.createMarker(p, color));
    }
    this.rebuildLines(this.areaClosed);
  }

  private createMarker(at: Vector3, color: Color3): AbstractMesh {
    const m = MeshBuilder.CreateSphere(
      `measure_marker_${Date.now()}_${this.markers.length}`,
      { diameter: 0.10, segments: 16 },
      this.scene
    );
    m.position = at.clone();
    m.isPickable = false;
    const mat = new StandardMaterial(`measure_mat_${Date.now()}_${this.markers.length}`, this.scene);
    mat.emissiveColor = color;
    mat.diffuseColor = color;
    mat.disableLighting = true;
    m.material = mat;
    m.renderingGroupId = 2;
    return m;
  }

  private rebuildLines(closeLoop: boolean): void {
    for (const line of this.lines) line.dispose();
    this.lines = [];
    if (this.points.length < 2) return;

    for (let i = 0; i < this.points.length - 1; i++) {
      this.lines.push(this.createLine(this.points[i], this.points[i + 1]));
    }
    if (closeLoop && this.points.length > 2) {
      this.lines.push(this.createLine(this.points[this.points.length - 1], this.points[0]));
    }
  }

  private createLine(a: Vector3, b: Vector3): LinesMesh {
    const line = MeshBuilder.CreateLines(
      `measure_line_${Date.now()}_${this.lines.length}`,
      { points: [a, b] },
      this.scene
    );
    line.color = new Color3(1.0, 0.78, 0.08);
    line.isPickable = false;
    line.renderingGroupId = 2;
    return line;
  }

  private disposeVisuals(): void {
    for (const m of this.markers) m.dispose();
    for (const l of this.lines) l.dispose();
    this.markers = [];
    this.lines = [];
  }

  private notify(result: MeasurementResult | null): void {
    for (const l of this.listeners) l(result);
  }
}

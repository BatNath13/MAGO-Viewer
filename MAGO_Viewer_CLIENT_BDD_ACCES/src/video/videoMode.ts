import {
  Scene,
  Engine,
  Vector3,
  Curve3,
  ArcRotateCamera,
  UniversalCamera,
  Camera,
} from "@babylonjs/core";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface Waypoint {
  /** Position monde de la caméra */
  position: Vector3;
  /** Point visé */
  target: Vector3;
  /** Pause sur ce waypoint, en secondes (0 = pas d'arrêt) */
  hold: number;
}

export type SpeedMode =
  | { kind: "constant"; unitsPerSecond: number }
  | { kind: "duration"; seconds: number };

export interface VideoModeOptions {
  fps: number;
  /** Vitesse de déplacement le long du chemin */
  speed: SpeedMode;
  /** Rotation continue ajoutée autour du target (deg/s). 0 = désactivé. */
  spinDegPerSecond: number;
  /** true = boucle fermée (dernier waypoint relié au premier) */
  loop: boolean;
  /** Lissage aux extrémités de chaque segment */
  easing: boolean;
  /** Échantillonnage de la spline (plus haut = chemin plus précis) */
  splineResolution: number;
}

const DEFAULTS: VideoModeOptions = {
  fps: 30,
  speed: { kind: "duration", seconds: 15 },
  spinDegPerSecond: 0,
  loop: true,
  easing: true,
  splineResolution: 40,
};

/* ------------------------------------------------------------------ */
/*  Chemin : spline Catmull-Rom + reparamétrage par longueur d'arc     */
/* ------------------------------------------------------------------ */

/**
 * Une spline Catmull-Rom brute est paramétrée par index de segment, pas par
 * distance : la caméra accélère dans les longs segments et ralentit dans les
 * courts. On reparamètre donc par longueur d'arc cumulée pour obtenir une
 * vitesse réellement constante.
 */
class ArcLengthPath {
  private points: Vector3[];
  private cumulative: number[] = [];
  public readonly length: number;

  constructor(controls: Vector3[], resolution: number, loop: boolean) {
    if (controls.length < 2) {
      throw new Error("Il faut au moins 2 waypoints pour tracer un chemin.");
    }
    // Catmull-Rom exige >= 4 points de contrôle : on duplique les extrémités.
    const padded = loop
      ? controls
      : [controls[0], ...controls, controls[controls.length - 1]];

    this.points =
      padded.length >= 4
        ? Curve3.CreateCatmullRomSpline(padded, resolution, loop).getPoints()
        : padded.map((p) => p.clone());

    let total = 0;
    this.cumulative.push(0);
    for (let i = 1; i < this.points.length; i++) {
      total += Vector3.Distance(this.points[i - 1], this.points[i]);
      this.cumulative.push(total);
    }
    this.length = total;
  }

  /** Position à la distance `d` depuis le début du chemin. */
  at(d: number): Vector3 {
    const clamped = Math.max(0, Math.min(d, this.length));
    // Recherche dichotomique du segment contenant `clamped`.
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid] <= clamped) lo = mid;
      else hi = mid;
    }
    const segLen = this.cumulative[hi] - this.cumulative[lo];
    const t = segLen > 1e-9 ? (clamped - this.cumulative[lo]) / segLen : 0;
    return Vector3.Lerp(this.points[lo], this.points[hi], t);
  }

  /** Échantillonne le chemin pour l'aperçu visuel (polyligne). */
  polyline(): Vector3[] {
    return this.points;
  }
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/* ------------------------------------------------------------------ */
/*  VideoMode                                                          */
/* ------------------------------------------------------------------ */

export class VideoMode {
  private opts: VideoModeOptions;
  private waypoints: Waypoint[] = [];
  private cancelled = false;

  constructor(
    private scene: Scene,
    private engine: Engine,
    private canvas: HTMLCanvasElement,
    options: Partial<VideoModeOptions> = {}
  ) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /* -------------------- gestion des waypoints -------------------- */

  /** Capture la caméra active telle qu'elle est à l'écran. */
  addWaypointFromCamera(hold = 0): Waypoint {
    const cam = this.scene.activeCamera;
    if (!cam) throw new Error("Aucune caméra active.");
    const wp: Waypoint = {
      position: cam.position.clone(),
      target: this.resolveTarget(cam),
      hold,
    };
    this.waypoints.push(wp);
    return wp;
  }

  private resolveTarget(cam: Camera): Vector3 {
    if (cam instanceof ArcRotateCamera) return cam.target.clone();
    if (cam instanceof UniversalCamera) return cam.getTarget().clone();
    // Fallback : point devant la caméra, à 10 unités.
    return cam.position.add(cam.getForwardRay().direction.scale(10));
  }

  removeWaypoint(index: number): void {
    this.waypoints.splice(index, 1);
  }

  moveWaypoint(from: number, to: number): void {
    const [wp] = this.waypoints.splice(from, 1);
    this.waypoints.splice(to, 0, wp);
  }

  clear(): void {
    this.waypoints = [];
  }

  getWaypoints(): readonly Waypoint[] {
    return this.waypoints;
  }

  /** Remplace tout le trajet d'un coup (orbite auto, preset, rechargement). */
  setWaypoints(wps: Waypoint[]): void {
    this.waypoints = wps.map((w) => ({
      position: w.position.clone(),
      target: w.target.clone(),
      hold: w.hold,
    }));
  }

  setHold(index: number, seconds: number): void {
    if (this.waypoints[index]) {
      this.waypoints[index].hold = Math.max(0, seconds);
    }
  }

  setOptions(patch: Partial<VideoModeOptions>): void {
    this.opts = { ...this.opts, ...patch };
  }

  /* -------------------- construction du trajet -------------------- */

  private buildPaths() {
    const positions = this.waypoints.map((w) => w.position);
    const targets = this.waypoints.map((w) => w.target);
    const posPath = new ArcLengthPath(
      positions,
      this.opts.splineResolution,
      this.opts.loop
    );
    const tgtPath = new ArcLengthPath(
      targets,
      this.opts.splineResolution,
      this.opts.loop
    );
    return { posPath, tgtPath };
  }

  /** Durée totale de l'animation, pauses comprises. */
  getDuration(): number {
    const { posPath } = this.buildPaths();
    const holds = this.waypoints.reduce((s, w) => s + w.hold, 0);
    const travel =
      this.opts.speed.kind === "duration"
        ? this.opts.speed.seconds
        : posPath.length / this.opts.speed.unitsPerSecond;
    return travel + holds;
  }

  /**
   * Place la caméra à l'instant `time` (secondes). C'est la seule fonction qui
   * touche à la caméra : aperçu et export l'utilisent toutes les deux, donc ce
   * que tu vois en aperçu est exactement ce qui sera exporté.
   */
  private applyPose(time: number, posPath: ArcLengthPath, tgtPath: ArcLengthPath) {
    const holds = this.waypoints.reduce((s, w) => s + w.hold, 0);
    const travel =
      this.opts.speed.kind === "duration"
        ? Math.max(0.001, this.opts.speed.seconds - holds)
        : posPath.length / this.opts.speed.unitsPerSecond;

    // Répartition du temps : chaque waypoint "consomme" son hold à son passage.
    const n = this.waypoints.length;
    let elapsed = 0;
    let distance = 0;
    for (let i = 0; i < n; i++) {
      const wp = this.waypoints[i];
      const segStart = (i / (n - (this.opts.loop ? 0 : 1))) * travel;
      const segEnd = ((i + 1) / (n - (this.opts.loop ? 0 : 1))) * travel;

      if (wp.hold > 0 && time >= elapsed + segStart && time < elapsed + segStart + wp.hold) {
        distance = (segStart / travel) * posPath.length;
        this.setCamera(posPath.at(distance), tgtPath.at(distance), time);
        return;
      }
      if (wp.hold > 0 && time >= elapsed + segStart + wp.hold) elapsed += wp.hold;
      if (time < elapsed + segEnd) {
        let t = (time - elapsed - segStart) / (segEnd - segStart);
        t = Math.max(0, Math.min(1, t));
        if (this.opts.easing) t = smoothstep(t);
        const d0 = (segStart / travel) * posPath.length;
        const d1 = (segEnd / travel) * posPath.length;
        distance = d0 + (d1 - d0) * t;
        this.setCamera(posPath.at(distance), tgtPath.at(distance), time);
        return;
      }
    }
    this.setCamera(posPath.at(posPath.length), tgtPath.at(tgtPath.length), time);
  }

  private setCamera(position: Vector3, target: Vector3, time: number) {
    const cam = this.scene.activeCamera;
    if (!cam) return;

    let pos = position;
    if (this.opts.spinDegPerSecond !== 0) {
      // Rotation continue autour de l'axe Y passant par le target.
      const angle = (this.opts.spinDegPerSecond * Math.PI) / 180 * time;
      const offset = position.subtract(target);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      pos = target.add(
        new Vector3(
          offset.x * cos - offset.z * sin,
          offset.y,
          offset.x * sin + offset.z * cos
        )
      );
    }

    if (cam instanceof ArcRotateCamera) {
      cam.target.copyFrom(target);
      cam.setPosition(pos);
    } else if (cam instanceof UniversalCamera) {
      cam.position.copyFrom(pos);
      cam.setTarget(target);
    }
  }

  /* -------------------- aperçu temps réel -------------------- */

  /** Joue le trajet à l'écran, sans capture. Retourne une fonction d'arrêt. */
  preview(onEnd?: () => void): () => void {
    const { posPath, tgtPath } = this.buildPaths();
    const duration = this.getDuration();
    const start = performance.now();
    let stopped = false;

    const observer = this.scene.onBeforeRenderObservable.add(() => {
      const t = (performance.now() - start) / 1000;
      if (t >= duration) {
        if (this.opts.loop) {
          this.applyPose(t % duration, posPath, tgtPath);
        } else {
          stop();
          onEnd?.();
        }
        return;
      }
      this.applyPose(t, posPath, tgtPath);
    });

    const stop = () => {
      if (stopped) return;
      stopped = true;
      this.scene.onBeforeRenderObservable.remove(observer);
    };
    return stop;
  }

  /* -------------------- export frame par frame -------------------- */

  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Rend la séquence image par image en temps virtuel et envoie chaque frame
   * au backend. Le framerate réel du viewer n'a aucune influence sur le
   * résultat : une frame lourde prend juste plus longtemps à produire.
   *
   * @param sink  reçoit chaque frame encodée en PNG
   */
  async export(
    sink: (frame: Blob, index: number, total: number) => Promise<void>,
    onProgress?: (done: number, total: number) => void
  ): Promise<void> {
    if (this.waypoints.length < 2) {
      throw new Error("Il faut au moins 2 waypoints.");
    }
    this.cancelled = false;
    const { posPath, tgtPath } = this.buildPaths();
    const duration = this.getDuration();
    const total = Math.round(duration * this.opts.fps);

    // On coupe la boucle de rendu automatique : on pilote scene.render() nous-mêmes.
    this.engine.stopRenderLoop();
    const cam = this.scene.activeCamera;
    const detached = cam?.inputs?.attachedToElement ?? false;
    if (detached) cam!.detachControl();

    try {
      for (let i = 0; i < total; i++) {
        if (this.cancelled) break;
        const time = i / this.opts.fps;
        this.applyPose(time, posPath, tgtPath);

        // Attendre que tout soit prêt : LOD, matériaux, textures.
        this.scene.render();
        while (!this.scene.isReady(true)) {
          await new Promise((r) => setTimeout(r, 30));
          this.scene.render();
        }

        const blob = await this.grabFrame();
        await sink(blob, i, total);
        onProgress?.(i + 1, total);

        // Rendre la main au navigateur pour ne pas geler l'onglet.
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      if (detached) cam!.attachControl(true);
      this.engine.runRenderLoop(() => this.scene.render());
    }
  }

  private grabFrame(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      this.canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Capture de frame échouée."))),
        "image/png"
      );
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Sink : envoi des frames vers le backend Fastify                    */
/* ------------------------------------------------------------------ */

/**
 * Ouvre une session d'encodage côté serveur, renvoie un sink et une fonction
 * de finalisation qui retourne l'URL du MP4.
 */
export async function createServerSink(apiBase: string, fps: number) {
  const res = await fetch(`${apiBase}/render/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fps }),
  });
  if (!res.ok) throw new Error(`Ouverture de session refusée (${res.status}).`);
  const { sessionId } = await res.json();

  const sink = async (frame: Blob, index: number) => {
    const r = await fetch(`${apiBase}/render/${sessionId}/frame/${index}`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: frame,
    });
    if (!r.ok) throw new Error(`Frame ${index} rejetée (${r.status}).`);
  };

  const finish = async (): Promise<string> => {
    const r = await fetch(`${apiBase}/render/${sessionId}/finish`, {
      method: "POST",
    });
    if (!r.ok) throw new Error(`Encodage échoué (${r.status}).`);
    const { url } = await r.json();
    return url;
  };

  return { sink, finish };
}

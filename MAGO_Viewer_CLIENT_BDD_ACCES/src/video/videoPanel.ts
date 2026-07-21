import { Scene, Engine, Vector3, AbstractMesh } from "@babylonjs/core";
import { VideoMode, Waypoint, createServerSink } from "./videoMode";

/* ------------------------------------------------------------------ */
/*  Orbite automatique                                                 */
/* ------------------------------------------------------------------ */

/**
 * Construit une orbite sans que l'utilisateur ait a placer un seul waypoint.
 * C'est le cas d'usage 90% : on veut montrer une scene, pas chorégraphier.
 *
 * L'ellipse est calee sur la bbox et non sur un cercle : dans une piece de
 * 10,8 x 12,7 m, un cercle assez large pour reculer au fond traverse le mur
 * lateral. Le rayon est donc independant sur chaque axe.
 */
export function buildAutoOrbit(
  meshes: AbstractMesh[],
  opts: { waypoints?: number; eyeHeight?: number; margin?: number; startTowards?: Vector3 } = {}
): Waypoint[] {
  const n = opts.waypoints ?? 8;
  const margin = opts.margin ?? 0.72;      // fraction de la demi-bbox
  const eyeH = opts.eyeHeight ?? 1.55;

  let min = new Vector3(Infinity, Infinity, Infinity);
  let max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const m of meshes) {
    const b = m.getBoundingInfo().boundingBox;
    min = Vector3.Minimize(min, b.minimumWorld);
    max = Vector3.Maximize(max, b.maximumWorld);
  }
  const center = min.add(max).scale(0.5);
  const half = max.subtract(min).scale(0.5);

  // Babylon travaille en Y-up : la hauteur est sur Y, l'orbite dans le plan XZ.
  const rx = half.x * margin;
  const rz = half.z * margin;
  const eyeY = min.y + eyeH;

  // Phase de depart : on regarde vers `startTowards` s'il est fourni.
  let phase = 0;
  if (opts.startTowards) {
    const d = opts.startTowards.subtract(center);
    phase = Math.atan2(d.z, d.x) + Math.PI;   // se placer a l'oppose de la cible
  }

  const wps: Waypoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = phase + (2 * Math.PI * i) / n;
    wps.push({
      position: new Vector3(
        center.x + rx * Math.cos(t),
        eyeY + 0.25 * Math.sin(2 * t),        // respiration verticale : donne du parallaxe
        center.z + rz * Math.sin(t)
      ),
      target: new Vector3(center.x, eyeY - 0.15, center.z),
      hold: 0,
    });
  }
  return wps;
}

/* ------------------------------------------------------------------ */
/*  Panneau                                                            */
/* ------------------------------------------------------------------ */

export interface VideoPanelDeps {
  scene: Scene;
  engine: Engine;
  canvas: HTMLCanvasElement;
  apiBase: string;
  /** Meshes a cadrer pour l'orbite auto (typiquement les LOD0 visibles). */
  getTargetMeshes: () => AbstractMesh[];
  /** Masquer gizmos, contours de selection, HUD pendant la capture. */
  setUiVisible?: (visible: boolean) => void;
}

const CSS = `
.mv-video { display:flex; flex-direction:column; gap:10px; font:12px/1.4 system-ui,sans-serif; color:#d8dee6; }
.mv-video h4 { margin:0; font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:#7c8899; }
.mv-row { display:flex; align-items:center; gap:8px; }
.mv-row label { flex:0 0 74px; color:#8b95a3; }
.mv-row input[type=range] { flex:1; }
.mv-row output { flex:0 0 52px; text-align:right; font-variant-numeric:tabular-nums; }
.mv-btn { padding:6px 10px; border:1px solid #3a4553; border-radius:4px; background:#232a34; color:#d8dee6; cursor:pointer; }
.mv-btn:hover:not(:disabled) { background:#2c3542; }
.mv-btn:disabled { opacity:.45; cursor:default; }
.mv-btn.primary { background:#2f6f4f; border-color:#3d8a63; }
.mv-list { max-height:150px; overflow:auto; border:1px solid #2a323d; border-radius:4px; }
.mv-wp { display:flex; align-items:center; gap:6px; padding:4px 6px; border-bottom:1px solid #232a34; }
.mv-wp:last-child { border-bottom:0; }
.mv-wp .i { flex:0 0 18px; color:#6f7b8a; font-variant-numeric:tabular-nums; }
.mv-wp input { width:46px; background:#1b212a; border:1px solid #2f3945; color:#d8dee6; border-radius:3px; padding:1px 3px; }
.mv-wp button { background:none; border:0; color:#7c8899; cursor:pointer; padding:2px 4px; }
.mv-wp button:hover { color:#e06c6c; }
.mv-bar { height:4px; background:#232a34; border-radius:2px; overflow:hidden; }
.mv-bar i { display:block; height:100%; width:0; background:#4c9e78; transition:width .15s; }
.mv-status { min-height:15px; color:#8b95a3; }
.mv-status.err { color:#e08585; }
`;

export class VideoPanel {
  private root: HTMLElement;
  private video: VideoMode;
  private stopPreview: (() => void) | null = null;
  private busy = false;

  constructor(private deps: VideoPanelDeps, mount: HTMLElement) {
    this.video = new VideoMode(deps.scene, deps.engine, deps.canvas, {
      fps: 25,
      loop: true,
      speed: { kind: "duration", seconds: 20 },
    });

    if (!document.getElementById("mv-video-css")) {
      const st = document.createElement("style");
      st.id = "mv-video-css";
      st.textContent = CSS;
      document.head.appendChild(st);
    }

    this.root = document.createElement("div");
    this.root.className = "mv-video";
    this.root.innerHTML = `
      <button class="mv-btn primary" data-a="auto">Orbite automatique</button>
      <div class="mv-row">
        <label>Durée</label>
        <input type="range" data-r="dur" min="6" max="40" step="1" value="20">
        <output data-o="dur">20 s</output>
      </div>
      <div class="mv-row">
        <label>Images/s</label>
        <input type="range" data-r="fps" min="12" max="60" step="1" value="25">
        <output data-o="fps">25</output>
      </div>
      <div class="mv-row">
        <label>Rotation</label>
        <input type="range" data-r="spin" min="-20" max="20" step="1" value="0">
        <output data-o="spin">0 °/s</output>
      </div>
      <h4>Points de vue</h4>
      <div class="mv-list" data-el="list"></div>
      <div class="mv-row">
        <button class="mv-btn" data-a="add">Ajouter la vue courante</button>
        <button class="mv-btn" data-a="clear">Vider</button>
      </div>
      <div class="mv-row">
        <button class="mv-btn" data-a="preview">Aperçu</button>
        <button class="mv-btn primary" data-a="export">Enregistrer la vidéo</button>
      </div>
      <div class="mv-bar"><i data-el="bar"></i></div>
      <div class="mv-status" data-el="status"></div>
    `;
    mount.appendChild(this.root);
    this.wire();
    this.renderList();
  }

  private $(sel: string) { return this.root.querySelector(sel) as HTMLElement; }

  private wire() {
    this.root.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).dataset?.a;
      if (!a) return;
      if (a === "auto") this.autoOrbit();
      if (a === "add") { this.video.addWaypointFromCamera(0); this.renderList(); }
      if (a === "clear") { this.video.clear(); this.renderList(); }
      if (a === "preview") this.togglePreview();
      if (a === "export") this.export();
    });

    this.root.addEventListener("input", (e) => {
      const r = (e.target as HTMLInputElement).dataset?.r;
      if (!r) return;
      const val = Number((e.target as HTMLInputElement).value);
      if (r === "dur") {
        this.$('[data-o="dur"]').textContent = `${val} s`;
        this.video.setOptions({ speed: { kind: "duration", seconds: val } });
      }
      if (r === "fps") {
        this.$('[data-o="fps"]').textContent = `${val}`;
        this.video.setOptions({ fps: val });
      }
      if (r === "spin") {
        this.$('[data-o="spin"]').textContent = `${val} °/s`;
        this.video.setOptions({ spinDegPerSecond: val });
      }
    });
  }

  private autoOrbit() {
    const meshes = this.deps.getTargetMeshes();
    if (meshes.length === 0) {
      this.status("Aucun objet à cadrer.", true);
      return;
    }
    this.video.setWaypoints(buildAutoOrbit(meshes));
    this.renderList();
    this.status(`Orbite de ${this.video.getWaypoints().length} points générée.`);
  }

  private renderList() {
    const list = this.$('[data-el="list"]');
    const wps = this.video.getWaypoints();
    if (wps.length === 0) {
      list.innerHTML = `<div class="mv-wp" style="color:#6f7b8a">Aucun point. Lancez une orbite automatique.</div>`;
      return;
    }
    list.innerHTML = wps
      .map((w, i) => `
        <div class="mv-wp" data-i="${i}">
          <span class="i">${i + 1}</span>
          <span style="flex:1">${w.position.x.toFixed(1)}, ${w.position.y.toFixed(1)}, ${w.position.z.toFixed(1)}</span>
          <input type="number" step="0.5" min="0" value="${w.hold}" title="Pause (s)">
          <button title="Supprimer">✕</button>
        </div>`)
      .join("");

    list.querySelectorAll(".mv-wp").forEach((el) => {
      const i = Number((el as HTMLElement).dataset.i);
      el.querySelector("button")?.addEventListener("click", () => {
        this.video.removeWaypoint(i); this.renderList();
      });
      el.querySelector("input")?.addEventListener("change", (ev) => {
        this.video.setHold(i, Number((ev.target as HTMLInputElement).value));
      });
    });
  }

  private togglePreview() {
    if (this.stopPreview) {
      this.stopPreview(); this.stopPreview = null;
      this.status(""); return;
    }
    if (this.video.getWaypoints().length < 2) {
      this.status("Il faut au moins 2 points de vue.", true); return;
    }
    this.status("Aperçu en cours — recliquez pour arrêter.");
    this.stopPreview = this.video.preview(() => {
      this.stopPreview = null; this.status("");
    });
  }

  private async export() {
    if (this.busy) { this.video.cancel(); return; }
    if (this.video.getWaypoints().length < 2) {
      this.status("Il faut au moins 2 points de vue.", true); return;
    }
    if (this.stopPreview) { this.stopPreview(); this.stopPreview = null; }

    this.busy = true;
    this.deps.setUiVisible?.(false);
    const btn = this.root.querySelector('[data-a="export"]') as HTMLButtonElement;
    btn.textContent = "Annuler";
    const bar = this.$('[data-el="bar"]');

    try {
      const fps = (this.root.querySelector('[data-r="fps"]') as HTMLInputElement).valueAsNumber;
      const { sink, finish } = await createServerSink(this.deps.apiBase, fps);
      const t0 = performance.now();

      await this.video.export(sink, (done, total) => {
        bar.style.width = `${(100 * done) / total}%`;
        const el = (performance.now() - t0) / 1000;
        const eta = (el / done) * (total - done);
        this.status(`${done}/${total} images — ${Math.ceil(eta)} s restantes`);
      });

      this.status("Encodage…");
      const url = await finish();
      this.status("");
      const a = document.createElement("a");
      a.href = url; a.download = "orbite.mp4"; a.click();
    } catch (err) {
      this.status(`Échec : ${(err as Error).message}`, true);
    } finally {
      this.busy = false;
      btn.textContent = "Enregistrer la vidéo";
      bar.style.width = "0";
      this.deps.setUiVisible?.(true);
    }
  }

  private status(msg: string, isError = false) {
    const s = this.$('[data-el="status"]');
    s.textContent = msg;
    s.className = isError ? "mv-status err" : "mv-status";
  }

  dispose() {
    this.stopPreview?.();
    this.root.remove();
  }
}

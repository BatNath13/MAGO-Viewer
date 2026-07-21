import { AbstractMesh, Mesh, VertexBuffer, VertexData, Vector3, Color3, Scene } from "@babylonjs/core";

/* ------------------------------------------------------------------ */
/*  Extraction de la boucle de bord                                    */
/* ------------------------------------------------------------------ */

/**
 * Boucles d'aretes de bord d'un mesh, restreintes a une boite de selection.
 *
 * Une arete de bord n'est portee que par une seule face. Les sommets sont
 * soudes par position (grille de 0,1 mm) : un PLY/OBJ issu du mailleur duplique
 * souvent les sommets, et sans soudure TOUTES les aretes paraissent des bords.
 */
export function findBoundaryLoops(
  mesh: Mesh,
  box?: { min: Vector3; max: Vector3 }
): number[][] {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  const idx = mesh.getIndices();
  if (!pos || !idx) return [];

  // --- soudure par position
  const GRID = 1e4; // 0,1 mm
  const keyOf = (i: number) =>
    `${Math.round(pos[i * 3] * GRID)},${Math.round(pos[i * 3 + 1] * GRID)},${Math.round(pos[i * 3 + 2] * GRID)}`;
  const weld = new Map<string, number>();
  const canon = new Int32Array(pos.length / 3);
  for (let i = 0; i < canon.length; i++) {
    const k = keyOf(i);
    let c = weld.get(k);
    if (c === undefined) { c = i; weld.set(k, i); }
    canon[i] = c;
  }

  // --- comptage des aretes
  const count = new Map<string, number>();
  const ekey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (let t = 0; t < idx.length; t += 3) {
    const a = canon[idx[t]], b = canon[idx[t + 1]], c = canon[idx[t + 2]];
    for (const [u, v] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      const k = ekey(u, v);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }

  const inBox = (i: number) => {
    if (!box) return true;
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    return x >= box.min.x && x <= box.max.x && y >= box.min.y && y <= box.max.y
        && z >= box.min.z && z <= box.max.z;
  };

  const adj = new Map<number, number[]>();
  for (const [k, n] of count) {
    if (n !== 1) continue;
    const [a, b] = k.split("_").map(Number);
    if (!inBox(a) && !inBox(b)) continue;
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }

  const seen = new Set<number>();
  const loops: number[][] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const loop = [start];
    seen.add(start);
    let cur = start, prev = -1;
    for (;;) {
      const nxt = (adj.get(cur) ?? []).find((w) => w !== prev && (!seen.has(w) || w === start));
      if (nxt === undefined || nxt === start) break;
      loop.push(nxt); seen.add(nxt);
      prev = cur; cur = nxt;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  loops.sort((a, b) => b.length - a.length);
  return loops;
}

/* ------------------------------------------------------------------ */
/*  Panneau                                                            */
/* ------------------------------------------------------------------ */

export interface HoleFillDeps {
  scene: Scene;
  apiBase: string;
  /** Mesh actuellement selectionne dans ton gestionnaire de scene. */
  getSelectedMesh: () => Mesh | null;
  /** Emprise de la selection (lasso/rectangle existants). null = tout l'objet. */
  getSelectionBox: () => { min: Vector3; max: Vector3 } | null;
  /** Classe de l'objet : tes noms sont du type "class_009_wall_inst_001_LOD0". */
  getObjectClass: (m: AbstractMesh) => number | null;
  /** Chemin serveur du nuage recale. */
  getCloudPath: () => string | null;
  /** Ton undo existant. */
  pushUndo?: (m: Mesh, before: VertexData) => void;
}

export class HoleFillPanel {
  private root: HTMLElement;
  private loops: number[][] = [];
  private busy = false;

  constructor(private deps: HoleFillDeps, mount: HTMLElement) {
    this.root = document.createElement("div");
    this.root.style.cssText = "display:flex;flex-direction:column;gap:8px;font:12px system-ui;color:#d8dee6";
    this.root.innerHTML = `
      <button data-a="scan">Détecter les trous dans la sélection</button>
      <div data-el="list" style="max-height:130px;overflow:auto"></div>
      <label style="display:flex;gap:6px;align-items:center">
        <input type="checkbox" data-el="useCloud" checked> Utiliser le nuage
      </label>
      <button data-a="fill" disabled>Reconstruire le trou</button>
      <label style="display:flex;gap:6px;align-items:center">
        <input type="checkbox" data-el="hl"> Surligner les faces reconstruites
      </label>
      <div data-el="status" style="color:#8b95a3;min-height:30px"></div>
    `;
    mount.appendChild(this.root);
    this.root.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).dataset?.a;
      if (a === "scan") this.scan();
      if (a === "fill") this.fill();
    });
    this.root.addEventListener("change", (e) => {
      if ((e.target as HTMLElement).dataset?.el === "hl") {
        const m = this.deps.getSelectedMesh();
        if (m) this.refreshHighlight(m);
      }
    });
  }

  private $(s: string) { return this.root.querySelector(s) as HTMLElement; }
  private status(m: string) { this.$('[data-el="status"]').textContent = m; }

  private scan() {
    const m = this.deps.getSelectedMesh();
    if (!m) return this.status("Sélectionnez d'abord un objet.");
    const box = this.deps.getSelectionBox() ?? undefined;
    this.loops = findBoundaryLoops(m, box);

    // La plus grande boucle est le contour exterieur de l'objet, pas un trou.
    if (this.loops.length > 1) this.loops = this.loops.slice(1);

    const list = this.$('[data-el="list"]');
    list.innerHTML = this.loops.slice(0, 40)
      .map((L, i) => `<label style="display:block"><input type="radio" name="hl" value="${i}"> Trou ${i + 1} — ${L.length} sommets</label>`)
      .join("") || "<i>Aucun trou détecté.</i>";
    (this.root.querySelector('[data-a="fill"]') as HTMLButtonElement).disabled = this.loops.length === 0;
    this.status(`${this.loops.length} trou(s) détecté(s).`);
  }

  private async fill() {
    if (this.busy) return;
    const m = this.deps.getSelectedMesh();
    const sel = this.root.querySelector('input[name="hl"]:checked') as HTMLInputElement;
    if (!m || !sel) return this.status("Choisissez un trou dans la liste.");

    const loop = this.loops[Number(sel.value)];
    const pos = m.getVerticesData(VertexBuffer.PositionKind)!;
    const wm = m.getWorldMatrix();
    const boundary = loop.map((i) =>
      Vector3.TransformCoordinates(new Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]), wm)
    );
    // Couleurs du bord : servent a teinter les points sans mesure (Steiner,
    // ou cas interpole). Sans elles, un trou reboucherait en gris.
    const vcol = m.getVerticesData(VertexBuffer.ColorKind);
    const boundaryRgb = vcol
      ? loop.map((i) => [
          Math.round(vcol[i * 4] * 255),
          Math.round(vcol[i * 4 + 1] * 255),
          Math.round(vcol[i * 4 + 2] * 255),
        ])
      : null;

    this.busy = true;
    this.status("Reconstruction…");
    try {
      const useCloud = (this.$('[data-el="useCloud"]') as HTMLInputElement).checked;
      const res = await fetch(`${this.deps.apiBase}/holes/fill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boundary: boundary.map((v) => [v.x, v.y, v.z]),
          targetClass: this.deps.getObjectClass(m),
          cloudPath: useCloud ? this.deps.getCloudPath() : null,
          boundaryRgb,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.faces) {
        return this.status(`Échec : ${data.info?.status ?? data.error}`);
      }
      this.apply(m, loop, data.vertices ?? [], data.faces, data.colors ?? null, data.info.provenance);
      const p = data.info.provenance;
      this.status(
        `${data.info.n_faces} faces ajoutées — provenance ${p}` +
        (p === "mesure" ? ` (${data.info.n_cloud_points} points du nuage, couleur ${data.info.color_source})`
                        : " (bord seul, aucune mesure)")
      );
    } catch (e) {
      this.status(`Erreur : ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Fusionne les nouvelles faces dans le mesh, en repere LOCAL.
   *
   * La couleur ecrite est la couleur MESUREE renvoyee par le nuage. La
   * provenance ne doit surtout pas etre cuite dans COLOR_0 : elle partirait
   * dans l'export et le client recevrait une plaque coloree au milieu de son
   * tableau. Elle vit donc dans mesh.metadata, et l'affichage la revele a la
   * demande.
   */
  private apply(m: Mesh, loop: number[], newVertsWorld: number[][],
                faces: number[][], newColors: number[][] | null,
                provenance: string) {
    const vd = VertexData.ExtractFromMesh(m, true, true);
    if (this.deps.pushUndo) this.deps.pushUndo(m, VertexData.ExtractFromMesh(m, true, true));

    const inv = m.getWorldMatrix().clone().invert();
    const positions = Array.from(vd.positions ?? []);
    const colors = vd.colors ? Array.from(vd.colors) : null;
    const base = positions.length / 3;

    newVertsWorld.forEach((w, k) => {
      const l = Vector3.TransformCoordinates(new Vector3(w[0], w[1], w[2]), inv);
      positions.push(l.x, l.y, l.z);
      if (colors) {
        const c = newColors?.[k];
        if (c) colors.push(c[0] / 255, c[1] / 255, c[2] / 255, 1);
        else colors.push(0.6, 0.6, 0.6, 1);
      }
    });

    // Le Python indexe 0..nb-1 sur le bord (dans l'ordre envoye) et nb.. sur
    // les nouveaux sommets. On remappe vers les indices reels du mesh.
    const nb = loop.length;
    const remap = (i: number) => (i < nb ? loop[i] : base + (i - nb));
    const indices = Array.from(vd.indices ?? []);
    for (const f of faces) indices.push(remap(f[0]), remap(f[1]), remap(f[2]));

    const out = new VertexData();
    out.positions = positions;
    out.indices = indices;
    if (colors) out.colors = colors;
    out.normals = [];
    VertexData.ComputeNormals(positions, indices, out.normals);
    out.applyToMesh(m, true);

    // Tracabilite : quels sommets ne sont pas issus de la mesure d'origine.
    const meta = (m.metadata ??= {});
    (meta.magoReconstruit ??= []).push({
      vertexStart: base,
      vertexCount: newVertsWorld.length,
      provenance,
      date: new Date().toISOString(),
    });
    this.refreshHighlight(m);
  }

  /** Teinte les sommets reconstruits, ou restaure leur couleur mesuree. */
  private refreshHighlight(m: Mesh) {
    const on = (this.$('[data-el="hl"]') as HTMLInputElement)?.checked;
    const zones = m.metadata?.magoReconstruit as
      | { vertexStart: number; vertexCount: number; provenance: string }[]
      | undefined;
    if (!zones?.length) return;
    const colors = m.getVerticesData(VertexBuffer.ColorKind);
    if (!colors) return;

    const meta = m.metadata;
    if (on) {
      meta.magoColorBackup ??= Float32Array.from(colors);
      for (const z of zones) {
        // orange = recupere du nuage, rouge = interpole (aucune mesure)
        const c = z.provenance === "mesure" ? [0.95, 0.55, 0.15] : [0.9, 0.2, 0.2];
        for (let i = z.vertexStart; i < z.vertexStart + z.vertexCount; i++) {
          colors[i * 4] = c[0]; colors[i * 4 + 1] = c[1]; colors[i * 4 + 2] = c[2];
        }
      }
    } else if (meta.magoColorBackup) {
      // FloatArray = number[] | Float32Array : pas de .set garanti.
      const bak = meta.magoColorBackup as Float32Array;
      for (let i = 0; i < bak.length && i < colors.length; i++) colors[i] = bak[i];
    }
    m.updateVerticesData(VertexBuffer.ColorKind, colors);
  }
}

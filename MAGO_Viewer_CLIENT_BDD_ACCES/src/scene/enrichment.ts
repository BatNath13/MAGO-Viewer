// =================================================================
//  MAGO — Enrichissement sémantique (panneau d'attributs)
// -----------------------------------------------------------------
//  Relie le viewer à l'API REST (mago-enrichment-api) :
//   - au chargement d'un GLB, crée/retrouve un "modèle" en base
//     (nommé d'après le fichier) ;
//   - au clic sur une couche de classe (liste) OU sur le mesh dans la
//     scène 3D, ouvre un panneau listant les attributs de la classe,
//     éditables (modif / ajout / suppression), avec filtre.
//
//  La clé de jointure mesh <-> base est le class_key
//  (ex. "class_009_wall"), porté par chaque mesh dans
//  metadata.magoClassKey (posé dans loaders.ts) et par MeshSubLayer.classKey.
// =================================================================
import type { AbstractMesh, Scene } from '@babylonjs/core';
import { PointerEventTypes } from '@babylonjs/core';
import type { LoadedAsset } from '../types';
import { toast } from '../utils/toast';
import { getToken, getClientModelId } from './clientSession';

const API_BASE: string = (window as any).MAGO_API_BASE ?? 'http://localhost:3001';

interface Attr {
  id: number;
  attr_key: string;
  attr_label: string;
  data_type: 'text' | 'number' | 'enum' | 'bool';
  value: string | null;
  unit: string | null;
  options: string | null;
  position: number;
}
interface ObjInfo {
  id: number;
  object_key: string;
  name: string | null;
  class_key: string;
  display_name: string;
  family: string;
}

interface EmbeddedAttribute {
  key: string;
  label: string;
  type: Attr['data_type'];
  value: string | null;
  unit: string | null;
  options: string | null;
  position: number;
}

interface MagoExtras {
  schemaVersion: 1;
  modelName: string;
  classKey: string;
  sourceClassKey: string;
  displayName: string;
  family: string;
  attributes: EmbeddedAttribute[];
}

let modelId: number | null = null;
let modelName = '';
let currentObject: ObjInfo | null = null;
let currentObjectKey = '';
let currentClassKey = '';
let currentFallbackName = '';
let isBlocked: () => boolean = () => false;
let enabled = false;
let toolSection: HTMLDetailsElement | null = null;
let toolToggle: HTMLInputElement | null = null;

// ---------------------------------------------------------------------
// Client API
// ---------------------------------------------------------------------
async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(token ? { Authorization: 'Bearer ' + token } : {}),
    ...(opts.headers as Record<string, string> | undefined),
  };

  // Ne pas envoyer Content-Type: application/json sur un DELETE sans body :
  // Fastify le refuse comme JSON vide invalide.
  if (opts.body != null && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(API_BASE + path, {
    ...opts,
    headers,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any)?.error ?? (body as any)?.message ?? `HTTP ${res.status}`);
  return body as T;
}

function guessSurveyType(name: string): 'interieur' | 'exterieur' {
  return /ext|exter|facade|façade|toit|drone|outdoor/i.test(name) ? 'exterieur' : 'interieur';
}

async function openObject(
  objectKey: string,
  classKey: string,
  fallbackName: string | undefined,
  instanceSpecific: boolean,
): Promise<void> {
  setEnabled(true);
  ensurePanel();
  showPanel(true);
  setPanelLoading(objectKey, fallbackName);

  if (modelId == null) {
    setPanelError(
      "Aucun modèle actif. Vérifie que l'API (http://localhost:3001) tourne, " +
      'puis recharge le mesh.'
    );
    return;
  }

  try {
    const path = instanceSpecific
      ? `/api/models/${modelId}/objects/by-instance/${encodeURIComponent(objectKey)}?classKey=${encodeURIComponent(classKey)}&name=${encodeURIComponent(fallbackName ?? objectKey)}`
      : `/api/models/${modelId}/objects/by-key/${encodeURIComponent(classKey)}`;
    const data = await api<{ object: ObjInfo; attributes: Attr[] }>(path);
    currentObject = data.object;
    currentObjectKey = objectKey;
    currentClassKey = classKey;
    currentFallbackName = fallbackName ?? objectKey;
    renderAttributes(data.object, data.attributes);
  } catch (e: any) {
    if (String(e.message).includes('inconnue')) {
      setPanelError(`La couche « ${fallbackName ?? objectKey} » n'est pas une classe cataloguée.`);
    } else {
      setPanelError(`Erreur : ${e.message}`);
    }
  }
}

function objectLookupPath(layer: any): string {
  const objectKey = String(layer.classKey ?? '');
  const classKey = String(layer.classId ?? layer.classKey ?? '');
  return `/api/models/${modelId}/objects/by-instance/${encodeURIComponent(objectKey)}?classKey=${encodeURIComponent(classKey)}&name=${encodeURIComponent(layer.instanceName ?? layer.name ?? objectKey)}`;
}

// ---------------------------------------------------------------------
// API publique du module
// ---------------------------------------------------------------------
export const enrichment = {
  /** Crée (ou retrouve) le modèle en base d'après le nom du GLB chargé. */
  async setModelFromFile(fileName: string): Promise<void> {
    const name = fileName.replace(/\.[^.]+$/i, '') || fileName;

    // En mode client, le modèle de référence est celui porté par le jeton de connexion
    // client_access.model_id. Il ne faut surtout pas recréer/retrouver un modèle à
    // partir du nom du GLB, sinon le client peut modifier un autre modèle que celui
    // que tu regardes dans pgAdmin.
    const clientModel = getClientModelId();
    if (clientModel != null && Number.isFinite(clientModel) && clientModel > 0) {
      modelId = clientModel;
      modelName = name;
      console.info(`[enrichment] Mode client : modèle BDD verrouillé sur model_id=${clientModel}.`);
      return;
    }

    try {
      const m = await api<{ id: number; name: string }>('/api/models', {
        method: 'POST',
        body: JSON.stringify({ name, survey_type: guessSurveyType(name) }),
      });
      modelId = m.id;
      modelName = m.name;
    } catch (e) {
      modelId = null;
      console.warn('[enrichment] API injoignable, enrichissement désactivé :', e);
    }
  },

  /** Ouvre le panneau d'attributs partagé par toute une classe. */
  async openForClassKey(classKey: string, fallbackName?: string): Promise<void> {
    return openObject(classKey, classKey, fallbackName, false);
  },

  /** Ouvre le panneau d'attributs d'une instance précise. */
  async openForObjectKey(objectKey: string, classKey: string, fallbackName?: string): Promise<void> {
    return openObject(objectKey, classKey, fallbackName, true);
  },

  /** Supprime l'enregistrement BDD d'une instance précise. */
  async deleteObjectKey(objectKey: string): Promise<void> {
    if (modelId == null) return;
    await api(`/api/models/${modelId}/objects/by-object-key/${encodeURIComponent(objectKey)}`, {
      method: 'DELETE',
    });
    if (currentObjectKey === objectKey) {
      currentObject = null;
      currentObjectKey = '';
      showPanel(false);
    }
  },

  /** Supprime tous les objets/instances BDD appartenant à une classe. */
  async deleteClassKey(classKey: string): Promise<void> {
    if (modelId == null) return;
    await api(`/api/models/${modelId}/objects/by-class/${encodeURIComponent(classKey)}`, {
      method: 'DELETE',
    });
    if (currentClassKey === classKey) {
      currentObject = null;
      currentObjectKey = '';
      currentClassKey = '';
      showPanel(false);
    }
  },

  /**
   * Charge les attributs depuis PostgreSQL et les écrit dans les `extras`
   * glTF de chaque mesh. L'exporteur Babylon les conserve dans le GLB.
   */
  async embedAttributesInAsset(asset: LoadedAsset | null): Promise<void> {
    if (!asset?.meshLayers?.length) return;
    if (modelId == null) {
      throw new Error("Aucun modèle d'enrichissement actif. Recharge le mesh avec l'API démarrée.");
    }

    for (const layer of asset.meshLayers) {
      if (!/^class_(?:m?\d+)(?:_|$)/i.test(layer.classKey)) continue;
      let data: { object: ObjInfo; attributes: Attr[] };
      try {
        data = await api<{ object: ObjInfo; attributes: Attr[] }>(
          objectLookupPath(layer)
        );
      } catch (error) {
        console.warn(`[enrichment] Couche ignorée à l'export : ${layer.classKey}`, error);
        continue;
      }
      const mago: MagoExtras = {
        schemaVersion: 1,
        modelName,
        classKey: data.object.class_key,
        sourceClassKey: layer.classKey,
        displayName: data.object.display_name,
        family: data.object.family,
        attributes: data.attributes.map((a) => ({
          key: a.attr_key,
          label: a.attr_label,
          type: a.data_type,
          value: a.value,
          unit: a.unit,
          options: a.options,
          position: a.position,
        })),
      };

      for (const mesh of layer.meshes) {
        const metadata = { ...(mesh.metadata ?? {}) } as any;
        metadata.magoClassKey = layer.classId ?? layer.classKey;
        metadata.magoObjectKey = layer.classKey;
        metadata.gltf = { ...(metadata.gltf ?? {}), extras: { ...(metadata.gltf?.extras ?? {}), mago } };
        mesh.metadata = metadata;
      }
    }
  },

  /**
   * Relit les attributs embarqués dans un GLB et les recopie dans PostgreSQL.
   * Les valeurs transportées par le fichier sont prioritaires sur les défauts.
   */
  async importEmbeddedAttributes(asset: LoadedAsset | null): Promise<number> {
    if (!asset?.meshLayers?.length || modelId == null) return 0;
    let imported = 0;

    for (const layer of asset.meshLayers) {
      const mago = findMagoExtras(layer.meshes);
      if (!mago?.attributes?.length) continue;

      const data = await api<{ object: ObjInfo; attributes: Attr[] }>(
        objectLookupPath(layer)
      );
      const existing = new Map(data.attributes.map((a) => [a.attr_key, a]));

      for (const embedded of mago.attributes) {
        const attr = existing.get(embedded.key);
        if (attr) {
          // IMPORTANT : la base de données est la source de vérité des VALEURS.
          // Le GLB publié est un instantané figé au moment de la publication : si on
          // repousse `value` ici, chaque rechargement de la scène écrase les
          // modifications faites par le client depuis (ex. smoby -> gabriel qui
          // revenait à smoby). On ne synchronise donc que les métadonnées ;
          // côté serveur, COALESCE préserve la valeur en base quand `value` est absent.
          await api(`/api/attributes/${attr.id}`, {
            method: 'PUT',
            body: JSON.stringify({
              attr_label: embedded.label,
              data_type: embedded.type,
              unit: embedded.unit,
              options: embedded.options,
              position: embedded.position,
            }),
          });
        } else {
          await api(`/api/objects/${data.object.id}/attributes`, {
            method: 'POST',
            body: JSON.stringify({
              attr_key: embedded.key,
              attr_label: embedded.label,
              data_type: embedded.type,
              value: embedded.value ?? '',
              unit: embedded.unit,
              options: embedded.options,
              position: embedded.position,
            }),
          });
        }
        imported++;
      }
    }
    return imported;
  },

  close(): void {
    showPanel(false);
  },

  setEnabled(value: boolean): void {
    setEnabled(value);
  },

  isEnabled(): boolean {
    return enabled;
  },

  getModelInfo(): { id: number | null; name: string } {
    return { id: modelId, name: modelName };
  },
};

// ---------------------------------------------------------------------
// Init : panneau DOM + picking 3D
// ---------------------------------------------------------------------
export function initEnrichment(
  scene: Scene,
  opts: { isInteractionBlocked?: () => boolean } = {}
): void {
  isBlocked = opts.isInteractionBlocked ?? (() => false);
  injectStyles();
  toolSection = document.getElementById('enrichment-tool-section') as HTMLDetailsElement | null;
  toolToggle = document.getElementById('toggle-enrichment') as HTMLInputElement | null;
  toolToggle?.addEventListener('change', () => setEnabled(toolToggle!.checked));
  setEnabled(false);
  ensurePanel();

  scene.onPointerObservable.add((pi) => {
    if (!enabled) return;
    if (pi.type !== PointerEventTypes.POINTERTAP) return;
    if (isBlocked()) return; // un autre outil (mesure, alignement, éditeur) est actif
    const pick = pi.pickInfo;
    if (!pick?.hit || !pick.pickedMesh) return;
    const metadata = (pick.pickedMesh.metadata as any) ?? {};
    const objectKey = metadata.magoObjectKey as string | undefined;
    const classKey = metadata.magoClassKey as string | undefined;
    if (objectKey && classKey) void enrichment.openForObjectKey(objectKey, classKey, objectKey);
    else if (classKey) void enrichment.openForClassKey(classKey);
  });
}

function setEnabled(value: boolean): void {
  enabled = value;
  if (toolToggle) toolToggle.checked = value;
  toolSection?.classList.toggle('enrichment-enabled', value);
  if (value && toolSection) toolSection.open = true;
  if (!value) {
    currentObject = null;
    showPanel(false);
  }
}

// ---------------------------------------------------------------------
// Métadonnées GLB
// ---------------------------------------------------------------------
function readMagoExtras(mesh: AbstractMesh): MagoExtras | null {
  const metadata = (mesh.metadata ?? {}) as any;
  const candidates = [
    metadata?.gltf?.extras?.mago,
    metadata?.extras?.mago,
    metadata?.mago,
    metadata?.gltf?.extras,
  ];
  for (const value of candidates) {
    if (value && value.schemaVersion === 1 && Array.isArray(value.attributes)) return value as MagoExtras;
  }
  return null;
}

function findMagoExtras(meshes: AbstractMesh[]): MagoExtras | null {
  for (const mesh of meshes) {
    const found = readMagoExtras(mesh);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------
// Panneau (DOM)
// ---------------------------------------------------------------------
let panel: HTMLElement | null = null;

function ensurePanel(): void {
  if (panel) return;
  const host = document.getElementById('enrichment-tool-content');
  if (!host) return;
  host.innerHTML = '';
  panel = document.createElement('div');
  panel.id = 'mago-enrich-panel';
  panel.innerHTML = `
    <div class="me-head">
      <div>
        <div class="me-title" id="me-title">Attributs</div>
        <div class="me-sub" id="me-sub"></div>
        <div class="me-tech" id="me-tech"></div>
      </div>
      <button class="me-close" id="me-close" title="Fermer">×</button>
    </div>
    <div class="me-filter">
      <input id="me-search" type="text" placeholder="Filtrer les attributs…" />
    </div>
    <div class="me-body" id="me-body"></div>
    <div class="me-add">
      <div class="me-add-title">Ajouter un attribut</div>
      <div class="me-add-row">
        <input id="me-add-label" type="text" placeholder="Libellé (ex. Résistance au feu)" />
        <select id="me-add-type">
          <option value="text">Texte</option>
          <option value="number">Nombre</option>
          <option value="bool">Oui/Non</option>
        </select>
      </div>
      <div class="me-add-row">
        <input id="me-add-value" type="text" placeholder="Valeur" />
        <input id="me-add-unit" type="text" placeholder="Unité" class="me-unit-in" />
        <button class="me-btn me-btn-accent" id="me-add-btn">+</button>
      </div>
    </div>
  `;
  host.appendChild(panel);

  panel.querySelector('#me-close')!.addEventListener('click', () => showPanel(false));
  (panel.querySelector('#me-search') as HTMLInputElement).addEventListener('input', applyFilter);
  panel.querySelector('#me-add-btn')!.addEventListener('click', onAddAttribute);
}

function showPanel(v: boolean): void {
  ensurePanel();
  if (!panel) return;
  panel.classList.toggle('open', v);
  if (v && toolSection) toolSection.open = true;
}


function isClientView(): boolean {
  return !!getToken() || getClientModelId() != null || document.body.classList.contains('client-mode');
}

function isTechnicalName(v: string | null | undefined): boolean {
  if (!v) return true;
  return /^class_\d+_/i.test(v) || /_inst_\d+/i.test(v) || /^[a-z0-9_]+$/i.test(v);
}

function cleanObjectTitle(obj: ObjInfo): string {
  const fallback = currentFallbackName?.trim();
  if (fallback && !isTechnicalName(fallback)) return fallback;
  if (obj.name && !isTechnicalName(obj.name)) return obj.name;
  return obj.display_name || obj.class_key || obj.object_key;
}

function cleanObjectSubtitle(obj: ObjInfo): string {
  const title = cleanObjectTitle(obj);
  if (obj.display_name && obj.display_name !== title) return obj.display_name;
  if (obj.name && !isTechnicalName(obj.name) && obj.name !== title) return obj.name;
  return 'Objet sélectionné';
}

function renderPanelHeader(obj: ObjInfo): void {
  const titleEl = panel!.querySelector('#me-title') as HTMLElement;
  const subEl = panel!.querySelector('#me-sub') as HTMLElement;
  const techEl = panel!.querySelector('#me-tech') as HTMLElement | null;

  titleEl.textContent = cleanObjectTitle(obj);
  subEl.textContent = cleanObjectSubtitle(obj);

  // Côté client : aucune information technique.
  if (isClientView()) {
    if (techEl) techEl.innerHTML = '';
    return;
  }

  // Côté admin : informations de diagnostic, mais repliées et discrètes.
  if (techEl) {
    techEl.innerHTML = `
      <details class="me-tech-details">
        <summary>Détails techniques</summary>
        <div class="me-tech-body">
          <div>Modèle BDD #${modelId ?? '—'}${modelName ? ` · ${escape(modelName)}` : ''}</div>
          <div>Objet BDD #${obj.id}</div>
          <div>Clé objet : ${escape(obj.object_key)}</div>
          <div>Classe : ${escape(obj.class_key)}</div>
        </div>
      </details>
    `;
  }
}


function setPanelLoading(classKey: string, name?: string): void {
  const title = name && !isTechnicalName(name) ? name : 'Objet sélectionné';
  (panel!.querySelector('#me-title') as HTMLElement).textContent = title;
  (panel!.querySelector('#me-sub') as HTMLElement).textContent = isClientView() ? '' : classKey;
  const tech = panel!.querySelector('#me-tech') as HTMLElement | null;
  if (tech) tech.innerHTML = '';
  (panel!.querySelector('#me-body') as HTMLElement).innerHTML = '<div class="me-msg">Chargement…</div>';
}

function setPanelError(msg: string): void {
  (panel!.querySelector('#me-body') as HTMLElement).innerHTML = `<div class="me-msg me-err">${escape(msg)}</div>`;
}

function renderAttributes(obj: ObjInfo, attrs: Attr[]): void {
  renderPanelHeader(obj);

  const body = panel!.querySelector('#me-body') as HTMLElement;
  body.innerHTML = '';
  if (attrs.length === 0) {
    body.innerHTML = '<div class="me-msg">Aucun attribut. Ajoute-en un ci-dessous.</div>';
    return;
  }

  for (const a of attrs) {
    const row = document.createElement('div');
    row.className = 'me-row';
    row.dataset.search = `${a.attr_label} ${a.attr_key}`.toLowerCase();

    const label = document.createElement('label');
    label.className = 'me-label';
    label.textContent = a.attr_label;

    const field = document.createElement('div');
    field.className = 'me-field';
    field.appendChild(buildInput(a));
    if (a.unit) {
      const u = document.createElement('span');
      u.className = 'me-unit';
      u.textContent = a.unit;
      field.appendChild(u);
    }
    const del = document.createElement('button');
    del.className = 'me-del';
    del.title = 'Supprimer cet attribut';
    del.textContent = 'Suppr.';
    del.addEventListener('click', () => onDeleteAttribute(a, row));
    field.appendChild(del);

    row.appendChild(label);
    row.appendChild(field);
    body.appendChild(row);
  }
  applyFilter();
}

function buildInput(a: Attr): HTMLElement {
  let el: HTMLInputElement | HTMLSelectElement;
  if (a.data_type === 'enum' && a.options) {
    const sel = document.createElement('select');
    for (const opt of a.options.split(',').map((s) => s.trim())) {
      const o = document.createElement('option');
      o.value = opt; o.textContent = opt;
      if (opt === a.value) o.selected = true;
      sel.appendChild(o);
    }
    el = sel;
  } else if (a.data_type === 'bool') {
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.checked = a.value === 'true' || a.value === '1';
    el = inp;
  } else {
    const inp = document.createElement('input');
    inp.type = a.data_type === 'number' ? 'number' : 'text';
    inp.value = a.value ?? '';
    el = inp;
  }
  el.className = 'me-input';

  let lastSaved = a.data_type === 'bool'
    ? String(a.value === 'true' || a.value === '1')
    : (a.value ?? '');
  let saveTimer: number | null = null;
  let saving = false;

  const readValue = () =>
    a.data_type === 'bool'
      ? String((el as HTMLInputElement).checked)
      : (el as HTMLInputElement).value;

  const commit = async (force = false) => {
    if (saveTimer != null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    const value = readValue();
    if (!force && value === lastSaved) return;
    if (saving) return;
    saving = true;
    const ok = await saveValue(a.id, value, el);
    saving = false;
    if (ok) {
      lastSaved = value;
      a.value = value;
    }
  };

  // Select/checkbox : sauvegarde immédiate.
  el.addEventListener('change', () => { void commit(true); });

  // Texte/nombre : sauvegarde automatique pendant la saisie + sauvegarde forcée au blur.
  // Comme ça, le client n'a pas besoin de penser à cliquer ailleurs pour pousser la BDD.
  if (el.tagName === 'INPUT' && a.data_type !== 'bool') {
    el.addEventListener('input', () => {
      if (saveTimer != null) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => { void commit(false); }, 650);
    });
    el.addEventListener('blur', () => { void commit(true); });
    el.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') {
        ev.preventDefault();
        void commit(true);
        (el as HTMLInputElement).blur();
      }
    });
  }
  return el;
}

// ---------------------------------------------------------------------
// Actions API
// ---------------------------------------------------------------------
async function saveValue(attrId: number, value: string, el: HTMLElement): Promise<boolean> {
  try {
    await api(`/api/attributes/${attrId}`, { method: 'PUT', body: JSON.stringify({ value }) });
    flash(el, 'ok');
    el.title = 'Sauvegardé en base';
    return true;
  } catch (e: any) {
    flash(el, 'err');
    el.title = 'Erreur de sauvegarde : ' + (e?.message ?? e);
    toast('Attribut non sauvegardé en base : ' + (e?.message ?? e), 'error', 6000);
    console.error('[enrichment] save', e);
    return false;
  }
}

async function onAddAttribute(): Promise<void> {
  if (!currentObject) return;
  const labelEl = panel!.querySelector('#me-add-label') as HTMLInputElement;
  const typeEl = panel!.querySelector('#me-add-type') as HTMLSelectElement;
  const valueEl = panel!.querySelector('#me-add-value') as HTMLInputElement;
  const unitEl = panel!.querySelector('#me-add-unit') as HTMLInputElement;

  const label = labelEl.value.trim();
  if (!label) { labelEl.focus(); return; }
  const attr_key = label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

  try {
    await api(`/api/objects/${currentObject.id}/attributes`, {
      method: 'POST',
      body: JSON.stringify({
        attr_key, attr_label: label, data_type: typeEl.value,
        value: valueEl.value || null, unit: unitEl.value || null,
      }),
    });
    labelEl.value = ''; valueEl.value = ''; unitEl.value = '';
    await enrichment.openForObjectKey(currentObjectKey, currentClassKey, currentFallbackName || currentObject.display_name);
  } catch (e: any) {
    alert(e.message === 'Cet attribut existe déjà pour cet objet'
      ? 'Un attribut avec ce libellé existe déjà.'
      : `Erreur : ${e.message}`);
  }
}

async function onDeleteAttribute(attr: Attr, row: HTMLElement): Promise<void> {
  const label = attr.attr_label || attr.attr_key || `#${attr.id}`;
  if (!confirm(`Supprimer l'attribut « ${label} » ?\n\nCette suppression sera enregistrée en base de données.`)) {
    return;
  }

  try {
    const deleted = await api<any>(`/api/attributes/${attr.id}`, { method: 'DELETE' });
    row.remove();
    const detail = deleted?.deleted?.id && !isClientView() ? ` #${deleted.deleted.id}` : '';
    toast(`Attribut supprimé${detail} : ${label}`, 'success', 3500);

    if (currentObject) {
      await enrichment.openForObjectKey(currentObjectKey, currentClassKey, currentFallbackName || currentObject.display_name);
    }
  } catch (e: any) {
    console.error('[enrichment] delete', e);
    toast('Attribut non supprimé : ' + (e?.message ?? e), 'error', 6000);
  }
}

// ---------------------------------------------------------------------
// Filtre + petits helpers UI
// ---------------------------------------------------------------------
function applyFilter(): void {
  const term = (panel!.querySelector('#me-search') as HTMLInputElement).value.trim().toLowerCase();
  panel!.querySelectorAll<HTMLElement>('.me-row').forEach((r) => {
    r.style.display = !term || (r.dataset.search ?? '').includes(term) ? '' : 'none';
  });
}

function flash(el: HTMLElement, kind: 'ok' | 'err'): void {
  el.classList.remove('me-flash-ok', 'me-flash-err');
  void el.offsetWidth; // reflow pour rejouer l'animation
  el.classList.add(kind === 'ok' ? 'me-flash-ok' : 'me-flash-err');
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// ---------------------------------------------------------------------
// Styles (injectés pour ne pas toucher global.css)
// ---------------------------------------------------------------------
function injectStyles(): void {
  if (document.getElementById('mago-enrich-styles')) return;
  const css = `
  #mago-enrich-panel{display:none;flex-direction:column;color:var(--text-0,#e8eaed);font:11px/1.35 'Inter',system-ui,sans-serif;}
  #mago-enrich-panel.open{display:flex;}
  #mago-enrich-panel .me-head{display:flex;align-items:flex-start;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line,rgba(255,255,255,.07));}
  #mago-enrich-panel .me-title{font-weight:700;font-size:11px;color:var(--text-0);}
  #mago-enrich-panel .me-sub{font-size:9px;color:var(--text-2,#7a8089);margin-top:2px;word-break:normal;}
  #mago-enrich-panel .me-tech{margin-top:4px;}
  #mago-enrich-panel .me-tech-details{font-size:9px;color:var(--text-2,#7a8089);}
  #mago-enrich-panel .me-tech-details summary{cursor:pointer;user-select:none;color:var(--text-2,#7a8089);}
  #mago-enrich-panel .me-tech-body{margin-top:4px;padding:5px 6px;border:1px solid var(--line,rgba(255,255,255,.07));border-radius:5px;background:rgba(255,255,255,.025);word-break:break-all;}
  #mago-enrich-panel .me-close{background:none;border:none;color:var(--text-2);font-size:18px;line-height:1;cursor:pointer;padding:0 2px;}
  #mago-enrich-panel .me-close:hover{color:var(--text-0);}
  #mago-enrich-panel .me-filter{padding:7px 0 4px;}
  #mago-enrich-panel .me-filter input{width:100%;box-sizing:border-box;background:var(--bg-2,#1c1f24);border:1px solid var(--line,rgba(255,255,255,.07));border-radius:5px;color:var(--text-0);padding:5px 6px;font-size:10px;}
  #mago-enrich-panel .me-body{max-height:250px;overflow-y:auto;padding:4px 1px 6px;}
  #mago-enrich-panel .me-row{margin-bottom:7px;}
  #mago-enrich-panel .me-label{display:block;font-size:9.5px;color:var(--text-1,#b8bcc4);margin-bottom:2px;}
  #mago-enrich-panel .me-field{display:flex;align-items:center;gap:4px;}
  #mago-enrich-panel .me-input{flex:1;min-width:0;background:var(--bg-2,#1c1f24);border:1px solid var(--line,rgba(255,255,255,.07));border-radius:5px;color:var(--text-0);padding:5px 6px;font-size:10px;transition:border-color .15s,background .3s;}
  #mago-enrich-panel input[type=checkbox].me-input{flex:0 0 auto;width:14px;height:14px;}
  #mago-enrich-panel .me-input:focus{outline:none;border-color:var(--accent,#7dd3c0);}
  #mago-enrich-panel .me-unit{font-size:9px;color:var(--text-2);min-width:14px;}
  #mago-enrich-panel .me-del{background:rgba(244,138,138,.10);border:1px solid rgba(244,138,138,.45);border-radius:5px;color:var(--danger,#f48a8a);cursor:pointer;font-size:9px;font-weight:700;padding:4px 6px;white-space:nowrap;}
  #mago-enrich-panel .me-del:hover{background:rgba(244,138,138,.18);border-color:rgba(244,138,138,.75);}
  #mago-enrich-panel .me-msg{color:var(--text-2);font-size:10px;padding:8px 1px;}
  #mago-enrich-panel .me-msg.me-err{color:var(--danger,#f48a8a);}
  #mago-enrich-panel .me-add{border-top:1px solid var(--line,rgba(255,255,255,.07));padding:7px 0 0;}
  #mago-enrich-panel .me-add-title{font-size:9px;color:var(--text-2);margin-bottom:5px;text-transform:uppercase;letter-spacing:.04em;}
  #mago-enrich-panel .me-add-row{display:flex;gap:4px;margin-bottom:4px;}
  #mago-enrich-panel .me-add-row input,#mago-enrich-panel .me-add-row select{flex:1;min-width:0;background:var(--bg-2,#1c1f24);border:1px solid var(--line,rgba(255,255,255,.07));border-radius:5px;color:var(--text-0);padding:5px 6px;font-size:10px;}
  #mago-enrich-panel .me-add-row .me-unit-in{flex:0 0 48px;}
  #mago-enrich-panel .me-btn{flex:0 0 auto;border:none;border-radius:5px;cursor:pointer;padding:4px 9px;font-size:12px;font-weight:700;}
  #mago-enrich-panel .me-btn-accent{background:var(--accent,#7dd3c0);color:#06201b;}
  #mago-enrich-panel .me-flash-ok{animation:meOk .6s ease;}
  #mago-enrich-panel .me-flash-err{animation:meErr .6s ease;border-color:var(--danger,#f48a8a)!important;}
  @keyframes meOk{0%{background:var(--accent-dim,rgba(125,211,192,.16));}100%{background:var(--bg-2,#1c1f24);}}
  @keyframes meErr{0%,100%{background:var(--bg-2,#1c1f24);}25%,75%{background:rgba(244,138,138,.18);}}
  `;
  const style = document.createElement('style');
  style.id = 'mago-enrich-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

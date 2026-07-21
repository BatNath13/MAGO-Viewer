/**
 * MAGO Viewer · clientSession.ts
 * ==============================
 * Session du client final : authentification (login) + récupération de la scène
 * hébergée côté serveur, le tout derrière le jeton d'accès.
 *
 * Le jeton est conservé en sessionStorage (effacé à la fermeture de l'onglet).
 * `getToken()` est aussi consommé par enrichment.ts pour signer ses requêtes API.
 */

// En mode client, la page est servie par l'API elle-même → même origine.
const API_BASE: string = (window as any).MAGO_API_BASE ?? '';
const TOKEN_KEY = 'mago_client_token';
const EXPIRES_KEY = 'mago_client_expires_at';
const MODEL_KEY = 'mago_client_model_id';

export function getToken(): string | null {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function setToken(t: string | null): void {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* sessionStorage indisponible */ }
}
function setExpiresAt(expiresAt: string | null): void {
  try {
    if (expiresAt) sessionStorage.setItem(EXPIRES_KEY, expiresAt);
    else sessionStorage.removeItem(EXPIRES_KEY);
  } catch { /* sessionStorage indisponible */ }
}
export function getExpiresAt(): string | null {
  try { return sessionStorage.getItem(EXPIRES_KEY); } catch { return null; }
}
function setModelId(id: number | null): void {
  try {
    if (id != null) sessionStorage.setItem(MODEL_KEY, String(id));
    else sessionStorage.removeItem(MODEL_KEY);
  } catch { /* sessionStorage indisponible */ }
}
/** model_id du compte client (renvoyé au login). Utilisé par l'enrichissement en mode client. */
export function getClientModelId(): number | null {
  try {
    const v = sessionStorage.getItem(MODEL_KEY);
    return v != null ? Number(v) : null;
  } catch { return null; }
}
export function isLoggedIn(): boolean { return !!getToken(); }
export function logout(): void { setToken(null); setExpiresAt(null); setModelId(null); }

/** Authentifie le client. Lève une erreur lisible si l'accès est refusé/expiré. */
export async function login(username: string, password: string): Promise<{ model_id: number; expires_at: string | null }> {
  const res = await fetch(API_BASE + '/api/client/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json().catch(() => ({} as any));
  if (!res.ok) throw new Error(body?.error ?? 'Connexion refusée.');
  setToken(body.token);
  setExpiresAt(body.expires_at ?? null);
  setModelId(body.model_id ?? null);
  return { model_id: body.model_id, expires_at: body.expires_at ?? null };
}

/** fetch avec le jeton client en en-tête (routes protégées). */
export async function authedFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(opts.headers ?? {});
  if (token) headers.set('Authorization', 'Bearer ' + token);
  return fetch(API_BASE + path, { ...opts, headers });
}

export interface SceneManifest {
  name?: string;
  mesh?: string | null;
  splat?: string | null;
  cloud?: string | null;
  /** Mesh publié en mode « arrière-plan » : invisible mais sélectionnable, figé côté client. */
  meshBackground?: boolean;
}


/** Vérifie que le jeton est toujours actif et récupère l'expiration actuelle en base. */
export async function fetchSession(): Promise<{ model_id: number; expires_at: string | null }> {
  const res = await authedFetch('/api/client/session');
  const body = await res.json().catch(() => ({} as any));
  if (!res.ok) {
    logout();
    throw new Error(body?.error ?? 'Session expirée — reconnecte-toi.');
  }
  setExpiresAt(body.expires_at ?? null);
  return { model_id: body.model_id, expires_at: body.expires_at ?? null };
}

/** Manifeste de la scène du compte (quels fichiers charger). */
export async function fetchManifest(): Promise<SceneManifest> {
  const res = await authedFetch('/api/client/scene/manifest');
  if (res.status === 401 || res.status === 403) {
    logout();
    throw new Error('Session expirée — reconnecte-toi.');
  }
  if (!res.ok) throw new Error('Scène indisponible pour ce compte.');
  return res.json();
}

/**
 * Récupère un fichier de la scène et le renvoie en File (réutilisable par handleFile).
 * - `displayName` : nom visible côté client (remplace le nom de fichier interne),
 *   l'extension d'origine est conservée pour que le loader reconnaisse le format.
 * - `onProgress`  : (octets reçus, octets totaux) → alimente la barre de chargement.
 */
export async function fetchSceneFile(
  name: string,
  displayName?: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<File> {
  const res = await authedFetch('/api/client/scene/file/' + encodeURIComponent(name));
  if (!res.ok) throw new Error('Fichier de scène indisponible : ' + name);

  const total = Number(res.headers.get('content-length') || 0);
  let blob: Blob;
  if (res.body && onProgress) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.length;
        onProgress(loaded, total);
      }
    }
    blob = new Blob(chunks as BlobPart[]);
  } else {
    blob = await res.blob();
  }

  let fname = name;
  if (displayName && displayName.trim()) {
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot) : '';
    const base = displayName.trim().replace(/\.[^.]+$/, '');
    fname = base + ext;
  }
  return new File([blob], fname);
}

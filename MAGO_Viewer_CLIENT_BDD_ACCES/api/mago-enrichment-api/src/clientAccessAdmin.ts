/**
 * Routes locales de gestion des accès client depuis le viewer éditeur.
 *
 * Ces routes sont prévues pour ton poste / réseau interne : elles permettent
 * au bouton « Créer vue client » de remplir directement la base séparée
 * mago_access.client_access.
 */
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { one } from './db.ts';
import { aq, aone } from './accessDb.ts';

const STORAGE_DIR = normalize(process.env.STORAGE_DIR ?? join(process.cwd(), 'storage'));
const PUBLIC_URL_FILE = normalize(process.env.CLIENT_PUBLIC_URL_FILE ?? join(process.cwd(), '.client_public_url'));
const DEFAULT_PUBLIC_BASE_URL = (process.env.CLIENT_PUBLIC_BASE_URL ?? process.env.CLIENT_PUBLIC_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
const EXPIRY_TIMEZONE = process.env.CLIENT_EXPIRY_TIMEZONE ?? 'Europe/Paris';
const CLIENT_SCENE_UPLOAD_LIMIT_BYTES = Number(process.env.CLIENT_SCENE_UPLOAD_LIMIT_BYTES ?? 2_000_000_000);
const LOCAL_VIEWER_URL = (process.env.CLIENT_LOCAL_VIEWER_URL ?? 'http://localhost:3001').replace(/\/+$/, '');

let tunnelProcess: ChildProcessWithoutNullStreams | null = null;
let tunnelPublicBaseUrl: string | null = null;
let tunnelStartPromise: Promise<string> | null = null;

function looksLikeTryCloudflareUrl(s: string): string | null {
  const m = String(s).match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
  return m ? m[0].replace(/\/+$/, '') : null;
}

async function pathExists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

async function findCloudflaredExecutable(): Promise<string> {
  const localApp = process.env.LOCALAPPDATA ?? '';
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const candidates = [
    process.env.CLOUDFLARED_EXE,
    localApp ? join(localApp, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe') : '',
    join(programFiles, 'cloudflared', 'cloudflared.exe'),
    join(programFilesX86, 'cloudflared', 'cloudflared.exe'),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }

  // Dernier recours : cloudflared est peut-être dans le PATH de la session API.
  return 'cloudflared';
}

function isTunnelProcessAlive(): boolean {
  return !!tunnelProcess && tunnelProcess.exitCode === null && !tunnelProcess.killed;
}

async function ensurePublicTunnel(): Promise<string> {
  if (isTunnelProcessAlive() && tunnelPublicBaseUrl) return tunnelPublicBaseUrl;
  if (tunnelStartPromise) return tunnelStartPromise;

  tunnelStartPromise = new Promise<string>(async (resolve, reject) => {
    let resolved = false;
    const doneOk = async (url: string) => {
      if (resolved) return;
      resolved = true;
      tunnelPublicBaseUrl = url;
      await writeFile(PUBLIC_URL_FILE, url, 'utf-8').catch(() => {});
      // Les tunnels "quick" de Cloudflare changent d'URL a CHAQUE redemarrage :
      // tous les liens client stockes en base deviennent morts. On les regenere
      // donc systematiquement sur la nouvelle URL. Un lien deja envoye reste
      // irrecuperable (l'ancien domaine n'existe plus) : il faut renvoyer le
      // lien a jour, visible dans admin.html ou via "Creer vue client".
      try {
        const updated = await aq(
          `UPDATE client_access
              SET lien_client = $1 || '/?client=1&m=' || model_id::text,
                  updated_at = now()
            WHERE lien_client IS DISTINCT FROM ($1 || '/?client=1&m=' || model_id::text)
            RETURNING id`,
          [url]
        );
        if (updated.length > 0) {
          console.log(`[tunnel] URL publique ${url} : ${updated.length} lien(s) client regenere(s).`);
        }
      } catch (e) {
        console.warn('[tunnel] Regeneration des liens client impossible :', e);
      }
      clearTimeout(timer);
      tunnelStartPromise = null;
      resolve(url);
    };
    const doneErr = (err: Error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      tunnelStartPromise = null;
      reject(err);
    };

    const timer = setTimeout(() => {
      doneErr(new Error('Tunnel Cloudflare démarré trop lentement. Réessaie dans quelques secondes.'));
    }, 45_000);

    try {
      const exe = await findCloudflaredExecutable();
      const child = spawn(exe, ['tunnel', '--url', LOCAL_VIEWER_URL], {
        cwd: process.cwd(),
        env: process.env,
        windowsHide: false,
      });
      tunnelProcess = child;

      const onData = (buf: Buffer) => {
        const text = buf.toString('utf-8');
        const url = looksLikeTryCloudflareUrl(text);
        if (url) void doneOk(url);
      };

      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (e) => {
        doneErr(new Error(`Impossible de lancer cloudflared : ${e.message}`));
      });
      child.on('exit', (code) => {
        tunnelProcess = null;
        if (!resolved) {
          doneErr(new Error(`cloudflared s'est arrêté avant de fournir une URL publique (code ${code ?? 'inconnu'}).`));
        }
      });
    } catch (e: any) {
      doneErr(new Error(e?.message ?? String(e)));
    }
  });

  return tunnelStartPromise;
}

async function readAutoPublicBaseUrl(): Promise<string> {
  try {
    const raw = (await readFile(PUBLIC_URL_FILE, 'utf-8')).trim().replace(/\/+$/, '');
    if (raw) return raw;
  } catch {}
  return DEFAULT_PUBLIC_BASE_URL;
}

function modelStorageDir(modelId: number): string {
  return normalize(join(STORAGE_DIR, 'models', String(modelId)));
}

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const p: Record<string, string> = {};
  for (const part of parts) if (part.type !== 'literal') p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

function timeZoneOffsetMs(dateUtc: Date, timeZone: string): number {
  const p = zonedParts(dateUtc, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - dateUtc.getTime();
}

function localZonedToIso(y: number, mo: number, d: number, h: number, mi: number, sec: number, timeZone: string): string {
  const wanted = Date.UTC(y, mo - 1, d, h, mi, sec);
  let utc = wanted - timeZoneOffsetMs(new Date(wanted), timeZone);
  utc = wanted - timeZoneOffsetMs(new Date(utc), timeZone);
  const out = new Date(utc);
  const check = zonedParts(out, timeZone);
  if (
    check.year !== y || check.month !== mo || check.day !== d ||
    check.hour !== h || check.minute !== mi || check.second !== sec
  ) {
    throw new Error(`Expiration impossible dans le fuseau ${timeZone}. Choisis une autre minute.`);
  }
  return out.toISOString();
}

export function parseClientExpiry(s?: string | null): string | null {
  if (!s) return null;
  const raw = String(s).trim();
  if (!raw || /^(never|jamais|null|none)$/i.test(raw)) return null;

  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const h = m[4] == null ? 23 : Number(m[4]);
    const mi = m[5] == null ? 59 : Number(m[5]);
    const sec = m[6] == null ? 59 : Number(m[6]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) {
      throw new Error(`Expiration invalide : ${s}`);
    }
    return localZonedToIso(y, mo, d, h, mi, sec, EXPIRY_TIMEZONE);
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  throw new Error(`Expiration invalide : ${s}. Exemple : "2026-08-30 18:45"`);
}

function sanitizePublicBaseUrl(raw?: string | null): string {
  const candidate = String(raw ?? '').trim() || DEFAULT_PUBLIC_BASE_URL;
  const clean = candidate.replace(/\/+$/, '');
  try {
    const u = new URL(clean);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
    return clean;
  } catch {
    throw new Error('Adresse publique invalide. Exemple : https://xxxxx.trycloudflare.com');
  }
}

function makeClientLink(modelId: number, publicBaseUrl?: string | null): string {
  const base = sanitizePublicBaseUrl(publicBaseUrl);
  return `${base}/?client=1&m=${encodeURIComponent(String(modelId))}`;
}

export function registerClientAccessAdmin(app: FastifyInstance): void {
  app.addContentTypeParser(['model/gltf-binary', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: CLIENT_SCENE_UPLOAD_LIMIT_BYTES }, (_req, body, done) => {
    done(null, body);
  });

  app.get('/api/admin/client-access/config', async () => {
    return {
      public_base_url: await readAutoPublicBaseUrl(),
      access_database: process.env.ACCESS_PGDATABASE ?? 'mago_access',
      enrichment_database: process.env.PGDATABASE ?? 'mago_enrichment',
      public_url_file: PUBLIC_URL_FILE,
      local_viewer_url: LOCAL_VIEWER_URL,
      tunnel_running: isTunnelProcessAlive(),
    };
  });

  app.post('/api/admin/public-tunnel/ensure', async (_req, reply) => {
    try {
      const url = await ensurePublicTunnel();
      return {
        ok: true,
        public_base_url: url,
        lien_base: url,
        public_url_file: PUBLIC_URL_FILE,
        local_viewer_url: LOCAL_VIEWER_URL,
        tunnel_running: isTunnelProcessAlive(),
      };
    } catch (e: any) {
      return reply.code(500).send({
        ok: false,
        error: e?.message ?? String(e),
        hint: 'Vérifie que cloudflared est installé avec winget install Cloudflare.cloudflared, puis relance MAGO Viewer.',
      });
    }
  });

  app.post<{
    Querystring: { model_id?: string; name?: string; mesh_background?: string };
    Body: Buffer;
  }>('/api/admin/client-scene/publish', { bodyLimit: CLIENT_SCENE_UPLOAD_LIMIT_BYTES }, async (req, reply) => {
    const modelId = Number(req.query?.model_id);
    const sceneName = String(req.query?.name ?? 'Vue client MAGO').trim() || 'Vue client MAGO';
    // Mode « arrière-plan » du mesh (invisible mais sélectionnable côté client),
    // figé dans le manifeste : le viewer client l'applique et ne l'expose pas.
    const meshBackground = String(req.query?.mesh_background ?? '') === '1';
    if (!Number.isFinite(modelId) || modelId <= 0) return reply.code(400).send({ error: 'model_id invalide.' });

    const model = await one<{ id: number }>('SELECT id FROM model WHERE id = $1', [modelId]);
    if (!model) return reply.code(400).send({ error: `Modèle ${modelId} inexistant dans mago_enrichment.` });

    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 12) {
      return reply.code(400).send({ error: 'Aucun GLB reçu pour publier la scène client.' });
    }

    const dir = modelStorageDir(modelId);
    await mkdir(dir, { recursive: true });
    const meshName = 'client_scene_mesh.glb';
    // La publication du mesh REINITIALISE le manifeste : les splats / nuage sont
    // (re)poussés juste après par le viewer via /publish-asset s'ils sont présents
    // dans la scène. Une scène sans splats ne garde donc pas un vieux PLY orphelin.
    const manifest = {
      name: sceneName,
      mesh: meshName,
      meshBackground,
      splat: null,
      cloud: null,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(join(dir, meshName), buf);
    await writeFile(join(dir, 'scene.json'), JSON.stringify(manifest, null, 2), 'utf-8');

    return reply.code(201).send({ ok: true, bytes: buf.length, dir, manifest });
  });

  // Publication d'un asset complémentaire de la scène client : splats ou nuage.
  // Appelé par le viewer juste après la publication du mesh.
  app.post<{
    Querystring: { model_id?: string; kind?: string; filename?: string };
    Body: Buffer;
  }>('/api/admin/client-scene/publish-asset', { bodyLimit: CLIENT_SCENE_UPLOAD_LIMIT_BYTES }, async (req, reply) => {
    const modelId = Number(req.query?.model_id);
    const kind = String(req.query?.kind ?? '').trim();
    if (!Number.isFinite(modelId) || modelId <= 0) return reply.code(400).send({ error: 'model_id invalide.' });
    if (kind !== 'splat' && kind !== 'cloud') return reply.code(400).send({ error: "kind doit valoir 'splat' ou 'cloud'." });

    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 16) {
      return reply.code(400).send({ error: `Aucun fichier reçu pour publier (${kind}).` });
    }

    // Extension d'origine conservée pour que le loader client reconnaisse le format.
    const rawName = String(req.query?.filename ?? '').trim();
    const extMatch = rawName.match(/\.([A-Za-z0-9]{1,5})$/);
    const ext = (extMatch ? extMatch[1] : 'ply').toLowerCase();
    const fileName = kind === 'splat' ? `client_scene_splats.${ext}` : `client_scene_cloud.${ext}`;

    const dir = modelStorageDir(modelId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, fileName), buf);

    // Fusion dans le manifeste existant (créé par la publication du mesh).
    let manifest: any = {};
    try { manifest = JSON.parse(await readFile(join(dir, 'scene.json'), 'utf-8')); } catch {}
    manifest[kind] = fileName;
    manifest.updatedAt = new Date().toISOString();
    await writeFile(join(dir, 'scene.json'), JSON.stringify(manifest, null, 2), 'utf-8');

    return reply.code(201).send({ ok: true, bytes: buf.length, file: fileName, manifest });
  });

  app.get('/api/admin/client-access', async () => {
    return aq(
      `SELECT id, lien_client, identifiant, mot_de_passe, model_id, active, date_expiration,
              CASE
                WHEN active = false THEN 'désactivé'
                WHEN date_expiration IS NOT NULL AND date_expiration <= now() THEN 'expiré'
                ELSE 'actif'
              END AS etat,
              created_at, updated_at
         FROM client_access
        ORDER BY id DESC`
    );
  });

  app.post<{
    Body: {
      model_id?: number | string;
      identifiant?: string;
      mot_de_passe?: string;
      date_expiration?: string | null;
      public_base_url?: string | null;
      active?: boolean;
    };
  }>('/api/admin/client-access', async (req, reply) => {
    const modelId = Number(req.body?.model_id);
    const identifiant = String(req.body?.identifiant ?? '').trim();
    const motDePasse = String(req.body?.mot_de_passe ?? '').trim();
    const active = req.body?.active !== false;

    if (!Number.isFinite(modelId) || modelId <= 0) return reply.code(400).send({ error: 'model_id invalide.' });
    if (!identifiant) return reply.code(400).send({ error: 'Identifiant requis.' });
    if (!motDePasse) return reply.code(400).send({ error: 'Mot de passe requis.' });

    const model = await one<{ id: number }>('SELECT id FROM model WHERE id = $1', [modelId]);
    if (!model) return reply.code(400).send({ error: `Modèle ${modelId} inexistant dans mago_enrichment.` });

    let expires: string | null;
    try {
      expires = parseClientExpiry(req.body?.date_expiration ?? null);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }

    let link: string;
    try {
      const publicBase = req.body?.public_base_url ?? await readAutoPublicBaseUrl();
      link = makeClientLink(modelId, publicBase);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }

    // Empêche de créer un compte client vide : le mesh doit avoir été publié avant
    // l'insertion de l'accès. Comme ça, un lien ne peut pas mener à une grille vide.
    const dir = modelStorageDir(modelId);
    const manifestOk = await pathExists(join(dir, 'scene.json'));
    const meshOk = await pathExists(join(dir, 'client_scene_mesh.glb'));
    if (!manifestOk || !meshOk) {
      return reply.code(409).send({
        error: `Scène client non publiée pour le modèle ${modelId}. Clique à nouveau sur « Créer l'accès » depuis le viewer après chargement du mesh.`,
        missing_scene_json: !manifestOk,
        missing_mesh: !meshOk,
        expected_dir: dir,
      });
    }

    const hash = await bcrypt.hash(motDePasse, 10);

    const row = await aone(
      `INSERT INTO client_access
         (lien_client, identifiant, mot_de_passe, model_id, active, date_expiration,
          username, password_hash, expires_at, token_version)
       VALUES ($1, $2, $3, $4, $5, $6, $2, $7, $6, 1)
       ON CONFLICT (identifiant)
       DO UPDATE SET lien_client = EXCLUDED.lien_client,
                     mot_de_passe = EXCLUDED.mot_de_passe,
                     model_id = EXCLUDED.model_id,
                     active = EXCLUDED.active,
                     date_expiration = EXCLUDED.date_expiration,
                     username = EXCLUDED.username,
                     password_hash = EXCLUDED.password_hash,
                     expires_at = EXCLUDED.expires_at,
                     token_version = client_access.token_version + 1,
                     updated_at = now()
       RETURNING id, lien_client, identifiant, mot_de_passe, model_id, active, date_expiration`,
      [link, identifiant, motDePasse, modelId, active, expires, hash]
    );

    return reply.code(201).send(row);
  });
}

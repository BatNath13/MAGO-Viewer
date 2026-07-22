import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, one, pool } from './db.ts';
import { registerAuth, requireClient, clientModelId } from './auth.ts';
import { registerClientScene } from './clientScene.ts';
import { registerClientAccessAdmin } from './clientAccessAdmin.ts';

const app = Fastify({ logger: true });

// CORS : en dev on autorise toutes les origines locales (viewer Vite sur :5173).
// En production, restreindre à l'origine du viewer.
await app.register(cors, { origin: true });

// ---------------------------------------------------------------------
// Accès client : authentification (JWT) + service de la scène hébergée.
// ---------------------------------------------------------------------
await registerAuth(app);
registerClientScene(app);
registerClientAccessAdmin(app);

// Quand CLIENT_AUTH_REQUIRED=true (déploiement client hébergé), l'enrichissement
// exige un jeton client valide et est scopé au modèle du compte. En dev (flag
// absent/false), l'éditeur local garde l'accès libre comme avant.
const CLIENT_AUTH_REQUIRED = (process.env.CLIENT_AUTH_REQUIRED ?? 'false').toLowerCase() === 'true';

// ---------------------------------------------------------------------------
// GARDE TUNNEL (toujours active, indépendante de CLIENT_AUTH_REQUIRED)
// ---------------------------------------------------------------------------
// cloudflared forwarde le trafic public vers localhost:3001 : côté serveur,
// req.ip vaut 127.0.0.1 même pour une requête venue d'Internet. Le seul
// discriminant fiable est l'en-tête que cloudflared ajoute (cf-connecting-ip).
// Règles pour le trafic tunnel :
//   - /api/admin/*  : INTERDIT (création d'accès, mots de passe, publication
//     de scènes — réservé au poste local, admin.html inclus)
//   - /api/models|objects|attributes : jeton client obligatoire + périmètre
//     restreint au modèle du compte, même en dev
//   - login, /api/client/*, statique : inchangés (protégés par ailleurs)
function isTunnelRequest(req: { headers: Record<string, unknown> }): boolean {
  return Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
}

app.addHook('onRequest', async (req, reply) => {
  if (!isTunnelRequest(req)) return; // trafic local : comportement historique
  const p = req.url.split('?')[0];

  if (p.startsWith('/api/admin')) {
    return reply.code(403).send({ error: "Routes d'administration accessibles uniquement depuis le poste local." });
  }

  const isEnrichment =
    p.startsWith('/api/models') || p.startsWith('/api/objects') || p.startsWith('/api/attributes');
  if (!isEnrichment) return;

  await requireClient(req, reply);
  if (reply.sent) return;
  const scoped = clientModelId(req);
  const m = p.match(/^\/api\/models\/(\d+)(?:\/|$)/);
  if (m && Number(m[1]) !== scoped) {
    return reply.code(403).send({ error: 'Modèle hors périmètre du compte.' });
  }
  if (p === '/api/models') {
    return reply.code(403).send({ error: 'Liste des modèles non autorisée en mode client.' });
  }
});
if (CLIENT_AUTH_REQUIRED) {
  app.addHook('onRequest', async (req, reply) => {
    const p = req.url.split('?')[0];
    const isEnrichment =
      p.startsWith('/api/models') || p.startsWith('/api/objects') || p.startsWith('/api/attributes');
    if (!isEnrichment) return; // login / health / classes / statique : libres
    await requireClient(req, reply);
    if (reply.sent) return;
    const scoped = clientModelId(req);
    const m = p.match(/^\/api\/models\/(\d+)(?:\/|$)/);
    if (m) {
      if (Number(m[1]) !== scoped) return reply.code(403).send({ error: 'Modèle hors périmètre du compte.' });
    } else if (p === '/api/models') {
      return reply.code(403).send({ error: 'Liste des modèles non autorisée en mode client.' });
    }
    // NB v1 : /api/objects/:id et /api/attributes/:id exigent un jeton valide ;
    // le contrôle d'appartenance fin par id (objet → model) est un durcissement ultérieur.
  });
}


// ---------------------------------------------------------------------
// Viewer intégré : le build Vite est servi directement par l'API.
// Il n'y a donc plus de serveur Vite séparé ni de port 5173 à démarrer.
// ---------------------------------------------------------------------
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicDir = normalize(join(__dirname, '..', 'public'));
const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
};

async function sendPublicFile(relativePath: string, reply: any) {
  const clean = relativePath.replace(/^\/+/, '');
  const candidate = normalize(join(publicDir, clean));
  if (!candidate.startsWith(publicDir)) return reply.code(403).send('Accès refusé');
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    const body = await readFile(candidate);
    reply.type(mimeTypes[extname(candidate).toLowerCase()] ?? 'application/octet-stream');
    return reply.send(body);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// Santé
// ---------------------------------------------------------------------
app.get('/api/health', async () => {
  const r = await one<{ now: string }>('SELECT now()::text AS now');
  return { ok: true, db_time: r?.now };
});


function extractClassLabel(classKey: string): number | null {
  const key = decodeURIComponent(classKey ?? '').trim();
  const m = key.match(/^class_(?:m(\d+)|(\d+))(?:_|$)/i);
  if (!m) return null;
  return m[1] ? -Number(m[1]) : Number(m[2]);
}

function humanizeClassName(classKey: string, label: number): string {
  const decoded = decodeURIComponent(classKey ?? '').trim();
  let slug = decoded
    .replace(/^class_(?:m\d+|\d+)(?:_|$)/i, '')
    .replace(/_inst_\d+.*$/i, '')
    .replace(/^class_-?\d+_?/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();

  const names: Record<string, string> = {
    wall: 'Mur', walls: 'Murs', mur: 'Mur',
    ceiling: 'Plafond', plafond: 'Plafond',
    floor: 'Sol', ground: 'Sol / terrain', sol: 'Sol', terrain: 'Terrain',
    door: 'Porte', porte: 'Porte', window: 'FenÃªtre', fenetre: 'FenÃªtre',
    vegetation: 'VÃ©gÃ©tation', vegetation_: 'VÃ©gÃ©tation',
    vehicle: 'VÃ©hicule', vehicles: 'VÃ©hicules', vehicule: 'VÃ©hicule',
    chair: 'Chaise', chaise: 'Chaise', table: 'Table', desk: 'Bureau',
    furniture: 'Mobilier', mobilier: 'Mobilier',
    electrical: 'Ã‰lectricitÃ©', electric: 'Ã‰lectricitÃ©',
    hvac: 'CVC', facade: 'FaÃ§ade', roof: 'Toiture', toiture: 'Toiture',
    building: 'BÃ¢timent', batiment: 'BÃ¢timent', noise: 'Bruit', bruit: 'Bruit',
  };

  if (!slug) return `Classe ${label}`;
  if (names[slug]) return names[slug];
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

function canonicalClassKey(classKey: string, label: number): string {
  const decoded = decodeURIComponent(classKey ?? '').trim();
  const withoutInstance = decoded.replace(/_inst_\d+.*$/i, '');
  if (/^class_(?:m\d+|\d+)(?:_|$)/i.test(withoutInstance)) return withoutInstance;
  const prefix = label < 0 ? `class_m${Math.abs(label)}` : `class_${String(label).padStart(3, '0')}`;
  return `${prefix}_class_${label}`;
}

async function resolveClass(classKey: string): Promise<any | null> {
  const decoded = decodeURIComponent(classKey ?? '').trim();
  if (!decoded) return null;

  const exact = await one(
    'SELECT id, class_key, label, display_name, family, mode FROM mago_class WHERE lower(class_key) = lower($1)',
    [decoded]
  );
  if (exact) return exact;

  const label = extractClassLabel(decoded);
  if (label == null) return null;

  const byLabel = await one(
    'SELECT id, class_key, label, display_name, family, mode FROM mago_class WHERE label = $1',
    [label]
  );
  if (byLabel) return byLabel;

  const canonical = canonicalClassKey(decoded, label);
  const displayName = humanizeClassName(canonical, label);

  return one(
    `INSERT INTO mago_class (class_key, label, display_name, family, mode)
     VALUES ($1, $2, $3, 'Autre', 'mixte')
     ON CONFLICT (label) DO UPDATE SET label = EXCLUDED.label
     RETURNING id, class_key, label, display_name, family, mode`,
    [canonical, label, displayName]
  );
}

async function ensureInstanceObject(
  modelId: number,
  objectKey: string,
  requestedClassKey: string,
  name?: string | null,
): Promise<any> {
  const cls = await resolveClass(requestedClassKey);
  if (!cls) throw new Error(`Classe inconnue : ${requestedClassKey}`);

  // Garantit l'existence de l'objet canonique de classe et de ses attributs par défaut.
  await q('SELECT f_instantiate_object($1, $2)', [modelId, cls.class_key]);
  const canonical = await one<any>(
    `SELECT id FROM object WHERE model_id = $1 AND object_key = $2`,
    [modelId, cls.class_key]
  );

  const obj = await one<any>(
    `INSERT INTO object (model_id, class_id, object_key, name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (model_id, object_key)
     DO UPDATE SET class_id = EXCLUDED.class_id,
                   name = COALESCE(EXCLUDED.name, object.name)
     RETURNING id, object_key, name`,
    [modelId, cls.id, objectKey, name ?? objectKey]
  );

  // À la première création, copie les attributs de la classe dans l'instance.
  if (canonical && obj) {
    await q(
      `INSERT INTO attribute (object_id, attr_key, attr_label, data_type, value, unit, options, position)
       SELECT $1, attr_key, attr_label, data_type, value, unit, options, position
         FROM attribute
        WHERE object_id = $2
       ON CONFLICT (object_id, attr_key) DO NOTHING`,
      [obj.id, canonical.id]
    );
  }

  return one(
    `SELECT o.id, o.object_key, o.name,
            c.class_key, c.label, c.display_name, c.family, c.mode
       FROM object o JOIN mago_class c ON c.id = o.class_id
      WHERE o.model_id = $1 AND o.object_key = $2`,
    [modelId, objectKey]
  );
}

async function objectWithAttributes(obj: any) {
  const attributes = await q(
    `SELECT id, attr_key, attr_label, data_type, value, unit, options, position, updated_at
       FROM attribute WHERE object_id = $1 ORDER BY position, attr_label`,
    [obj.id]
  );
  return { object: obj, attributes };
}

// ---------------------------------------------------------------------
// Classes (catalogue, lecture seule)
// ---------------------------------------------------------------------
app.get('/api/classes', async () => {
  return q(
    `SELECT id, class_key, label, display_name, family, mode, color_hex
       FROM mago_class
      ORDER BY mode, family, label`
  );
});

// ---------------------------------------------------------------------
// Modèles (datasets)
// ---------------------------------------------------------------------
app.get('/api/models', async () => {
  return q(`SELECT id, name, survey_type, description, created_at
              FROM model ORDER BY created_at DESC`);
});

app.post<{ Body: { name: string; survey_type?: string; description?: string } }>(
  '/api/models',
  async (req, reply) => {
    const { name, survey_type = 'interieur', description = null } = req.body ?? ({} as any);
    if (!name || !name.trim()) return reply.code(400).send({ error: 'name requis' });
    try {
      const row = await one(
        `INSERT INTO model (name, survey_type, description)
         VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
         RETURNING id, name, survey_type, description, created_at`,
        [name.trim(), survey_type, description]
      );
      return reply.code(201).send(row);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  }
);

app.delete<{ Params: { id: string } }>('/api/models/:id', async (req, reply) => {
  await q('DELETE FROM model WHERE id = $1', [Number(req.params.id)]);
  return reply.code(204).send();
});

// Import : instancie en lot les objets d'un modèle à partir des classes
// détectées côté viewer (liste de class_key). Idempotent.
app.post<{ Params: { id: string }; Body: { classKeys: string[] } }>(
  '/api/models/:id/import',
  async (req, reply) => {
    const modelId = Number(req.params.id);
    const keys = req.body?.classKeys ?? [];
    if (!Array.isArray(keys)) return reply.code(400).send({ error: 'classKeys[] requis' });

    const created: string[] = [];
    const skipped: string[] = [];
    for (const key of keys) {
      const cls = await resolveClass(key);
      if (!cls) { skipped.push(key); continue; }
      await q('SELECT f_instantiate_object($1, $2)', [modelId, cls.class_key]);
      created.push(cls.class_key);
    }
    return { created, skipped };
  }
);

// Liste des objets d'un modèle (avec infos de classe)
app.get<{ Params: { id: string } }>('/api/models/:id/objects', async (req) => {
  return q(
    `SELECT o.id, o.object_key, o.name,
            c.class_key, c.label, c.display_name, c.family, c.mode
       FROM object o
       JOIN mago_class c ON c.id = o.class_id
      WHERE o.model_id = $1
      ORDER BY c.family, c.label`,
    [Number(req.params.id)]
  );
});

// Récupère (ou crée à la volée) l'objet d'un modèle via son class_key,
// avec ses attributs. C'est l'endpoint que le viewer appelle au clic sur une couche.
app.get<{ Params: { id: string; classKey: string } }>(
  '/api/models/:id/objects/by-key/:classKey',
  async (req, reply) => {
    const modelId = Number(req.params.id);
    const requestedClassKey = req.params.classKey;
    const cls = await resolveClass(requestedClassKey);
    if (!cls) return reply.code(404).send({ error: `Classe inconnue : ${requestedClassKey}` });
    const classKey = cls.class_key as string;

    // Création paresseuse : la clé canonique du catalogue est utilisée, même si
    // le GLB emploie un suffixe français ou issu d'une ancienne version.
    await q('SELECT f_instantiate_object($1, $2)', [modelId, classKey]);

    const obj = await one(
      `SELECT o.id, o.object_key, o.name,
              c.class_key, c.label, c.display_name, c.family, c.mode
         FROM object o JOIN mago_class c ON c.id = o.class_id
        WHERE o.model_id = $1 AND o.object_key = $2`,
      [modelId, classKey]
    );
    const attributes = await q(
      `SELECT id, attr_key, attr_label, data_type, value, unit, options, position, updated_at
         FROM attribute WHERE object_id = $1 ORDER BY position, attr_label`,
      [(obj as any).id]
    );
    return { object: obj, attributes };
  }
);


// Récupère/crée un objet d'INSTANCE précis. objectKey est le nom logique du GLB
// (ex. class_118_chair_inst_005), classKey la classe canonique (class_118_chair).
app.get<{
  Params: { id: string; objectKey: string };
  Querystring: { classKey?: string; name?: string };
}>(
  '/api/models/:id/objects/by-instance/:objectKey',
  async (req, reply) => {
    const modelId = Number(req.params.id);
    const objectKey = decodeURIComponent(req.params.objectKey).trim();
    const classKey = decodeURIComponent(req.query?.classKey ?? objectKey).trim();
    const name = req.query?.name ? decodeURIComponent(req.query.name) : objectKey;
    try {
      const obj = await ensureInstanceObject(modelId, objectKey, classKey, name);
      return objectWithAttributes(obj);
    } catch (e: any) {
      return reply.code(404).send({ error: e.message });
    }
  }
);

// Suppression d'une instance précise dans la BDD.
app.delete<{ Params: { id: string; objectKey: string } }>(
  '/api/models/:id/objects/by-object-key/:objectKey',
  async (req, reply) => {
    await q(
      'DELETE FROM object WHERE model_id = $1 AND object_key = $2',
      [Number(req.params.id), decodeURIComponent(req.params.objectKey)]
    );
    return reply.code(204).send();
  }
);

// Suppression de toute une classe : objet canonique + toutes ses instances.
app.delete<{ Params: { id: string; classKey: string } }>(
  '/api/models/:id/objects/by-class/:classKey',
  async (req, reply) => {
    const modelId = Number(req.params.id);
    const cls = await resolveClass(decodeURIComponent(req.params.classKey));
    if (!cls) return reply.code(404).send({ error: 'Classe inconnue' });
    await q('DELETE FROM object WHERE model_id = $1 AND class_id = $2', [modelId, cls.id]);
    return reply.code(204).send();
  }
);

// ---------------------------------------------------------------------
// Attributs d'un objet
// ---------------------------------------------------------------------
app.get<{ Params: { id: string } }>('/api/objects/:id/attributes', async (req) => {
  return q(
    `SELECT id, attr_key, attr_label, data_type, value, unit, options, position, updated_at
       FROM attribute WHERE object_id = $1 ORDER BY position, attr_label`,
    [Number(req.params.id)]
  );
});

// Ajout d'un attribut personnalisé
app.post<{
  Params: { id: string };
  Body: { attr_key: string; attr_label?: string; data_type?: string; value?: string; unit?: string; options?: string; position?: number };
}>('/api/objects/:id/attributes', async (req, reply) => {
  const objectId = Number(req.params.id);
  const b = req.body ?? ({} as any);
  if (!b.attr_key || !b.attr_key.trim()) return reply.code(400).send({ error: 'attr_key requis' });
  try {
    const row = await one(
      `INSERT INTO attribute (object_id, attr_key, attr_label, data_type, value, unit, options, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, attr_key, attr_label, data_type, value, unit, options, position, updated_at`,
      [
        objectId,
        b.attr_key.trim(),
        b.attr_label ?? b.attr_key.trim(),
        b.data_type ?? 'text',
        b.value ?? null,
        b.unit ?? null,
        b.options ?? null,
        b.position ?? 50,
      ]
    );
    return reply.code(201).send(row);
  } catch (e: any) {
    // 23505 = violation de contrainte unique (attr_key déjà présent sur cet objet)
    if (e.code === '23505') return reply.code(409).send({ error: 'Cet attribut existe déjà pour cet objet' });
    return reply.code(400).send({ error: e.message });
  }
});

// Modification d'un attribut (valeur et/ou métadonnées)
app.put<{
  Params: { id: string };
  Body: { value?: string; attr_label?: string; data_type?: string; unit?: string; options?: string; position?: number };
}>('/api/attributes/:id', async (req, reply) => {
  const id = Number(req.params.id);
  const b = req.body ?? ({} as any);
  const row = await one(
    `UPDATE attribute SET
        value     = COALESCE($2, value),
        attr_label= COALESCE($3, attr_label),
        data_type = COALESCE($4, data_type),
        unit      = COALESCE($5, unit),
        options   = COALESCE($6, options),
        position  = COALESCE($7, position),
        updated_at= now()
      WHERE id = $1
      RETURNING id, attr_key, attr_label, data_type, value, unit, options, position, updated_at`,
    [id, b.value ?? null, b.attr_label ?? null, b.data_type ?? null, b.unit ?? null, b.options ?? null, b.position ?? null]
  );
  if (!row) return reply.code(404).send({ error: 'Attribut introuvable' });
  return row;
});

// Suppression d'un attribut
app.delete<{ Params: { id: string } }>('/api/attributes/:id', async (req, reply) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return reply.code(400).send({ error: 'id attribut invalide' });

  const rows = await q(
    `DELETE FROM attribute
      WHERE id = $1
      RETURNING id, object_id, attr_key, attr_label`,
    [id]
  );

  if (!rows || rows.length === 0) {
    return reply.code(404).send({ error: 'Attribut introuvable' });
  }

  return { deleted: rows[0] };
});



// ---------------------------------------------------------------------
// Application web intégrée
// ---------------------------------------------------------------------
app.get('/', async (_req, reply) => {
  const sent = await sendPublicFile('index.html', reply);
  if (sent === false) return reply.code(503).send('Le build du viewer est absent du dossier public.');
  return sent;
});

app.get('/*', async (req, reply) => {
  const path = (req.params as any)['*'] as string;
  if (path.startsWith('api/')) return reply.code(404).send({ error: 'Route API introuvable' });
  const sent = await sendPublicFile(path, reply);
  if (sent !== false) return sent;
  // Fallback SPA pour les routes côté client.
  const index = await sendPublicFile('index.html', reply);
  if (index === false) return reply.code(404).send('Fichier introuvable');
  return index;
});

// ---------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------
const port = Number(process.env.PORT ?? 3001);
try {
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`MAGO Enrichment API en écoute sur http://localhost:${port}`);
} catch (err) {
  app.log.error(err);
  await pool.end();
  process.exit(1);
}

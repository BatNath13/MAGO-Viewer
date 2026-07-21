/**
 * MAGO · clientScene.ts
 * =====================
 * Sert la scène d'un client, hébergée côté serveur, DERRIÈRE l'authentification.
 *
 * Les fichiers du modèle (GLB, splats) vivent dans :
 *     <STORAGE_DIR>/models/<model_id>/
 * c.-à-d. HORS du dossier public/ → ils ne sont jamais servis en statique ouvert.
 * Seul un client authentifié dont le jeton porte ce model_id peut les récupérer.
 *
 * Chaque dossier modèle contient un manifeste `scene.json`, p.ex. :
 *     { "name": "Salle C10", "mesh": "modele.glb", "splat": "nuage.ply" }
 * (champs mesh / splat facultatifs ; au moins l'un des deux.)
 *
 *   GET /api/client/scene/manifest        (protégé) → renvoie scene.json + nom
 *   GET /api/client/scene/file/:name      (protégé) → renvoie le fichier demandé
 */
import type { FastifyInstance } from 'fastify';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, basename, extname } from 'node:path';
import { requireClient, clientModelId } from './auth.ts';

const STORAGE_DIR = normalize(process.env.STORAGE_DIR ?? join(process.cwd(), 'storage'));

const mime: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.obj': 'text/plain; charset=utf-8',
  '.ply': 'application/octet-stream',
  '.splat': 'application/octet-stream',
  '.spz': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
};

function modelDir(modelId: number): string {
  return normalize(join(STORAGE_DIR, 'models', String(modelId)));
}

export function registerClientScene(app: FastifyInstance): void {
  // Manifeste de la scène associée au compte.
  app.get('/api/client/scene/manifest', { preHandler: requireClient }, async (req, reply) => {
    const dir = modelDir(clientModelId(req));
    try {
      const raw = await readFile(join(dir, 'scene.json'), 'utf-8');
      return reply.send(JSON.parse(raw));
    } catch {
      return reply.code(404).send({ error: "Scène introuvable pour ce compte (scene.json manquant)." });
    }
  });

  // Fichier individuel de la scène (basename only → pas de remontée de chemin).
  app.get<{ Params: { name: string } }>(
    '/api/client/scene/file/:name',
    { preHandler: requireClient },
    async (req, reply) => {
      const dir = modelDir(clientModelId(req));
      const name = basename(req.params.name); // neutralise tout ../ ou chemin absolu
      const candidate = normalize(join(dir, name));
      if (!candidate.startsWith(dir)) return reply.code(403).send({ error: 'Chemin refusé.' });
      try {
        const info = await stat(candidate);
        if (!info.isFile()) return reply.code(404).send({ error: 'Fichier introuvable.' });
        const buf = await readFile(candidate);
        reply.header('content-type', mime[extname(name).toLowerCase()] ?? 'application/octet-stream');
        reply.header('content-length', String(info.size));
        return reply.send(buf);
      } catch {
        return reply.code(404).send({ error: 'Fichier introuvable.' });
      }
    }
  );
}

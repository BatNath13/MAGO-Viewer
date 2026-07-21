/**
 * MAGO · auth.ts
 * ==============
 * Authentification des accès client depuis la table PostgreSQL client_access.
 *
 * Table voulue côté pgAdmin :
 *   lien_client | identifiant | mot_de_passe | date_expiration | active
 *
 * Le login utilise identifiant + mot_de_passe.
 * La coupure se fait automatiquement quand date_expiration <= now().
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';
import { aone } from './accessDb.ts';

type ClientToken = { account_id: number; model_id: number; tv: number };

type AccountRow = {
  id: number;
  lien_client: string | null;
  identifiant: string | null;
  mot_de_passe: string | null;
  username: string | null;
  password_hash: string | null;
  model_id: number;
  active: boolean;
  date_expiration: string | null;
  expires_at: string | null;
  token_version: number;
};

const JWT_SECRET = process.env.JWT_SECRET ?? '';
const TOKEN_TTL = process.env.CLIENT_TOKEN_TTL ?? '12h';

function effectiveExpiry(acc: Pick<AccountRow, 'date_expiration' | 'expires_at'>): string | null {
  return acc.date_expiration ?? acc.expires_at ?? null;
}

async function passwordMatches(password: string, acc: AccountRow): Promise<boolean> {
  // Fonctionnement demandé : mot_de_passe visible/modifiable dans la base.
  if (acc.mot_de_passe != null && password === acc.mot_de_passe) return true;

  // Compatibilité avec l'ancien patch hashé.
  if (acc.password_hash) {
    try { return await bcrypt.compare(password, acc.password_hash); }
    catch { return false; }
  }

  return false;
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  if (!JWT_SECRET || JWT_SECRET.length < 16) {
    throw new Error(
      'JWT_SECRET manquant ou trop court dans .env. ' +
      'Génère-le avec : node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  await app.register(fastifyJwt, { secret: JWT_SECRET });

  app.post<{ Body: { username?: string; identifiant?: string; password?: string } }>(
    '/api/client/login',
    async (req, reply) => {
      const identifiant = (req.body?.identifiant ?? req.body?.username ?? '').trim();
      const password = req.body?.password ?? '';
      if (!identifiant || !password) {
        return reply.code(400).send({ error: 'Identifiant et mot de passe requis.' });
      }

      const acc = await aone<AccountRow>(
        `SELECT id, lien_client, identifiant, mot_de_passe, username, password_hash,
                model_id, active, date_expiration, expires_at, token_version
           FROM client_access
          WHERE identifiant = $1 OR username = $1`,
        [identifiant]
      );

      const invalid = () => reply.code(401).send({ error: 'Identifiants invalides ou accès expiré.' });
      if (!acc || !acc.active || !acc.model_id) return invalid();

      const expiry = effectiveExpiry(acc);
      if (expiry && new Date(expiry).getTime() <= Date.now()) return invalid();

      const ok = await passwordMatches(password, acc);
      if (!ok) return invalid();

      const token = await reply.jwtSign(
        { account_id: acc.id, model_id: acc.model_id, tv: acc.token_version } satisfies ClientToken,
        { expiresIn: TOKEN_TTL }
      );

      return reply.send({
        token,
        model_id: acc.model_id,
        expires_at: expiry,
        date_expiration: expiry,
        lien_client: acc.lien_client,
      });
    }
  );

  app.get('/api/client/session', { preHandler: requireClient }, async (req) => {
    return {
      model_id: clientModelId(req),
      expires_at: clientExpiresAt(req),
      date_expiration: clientExpiresAt(req),
    };
  });
}

export async function requireClient(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  let payload: ClientToken;
  try {
    payload = await req.jwtVerify<ClientToken>();
  } catch {
    return reply.code(401).send({ error: 'Authentification requise.' });
  }

  const acc = await aone<AccountRow>(
    `SELECT id, lien_client, identifiant, mot_de_passe, username, password_hash,
            model_id, active, date_expiration, expires_at, token_version
       FROM client_access
      WHERE id = $1`,
    [payload.account_id]
  );

  const denied = () => reply.code(403).send({ error: 'Accès révoqué ou expiré.' });
  if (!acc || !acc.active || !acc.model_id) return denied();
  if (acc.token_version !== payload.tv) return denied();

  const expiry = effectiveExpiry(acc);
  if (expiry && new Date(expiry).getTime() <= Date.now()) return denied();

  (req as any).clientModelId = acc.model_id;
  (req as any).clientExpiresAt = expiry;
}

export function clientModelId(req: FastifyRequest): number {
  return (req as any).clientModelId as number;
}

export function clientExpiresAt(req: FastifyRequest): string | null {
  return ((req as any).clientExpiresAt ?? null) as string | null;
}

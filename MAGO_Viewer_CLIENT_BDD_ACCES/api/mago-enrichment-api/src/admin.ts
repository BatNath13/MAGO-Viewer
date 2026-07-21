/**
 * MAGO · admin.ts — gestion simple des accès client en base PostgreSQL
 * ==================================================================
 * Objectif : une vraie table modifiable dans pgAdmin :
 *   client_access(lien_client, identifiant, mot_de_passe, date_expiration, active)
 *
 * Utilisation : npm run admin -- <commande> [options]
 *
 *   register-model --name "Salle C10" [--type interieur] [--desc "..."]
 *       Crée un modèle + storage/models/<id>/scene.json.
 *
 *   create --user dupont --pass "Mdp#2026" --model 3 --expires "2026-08-30 18:45"
 *       Ajoute une ligne dans client_access avec lien + identifiant + mot de passe + expiration.
 *
 *   expire --user dupont --expires "2026-10-31 12:30"
 *       Modifie uniquement date_expiration. Tu peux aussi le faire directement dans pgAdmin.
 *
 *   set-password --user dupont --pass "NouveauMdp"
 *       Modifie mot_de_passe dans la base.
 *
 *   disable / enable / delete / list
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { one, pool } from './db.ts';
import { aq, accessPool } from './accessDb.ts';

const STORAGE_DIR = normalize(process.env.STORAGE_DIR ?? join(process.cwd(), 'storage'));
const PUBLIC_BASE_URL = (process.env.CLIENT_PUBLIC_BASE_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
const EXPIRY_TIMEZONE = process.env.CLIENT_EXPIRY_TIMEZONE ?? 'Europe/Paris';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = 'true';
    }
  }
  return out;
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

function parseExpiry(s?: string): string | null {
  if (!s) return null;
  const raw = s.trim();
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
  if (!isNaN(parsed.getTime())) return parsed.toISOString();
  throw new Error(`Expiration invalide : ${s}. Exemple : "2026-08-30 18:45"`);
}

function formatExpiry(iso: string | null): string {
  if (!iso) return '—';
  const p = zonedParts(new Date(iso), EXPIRY_TIMEZONE);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} (${EXPIRY_TIMEZONE})`;
}

function makeClientLink(modelId: number): string {
  return `${PUBLIC_BASE_URL}/?client=1&m=${encodeURIComponent(String(modelId))}`;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (cmd) {
    case 'register-model': {
      if (!args.name) throw new Error('--name requis.');
      const row = await one<{ id: number }>(
        `INSERT INTO model (name, survey_type, description) VALUES ($1, $2, $3) RETURNING id`,
        [args.name, args.type ?? 'interieur', args.desc ?? null]
      );
      const id = row!.id;
      const dir = join(STORAGE_DIR, 'models', String(id));
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'scene.json'),
        JSON.stringify({ name: args.name, mesh: 'modele.glb', splat: null }, null, 2),
        'utf-8'
      );
      console.log(`✓ Modèle créé : id=${id}`);
      console.log(`  Dossier scène : ${dir}`);
      console.log(`  Lien client futur : ${makeClientLink(id)}`);
      break;
    }

    case 'create': {
      for (const k of ['user', 'pass', 'model']) if (!args[k]) throw new Error(`--${k} requis.`);
      const modelId = Number(args.model);
      const model = await one(`SELECT id FROM model WHERE id = $1`, [modelId]);
      if (!model) throw new Error(`Modèle ${modelId} inexistant.`);

      const expires = parseExpiry(args.expires);
      const link = args.link ?? makeClientLink(modelId);
      const hash = await bcrypt.hash(args.pass, 10);

      await aq(
        `INSERT INTO client_access
           (lien_client, identifiant, mot_de_passe, model_id, active, date_expiration,
            username, password_hash, expires_at, token_version)
         VALUES ($1, $2, $3, $4, true, $5, $2, $6, $5, 1)`,
        [link, args.user, args.pass, modelId, expires, hash]
      );

      console.log('✓ Accès client créé dans la table client_access');
      console.log(`  lien_client     : ${link}`);
      console.log(`  identifiant     : ${args.user}`);
      console.log(`  mot_de_passe    : ${args.pass}`);
      console.log(`  date_expiration : ${formatExpiry(expires)}`);
      break;
    }

    case 'set-password': {
      for (const k of ['user', 'pass']) if (!args[k]) throw new Error(`--${k} requis.`);
      const hash = await bcrypt.hash(args.pass, 10);
      const r = await aq(
        `UPDATE client_access
            SET mot_de_passe=$2,
                password_hash=$3,
                token_version=token_version+1,
                updated_at=now()
          WHERE identifiant=$1 OR username=$1
          RETURNING id`,
        [args.user, args.pass, hash]
      );
      if (!r.length) throw new Error(`Accès « ${args.user} » introuvable.`);
      console.log(`✓ Mot de passe changé pour « ${args.user} » dans la base.`);
      break;
    }

    case 'expire': {
      if (!args.user) throw new Error('--user requis.');
      const expires = parseExpiry(args.expires);
      const r = await aq(
        `UPDATE client_access
            SET date_expiration=$2,
                expires_at=$2,
                updated_at=now()
          WHERE identifiant=$1 OR username=$1
          RETURNING id`,
        [args.user, expires]
      );
      if (!r.length) throw new Error(`Accès « ${args.user} » introuvable.`);
      console.log(`✓ date_expiration de « ${args.user} » fixée à ${formatExpiry(expires)}.`);
      break;
    }

    case 'disable':
    case 'enable': {
      if (!args.user) throw new Error('--user requis.');
      const active = cmd === 'enable';
      const r = await aq(
        `UPDATE client_access SET active=$2, updated_at=now()
          WHERE identifiant=$1 OR username=$1
          RETURNING id`,
        [args.user, active]
      );
      if (!r.length) throw new Error(`Accès « ${args.user} » introuvable.`);
      console.log(`✓ Accès « ${args.user} » ${active ? 'réactivé' : 'désactivé'}.`);
      break;
    }

    case 'delete': {
      if (!args.user) throw new Error('--user requis.');
      const r = await aq(`DELETE FROM client_access WHERE identifiant=$1 OR username=$1 RETURNING id`, [args.user]);
      if (!r.length) throw new Error(`Accès « ${args.user} » introuvable.`);
      console.log(`✓ Accès « ${args.user} » supprimé.`);
      break;
    }

    case 'list': {
      const rows = await aq<{
        lien_client: string | null;
        identifiant: string | null;
        mot_de_passe: string | null;
        model_id: number | null;
        active: boolean;
        date_expiration: string | null;
      }>(
        `SELECT lien_client, identifiant, mot_de_passe, model_id, active, date_expiration
           FROM client_access
          ORDER BY id DESC`
      );
      if (!rows.length) { console.log('(aucun accès client)'); break; }
      for (const r of rows) {
        const expired = r.date_expiration && new Date(r.date_expiration).getTime() <= Date.now();
        const state = !r.active ? 'désactivé' : expired ? 'expiré' : 'actif';
        console.log('----------------------------------------');
        console.log(`état            : ${state}`);
        console.log(`lien_client     : ${r.lien_client ?? '—'}`);
        console.log(`identifiant     : ${r.identifiant ?? '—'}`);
        console.log(`mot_de_passe    : ${r.mot_de_passe ?? '—'}`);
        console.log(`model_id        : ${r.model_id ?? '—'}`);
        console.log(`date_expiration : ${formatExpiry(r.date_expiration)}`);
      }
      break;
    }

    default:
      console.log('Commandes : register-model | create | set-password | expire | disable | enable | delete | list');
      console.log('Exemple : npm run admin -- create --user dupont --pass "Mdp#2026" --model 3 --expires "2026-08-30 18:45"');
      console.log('Tu peux aussi modifier directement date_expiration dans pgAdmin, table client_access.');
  }
}

main()
  .then(async () => { await pool.end(); await accessPool.end(); })
  .catch(async (e) => { console.error('✗', e.message); await pool.end(); await accessPool.end(); process.exit(1); });

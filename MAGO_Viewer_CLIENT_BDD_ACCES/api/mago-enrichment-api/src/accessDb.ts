import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

// Base séparée pour les accès client.
// Elle évite de mélanger les identifiants / expirations avec les tables métier
// du maillage (attribute, object, model...) qui restent dans mago_enrichment.
export const accessPool = new Pool({
  host: process.env.ACCESS_PGHOST ?? process.env.PGHOST ?? 'localhost',
  port: Number(process.env.ACCESS_PGPORT ?? process.env.PGPORT ?? 5432),
  user: process.env.ACCESS_PGUSER ?? process.env.PGUSER ?? 'postgres',
  password: process.env.ACCESS_PGPASSWORD ?? process.env.PGPASSWORD ?? '',
  database: process.env.ACCESS_PGDATABASE ?? 'mago_access',
});

export async function aq<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await accessPool.query(text, params);
  return res.rows as T[];
}

export async function aone<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await aq<T>(text, params);
  return rows[0] ?? null;
}

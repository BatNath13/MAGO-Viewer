import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

// Pool de connexions PostgreSQL. Config lue depuis .env (voir .env.example).
export const pool = new Pool({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? '',
  database: process.env.PGDATABASE ?? 'mago_enrichment',
});

// Helper : exécute une requête et renvoie directement les lignes typées.
export async function q<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

// Helper : renvoie la première ligne ou null.
export async function one<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

import { Pool } from 'pg';

const connectionString =
  process.env.DATABASE_URL || 'postgres://localhost:5432/ai_designer_storage';

// On platforms like Render, Postgres usually requires SSL.
// Enable it via DATABASE_SSL=true to avoid breaking local development.
const useSsl =
  process.env.DATABASE_SSL === 'true' || process.env.DATABASE_SSL === '1';

export const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
});

export async function query<T = any>(text: string, params?: any[]) {
  const client = await pool.connect();
  try {
    const res = await client.query<T>(text, params);
    return res;
  } finally {
    client.release();
  }
}

import { neon } from '@neondatabase/serverless';

/**
 * Neon Lakebase Postgres client (HTTP / serverless).
 * Uses pooled DATABASE_URL for app traffic (see neon-postgres skill).
 * Use DATABASE_URL_UNPOOLED only for migrations / dumps / session ops.
 */

let sqlSingleton = null;

/**
 * @returns {string}
 */
export function getDatabaseUrl() {
  const url = String(process.env.DATABASE_URL || '').trim();
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Run `neon env pull --file .env.local` or set DATABASE_URL in the environment.',
    );
  }
  return url;
}

/**
 * @returns {string}
 */
export function getDatabaseUrlUnpooled() {
  const url = String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || '').trim();
  if (!url) {
    throw new Error(
      'DATABASE_URL_UNPOOLED (or DATABASE_URL) is not set. Run `neon env pull --file .env.local`.',
    );
  }
  return url;
}

/**
 * Pooled Neon SQL tagged-template client for one-shot queries (Netlify / serverless).
 * @returns {ReturnType<typeof neon>}
 */
export function getNeonSql() {
  if (!sqlSingleton) {
    sqlSingleton = neon(getDatabaseUrl());
  }
  return sqlSingleton;
}

/**
 * Direct (unpooled) Neon SQL client — migrations, dumps, session-scoped work.
 * @returns {ReturnType<typeof neon>}
 */
export function getNeonSqlUnpooled() {
  return neon(getDatabaseUrlUnpooled());
}

/**
 * Lightweight connectivity check. Never logs connection strings.
 * @returns {Promise<{ ok: true, result: number }>}
 */
export async function pingNeon() {
  const sql = getNeonSql();
  const rows = await sql`SELECT 1::int AS ok`;
  const result = Number(rows?.[0]?.ok);
  if (result !== 1) {
    throw new Error('Neon ping failed: unexpected result');
  }
  return { ok: true, result };
}

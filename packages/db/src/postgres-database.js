import pg from 'pg';
import { DatabaseBusyError } from './database.js';

const { Pool } = pg;

/**
 * Convert SQLite-style `?` placeholders to Postgres `$1..$n`.
 * Leaves existing `$n` markers alone.
 * @param {string} sql
 */
export function toPostgresParams(sql) {
  let index = 0;
  return String(sql).replace(/\?/g, () => `$${++index}`);
}

/** Map SQLite 0/1 boolean column comparisons to Postgres boolean literals. */
export function adaptSqliteBooleans(sql) {
  const cols = [
    'is_active',
    'is_slot_busy',
    'is_merchant_enabled',
    'is_successful',
    'is_phone_verified',
    'allow_reuse_after_paid',
  ];
  let out = String(sql);
  for (const col of cols) {
    out = out.replace(new RegExp(`\\b${col}\\s*=\\s*0\\b`, 'gi'), `${col} = false`);
    out = out.replace(new RegExp(`\\b${col}\\s*=\\s*1\\b`, 'gi'), `${col} = true`);
  }
  return out;
}

function isRetryablePgError(err) {
  if (!err) return false;
  const code = String(err.code || '');
  const msg = String(err.message || '').toLowerCase();
  return (
    code === '40001' || // serialization_failure
    code === '40P01' || // deadlock_detected
    code === '55P03' || // lock_not_available
    code === '57P03' || // cannot_connect_now
    code === '53300' || // too_many_connections
    msg.includes('timeout') ||
    msg.includes('connection terminated') ||
    msg.includes('econnreset')
  );
}

/**
 * Async Postgres Database client matching the YOUPI Database surface.
 * Uses a pooled connection string (DATABASE_URL with -pooler) for app traffic.
 */
export class PostgresDatabase {
  /**
   * @param {{ connectionString?: string, pool?: import('pg').Pool, autoMigrate?: boolean }} [options]
   */
  constructor(options = {}) {
    const connectionString = options.connectionString || process.env.DATABASE_URL;
    if (!options.pool && !connectionString) {
      throw new Error('PostgresDatabase requires DATABASE_URL or an explicit pool');
    }
    this.pool = options.pool || new Pool({
      connectionString,
      ssl: connectionString.includes('sslmode=require') || connectionString.includes('neon.tech')
        ? { rejectUnauthorized: false }
        : undefined,
      max: Number(process.env.PG_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
    this.driver = 'postgres';
    this._transactionDepth = 0;
    this._client = null;
  }

  /**
   * @param {string} sql
   * @param {any[]} [params]
   */
  async execute(sql, params = []) {
    const text = toPostgresParams(adaptSqliteBooleans(sql));
    const client = this._client || this.pool;
    const result = await client.query(text, params);
    return {
      changes: result.rowCount || 0,
      lastInsertRowid: 0,
      rows: result.rows,
    };
  }

  async run(sql, params = []) {
    return this.execute(sql, params);
  }

  async query(sql, params = []) {
    // SQLite introspection no-ops for Postgres path
    if (/^\s*PRAGMA\b/i.test(sql) || /sqlite_master/i.test(sql)) {
      return [];
    }
    const text = toPostgresParams(adaptSqliteBooleans(sql));
    const client = this._client || this.pool;
    const result = await client.query(text, params);
    return result.rows;
  }

  async queryOne(sql, params = []) {
    if (/^\s*PRAGMA\b/i.test(sql) || /sqlite_master/i.test(sql)) {
      return null;
    }
    const rows = await this.query(sql, params);
    return rows[0] || null;
  }

  async exec(sql) {
    if (/^\s*PRAGMA\b/i.test(sql)) return;
    const client = this._client || this.pool;
    await client.query(sql);
  }

  /**
   * @template T
   * @param {() => Promise<T>|T} callback
   * @returns {Promise<T>}
   */
  async transaction(callback) {
    const isNested = (this._transactionDepth || 0) > 0;
    const nextDepth = (this._transactionDepth || 0) + 1;
    const savepointName = `sp_${nextDepth}`;

    if (isNested) {
      await this._client.query(`SAVEPOINT ${savepointName}`);
      this._transactionDepth = nextDepth;
      try {
        const result = await callback();
        await this._client.query(`RELEASE SAVEPOINT ${savepointName}`);
        return result;
      } catch (err) {
        try {
          await this._client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        } catch {}
        throw err;
      } finally {
        this._transactionDepth--;
      }
    }

    const client = await this.pool.connect();
    this._client = client;
    this._transactionDepth = 1;
    try {
      await client.query('BEGIN');
      const result = await callback();
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      throw err;
    } finally {
      this._transactionDepth = 0;
      this._client = null;
      client.release();
    }
  }

  /**
   * @template T
   * @param {() => Promise<T>|T} operation
   * @param {number} [maxRetries]
   * @param {number} [baseDelayMs]
   * @returns {Promise<T>}
   */
  async withRetry(operation, maxRetries = 3, baseDelayMs = 50) {
    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (err) {
        attempt++;
        if (attempt > maxRetries || !isRetryablePgError(err)) {
          if (isRetryablePgError(err)) {
            throw new DatabaseBusyError(
              `Database contention after ${attempt} retry attempt(s): ${err.message}`,
              err,
            );
          }
          throw err;
        }
        const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 500) + Math.floor(Math.random() * 20);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  async close() {
    await this.pool.end();
  }
}

/**
 * @returns {boolean}
 */
export function shouldUsePostgres() {
  const url = String(process.env.DATABASE_URL || '').trim();
  if (!url) return false;
  const fallback = String(process.env.USE_SQLITE_FALLBACK || '').trim().toLowerCase();
  return fallback !== 'true';
}

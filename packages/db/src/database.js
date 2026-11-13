import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './migrate.js';
import { PostgresDatabase, shouldUsePostgres } from './postgres-database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');

/**
 * Checks if core tables exist and executes migrations if not yet initialized.
 * @param {Database} db
 */
export async function ensureDatabaseInitialized(db) {
  if (db.driver === 'postgres') {
    return null;
  }
  try {
    const row = await db.queryOne("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='merchants'");
    if (!row || Number(row.count) === 0) {
      return await runMigrations(db);
    }
  } catch {
    return await runMigrations(db);
  }
  return null;
}

export class DatabaseBusyError extends Error {
  constructor(message = 'Database lock contention timeout after bounded retries', originalError = null) {
    super(message);
    this.name = 'DatabaseBusyError';
    this.code = 'DATABASE_BUSY';
    this.isRetryable = true;
    this.originalError = originalError;
  }
}

export function isRetryableSqliteError(err) {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  const code = (err.code || '').toUpperCase();
  return (
    msg.includes('database is locked') ||
    msg.includes('busy') ||
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED'
  );
}

/**
 * Universal Database Client for YOUPI PG (SQLite).
 * Methods are async so callers share one await-based API with PostgresDatabase.
 */
export class Database {
  /**
   * @param {{ dbPath?: string, inMemory?: boolean, autoMigrate?: boolean }} [options={}]
   */
  constructor(options = {}) {
    this.driver = 'sqlite';
    this._ready = null;
    if (options.inMemory) {
      this.db = new DatabaseSync(':memory:');
    } else {
      let dbPath;
      if (options.dbPath) {
        dbPath = path.isAbsolute(options.dbPath)
          ? options.dbPath
          : path.resolve(process.cwd(), options.dbPath);
      } else if (process.env.SQLITE_DB_PATH) {
        dbPath = path.isAbsolute(process.env.SQLITE_DB_PATH)
          ? process.env.SQLITE_DB_PATH
          : path.resolve(repoRoot, process.env.SQLITE_DB_PATH);
      } else {
        dbPath = path.resolve(repoRoot, 'data/youpi_pg.sqlite');
      }
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.db = new DatabaseSync(dbPath);
    }

    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
    } catch {}

    if (!options.inMemory && options.autoMigrate !== false) {
      this._ready = ensureDatabaseInitialized(this);
    }
  }

  async ready() {
    if (this._ready) await this._ready;
  }

  normalizeSql(sql) {
    return sql.replace(/\$\d+/g, '?');
  }

  async execute(sql, params = []) {
    await this.ready();
    const normalized = this.normalizeSql(sql);
    const stmt = this.db.prepare(normalized);
    return stmt.run(...params);
  }

  async run(sql, params = []) {
    return this.execute(sql, params);
  }

  async query(sql, params = []) {
    await this.ready();
    const normalized = this.normalizeSql(sql);
    const stmt = this.db.prepare(normalized);
    return stmt.all(...params);
  }

  async queryOne(sql, params = []) {
    await this.ready();
    const normalized = this.normalizeSql(sql);
    const stmt = this.db.prepare(normalized);
    const res = stmt.get(...params);
    return res !== undefined ? res : null;
  }

  async exec(sql) {
    await this.ready();
    this.db.exec(sql);
  }

  /**
   * @template T
   * @param {() => Promise<T>|T} callback
   * @param {{ mode?: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE' }} [options={}]
   * @returns {Promise<T>}
   */
  async transaction(callback, options = {}) {
    await this.ready();
    const mode = options.mode || 'IMMEDIATE';
    const isNested = (this._transactionDepth || 0) > 0;
    const nextDepth = (this._transactionDepth || 0) + 1;
    const savepointName = `sp_${nextDepth}`;

    if (isNested) {
      this.db.exec(`SAVEPOINT ${savepointName};`);
    } else {
      this.db.exec(`BEGIN ${mode} TRANSACTION;`);
    }
    this._transactionDepth = nextDepth;

    try {
      const result = await callback();
      if (isNested) {
        this.db.exec(`RELEASE SAVEPOINT ${savepointName};`);
      } else {
        this.db.exec('COMMIT;');
      }
      return result;
    } catch (err) {
      try {
        if (isNested) {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepointName};`);
        } else {
          this.db.exec('ROLLBACK;');
        }
      } catch {}
      throw err;
    } finally {
      this._transactionDepth--;
    }
  }

  /**
   * @template T
   * @param {() => Promise<T>|T} operation
   * @param {number} [maxRetries=3]
   * @param {number} [baseDelayMs=50]
   * @returns {Promise<T>}
   */
  async withRetry(operation, maxRetries = 3, baseDelayMs = 50) {
    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (err) {
        attempt++;
        if (attempt > maxRetries || !isRetryableSqliteError(err)) {
          if (isRetryableSqliteError(err)) {
            throw new DatabaseBusyError(`Database lock contention after ${attempt} retry attempt(s): ${err.message}`, err);
          }
          throw err;
        }
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), 500) + Math.floor(Math.random() * 20);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  async close() {
    this.db.close();
  }
}

let defaultDbInstance = null;

/**
 * Returns the singleton database instance (Postgres or SQLite).
 * @param {{ dbPath?: string, inMemory?: boolean, connectionString?: string }} [options={}]
 * @returns {Database|PostgresDatabase}
 */
export function getDatabase(options = {}) {
  if (!defaultDbInstance) {
    if (shouldUsePostgres() || options.connectionString) {
      defaultDbInstance = new PostgresDatabase({
        connectionString: options.connectionString || process.env.DATABASE_URL,
      });
    } else {
      defaultDbInstance = new Database(options);
      // Fire-and-forget init; callers should await methods which wait on ready()
      ensureDatabaseInitialized(defaultDbInstance).catch((err) => {
        console.error('[db] SQLite init failed:', err?.message || err);
      });
    }
  }
  return defaultDbInstance;
}

/**
 * Reset singleton (tests only).
 */
export async function resetDatabaseSingleton() {
  if (defaultDbInstance?.close) {
    try {
      await defaultDbInstance.close();
    } catch {}
  }
  defaultDbInstance = null;
}

export { PostgresDatabase, shouldUsePostgres } from './postgres-database.js';

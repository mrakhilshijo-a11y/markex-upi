import test from 'node:test';
import assert from 'node:assert/strict';
import { toPostgresParams, adaptSqliteBooleans, shouldUsePostgres } from '../postgres-database.js';

test('toPostgresParams converts ? placeholders', () => {
  assert.equal(
    toPostgresParams('SELECT * FROM t WHERE a = ? AND b = ?'),
    'SELECT * FROM t WHERE a = $1 AND b = $2',
  );
});

test('adaptSqliteBooleans maps 0/1 comparisons', () => {
  assert.equal(adaptSqliteBooleans('WHERE is_active = 1 AND is_slot_busy = 0'), 'WHERE is_active = true AND is_slot_busy = false');
});

test('shouldUsePostgres respects USE_SQLITE_FALLBACK', () => {
  const prevUrl = process.env.DATABASE_URL;
  const prevFallback = process.env.USE_SQLITE_FALLBACK;
  try {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost/db';
    process.env.USE_SQLITE_FALLBACK = 'true';
    assert.equal(shouldUsePostgres(), false);
    process.env.USE_SQLITE_FALLBACK = 'false';
    assert.equal(shouldUsePostgres(), true);
  } finally {
    if (prevUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevUrl;
    if (prevFallback === undefined) delete process.env.USE_SQLITE_FALLBACK;
    else process.env.USE_SQLITE_FALLBACK = prevFallback;
  }
});

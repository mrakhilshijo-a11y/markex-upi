import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Load root env files without clobbering existing process.env values.
 * Order: `.env` then `.env.local` (Neon CLI vars) so local Neon overrides apply
 * only when the key was not already set.
 * @param {string} [rootDir]
 */
export function loadRootEnv(rootDir = repoRoot) {
  const files = ['.env', '.env.local'];
  for (const name of files) {
    const filePath = path.join(rootDir, name);
    if (!fs.existsSync(filePath)) continue;
    if (typeof process.loadEnvFile === 'function') {
      try {
        // Node's loadEnvFile does not override existing keys.
        process.loadEnvFile(filePath);
        continue;
      } catch {
        // fall through to manual parse
      }
    }
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}

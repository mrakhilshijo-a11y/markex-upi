import fs from 'node:fs';
import path from 'node:path';

function findYoupiRoot(start) {
  let dir = start;
  for (let i = 0; i < 14; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.name === 'youpi-pg') return dir;
      } catch {
        // keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * True when this process was started with that source file.
 * A Netlify bundle rewrites every module's import.meta.url to the bundle,
 * so comparing import.meta.url with argv would start every service.
 * @param {string} suffix path from the repo root, using forward slashes
 */
export function isInvokedPath(suffix) {
  if (!process.argv[1]) return false;
  const invoked = path.resolve(process.argv[1]).split(path.sep).join('/');
  const expected = String(suffix).split(path.sep).join('/').replace(/^\//, '');
  return invoked.endsWith(expected);
}

/**
 * Find a repo file both when Node loads the original module and when
 * Netlify bundles every module into one file. Staged copies live in
 * `netlify/server/assets/<repo path>` beside that bundle.
 * @param {string} fromDir
 * @param {string} repoRelative
 * @param {string} [localRelative]
 */
export function resolveRepoFile(fromDir, repoRelative, localRelative) {
  const rel = repoRelative.split('/').join(path.sep);
  const candidates = [];
  if (localRelative) candidates.push(path.resolve(fromDir, localRelative));
  candidates.push(path.join(fromDir, 'assets', rel));
  candidates.push(path.join(fromDir, 'netlify', 'server', 'assets', rel));
  const root = findYoupiRoot(fromDir) || findYoupiRoot(process.cwd());
  if (root) candidates.push(path.join(root, rel));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0] || path.join(fromDir, rel);
}

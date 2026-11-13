/**
 * Copy runtime files next to the Netlify Server entry.
 * The bundler inlines JavaScript, so HTML, SQL, and public assets have to
 * travel in `includedFiles` and be resolved from `netlify/server/assets`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destRoot = path.join(root, 'netlify', 'server', 'assets');

const copies = [
  ['apps/coin-wallet-store/src', 'apps/coin-wallet-store/src', (name) => name.endsWith('.html')],
  ['apps/coin-wallet-store/public', 'apps/coin-wallet-store/public'],
  ['apps/checkout-portal/src/views', 'apps/checkout-portal/src/views'],
  ['apps/checkout-portal/src/sdk', 'apps/checkout-portal/src/sdk'],
  ['apps/checkout-portal/public', 'apps/checkout-portal/public'],
  ['apps/merchant-admin/src/views', 'apps/merchant-admin/src/views'],
  ['apps/merchant-admin/public', 'apps/merchant-admin/public'],
  ['packages/db/src/schema.sql', 'packages/db/src/schema.sql'],
  ['packages/db/src/sqlite-schema.sql', 'packages/db/src/sqlite-schema.sql'],
  ['openapi.yaml', 'openapi.yaml'],
];

fs.rmSync(destRoot, { recursive: true, force: true });

for (const [fromRel, toRel, filter] of copies) {
  const from = path.join(root, fromRel);
  const to = path.join(destRoot, toRel);
  if (!fs.existsSync(from)) continue;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.statSync(from).isDirectory() && filter) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      if (!filter(name)) continue;
      fs.copyFileSync(path.join(from, name), path.join(to, name));
    }
    continue;
  }
  fs.cpSync(from, to, { recursive: true });
}

console.log('[stage-netlify-assets] staged', destRoot);

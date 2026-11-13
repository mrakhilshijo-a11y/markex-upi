/**
 * Netlify Server entry — single origin for MARKEX:
 *   /api/v1/*          → payment-api
 *   /api/markex/*      → academy store
 *   /api/webhook       → academy store (merchant webhook)
 *   /checkout,/pay,/youpi.js → checkout portal
 *   /admin/*           → merchant admin
 *   /*                 → academy store
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRootEnv } from '../../packages/common/src/load-root-env.js';

const moduleDirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(moduleDirname, '../..');

loadRootEnv(rootDir);

// Netlify sets NETLIFY during the build only. Runtime code must not depend on it.
process.env.NETLIFY = 'true';
process.env.YOUPI_SECRETS_DIR = process.env.YOUPI_SECRETS_DIR || path.join(os.tmpdir(), 'youpi-secrets');

process.env.YOUPI_MODE = process.env.YOUPI_MODE || 'production';
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
if (process.env.DATABASE_URL) {
  process.env.USE_SQLITE_FALLBACK = 'false';
}
process.env.YOUPI_BIND_HOST = process.env.YOUPI_BIND_HOST || '127.0.0.1';
process.env.YOUPI_ALLOW_LOCALHOST_MODE = process.env.YOUPI_ALLOW_LOCALHOST_MODE || 'false';

const INTERNAL = {
  api: Number(process.env.NETLIFY_INTERNAL_API_PORT || 6100),
  checkout: Number(process.env.NETLIFY_INTERNAL_CHECKOUT_PORT || 7100),
  store: Number(process.env.NETLIFY_INTERNAL_STORE_PORT || 5100),
  admin: Number(process.env.NETLIFY_INTERNAL_ADMIN_PORT || 6001),
};

function applyPublicUrls(origin) {
  if (!origin) return;
  const keys = [
    'BASE_PAYMENT_API_URL',
    'BASE_CHECKOUT_URL',
    'BASE_ADMIN_URL',
    'BASE_DEMO_STORE_URL',
    'CHECKOUT_PUBLIC_URL',
    'COIN_STORE_PUBLIC_URL',
  ];
  for (const key of keys) {
    const cur = String(process.env[key] || '');
    if (!cur || cur.includes('localhost') || cur.includes('127.0.0.1') || !cur.startsWith(origin)) {
      process.env[key] = origin;
    }
  }
  for (const key of ['YOUPI_ALLOWED_ORIGINS', 'YOUPI_ALLOWED_RETURN_ORIGINS', 'CHECKOUT_FRAME_ANCESTORS']) {
    const cur = String(process.env[key] || '');
    if (!cur || cur.includes('localhost')) {
      process.env[key] = origin;
    } else if (!cur.includes(origin)) {
      process.env[key] = `${cur} ${origin}`;
    }
  }
  process.env.BASE_PAYMENT_API_URL = process.env.BASE_PAYMENT_API_URL || origin;
  process.env.PAYMENT_API_INTERNAL_URL = `http://127.0.0.1:${INTERNAL.api}`;
}

function proxy(req, res, port) {
  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  const opts = {
    hostname: '127.0.0.1',
    port,
    path: req.url,
    method: req.method,
    headers,
  };
  const upstream = http.request(opts, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (err) => {
    console.error('[netlify-server] proxy error', err?.message || err);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'Upstream unavailable' }));
  });
  req.pipe(upstream);
}

function pickPort(pathname) {
  if (pathname.startsWith('/api/v1')) return INTERNAL.api;
  if (pathname.startsWith('/api/markex') || pathname === '/api/webhook' || pathname.startsWith('/api/webhook')) {
    return INTERNAL.store;
  }
  if (
    pathname.startsWith('/checkout') ||
    pathname.startsWith('/pay') ||
    pathname === '/youpi.js' ||
    pathname.startsWith('/youpi.js') ||
    pathname.startsWith('/assets/checkout') ||
    pathname.startsWith('/icons/') ||
    pathname === '/css/checkout.css' ||
    pathname.startsWith('/css/checkout.') ||
    pathname === '/js/checkout.js' ||
    pathname.startsWith('/js/checkout.')
  ) {
    return INTERNAL.checkout;
  }
  if (pathname.startsWith('/admin')) return INTERNAL.admin;
  return INTERNAL.store;
}

async function bootInternals() {
  const { startServer } = await import('../../apps/payment-api/src/index.js');
  const { startCheckoutServer } = await import('../../apps/checkout-portal/src/index.js');
  const { startCoinWalletStore } = await import('../../apps/coin-wallet-store/src/index.js');
  const { startAdminServer } = await import('../../apps/merchant-admin/src/index.js');

  process.env.PAYMENT_API_PORT = String(INTERNAL.api);
  process.env.CHECKOUT_PORTAL_PORT = String(INTERNAL.checkout);
  process.env.CHECKOUT_PORT = String(INTERNAL.checkout);
  process.env.COIN_STORE_PORT = String(INTERNAL.store);
  process.env.COIN_WALLET_STORE_PORT = String(INTERNAL.store);
  process.env.MERCHANT_ADMIN_PORT = String(INTERNAL.admin);
  process.env.PAYMENT_API_INTERNAL_URL = `http://127.0.0.1:${INTERNAL.api}`;
  process.env.CHECKOUT_PORTAL_URL = `http://127.0.0.1:${INTERNAL.checkout}`;
  process.env.BASE_PAYMENT_API_URL =
    process.env.BASE_PAYMENT_API_URL || `http://127.0.0.1:${INTERNAL.api}`;

  await startServer(INTERNAL.api);
  await startCheckoutServer(INTERNAL.checkout);
  await startCoinWalletStore(INTERNAL.store);
  await startAdminServer(INTERNAL.admin);
  console.log('[netlify-server] Internal services ready', INTERNAL);
}

let bootError = null;
const boot = bootInternals().catch((err) => {
  bootError = err;
  console.error('[netlify-server] boot failed:', err?.stack || err?.message || err);
});

const publicPort = Number(process.env.PORT || 8080);
const publicServer = http.createServer(async (req, res) => {
  try {
    await boot;
  } catch {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Server starting' }));
    return;
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  if (host) applyPublicUrls(`${proto}://${String(host).split(',')[0].trim()}`);

  let pathname = '/';
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname;
  } catch {}

  if (pathname === '/.netlify/health' || pathname === '/healthz') {
    if (bootError) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: bootError.message || 'boot failed' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (bootError) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('MARKEX is starting. Retry in a moment.');
    return;
  }

  proxy(req, res, pickPort(pathname));
});

publicServer.listen(publicPort, '0.0.0.0', () => {
  console.log(`[netlify-server] Listening on ${publicPort}`);
});

export const config = {
  region: 'cmh',
  size: 'small',
  includedFiles: ['assets/**'],
};

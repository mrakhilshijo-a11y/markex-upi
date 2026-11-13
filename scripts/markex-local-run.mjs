#!/usr/bin/env node
/**
 * Durable local runner for MARKEX (API + checkout + academy + admin).
 * Keeps child processes alive and restarts them if they exit.
 *
 * Usage: node scripts/markex-local-run.mjs
 * Stop:  kill $(cat /tmp/markex-local-run.pid)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const pidFile = '/tmp/markex-local-run.pid';
const logDir = '/tmp';

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
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

loadEnvFile(path.join(root, '.env'));
loadEnvFile(path.join(root, '.env.local'));

process.env.YOUPI_ALLOW_LOCALHOST_MODE = process.env.YOUPI_ALLOW_LOCALHOST_MODE || 'true';
process.env.YOUPI_MODE = process.env.YOUPI_MODE || 'localhost';
process.env.PAYMENT_API_PORT = process.env.PAYMENT_API_PORT || '6100';
process.env.CHECKOUT_PORTAL_PORT = process.env.CHECKOUT_PORTAL_PORT || '7100';
process.env.MERCHANT_ADMIN_PORT = process.env.MERCHANT_ADMIN_PORT || '6001';
process.env.COIN_STORE_PORT = process.env.COIN_STORE_PORT || process.env.COIN_WALLET_STORE_PORT || '5100';

const services = [
  {
    name: 'payment-api',
    script: 'apps/payment-api/src/index.js',
    port: process.env.PAYMENT_API_PORT,
    log: path.join(logDir, 'markex-api.log')
  },
  {
    name: 'checkout-portal',
    script: 'apps/checkout-portal/src/index.js',
    port: process.env.CHECKOUT_PORTAL_PORT,
    log: path.join(logDir, 'markex-checkout.log')
  },
  {
    name: 'academy-store',
    script: 'apps/coin-wallet-store/src/index.js',
    port: process.env.COIN_STORE_PORT,
    log: path.join(logDir, 'markex-store.log')
  },
  {
    name: 'merchant-admin',
    script: 'apps/merchant-admin/src/index.js',
    port: process.env.MERCHANT_ADMIN_PORT,
    log: path.join(logDir, 'markex-admin.log')
  }
];

const children = new Map();
let shuttingDown = false;

function stamp(msg) {
  console.log(`[markex-local-run] ${new Date().toISOString()} ${msg}`);
}

function startOne(svc) {
  if (shuttingDown) return;
  const out = fs.openSync(svc.log, 'a');
  const child = spawn(process.execPath, [svc.script], {
    cwd: root,
    env: { ...process.env },
    stdio: ['ignore', out, out],
    detached: false
  });
  children.set(svc.name, child);
  stamp(`started ${svc.name} pid=${child.pid} port=${svc.port} log=${svc.log}`);
  child.on('exit', (code, signal) => {
    children.delete(svc.name);
    stamp(`${svc.name} exited code=${code} signal=${signal || ''}`);
    if (!shuttingDown) {
      setTimeout(() => startOne(svc), 1200);
    }
  });
}

function shutdown() {
  shuttingDown = true;
  stamp('shutting down…');
  for (const child of children.values()) {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
  try {
    if (fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, 'utf8')) === process.pid) {
      fs.unlinkSync(pidFile);
    }
  } catch {}
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (fs.existsSync(pidFile)) {
  const old = Number(fs.readFileSync(pidFile, 'utf8').trim());
  if (old && old !== process.pid) {
    try {
      process.kill(old, 0);
      stamp(`another runner already active pid=${old}; exiting`);
      process.exit(0);
    } catch {
      // stale pid
    }
  }
}

fs.writeFileSync(pidFile, String(process.pid));
stamp(`supervisor pid=${process.pid}`);
stamp(
  `URLs: academy http://127.0.0.1:${process.env.COIN_STORE_PORT} | checkout http://127.0.0.1:${process.env.CHECKOUT_PORTAL_PORT} | admin http://127.0.0.1:${process.env.MERCHANT_ADMIN_PORT} | api http://127.0.0.1:${process.env.PAYMENT_API_PORT}`
);

for (const svc of services) startOne(svc);

// Keep event loop alive
setInterval(() => {}, 60_000);

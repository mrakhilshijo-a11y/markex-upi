import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { getCoinStoreWebhookSecret, LEGACY_DEFAULT_WEBHOOK_SECRET, resolveDefaultBranding, isValidVpa } from '@youpi/common';
import { PostgresDatabase } from './postgres-database.js';
import { MerchantRepository } from './repositories/merchant.repository.js';
import { ReceivingAccountRepository } from './repositories/receiving-account.repository.js';
import { CustomerRepository } from './repositories/customer.repository.js';

const { Client } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Postgres-compatible outbox trigger (replaces SQLite INSERT OR IGNORE trigger in schema.sql).
 */
const PG_PAYMENT_LINKS_SQL = `
CREATE TABLE IF NOT EXISTS payment_links (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    merchant_id TEXT NOT NULL REFERENCES merchants(id),
    course_id TEXT NOT NULL,
    course_name TEXT NOT NULL,
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    student_name TEXT,
    student_mobile TEXT,
    student_email TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE'
      CHECK (status IN ('ACTIVE','USED','EXPIRED','REVOKED','PAID')),
    expires_at TIMESTAMPTZ,
    payment_session_id TEXT REFERENCES payment_sessions(id) ON DELETE SET NULL,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    revoked_by TEXT,
    paid_at TIMESTAMPTZ,
    allow_reuse_after_paid BOOLEAN NOT NULL DEFAULT false,
    metadata TEXT DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_links_token ON payment_links (token);
CREATE INDEX IF NOT EXISTS idx_payment_links_merchant ON payment_links (merchant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_links_status ON payment_links (status);
CREATE INDEX IF NOT EXISTS idx_payment_links_session ON payment_links (payment_session_id);
`;

const PG_OUTBOX_TRIGGER_SQL = `
CREATE TABLE IF NOT EXISTS payment_webhook_outbox (
    payment_id TEXT NOT NULL REFERENCES payment_sessions(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK(event_type IN ('SUCCESS','FAILED','EXPIRED','CANCELLED','OBSERVED_SUCCESS','MANUAL_REVIEW','RECONCILED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (payment_id, event_type)
);

CREATE OR REPLACE FUNCTION trg_terminal_payment_webhook_outbox_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('SUCCESS','FAILED','EXPIRED','CANCELLED','OBSERVED_SUCCESS','MANUAL_REVIEW','RECONCILED')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO payment_webhook_outbox (payment_id, event_type)
    VALUES (NEW.id, NEW.status)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_terminal_payment_webhook_outbox ON payment_sessions;
CREATE TRIGGER trg_terminal_payment_webhook_outbox
AFTER UPDATE OF status ON payment_sessions
FOR EACH ROW
EXECUTE FUNCTION trg_terminal_payment_webhook_outbox_fn();
`;

/**
 * Strip SQLite-only outbox block from schema.sql before applying to Postgres.
 * @param {string} sql
 */
export function preparePostgresSchemaSql(sql) {
  // Remove from "-- Durable terminal-event outbox" through the SQLite trigger END;
  return sql.replace(
    /-- Durable terminal-event outbox[\s\S]*?END;\s*/m,
    '-- (outbox + trigger applied separately for Postgres)\n',
  );
}

/**
 * Apply Postgres DDL using the unpooled connection string.
 * @param {{ connectionString?: string }} [options]
 */
export async function applyPostgresSchema(options = {}) {
  const connectionString =
    options.connectionString ||
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL_UNPOOLED (or DATABASE_URL) is required for Postgres migrations');
  }
  if (connectionString.includes('-pooler.') && !options.connectionString) {
    console.warn('[migrate-postgres] Prefer DATABASE_URL_UNPOOLED for DDL (pooled URL detected).');
  }

  const schemaPath = path.join(__dirname, 'schema.sql');
  let schemaSql = fs.readFileSync(schemaPath, 'utf8');
  schemaSql = preparePostgresSchemaSql(schemaSql);

  const client = new Client({
    connectionString,
    ssl: connectionString.includes('neon.tech') || connectionString.includes('sslmode=require')
      ? { rejectUnauthorized: false }
      : undefined,
  });
  await client.connect();
  try {
    await client.query(schemaSql);
    await client.query(PG_PAYMENT_LINKS_SQL);
    await client.query(PG_OUTBOX_TRIGGER_SQL);
  } finally {
    await client.end();
  }
  return { ok: true };
}

/**
 * Seed default MARKEX merchant + receiving account (same semantics as SQLite migrate).
 * @param {PostgresDatabase} db
 */
export async function seedPostgresDefaults(db) {
  const merchantRepo = new MerchantRepository(db);
  const existing = await merchantRepo.findAll();

  let defaultMerchant;
  if (existing.length === 0) {
    const branding = resolveDefaultBranding();
    const businessName = process.env.MERCHANT_NAME || process.env.DEFAULT_MERCHANT_NAME || 'MARKEX TRADING ACADEMY';
    const slug = process.env.DEFAULT_MERCHANT_SLUG || 'markex-academy';
    const contactEmail = process.env.DEFAULT_SUPPORT_EMAIL || 'support@markex-academy.com';
    const contactPhone = process.env.DEFAULT_SUPPORT_PHONE || '8137864105';

    defaultMerchant = await merchantRepo.create({
      id: '00000000-0000-0000-0000-000000000001',
      businessName,
      slug,
      contactEmail,
      contactPhone,
      webhookUrl: process.env.COIN_STORE_WEBHOOK_URL || 'http://localhost:5000/api/webhook',
      webhookSecret: getCoinStoreWebhookSecret(),
      branding: {
        appName: branding.appName,
        primaryColor: branding.primaryColor,
        logoUrl: branding.logoUrl,
        trustBadgeText: branding.trustBadgeText,
        footerGuarantee: branding.footerGuarantee,
        businessName,
        website: 'https://markex-academy.com',
        sellingMode: 'ONLINE',
        enabledPaymentMethods: ['UPI', 'BANK_TRANSFER'],
      },
    });
  } else {
    defaultMerchant = existing[0];
    if (!defaultMerchant.webhookSecret) {
      await merchantRepo.update(defaultMerchant.id, {
        webhookUrl: 'http://localhost:5000/api/webhook',
        webhookSecret: getCoinStoreWebhookSecret(),
      });
    } else if (defaultMerchant.webhookSecret === LEGACY_DEFAULT_WEBHOOK_SECRET) {
      await merchantRepo.update(defaultMerchant.id, { webhookSecret: getCoinStoreWebhookSecret() });
      console.warn('[migrate-postgres] Rotated legacy webhook secret.');
    }

    const desiredName = (process.env.MERCHANT_NAME || process.env.DEFAULT_MERCHANT_NAME || '').trim();
    const currentBranding = defaultMerchant.branding || {};
    const branding = resolveDefaultBranding(currentBranding);
    const bankConfigured = Boolean(
      String(process.env.MERCHANT_BANK_ACCOUNT || '').trim() &&
        String(process.env.MERCHANT_IFSC || '').trim(),
    );
    const methods = Array.isArray(currentBranding.enabledPaymentMethods)
      ? [...currentBranding.enabledPaymentMethods]
      : ['UPI'];
    if (bankConfigured && !methods.includes('BANK_TRANSFER')) methods.push('BANK_TRANSFER');
    const needsMethodSync = bankConfigured && !(currentBranding.enabledPaymentMethods || []).includes('BANK_TRANSFER');
    const needsNameSync = Boolean(desiredName && desiredName !== defaultMerchant.businessName);
    if (needsNameSync || needsMethodSync) {
      await merchantRepo.update(defaultMerchant.id, {
        businessName: desiredName || defaultMerchant.businessName,
        branding: {
          ...currentBranding,
          appName: branding.appName,
          primaryColor: branding.primaryColor,
          trustBadgeText: branding.trustBadgeText,
          footerGuarantee: branding.footerGuarantee,
          businessName: desiredName || currentBranding.businessName || defaultMerchant.businessName,
          website: currentBranding.website || 'https://markex-academy.com',
          sellingMode: currentBranding.sellingMode || 'ONLINE',
          enabledPaymentMethods: methods,
        },
      });
      defaultMerchant = (await merchantRepo.findById(defaultMerchant.id)) || defaultMerchant;
    }
  }

  const accountRepo = new ReceivingAccountRepository(db);
  const accounts = await accountRepo.findByMerchantId(defaultMerchant.id);
  const envVpa = String(process.env.MERCHANT_UPI_ID || process.env.DEFAULT_PAYEE_VPA || '').trim();
  const payeeName = process.env.MERCHANT_NAME || defaultMerchant.businessName || 'MARKEX TRADING ACADEMY';
  if (accounts.length === 0) {
    await accountRepo.create({
      id: '00000000-0000-0000-0000-000000000002',
      merchantId: defaultMerchant.id,
      upiId: envVpa && isValidVpa(envVpa) ? envVpa : 'merchant@upi',
      payeeName,
      isActive: true,
    });
  } else if (envVpa && isValidVpa(envVpa)) {
    const active = accounts.find((a) => a.isActive) || accounts[0];
    if (active && active.upiId !== envVpa) {
      try {
        await accountRepo.upsertActiveForMerchant(defaultMerchant.id, envVpa, payeeName);
      } catch (err) {
        console.warn('[migrate-postgres] Could not sync MERCHANT_UPI_ID:', err.message);
      }
    }
  }

  if (process.env.YOUPI_SEED_DEMO_CUSTOMER === 'true') {
    const customerRepo = new CustomerRepository(db);
    const demoMobile = '9000000000';
    if (!(await customerRepo.findByMobile(demoMobile))) {
      await customerRepo.create({
        id: '00000000-0000-0000-0000-000000000002',
        name: 'Demo Customer',
        email: 'demo-customer@youpi.local',
        mobileNumber: demoMobile,
        isPhoneVerified: false,
      });
    }
  }

  return { defaultMerchant };
}

/**
 * Full Postgres migrate: schema + seed.
 */
export async function runPostgresMigrations(options = {}) {
  await applyPostgresSchema(options);
  const db = new PostgresDatabase({
    connectionString: options.connectionString || process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED,
  });
  try {
    const seeded = await seedPostgresDefaults(db);
    return { db, ...seeded };
  } finally {
    await db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('Running YOUPI PG Postgres migrations...');
  runPostgresMigrations()
    .then((result) => {
      console.log(`Postgres migration OK. Default merchant: ${result.defaultMerchant.businessName}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Postgres migration failed:', err?.message || err);
      process.exit(1);
    });
}

# MARKEX — Netlify + Neon deploy checklist

## Prerequisites
1. Neon project with schema applied: `npm run db:migrate:pg` (uses `DATABASE_URL_UNPOOLED`).
2. Netlify site with **Server (Early Access)** enabled.
3. Node 24 on the build (`NODE_VERSION=24` in `netlify.toml`).

## Environment
Paste keys from `.env.production.netlify` (gitignored) into Netlify → Site configuration → Environment variables.

Required:
- `DATABASE_URL` (pooled), `DATABASE_URL_UNPOOLED` (direct)
- `USE_SQLITE_FALLBACK=false`
- `ADMIN_API_TOKEN`, `JWT_SECRET`, `ENCRYPTION_MASTER_KEY`
- `MERCHANT_UPI_ID`, `MERCHANT_BANK_ACCOUNT`, `MERCHANT_IFSC`
- All `BASE_*` / origin URLs set to your real Netlify HTTPS origin

## Deploy
1. Push `feature/netlify-neon-live` (or merge) and connect the repo in Netlify, **or** `netlify deploy --prod` with CLI ≥ 27.17.
2. Confirm build uses Node 24 and detects `netlify/server/`.
3. Open `https://<site>/healthz` → `{ ok: true }`.
4. Open `/` (academy), `/admin`, `/checkout/...` after creating a payment.

## Smoke test
1. Create a payment from the academy store.
2. Pay via UPI or bank-transfer rail (small amount).
3. Confirm manually in admin (`PAYMENT_VERIFICATION_MODE=manual`).
4. Verify webhook / order status UI.

## Security
- Rotate any Neon password that was ever pasted into chat.
- Never commit `.env*`, `.neon`, or production secrets.

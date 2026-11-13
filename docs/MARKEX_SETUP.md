# MARKEX Trading Academy — Local Setup

Direct UPI payment acceptance on YouPI-PG for **MARKEX TRADING ACADEMY**.

## Important honesty notes

- This is **direct UPI** (QR / intent) to your merchant VPA. Students **may see the UPI ID**.
- Students can also pay via **Bank Transfer** (NEFT/IMPS/RTGS). Account number and IFSC are shown **only on the checkout payment screen** (from server `.env`), not on the academy landing page.
- This stack **cannot pull money** from a student’s bank via API. The student initiates UPI or bank transfer; admin confirms credit.
- This is **not** a bank-approved hosted payment gateway (Razorpay/Cashfree/etc.).
- Payments become **successful only after admin confirmation** against your real bank statement.
- Settlement to your MARKEX bank account depends on your UPI VPA / account linkage. Confirm with a real ₹1–test before relying on it.

## Environment

```bash
cp .env.example .env
# Edit .env with your local authorized values:
# MERCHANT_UPI_ID=...
# MERCHANT_NAME=MARKEX TRADING ACADEMY
# MERCHANT_BANK_ACCOUNT=...   # never commit
# MERCHANT_IFSC=...           # never commit
# PAYMENT_VERIFICATION_MODE=manual
# CHECKOUT_GUEST_MODE=true
```

`.env` is gitignored. Never commit real credentials.

## Start locally

```bash
npm install
npm run dev
```

| Service | URL |
|---------|-----|
| Academy storefront | http://localhost:5100 (or `COIN_STORE_PORT`; avoid macOS AirPlay on 5000) |
| Checkout portal | http://localhost:7100 (or `CHECKOUT_PORTAL_PORT`; avoid macOS Control Center on 7000) |
| Merchant admin | http://localhost:6001 |
| Payment API | http://localhost:6100 |
| Control Center | http://localhost:8090 (`npm run dev`) |

On macOS, ports **5000** and **7000** are often taken by AirPlay / Control Center. This project’s local `.env` may use **5100** / **7100** instead.

Admin APIs require `ADMIN_API_TOKEN` (auto-generated under `data/.secrets/` on first boot, or set in `.env`).

## Student flows

1. **Open checkout:** http://localhost:5100 — choose course → enter name/mobile → pay via **UPI QR** or **Bank Transfer** → submit for review.
2. **Payment link:** Admin → Daily Operations → MARKEX Academy → Generate Secure Link → copy / WhatsApp share → student opens `/pay/<token>`.

## Admin verification

1. Open http://localhost:6001 → authenticate with admin token.
2. MARKEX Academy → Pending Manual Verification.
3. Check your bank statement independently.
4. Confirm or Reject. Only Confirm marks payment `RECONCILED` / successful.

## Courses (server-priced)

| Course | Amount |
|--------|--------|
| Initial | ₹5,000 |
| Advanced | ₹10,000 |
| Complete | ₹15,000 |

Browser-supplied amounts are rejected.

## Future PSP upgrade

`PAYMENT_PROVIDER=psp_hosted` is reserved. Set it only after merchant KYC and real provider keys. The app falls back to `direct_upi` until then.

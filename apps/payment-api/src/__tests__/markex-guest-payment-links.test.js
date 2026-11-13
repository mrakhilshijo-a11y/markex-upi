import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { createPaymentApp } from '../index.js';
import { getMarkexCourse, listMarkexCourses, resolveActivePaymentProvider, getAdminToken } from '@youpi/common';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.rawServer.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, base: `http://127.0.0.1:${port}`, app });
    });
  });
}

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

test('MARKEX course catalog locks server-side prices', () => {
  assert.equal(getMarkexCourse('initial').amountPaise, 500000);
  assert.equal(getMarkexCourse('advanced').amountPaise, 1000000);
  assert.equal(getMarkexCourse('complete').amountPaise, 1500000);
  assert.equal(listMarkexCourses().length, 3);
  assert.equal(resolveActivePaymentProvider({ PAYMENT_PROVIDER: 'direct_upi' }).exposesMerchantVpa, true);
});

test('MARKEX guest checkout, payment links, and manual admin confirm', async (t) => {
  process.env.CHECKOUT_GUEST_MODE = 'true';
  process.env.PAYMENT_VERIFICATION_MODE = 'manual';
  process.env.MERCHANT_UPI_ID = 'markex-test@upi';
  process.env.MERCHANT_NAME = 'MARKEX TRADING ACADEMY';
  process.env.DEFAULT_MERCHANT_NAME = 'MARKEX TRADING ACADEMY';
  // Synthetic settlement secrets for leak checks only — never put production bank details in tests
  process.env.MERCHANT_BANK_ACCOUNT = '99999999999999';
  process.env.MERCHANT_IFSC = 'TEST0001333';

  const db = new Database({ inMemory: true });
  const app = createPaymentApp(db);
  const { server, base } = await listen(app);
  const adminToken = getAdminToken();

  t.after(() => {
    app.destroy();
    server.close();
  });

  // Create payment link
  const created = await jsonFetch(`${base}/api/v1/admin/payment-links`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      courseId: 'initial',
      studentName: 'Test Student',
      studentMobile: '9876543210',
      expiresInHours: 24
    })
  });
  assert.equal(created.res.status, 201);
  assert.equal(created.body.link.amountPaise, 500000);
  assert.match(created.body.link.url, /\/pay\/[a-f0-9]+$/i);
  assert.ok(!JSON.stringify(created.body).includes('99999999999999'));
  assert.ok(!JSON.stringify(created.body).includes('TEST0001333'));

  const token = created.body.link.token;

  // Reject amount tampering on create
  const tamper = await jsonFetch(`${base}/api/v1/admin/payment-links`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ courseId: 'advanced', amountPaise: 100 })
  });
  assert.equal(tamper.res.status, 400);

  // Open link
  const opened = await jsonFetch(`${base}/api/v1/pay-links/${token}/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      studentName: 'Test Student',
      studentMobile: '9876543210',
      studentEmail: 'student@example.com'
    })
  });
  assert.equal(opened.res.status, 201);
  assert.equal(opened.body.amountPaise, 500000);
  const paymentId = opened.body.paymentId;

  // Guest bind (no OTP)
  const bound = await jsonFetch(`${base}/api/v1/checkout/${paymentId}/bind-guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      studentName: 'Test Student',
      studentMobile: '9876543210',
      studentEmail: 'student@example.com'
    })
  });
  assert.equal(bound.res.status, 200);
  assert.ok(bound.body.token);
  assert.ok(['ACTIVE', 'QUEUED'].includes(bound.body.status));

  // Checkout state exposes bank transfer details only when BANK_TRANSFER is enabled
  const state = await jsonFetch(`${base}/api/v1/checkout/${paymentId}/state`);
  assert.equal(state.res.status, 200);
  assert.equal(state.body.metadata.courseId, 'initial');
  assert.ok(Array.isArray(state.body.enabledMethods));
  assert.ok(state.body.enabledMethods.includes('UPI'));
  assert.ok(state.body.enabledMethods.includes('BANK_TRANSFER'));
  assert.ok(state.body.bankTransfer);
  assert.equal(state.body.bankTransfer.accountNumber, '99999999999999');
  assert.equal(state.body.bankTransfer.ifsc, 'TEST0001333');
  assert.equal(state.body.bankTransfer.accountUpiVpa, '99999999999999@TEST0001333.ifsc.npci');
  assert.ok(state.body.bankTransferUpiUri);
  assert.ok(String(state.body.bankTransferUpiUri).includes('TEST0001333.ifsc.npci'));
  assert.equal(state.body.upiServerIndicator?.tier, 'GREEN');

  const bankSelect = await jsonFetch(`${base}/api/v1/checkout/${paymentId}/select-method`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'BANK_TRANSFER' })
  });
  assert.equal(bankSelect.res.status, 200);
  assert.equal(bankSelect.body.method, 'BANK_TRANSFER');
  assert.ok(bankSelect.body.bankTransfer?.accountNumber);

  // Switch back to UPI for remaining manual-confirm flow
  const upiSelect = await jsonFetch(`${base}/api/v1/checkout/${paymentId}/select-method`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'UPI' })
  });
  assert.equal(upiSelect.res.status, 200);

  // Student submit for review does NOT mark success
  const pending = await jsonFetch(`${base}/api/v1/checkout/${paymentId}/submit-for-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ utr: 'MARKEXUTR123456' })
  });
  assert.equal(pending.res.status, 200);
  assert.equal(pending.body.status, 'PENDING_VERIFICATION');

  const afterClaim = await jsonFetch(`${base}/api/v1/checkout/${paymentId}/state`);
  assert.equal(afterClaim.body.status, 'MANUAL_REVIEW');

  // Unauthenticated confirm must fail
  const unauth = await jsonFetch(`${base}/api/v1/admin/payments/${paymentId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operatorId: 'hacker' })
  });
  assert.ok(unauth.res.status === 401 || unauth.res.status === 403);

  // Admin confirm
  const confirmed = await jsonFetch(`${base}/api/v1/admin/payments/${paymentId}/confirm`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      operatorId: 'admin',
      notes: 'Matched FDRL statement',
      bankReference: 'MARKEXUTR123456'
    })
  });
  assert.equal(confirmed.res.status, 200);
  assert.equal(confirmed.body.confirmed, true);
  assert.equal(confirmed.body.status, 'RECONCILED');

  const dash = await jsonFetch(`${base}/api/v1/admin/markex/dashboard`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(dash.res.status, 200);
  assert.ok(dash.body.successfulPayments >= 1);
  assert.ok(!JSON.stringify(dash.body).includes('99999999999999'));

  // Revoke another link
  const link2 = await jsonFetch(`${base}/api/v1/admin/payment-links`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ courseId: 'complete' })
  });
  const revoked = await jsonFetch(`${base}/api/v1/admin/payment-links/${link2.body.link.id}/revoke`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ actorId: 'admin' })
  });
  assert.equal(revoked.res.status, 200);
  assert.equal(revoked.body.link.status, 'REVOKED');
});

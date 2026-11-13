import fs from 'node:fs';
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile('/Users/m/Desktop/PAYMENT-GATEWAY/YouPI-PG/.env'); } catch {}
}
import { getAdminToken } from '@youpi/common';
import { spawnSync } from 'node:child_process';

const API = 'http://127.0.0.1:6100';
const STORE = 'http://127.0.0.1:5100';
const CHECKOUT = 'http://127.0.0.1:7100';
const ADMIN = 'http://127.0.0.1:6001';
const DB = '/Users/m/Desktop/PAYMENT-GATEWAY/YouPI-PG/data/youpi_pg.sqlite';
const token = getAdminToken();
const results = [];
const pass = (name, detail='') => { results.push({name, ok:true, detail}); console.log('PASS:', name, detail||''); };
const fail = (name, detail='') => { results.push({name, ok:false, detail}); console.log('FAIL:', name, detail||''); };
const bankSecret = process.env.MERCHANT_BANK_ACCOUNT || '';
const ifscSecret = process.env.MERCHANT_IFSC || '';
const scrub = (s) => {
  let out = String(s).replace(/[0-9]{10,}@[A-Za-z0-9._-]+/g, '[UPI_REDACTED]');
  if (bankSecret) out = out.split(bankSecret).join('[BANK_REDACTED]');
  if (ifscSecret) out = out.split(ifscSecret).join('[IFSC_REDACTED]');
  out = out.replace(new RegExp(String(token).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'g'), '[ADMIN_TOKEN_REDACTED]');
  return out;
};
const containsBankSecrets = (text) => {
  const s = String(text || '');
  if (bankSecret && s.includes(bankSecret)) return true;
  if (ifscSecret && s.includes(ifscSecret)) return true;
  return false;
};

async function jfetch(url, opts={}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { res, body, text };
}

function sql(cmd) {
  const r = spawnSync('sqlite3', [DB, cmd], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'sqlite failed');
  return r.stdout.trim();
}

async function clearActiveSlots() {
  // Free UPI slots so guest bind can reach ACTIVE (single-slot FIFO)
  sql(`UPDATE payment_sessions
       SET status = 'EXPIRED', updated_at = datetime('now'), completed_at = datetime('now')
       WHERE status IN ('ACTIVE','PROCESSING','QUEUED','INITIATED')
         AND order_id LIKE 'MARKEX-%';`);
  sql(`UPDATE payment_receiving_accounts
       SET is_slot_busy = 0, current_active_session_id = NULL
       WHERE is_active = 1;`);
}

async function main() {
  await clearActiveSlots();

  // PHASE 3
  {
    const r = await jfetch(`${STORE}/`);
    const html = r.text;
    (r.res.status===200 && html.includes('MARKEX') && !html.includes('Mitto Pay') && !html.includes('V-Visa')) ? pass('academy branding') : fail('academy branding', String(r.res.status));
    (!html.includes('WhatsApp OTP') && !html.includes('Sign in to Pay')) ? pass('no OTP on academy page') : fail('no OTP on academy page');
    (!/[0-9]{10,}@/.test(html) && !containsBankSecrets(html)) ? pass('academy page no bank secrets') : fail('academy page leaked secrets');
  }
  {
    const r = await jfetch(`${STORE}/api/markex/courses`);
    const map = Object.fromEntries((r.body.courses||[]).map(c => [c.id, c.amountPaise]));
    (map.initial===500000 && map.advanced===1000000 && map.complete===1500000) ? pass('course prices server catalog') : fail('course prices', scrub(JSON.stringify(map)));
  }

  let paymentId;
  let utrAlpha;
  {
    const tamper = await jfetch(`${STORE}/api/markex/checkout`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ courseId:'initial', studentName:'Test Student Alpha', studentMobile:'9876501234', amountPaise:1 })
    });
    if (tamper.res.status===400) pass('store rejects amount tampering');
    else if (tamper.res.ok && tamper.body.amountPaise===500000) pass('store ignores amount tampering (locked)');
    else fail('store amount tamper', `status=${tamper.res.status}`);

    const r = await jfetch(`${STORE}/api/markex/checkout`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ courseId:'initial', studentName:'Test Student Alpha', studentMobile:'9876501234', studentEmail:'alpha@example.com' })
    });
    if (r.res.ok && r.body.amountPaise===500000) { pass('store checkout creates initial ₹5000'); paymentId = r.body.paymentId; }
    else fail('store checkout create', scrub(JSON.stringify(r.body)));
  }

  if (paymentId) {
    const page = await jfetch(`${CHECKOUT}/checkout/${paymentId}`);
    (page.res.status===200 && page.text.includes('Student Checkout') && page.text.includes('No login or OTP')) ? pass('checkout guest UI') : fail('checkout guest UI', String(page.res.status));
    (page.text.includes('handleGuestCheckoutSubmit') || page.text.includes('bind-guest')) ? pass('guest JS present') : fail('guest JS present');
    // Bank account/IFSC may appear on checkout when BANK_TRANSFER is enabled (intentional).
    // ADMIN_API_TOKEN must never appear in checkout HTML.
    (!page.text.includes(token)) ? pass('checkout HTML has no admin token') : fail('checkout HTML admin token leak');

    const bind = await jfetch(`${API}/api/v1/checkout/${paymentId}/bind-guest`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ studentName:'Test Student Alpha', studentMobile:'9876501234', studentEmail:'alpha@example.com' })
    });
    (bind.res.ok && ['ACTIVE','QUEUED'].includes(bind.body.status)) ? pass('guest bind activates session', bind.body.status) : fail('guest bind', scrub(JSON.stringify(bind.body)));

    const state = await jfetch(`${API}/api/v1/checkout/${paymentId}/state`);
    state.res.ok ? pass('checkout state ok', state.body.status) : fail('checkout state');
    (state.body.upiServerIndicator?.tier === 'GREEN' || state.body.upiServerIndicator?.isWorking === true)
      ? pass('UPI health GREEN in manual mode')
      : fail('UPI health not green', scrub(JSON.stringify(state.body.upiServerIndicator || {})));
    (state.body.upiUri || state.body.payeeVpa) ? pass('UPI QR/intent fields present') : fail('UPI fields missing', state.body.status);
    (Array.isArray(state.body.enabledMethods) && state.body.enabledMethods.includes('BANK_TRANSFER'))
      ? pass('BANK_TRANSFER enabled')
      : fail('BANK_TRANSFER missing', scrub(JSON.stringify(state.body.enabledMethods || [])));
    (state.body.bankTransfer?.accountNumber && state.body.bankTransfer?.ifsc)
      ? pass('bank transfer details present for checkout')
      : fail('bank transfer details missing');

    const bankSel = await jfetch(`${API}/api/v1/checkout/${paymentId}/select-method`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ method:'BANK_TRANSFER' })
    });
    (bankSel.res.ok && bankSel.body.method==='BANK_TRANSFER')
      ? pass('select BANK_TRANSFER ok')
      : fail('select BANK_TRANSFER', scrub(JSON.stringify(bankSel.body)));
    await jfetch(`${API}/api/v1/checkout/${paymentId}/select-method`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ method:'UPI' })
    });

    utrAlpha = `TESTUTRALPHA${Date.now()}`;
    const sub = await jfetch(`${API}/api/v1/checkout/${paymentId}/submit-for-review`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ utr: utrAlpha })
    });
    (sub.res.ok && sub.body.status==='PENDING_VERIFICATION') ? pass('submit-for-review -> pending') : fail('submit-for-review', scrub(JSON.stringify(sub.body)));
    const after = await jfetch(`${API}/api/v1/checkout/${paymentId}/state`);
    (after.body.status==='MANUAL_REVIEW') ? pass('status MANUAL_REVIEW pending admin') : fail('pending status', after.body.status);

    const selfConfirm = await jfetch(`${API}/api/v1/admin/payments/${paymentId}/confirm`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ operatorId:'student' })
    });
    (selfConfirm.res.status===401 || selfConfirm.res.status===403) ? pass('student cannot confirm payment') : fail('student confirm blocked', `status=${selfConfirm.res.status}`);
  }

  // PHASE 4
  let linkToken, linkId;
  {
    const bad = await jfetch(`${API}/api/v1/admin/payment-links`, {
      method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body: JSON.stringify({ courseId:'advanced', amountPaise:100 })
    });
    (bad.res.status===400) ? pass('admin link rejects amount tamper') : fail('admin link tamper', `status=${bad.res.status}`);

    const created = await jfetch(`${API}/api/v1/admin/payment-links`, {
      method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body: JSON.stringify({ courseId:'advanced', studentName:'Link Student', studentMobile:'9123456780', expiresInHours:24 })
    });
    if (created.res.status===201 && created.body.link?.amountPaise===1000000 && /^[a-f0-9]{64}$/i.test(created.body.link.token)) {
      pass('payment link created locked ₹10000', `tokenLen=${created.body.link.token.length}`);
      linkToken = created.body.link.token; linkId = created.body.link.id;
    } else fail('payment link create', scrub(JSON.stringify(created.body)));
    (created.body.whatsappShareText && created.body.link?.url && created.body.whatsappShareText.includes(created.body.link.url)) ? pass('whatsapp share text includes URL') : fail('whatsapp share text');

    const unauth = await jfetch(`${API}/api/v1/admin/payment-links`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ courseId:'complete' })
    });
    (unauth.res.status===401 || unauth.res.status===403) ? pass('unauth cannot create payment links') : fail('unauth create links', `status=${unauth.res.status}`);
  }

  if (linkToken) {
    const pub = await jfetch(`${API}/api/v1/pay-links/${linkToken}`);
    (pub.res.ok && pub.body.amountPaise===1000000 && pub.body.courseId==='advanced') ? pass('public link resolve locked amount') : fail('public link resolve', scrub(JSON.stringify(pub.body)));
    const pubText = JSON.stringify(pub.body);
    (!containsBankSecrets(pubText)) ? pass('public link no bank secrets') : fail('public link leaked bank');

    const page = await jfetch(`${CHECKOUT}/pay/${linkToken}`);
    (page.res.status===200 && page.text.includes('MARKEX')) ? pass('pay-link HTML page') : fail('pay-link HTML', String(page.res.status));

    const open = await jfetch(`${API}/api/v1/pay-links/${linkToken}/open`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ studentName:'Link Student', studentMobile:'9123456780' })
    });
    (open.res.status===201 && open.body.amountPaise===1000000) ? pass('open link creates session') : fail('open link', scrub(JSON.stringify(open.body)));
  }

  // Expired
  {
    const created = await jfetch(`${API}/api/v1/admin/payment-links`, {
      method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body: JSON.stringify({ courseId:'complete', expiresInHours:72 })
    });
    const id = created.body.link.id; const tok = created.body.link.token;
    // Force an ISO-UTC past expiry (avoid SQLite datetime() local/UTC ambiguity)
    const pastIso = new Date(Date.now() - 3600_000).toISOString();
    sql(`UPDATE payment_links SET expires_at = '${pastIso}' WHERE id = '${id.replace(/'/g,"''")}';`);
    const expired = await jfetch(`${API}/api/v1/pay-links/${tok}`);
    (expired.res.status===410 && expired.body.error==='EXPIRED') ? pass('expired link rejected') : fail('expired link', `status=${expired.res.status} ${scrub(JSON.stringify(expired.body))}`);
  }

  // Revoke
  {
    const created = await jfetch(`${API}/api/v1/admin/payment-links`, {
      method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body: JSON.stringify({ courseId:'initial' })
    });
    const id = created.body.link.id; const tok = created.body.link.token;
    const rev = await jfetch(`${API}/api/v1/admin/payment-links/${id}/revoke`, {
      method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body: JSON.stringify({ actorId:'admin' })
    });
    (rev.res.ok && rev.body.link.status==='REVOKED') ? pass('revoke payment link') : fail('revoke', scrub(JSON.stringify(rev.body)));
    const open = await jfetch(`${API}/api/v1/pay-links/${tok}/open`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ studentName:'X', studentMobile:'9000000001' })
    });
    (open.res.status===410 && open.body.error==='REVOKED') ? pass('revoked link rejected on open') : fail('revoked open', `status=${open.res.status}`);
  }

  // PHASE 5
  {
    const dash = await jfetch(`${API}/api/v1/admin/markex/dashboard`, { headers:{Authorization:`Bearer ${token}`} });
    (dash.res.ok && typeof dash.body.totalCollectionsPaise==='number') ? pass('markex dashboard') : fail('markex dashboard', scrub(JSON.stringify(dash.body)));
    const dtxt = JSON.stringify(dash.body);
    (!containsBankSecrets(dtxt)) ? pass('dashboard omits bank/IFSC') : fail('dashboard leaked bank');
    const unauthDash = await jfetch(`${API}/api/v1/admin/markex/dashboard`);
    (unauthDash.res.status===401 || unauthDash.res.status===403) ? pass('dashboard requires auth') : fail('dashboard auth', `status=${unauthDash.res.status}`);
    const adminHtml = await jfetch(`${ADMIN}/`);
    (adminHtml.res.status===200 && (adminHtml.text.includes('MARKEX Academy') || adminHtml.text.includes('subViewOpsMarkex'))) ? pass('admin UI has MARKEX tab') : fail('admin UI MARKEX tab');
    (!containsBankSecrets(adminHtml.text) && !adminHtml.text.includes(token)) ? pass('admin HTML no secrets') : fail('admin HTML secrets');
  }

  if (paymentId) {
    const confirm = await jfetch(`${API}/api/v1/admin/payments/${paymentId}/confirm`, {
      method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body: JSON.stringify({ operatorId:'admin-tester', notes:'Local test confirm', bankReference: utrAlpha || `CONF${Date.now()}` })
    });
    (confirm.res.ok && confirm.body.confirmed && confirm.body.status==='RECONCILED') ? pass('admin confirm payment') : fail('admin confirm', scrub(JSON.stringify(confirm.body)));
    const again = await jfetch(`${API}/api/v1/admin/payments/${paymentId}/confirm`, {
      method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body: JSON.stringify({ operatorId:'admin-tester' })
    });
    (again.res.status===409) ? pass('duplicate confirm rejected') : fail('duplicate confirm', `status=${again.res.status}`);
  }

  {
    await clearActiveSlots();
    const r2 = await jfetch(`${STORE}/api/markex/checkout`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ courseId:'complete', studentName:'Reject Me', studentMobile:'9888877776' })
    });
    const pid = r2.body.paymentId;
    const bind2 = await jfetch(`${API}/api/v1/checkout/${pid}/bind-guest`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ studentName:'Reject Me', studentMobile:'9888877776' }) });
    if (bind2.body.status !== 'ACTIVE') fail('reject-flow bind not ACTIVE', String(bind2.body.status));
    await jfetch(`${API}/api/v1/checkout/${pid}/submit-for-review`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ utr:'TESTUTRREJECT01' }) });
    const rej = await jfetch(`${API}/api/v1/admin/payments/${pid}/reject`, {
      method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body: JSON.stringify({ operatorId:'admin-tester', reason:'No matching bank credit (test)' })
    });
    (rej.res.ok && rej.body.rejected && rej.body.status==='FAILED') ? pass('admin reject payment') : fail('admin reject', scrub(JSON.stringify(rej.body)));
  }

  {
    await clearActiveSlots();
    const a = await jfetch(`${STORE}/api/markex/checkout`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ courseId:'initial', studentName:'Dup One', studentMobile:'9777766665' }) });
    const b = await jfetch(`${STORE}/api/markex/checkout`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ courseId:'initial', studentName:'Dup Two', studentMobile:'9666655554' }) });
    await jfetch(`${API}/api/v1/checkout/${a.body.paymentId}/bind-guest`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ studentName:'Dup One', studentMobile:'9777766665' })});
    await jfetch(`${API}/api/v1/checkout/${a.body.paymentId}/submit-for-review`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ utr:'DUPLICATEUTR999' })});
    // Second student after first is pending review (slot freed on submit-for-review)
    await jfetch(`${API}/api/v1/checkout/${b.body.paymentId}/bind-guest`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ studentName:'Dup Two', studentMobile:'9666655554' })});
    const dup = await jfetch(`${API}/api/v1/checkout/${b.body.paymentId}/submit-for-review`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ utr:'DUPLICATEUTR999' })});
    (dup.res.status===409) ? pass('duplicate UTR rejected') : fail('duplicate UTR', `status=${dup.res.status} ${scrub(JSON.stringify(dup.body))}`);
  }

  {
    const ledger = await jfetch(`${API}/api/v1/admin/payments?limit=20`, { headers:{Authorization:`Bearer ${token}`} });
    (ledger.res.ok && Array.isArray(ledger.body.payments)) ? pass('transactions ledger') : fail('transactions ledger');
  }

  // Advanced + complete quick create
  for (const [courseId, amount] of [['advanced',1000000],['complete',1500000]]) {
    const r = await jfetch(`${STORE}/api/markex/checkout`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ courseId, studentName:`Student ${courseId}`, studentMobile: courseId==='advanced'?'9555544443':'9444433332' })
    });
    (r.res.ok && r.body.amountPaise===amount) ? pass(`course ${courseId} amount locked`) : fail(`course ${courseId}`, scrub(JSON.stringify(r.body)));
  }

  const passed = results.filter(r=>r.ok).length;
  const failed = results.filter(r=>!r.ok);
  console.log('\n=== SUMMARY ===');
  console.log('passed='+passed);
  console.log('failed='+failed.length);
  for (const f of failed) console.log(' -', f.name, '::', f.detail);
  fs.writeFileSync('/tmp/markex-manual-test-results.json', JSON.stringify({passed, failed: failed.length, results}, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => { console.error('SCRIPT_ERROR', scrub(err.stack||err.message)); process.exit(2); });

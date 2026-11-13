import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Database,
  runMigrations,
  MerchantRepository,
  ReceivingAccountRepository,
  CustomerRepository,
  PaymentSessionRepository,
  ObservationRepository,
  SupportTicketRepository,
  AuditLogRepository
} from '../index.js';
import { PaymentStatus, PaymentMethod, ObserverSource, SenderType, TicketStatus } from '@youpi/common';

describe('@youpi/db Unit & Integration Tests', () => {
  let db;
  let merchantRepo;
  let accountRepo;
  let customerRepo;
  let sessionRepo;
  let obsRepo;
  let ticketRepo;
  let auditRepo;
  let testMerchant;
  let testAccount;

  test('merchant API authentication accepts only the dedicated API key hash', async () => {
    const merchant = await merchantRepo.create({
      businessName: 'Key isolation fixture', slug: 'key-isolation-fixture', contactEmail: 'keys@example.test', contactPhone: '9000000000',
      apiKey: 'mk_live_dedicated_api_credential_123456', webhookSecret: 'independent_webhook_hmac_secret_123456',
      branding: { merchantApiKey: 'legacy_branding_key_123456' }
    });
    assert.equal(await merchantRepo.verifyApiKey(merchant, 'mk_live_dedicated_api_credential_123456'), true);
    assert.equal(await merchantRepo.verifyApiKey(merchant, 'independent_webhook_hmac_secret_123456'), false);
    assert.equal(await merchantRepo.verifyApiKey(merchant, 'legacy_branding_key_123456'), false);
    assert.equal(merchant.merchantKey, '', 'webhook secrets must never be exposed as API keys');
  });

  beforeEach(async () => {
    db = new Database({ inMemory: true });
    const { defaultMerchant } = await runMigrations(db);
    testMerchant = defaultMerchant;

    merchantRepo = new MerchantRepository(db);
    accountRepo = new ReceivingAccountRepository(db);
    customerRepo = new CustomerRepository(db);
    sessionRepo = new PaymentSessionRepository(db);
    obsRepo = new ObservationRepository(db);
    ticketRepo = new SupportTicketRepository(db);
    auditRepo = new AuditLogRepository(db);

    testAccount = await accountRepo.findActiveForMerchant(testMerchant.id);
  });

  afterEach(async () => {
    await db.close();
  });

  test('migrations seed default merchant and active UPI receiving account', () => {
    assert.ok(testMerchant);
    assert.equal(testMerchant.slug, 'markex-academy');
    assert.ok(testAccount);
    const expectedVpa = String(process.env.MERCHANT_UPI_ID || process.env.DEFAULT_PAYEE_VPA || 'merchant@upi').trim();
    assert.equal(testAccount.upiId, expectedVpa);
    assert.equal(Boolean(testAccount.isActive), true);
    assert.equal(Boolean(testAccount.isSlotBusy), false);
  });

  test('manual UPI UTR is idempotent, unique per receiving account, and only moves to review', async () => {
    const first = await sessionRepo.create({ merchantId: testMerchant.id, receivingAccountId: testAccount.id,
      orderId: 'MANUAL-UTR-1', amountPaise: 12300, method: PaymentMethod.MANUAL_UPI });
    await sessionRepo.acquireSlotAtomic(first.id, testAccount.id, 300000);
    const submitted = await sessionRepo.submitManualUtr(first.id, ' ab1234567890 ');
    assert.equal(submitted.status, PaymentStatus.MANUAL_REVIEW);
    assert.equal(submitted.customerUtr, 'AB1234567890');
    assert.equal((await sessionRepo.submitManualUtr(first.id, 'AB1234567890')).id, first.id);
    await assert.rejects(async () => await sessionRepo.submitManualUtr(first.id, 'bad'), /valid UPI reference/);

    const second = await sessionRepo.create({ merchantId: testMerchant.id, receivingAccountId: testAccount.id,
      orderId: 'MANUAL-UTR-2', amountPaise: 12300, method: PaymentMethod.MANUAL_UPI });
    await sessionRepo.acquireSlotAtomic(second.id, testAccount.id, 300000);
    await assert.rejects(async () => await sessionRepo.submitManualUtr(second.id, 'AB1234567890'), /UNIQUE constraint failed/);
    assert.equal((await sessionRepo.findById(second.id)).status, PaymentStatus.ACTIVE);
  });

  test('customer registration and password verification', async () => {
    const customer = await customerRepo.create({
      name: 'Gaurav Sharma',
      email: 'gaurav.dbtest@youpi.local',
      mobileNumber: '9876543210',
      password: 'SecurePassword123!'
    });

    assert.ok(customer.id);
    assert.equal(customer.phoneNumber, '9876543210');
    assert.equal(customer.fullName, 'Gaurav Sharma');

    const verified = await customerRepo.verifyCredentials(
      '9876543210',
      'SecurePassword123!'
    );
    assert.ok(verified);
    assert.equal(verified.id, customer.id);

    const failed = await customerRepo.verifyCredentials(
      '9876543210',
      'WrongPassword'
    );
    assert.equal(failed, null);
  });

  describe('Queue Engine & Concurrency Slot Invariants', () => {
    test('enforces ONE active slot at one time and queues subsequent sessions', async () => {
      // Create session A
      const sessionA = await sessionRepo.create({
        merchantId: testMerchant.id,
        receivingAccountId: testAccount.id,
        orderId: 'ORDER-A',
        amountPaise: 20000n
      });

      // Create session B (same amount, same account)
      const sessionB = await sessionRepo.create({
        merchantId: testMerchant.id,
        receivingAccountId: testAccount.id,
        orderId: 'ORDER-B',
        amountPaise: 20000n
      });

      // Create session C (same amount, same account)
      const sessionC = await sessionRepo.create({
        merchantId: testMerchant.id,
        receivingAccountId: testAccount.id,
        orderId: 'ORDER-C',
        amountPaise: 20000n
      });

      // 1. Session A attempts to acquire slot
      const resA = await sessionRepo.acquireSlotAtomic(sessionA.id, testAccount.id, 300000);
      assert.equal(resA.status, PaymentStatus.ACTIVE);
      assert.equal(resA.queuePosition, 0);
      assert.ok(resA.expiresAt instanceof Date);

      // Verify receiving account is marked busy
      const acctAfterA = await accountRepo.findById(testAccount.id);
      assert.equal(acctAfterA.isSlotBusy, true);
      assert.equal(acctAfterA.currentActiveSessionId, sessionA.id);

      // 2. Session B attempts to acquire slot -> MUST BE QUEUED at position 1
      const resB = await sessionRepo.acquireSlotAtomic(sessionB.id, testAccount.id, 300000);
      assert.equal(resB.status, PaymentStatus.QUEUED);
      assert.equal(resB.queuePosition, 1);
      assert.equal(resB.expiresAt, null);

      // 3. Session C attempts to acquire slot -> MUST BE QUEUED at position 2
      const resC = await sessionRepo.acquireSlotAtomic(sessionC.id, testAccount.id, 300000);
      assert.equal(resC.status, PaymentStatus.QUEUED);
      assert.equal(resC.queuePosition, 2);

      // 4. Session A transitions to PROCESSING when customer clicks "Payment Done"
      const procA = await sessionRepo.transitionToProcessing(sessionA.id, 30000);
      assert.equal(procA.status, PaymentStatus.PROCESSING);
      assert.ok(procA.processingStartedAt instanceof Date);
      assert.ok(procA.processingExpiresAt instanceof Date);

      // Slot MUST STILL BE BUSY during PROCESSING! Session B cannot steal it
      const acctDuringProc = await accountRepo.findById(testAccount.id);
      assert.equal(acctDuringProc.isSlotBusy, true);
      assert.equal(acctDuringProc.currentActiveSessionId, sessionA.id);

      // 5. Session A finishes with SUCCESS
      const successA = await sessionRepo.transitionToTerminal(sessionA.id, PaymentStatus.SUCCESS);
      assert.equal(successA.status, PaymentStatus.SUCCESS);
      assert.ok(successA.completedAt instanceof Date);

      // Slot is now released!
      const acctAfterSuccess = await accountRepo.findById(testAccount.id);
      assert.equal(acctAfterSuccess.isSlotBusy, false);
      assert.equal(acctAfterSuccess.currentActiveSessionId, null);

      // 6. Promote next queued session (B)
      const nextQueued = await sessionRepo.getNextQueuedSession(testAccount.id);
      assert.equal(nextQueued.id, sessionB.id);

      const resBAfterPromo = await sessionRepo.acquireSlotAtomic(sessionB.id, testAccount.id, 300000);
      assert.equal(resBAfterPromo.status, PaymentStatus.ACTIVE);
      assert.equal(resBAfterPromo.queuePosition, 0);

      // Re-index remaining queue
      await sessionRepo.reindexQueue(testAccount.id);
      const updatedC = await sessionRepo.findById(sessionC.id);
      assert.equal(updatedC.queuePosition, 1); // C promoted from #2 to #1 in waiting line
    });

    test('transitions to CANCELLED and immediately releases slot', async () => {
      const session = await sessionRepo.create({
        merchantId: testMerchant.id,
        receivingAccountId: testAccount.id,
        orderId: 'ORDER-CANCEL',
        amountPaise: 50000n
      });

      await sessionRepo.acquireSlotAtomic(session.id, testAccount.id, 300000);
      let acct = await accountRepo.findById(testAccount.id);
      assert.equal(acct.isSlotBusy, true);

      await sessionRepo.transitionToTerminal(session.id, PaymentStatus.CANCELLED);
      acct = await accountRepo.findById(testAccount.id);
      assert.equal(acct.isSlotBusy, false);
      assert.equal(acct.currentActiveSessionId, null);
    });
  });

  describe('Observation Deduplication & Storage', () => {
    test('records observations and retrieves by fingerprint for deduplication', async () => {
      const now = new Date();
      const obs = await obsRepo.create({
        receivingAccountId: testAccount.id,
        source: ObserverSource.GOOGLE_MESSAGES,
        amountPaise: 20000n,
        observedAt: now,
        bankReferenceNumber: 'UTR998877',
        fingerprintHash: 'hash_abc_123',
        rawPayload: { text: 'Received Rs 200 via UPI' }
      });

      assert.ok(obs.id);
      assert.equal(obs.bankReferenceNumber, 'UTR998877');

      const found = await obsRepo.findByFingerprint('hash_abc_123');
      assert.ok(found);
      assert.equal(found.id, obs.id);
    });
  });

  describe('Support Tickets & Live Messages', () => {
    test('creates tickets, links payments, and records bidirectional chat', async () => {
      const customer = await customerRepo.create({
        merchantId: testMerchant.id,
        phoneNumber: '9123456780',
        fullName: 'Anita Roy',
        password: 'PassWord123!'
      });

      const ticket = await ticketRepo.createTicket({
        merchantId: testMerchant.id,
        customerId: customer.id,
        subject: 'Payment failed but money deducted',
        initialMessage: {
          senderType: SenderType.CUSTOMER,
          senderId: customer.id,
          message: 'I paid 200 rupees but the screen said failed.'
        }
      });

      assert.ok(ticket.id);
      assert.equal(ticket.status, TicketStatus.OPEN);

      // Admin replies
      const adminMsg = await ticketRepo.addMessage({
        ticketId: ticket.id,
        senderType: SenderType.ADMIN,
        senderId: testMerchant.id,
        message: 'Hello Anita, we found your transaction and have credited your order.'
      });

      assert.ok(adminMsg.id);

      const messages = await ticketRepo.findMessagesByTicket(ticket.id);
      assert.equal(messages.length, 2);
      assert.equal(messages[0].senderType, SenderType.CUSTOMER);
      assert.equal(messages[1].senderType, SenderType.ADMIN);
    });
  });

  describe('Audit Logging', () => {
    test('records and queries audit trail', async () => {
      await auditRepo.log({
        merchantId: testMerchant.id,
        entityType: 'PAYMENT_SESSION',
        entityId: 'pay_123',
        action: 'SLOT_ACQUIRED',
        details: { queuePosition: 0 }
      });

      const logs = await auditRepo.findByEntity('PAYMENT_SESSION', 'pay_123');
      assert.equal(logs.length, 1);
      assert.equal(logs[0].action, 'SLOT_ACQUIRED');
      assert.equal(logs[0].details.queuePosition, 0);
    });
  });

  describe('Phase 9D Migration Correctness & Invariants', () => {
    test('runMigrations halts safely when existing table has conflicting active sessions', async () => {
      const legacyDb = new Database({ inMemory: true });
      const { defaultMerchant } = await runMigrations(legacyDb);
      const acct = await new ReceivingAccountRepository(legacyDb).findActiveForMerchant(defaultMerchant.id);

      // Simulate a pre-9C database by dropping idx_single_active_session
      await legacyDb.exec("DROP INDEX IF EXISTS idx_single_active_session;");
      await legacyDb.exec("DROP INDEX IF EXISTS idx_one_slot_per_receiving_account;");

      // Insert duplicate ACTIVE sessions on the same receiving account
      await legacyDb.run(`
        INSERT INTO payment_sessions (id, merchant_id, receiving_account_id, order_id, amount_paise, status)
        VALUES ('s1', ?, ?, 'ord1', 1000, 'ACTIVE')
      `, [defaultMerchant.id, acct.id]);
      await legacyDb.run(`
        INSERT INTO payment_sessions (id, merchant_id, receiving_account_id, order_id, amount_paise, status)
        VALUES ('s2', ?, ?, 'ord2', 2000, 'ACTIVE')
      `, [defaultMerchant.id, acct.id]);

      // Running migrations must throw explicit preflight error
      await assert.rejects(
        () => runMigrations(legacyDb),
        /Cannot apply idx_single_active_session: Detected 1 receiving account\(s\) with multiple active\/processing sessions/
      );

      // Resolve the conflict by marking one as EXPIRED
      await legacyDb.run("UPDATE payment_sessions SET status = 'EXPIRED' WHERE id = 's1'");

      // Now running migrations must succeed and apply the index
      await runMigrations(legacyDb);

      // Verify the index is active: attempting to insert another ACTIVE session for acct.id throws UNIQUE constraint
      await assert.rejects(() => legacyDb.run(`
          INSERT INTO payment_sessions (id, merchant_id, receiving_account_id, order_id, amount_paise, status)
          VALUES ('s3', ?, ?, 'ord3', 3000, 'ACTIVE')
        `, [defaultMerchant.id, acct.id]), /UNIQUE constraint failed/);

      await legacyDb.close();
    });
  });
});

describe('Database transaction recovery after writer contention', () => {
  let directory;
  let writer;
  let other;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'youpi-transaction-recovery-'));
    const dbPath = join(directory, 'test.sqlite');
    writer = new Database({ dbPath, autoMigrate: false });
    other = new Database({ dbPath, autoMigrate: false });
    await writer.exec('PRAGMA busy_timeout = 0; CREATE TABLE entries (value TEXT);');
    await other.exec('PRAGMA busy_timeout = 0;');
  });

  afterEach(async () => {
    if (writer) await writer.close();
    if (other) await other.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test('a rejected BEGIN does not weaken the next IMMEDIATE transaction', async () => {
    await other.exec('BEGIN IMMEDIATE;');
    let callbackCalled = false;
    await assert.rejects(() => writer.transaction(async () => {
      callbackCalled = true;
    }), /database is locked/);
    assert.equal(callbackCalled, false);
    await other.exec('ROLLBACK;');

    await writer.transaction(async () => {
      // The writer lock must be held before the callback, even before its first write.
      await assert.rejects(() => other.exec('BEGIN IMMEDIATE;'), /database is locked/);
      await writer.execute('INSERT INTO entries VALUES (?)', ['committed']);
    });
    const committedCount = (await other.queryOne('SELECT COUNT(*) AS count FROM entries')).count;
    assert.equal(committedCount, 1);
  });

  test('successful writes after exhausted retries remain committed across connections and close', async () => {
    await other.exec('BEGIN IMMEDIATE;');
    await assert.rejects(() => writer.withRetry(() => writer.transaction(async () => {
      await writer.execute('INSERT INTO entries VALUES (?)', ['blocked']);
    }), 1, 0), { name: 'DatabaseBusyError' });
    await other.exec('ROLLBACK;');

    await writer.transaction(async () => writer.execute('INSERT INTO entries VALUES (?)', ['committed']));
    assert.equal((await writer.queryOne('SELECT COUNT(*) AS count FROM entries')).count, 1);
    const visibleBeforeClose = (await other.queryOne('SELECT COUNT(*) AS count FROM entries')).count;
    await writer.close();
    writer = null;
    const persistedAfterClose = (await other.queryOne('SELECT COUNT(*) AS count FROM entries')).count;
    assert.deepEqual([visibleBeforeClose, persistedAfterClose], [1, 1]);
  });

  test('nested rollback preserves outer writes and later top-level rollback remains atomic', async () => {
    await writer.transaction(async () => {
      await writer.execute('INSERT INTO entries VALUES (?)', ['outer']);
      await assert.rejects(() => writer.transaction(async () => {
        await writer.execute('INSERT INTO entries VALUES (?)', ['rolled-back-inner']);
        throw new Error('inner failure');
      }), /inner failure/);
      await writer.transaction(async () => writer.execute('INSERT INTO entries VALUES (?)', ['nested']));
    });
    const nestedRows = (await other.query('SELECT value FROM entries ORDER BY rowid')).map(row => row.value);
    assert.deepEqual(nestedRows, ['outer', 'nested']);

    await assert.rejects(() => writer.transaction(async () => {
      await writer.execute('INSERT INTO entries VALUES (?)', ['rolled-back-outer']);
      await writer.transaction(async () => writer.execute('INSERT INTO entries VALUES (?)', ['rolled-back-nested']));
      throw new Error('outer failure');
    }), /outer failure/);
    const finalRows = (await other.query('SELECT value FROM entries ORDER BY rowid')).map(row => row.value);
    assert.deepEqual(finalRows, ['outer', 'nested']);
  });
});

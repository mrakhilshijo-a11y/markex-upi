import crypto from 'node:crypto';
import { ObservationAttributionStatus } from '@youpi/common';

export class ObservationRepository {
  /**
   * @param {import('../database.js').Database} db
   */
  constructor(db) {
    this.db = db;
  }

  async create(data) {
    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const rawPayload = typeof data.rawPayload === 'object' ? JSON.stringify(data.rawPayload) : (data.rawPayload || '{}');

    const sql = `
      INSERT INTO payment_observations (
        id, receiving_account_id, source, amount_paise, observed_at,
        ingested_at, sender_vpa, bank_reference_number, fingerprint_hash,
        raw_payload, attribution_status, attributed_payment_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.db.execute(sql, [
      id,
      data.receivingAccountId,
      data.source,
      Number(data.amountPaise),
      data.observedAt.toISOString(),
      now,
      data.senderVpa || null,
      data.bankReferenceNumber || null,
      data.fingerprintHash,
      rawPayload,
      data.attributionStatus || ObservationAttributionStatus.UNATTRIBUTED,
      data.attributedPaymentId || null,
      now
    ]);

    return await this.findById(id);
  }

  async findById(id) {
    const row = await this.db.queryOne('SELECT * FROM payment_observations WHERE id = ?', [id]);
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * @param {string} fingerprintHash
   * @param {string} [source] Restrict to one channel. A UTR fingerprint is shared by every
   *   channel, so after a cross-channel upgrade the unfiltered lookup may return another
   *   channel's row and hide a same-channel replay.
   */
  async findByFingerprint(fingerprintHash, source) {
    const row = source
      ? await this.db.queryOne('SELECT * FROM payment_observations WHERE fingerprint_hash = ? AND source = ? LIMIT 1', [fingerprintHash, source])
      : await this.db.queryOne('SELECT * FROM payment_observations WHERE fingerprint_hash = ?', [fingerprintHash]);
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Finds an existing observation with the same fingerprint within the same independent
   * channel family ('GMAIL' vs SMS/device channels 'SMS', 'SMS_GATEWAY', 'GOOGLE_MESSAGES', 'ANDROID_OBSERVER').
   * @param {string} fingerprintHash
   * @param {string} source
   */
  async findByFingerprintOrFamily(fingerprintHash, source) {
    const normalized = String(source || '').trim().toUpperCase();
    if (!normalized) return await this.findByFingerprint(fingerprintHash);
    if (normalized === 'GMAIL') {
      return await this.findByFingerprint(fingerprintHash, 'GMAIL');
    }
    const row = await this.db.queryOne(
      `SELECT * FROM payment_observations
       WHERE fingerprint_hash = ?
         AND UPPER(source) IN ('SMS', 'SMS_GATEWAY', 'GOOGLE_MESSAGES', 'ANDROID_OBSERVER')
       LIMIT 1`,
      [fingerprintHash]
    );
    if (!row) return null;
    return this.mapRow(row);
  }

  async findUnattributed(receivingAccountId) {
    const rows = await this.db.query(`
      SELECT * FROM payment_observations
      WHERE receiving_account_id = ? AND attribution_status = ?
      ORDER BY observed_at ASC
    `, [receivingAccountId, ObservationAttributionStatus.UNATTRIBUTED]);

    return rows.map(r => this.mapRow(r));
  }

  async findUnmatchedForReconciliation(receivingAccountId) {
    const rows = await this.db.query(`
      SELECT * FROM payment_observations
      WHERE receiving_account_id = ?
        AND attribution_status IN (?, ?, ?)
      ORDER BY observed_at ASC
    `, [
      receivingAccountId,
      ObservationAttributionStatus.UNATTRIBUTED,
      ObservationAttributionStatus.LATE_UNMATCHED,
      ObservationAttributionStatus.AMBIGUOUS
    ]);

    return rows.map(r => this.mapRow(r));
  }

  async findByReceivingAccount(receivingAccountId, limit = 50) {
    const rows = await this.db.query(`
      SELECT * FROM payment_observations
      WHERE receiving_account_id = ?
      ORDER BY observed_at DESC
      LIMIT ?
    `, [receivingAccountId, limit]);

    return rows.map(r => this.mapRow(r));
  }

  async markAttributed(id, paymentId) {
    const current = await this.findById(id);
    if (current?.bankReferenceNumber) {
      const existingSameSession = await this.db.queryOne(
        `SELECT id FROM payment_observations
         WHERE bank_reference_number = ?
           AND attributed_payment_id = ?
           AND id != ?
         LIMIT 1`,
        [current.bankReferenceNumber, paymentId, id]
      );
      if (existingSameSession) {
        const updatedPayload = {
          ...(current.rawPayload || {}),
          corroboratedPaymentId: paymentId
        };
        await this.db.execute(`
          UPDATE payment_observations
          SET attribution_status = ?, raw_payload = ?
          WHERE id = ?
        `, [ObservationAttributionStatus.ATTRIBUTED, JSON.stringify(updatedPayload), id]);
        return await this.findById(id);
      }
    }

    await this.db.execute(`
      UPDATE payment_observations
      SET attribution_status = ?, attributed_payment_id = ?
      WHERE id = ?
    `, [ObservationAttributionStatus.ATTRIBUTED, paymentId, id]);

    return await this.findById(id);
  }

  async markDuplicate(id) {
    await this.db.execute(`
      UPDATE payment_observations
      SET attribution_status = ?
      WHERE id = ?
    `, [ObservationAttributionStatus.DUPLICATE_IGNORED, id]);

    return await this.findById(id);
  }

  async markAmbiguous(id) {
    await this.db.execute(`
      UPDATE payment_observations
      SET attribution_status = ?
      WHERE id = ?
    `, [ObservationAttributionStatus.AMBIGUOUS, id]);

    return await this.findById(id);
  }

  async markLateUnmatched(id, candidatePaymentId = null) {
    if (candidatePaymentId) {
      const current = await this.findById(id);
      const updatedPayload = {
        ...(current?.rawPayload || {}),
        lateMatchedSessionId: candidatePaymentId
      };
      await this.db.execute(`
        UPDATE payment_observations
        SET attribution_status = ?, raw_payload = ?
        WHERE id = ?
      `, [ObservationAttributionStatus.LATE_UNMATCHED, JSON.stringify(updatedPayload), id]);
      return await this.findById(id);
    }

    await this.db.execute(`
      UPDATE payment_observations
      SET attribution_status = ?
      WHERE id = ?
    `, [ObservationAttributionStatus.LATE_UNMATCHED, id]);

    return await this.findById(id);
  }

  mapRow(row) {
    return {
      id: row.id,
      receivingAccountId: row.receiving_account_id,
      source: row.source,
      amountPaise: BigInt(row.amount_paise),
      observedAt: new Date(row.observed_at),
      ingestedAt: new Date(row.ingested_at),
      senderVpa: row.sender_vpa,
      bankReferenceNumber: row.bank_reference_number,
      fingerprintHash: row.fingerprint_hash,
      rawPayload: JSON.parse(row.raw_payload || '{}'),
      attributionStatus: row.attribution_status,
      attributedPaymentId: row.attributed_payment_id,
      createdAt: new Date(row.created_at)
    };
  }
}

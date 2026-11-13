import crypto from 'node:crypto';

export class ReceivingAccountRepository {
  /**
   * @param {import('../database.js').Database} db
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Creates a new receiving UPI account.
   * If isActive is true, atomically deactivates any other active accounts for this merchant.
   * Enforces that maximum ONE VPA may be active per merchant.
   */
  async create(data) {
    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const isActive = data.isActive !== undefined ? Boolean(data.isActive) : true;
    const isMerchantEnabled = data.isMerchantEnabled !== undefined ? Boolean(data.isMerchantEnabled) : true;

    return await this.db.transaction(async () => {
      // If this new account is marked active, atomically deactivate all existing active accounts for this merchant
      if (isActive) {
        await this.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_active = false, updated_at = ?
          WHERE merchant_id = ?
        `, [now, data.merchantId]);
      }

      const sql = `
        INSERT INTO payment_receiving_accounts (
          id, merchant_id, upi_id, payee_name, is_merchant_enabled,
          is_active, is_slot_busy, current_active_session_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      await this.db.execute(sql, [
        id,
        data.merchantId,
        data.upiId.trim(),
        data.payeeName.trim(),
        isMerchantEnabled,
        isActive,
        false,
        null,
        now,
        now
      ]);

      return await this.findById(id);
    });
  }

  async findById(id) {
    const row = await this.db.queryOne('SELECT * FROM payment_receiving_accounts WHERE id = ?', [id]);
    if (!row) return null;
    return this.mapRow(row);
  }

  async findByMerchantId(merchantId) {
    const rows = await this.db.query(
      'SELECT * FROM payment_receiving_accounts WHERE merchant_id = ? ORDER BY is_active DESC, created_at ASC',
      [merchantId]
    );
    return rows.map(r => this.mapRow(r));
  }

  async findActiveForMerchant(merchantId) {
    const row = await this.db.queryOne(
      'SELECT * FROM payment_receiving_accounts WHERE merchant_id = ? AND is_active = true LIMIT 1',
      [merchantId]
    );
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Atomically activates an account and deactivates all other accounts for this merchant.
   * Backend invariant: At most ONE VPA active per merchant.
   */
  async activateAccount(merchantId, accountId) {
    return await this.db.transaction(async () => {
      const now = new Date().toISOString();

      // Deactivate all existing accounts for this merchant
      await this.db.execute(`
        UPDATE payment_receiving_accounts
        SET is_active = false, updated_at = ?
        WHERE merchant_id = ?
      `, [now, merchantId]);

      // Activate the targeted account
      await this.db.execute(`
        UPDATE payment_receiving_accounts
        SET is_active = true, updated_at = ?
        WHERE id = ? AND merchant_id = ?
      `, [now, accountId, merchantId]);

      return await this.findById(accountId);
    });
  }

  /**
   * Deactivates a specific account.
   */
  async deactivateAccount(merchantId, accountId) {
    const now = new Date().toISOString();
    await this.db.execute(`
      UPDATE payment_receiving_accounts
      SET is_active = false, updated_at = ?
      WHERE id = ? AND merchant_id = ?
    `, [now, accountId, merchantId]);

    return await this.findById(accountId);
  }

  /**
   * Updates an existing account's details.
   */
  async updateAccount(id, data) {
    return await this.db.transaction(async () => {
      const existing = await this.findById(id);
      if (!existing) return null;

      const now = new Date().toISOString();
      const upiId = data.upiId !== undefined ? data.upiId.trim() : existing.upiId;

      if (existing.isSlotBusy && data.upiId !== undefined && upiId !== existing.upiId) {
        throw new Error('Cannot change UPI ID while receiving account slot is currently busy with an active payment session.');
      }

      const payeeName = data.payeeName !== undefined ? data.payeeName.trim() : existing.payeeName;
      const isMerchantEnabled = data.isMerchantEnabled !== undefined ? Boolean(data.isMerchantEnabled) : existing.isMerchantEnabled;

      if (data.isActive === true) {
        await this.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_active = false, updated_at = ?
          WHERE merchant_id = ?
        `, [now, existing.merchantId]);

        await this.db.execute(`
          UPDATE payment_receiving_accounts
          SET upi_id = ?, payee_name = ?, is_merchant_enabled = ?, is_active = true, updated_at = ?
          WHERE id = ?
        `, [upiId, payeeName, isMerchantEnabled ? 1 : 0, now, id]);
      } else if (data.isActive === false) {
        await this.db.execute(`
          UPDATE payment_receiving_accounts
          SET upi_id = ?, payee_name = ?, is_merchant_enabled = ?, is_active = false, updated_at = ?
          WHERE id = ?
        `, [upiId, payeeName, isMerchantEnabled ? 1 : 0, now, id]);
      } else {
        await this.db.execute(`
          UPDATE payment_receiving_accounts
          SET upi_id = ?, payee_name = ?, is_merchant_enabled = ?, updated_at = ?
          WHERE id = ?
        `, [upiId, payeeName, isMerchantEnabled ? 1 : 0, now, id]);
      }

      return await this.findById(id);
    });
  }

  /**
   * Deletes a receiving account.
   * Throws if the slot is currently busy.
   */
  async deleteAccount(merchantId, accountId) {
    const account = await this.findById(accountId);
    if (!account || account.merchantId !== merchantId) {
      throw new Error(`Account not found or does not belong to merchant: ${accountId}`);
    }

    if (account.isSlotBusy || account.currentActiveSessionId) {
      throw new Error(`Cannot delete account ${account.upiId} because it has an active checkout session.`);
    }

    await this.db.execute('DELETE FROM payment_receiving_accounts WHERE id = ? AND merchant_id = ?', [accountId, merchantId]);
    return true;
  }

  /**
   * Sets slot busy status and currently active session ID.
   */
  async setSlotStatus(id, isBusy, activeSessionId = null) {
    const now = new Date().toISOString();
    await this.db.execute(`
      UPDATE payment_receiving_accounts
      SET is_slot_busy = ?, current_active_session_id = ?, updated_at = ?
      WHERE id = ?
    `, [isBusy ? 1 : 0, activeSessionId, now, id]);

    return await this.findById(id);
  }

  /**
   * Updates or creates the active receiving UPI account for a merchant.
   * @param {string} merchantId
   * @param {string} upiId
   * @param {string} [payeeName]
   * @param {boolean} [isMerchantEnabled=true]
   */
  async upsertActiveForMerchant(merchantId, upiId, payeeName = null, isMerchantEnabled = true) {
    const cleanUpi = upiId.trim();
    const existing = await this.findActiveForMerchant(merchantId);
    const now = new Date().toISOString();

    if (existing) {
      await this.db.execute(`
        UPDATE payment_receiving_accounts
        SET upi_id = ?, payee_name = COALESCE(?, payee_name), is_merchant_enabled = ?, updated_at = ?
        WHERE id = ?
      `, [cleanUpi, payeeName?.trim() || null, isMerchantEnabled ? 1 : 0, now, existing.id]);
      return await this.findById(existing.id);
    } else {
      return await this.create({
        merchantId,
        upiId: cleanUpi,
        payeeName: payeeName?.trim() || 'Merchant Store',
        isMerchantEnabled,
        isActive: true
      });
    }
  }

  mapRow(row) {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      upiId: row.upi_id,
      payeeName: row.payee_name,
      isMerchantEnabled: Boolean(row.is_merchant_enabled !== undefined ? row.is_merchant_enabled : 1),
      isActive: Boolean(row.is_active),
      isSlotBusy: Boolean(row.is_slot_busy),
      currentActiveSessionId: row.current_active_session_id,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }
}

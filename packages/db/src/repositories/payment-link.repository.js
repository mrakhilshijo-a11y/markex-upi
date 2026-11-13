import crypto from 'node:crypto';

const ACTIVE_STATUSES = new Set(['ACTIVE']);
const TERMINAL_LINK_STATUSES = new Set(['PAID', 'REVOKED', 'EXPIRED']);

/**
 * Secure individual payment links for MARKEX course checkout.
 * Amount and course are locked at creation time (server-side).
 */
export class PaymentLinkRepository {
  /**
   * @param {import('../database.js').Database} db
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * @param {{
   *   merchantId: string,
   *   courseId: string,
   *   courseName: string,
   *   amountPaise: number,
   *   studentName?: string|null,
   *   studentMobile?: string|null,
   *   studentEmail?: string|null,
   *   expiresAt?: Date|string|null,
   *   createdBy?: string|null,
   *   allowReuseAfterPaid?: boolean,
   *   metadata?: object
   * }} data
   */
  async create(data) {
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('hex');
    const now = new Date().toISOString();
    const expiresAt = data.expiresAt
      ? (data.expiresAt instanceof Date ? data.expiresAt.toISOString() : String(data.expiresAt))
      : null;

    await this.db.execute(`
      INSERT INTO payment_links (
        id, token, merchant_id, course_id, course_name, amount_paise,
        student_name, student_mobile, student_email, status, expires_at,
        payment_session_id, created_by, created_at, updated_at,
        allow_reuse_after_paid, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, NULL, ?, ?, ?, ?, ?)
    `, [
      id,
      token,
      data.merchantId,
      data.courseId,
      data.courseName,
      Number(data.amountPaise),
      data.studentName || null,
      data.studentMobile || null,
      data.studentEmail || null,
      expiresAt,
      data.createdBy || 'admin',
      now,
      now,
      data.allowReuseAfterPaid ? 1 : 0,
      JSON.stringify(data.metadata || {})
    ]);

    return await this.findById(id);
  }

  async findById(id) {
    if (!id) return null;
    const row = await this.db.queryOne('SELECT * FROM payment_links WHERE id = ?', [id]);
    return row ? this.mapRow(row) : null;
  }

  async findByToken(token) {
    if (!token) return null;
    const row = await this.db.queryOne('SELECT * FROM payment_links WHERE token = ?', [token]);
    return row ? this.mapRow(row) : null;
  }

  /**
   * Lists links for a merchant (newest first).
   * @param {string} merchantId
   * @param {{ limit?: number, status?: string }} [options]
   */
  async listByMerchant(merchantId, options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
    const params = [merchantId];
    let sql = 'SELECT * FROM payment_links WHERE merchant_id = ?';
    if (options.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    return await this.db.query(sql, params).map((row) => this.mapRow(row));
  }

  /**
   * Validates a public token and refreshes expiry status.
   * @param {string} token
   */
  async resolvePublicToken(token) {
    const link = await this.findByToken(token);
    if (!link) return { ok: false, code: 'NOT_FOUND', link: null };

    if (link.status === 'REVOKED') {
      return { ok: false, code: 'REVOKED', link };
    }
    if (link.status === 'PAID' && !link.allowReuseAfterPaid) {
      return { ok: false, code: 'ALREADY_PAID', link };
    }
    if (link.status === 'EXPIRED' || (link.expiresAt && link.expiresAt.getTime() <= Date.now())) {
      if (link.status !== 'EXPIRED') {
        await this.updateStatus(link.id, 'EXPIRED');
        link.status = 'EXPIRED';
      }
      return { ok: false, code: 'EXPIRED', link };
    }
    if (!ACTIVE_STATUSES.has(link.status) && link.status !== 'USED') {
      return { ok: false, code: 'UNAVAILABLE', link };
    }
    return { ok: true, code: 'OK', link };
  }

  async attachPaymentSession(linkId, paymentSessionId) {
    const now = new Date().toISOString();
    await this.db.execute(`
      UPDATE payment_links
      SET payment_session_id = ?, status = CASE WHEN status = 'ACTIVE' THEN 'USED' ELSE status END,
          updated_at = ?
      WHERE id = ?
    `, [paymentSessionId, now, linkId]);
    return await this.findById(linkId);
  }

  async markPaid(linkId) {
    const now = new Date().toISOString();
    await this.db.execute(`
      UPDATE payment_links
      SET status = 'PAID', paid_at = ?, updated_at = ?
      WHERE id = ?
    `, [now, now, linkId]);
    return await this.findById(linkId);
  }

  async revoke(linkId, actorId = 'admin') {
    const link = await this.findById(linkId);
    if (!link) return null;
    if (TERMINAL_LINK_STATUSES.has(link.status) && link.status !== 'EXPIRED') {
      throw new Error(`Cannot revoke a link in status ${link.status}`);
    }
    const now = new Date().toISOString();
    await this.db.execute(`
      UPDATE payment_links
      SET status = 'REVOKED', revoked_at = ?, revoked_by = ?, updated_at = ?
      WHERE id = ?
    `, [now, actorId, now, linkId]);
    return await this.findById(linkId);
  }

  async updateStatus(linkId, status) {
    const now = new Date().toISOString();
    await this.db.execute(`UPDATE payment_links SET status = ?, updated_at = ? WHERE id = ?`, [status, now, linkId]);
    return await this.findById(linkId);
  }

  mapRow(row) {
    let metadata = {};
    try {
      metadata = row.metadata ? JSON.parse(row.metadata) : {};
    } catch {
      metadata = {};
    }
    return {
      id: row.id,
      token: row.token,
      merchantId: row.merchant_id,
      courseId: row.course_id,
      courseName: row.course_name,
      amountPaise: Number(row.amount_paise),
      studentName: row.student_name,
      studentMobile: row.student_mobile,
      studentEmail: row.student_email,
      status: row.status,
      expiresAt: parseDbDate(row.expires_at),
      paymentSessionId: row.payment_session_id,
      createdBy: row.created_by,
      createdAt: parseDbDate(row.created_at),
      updatedAt: parseDbDate(row.updated_at),
      revokedAt: parseDbDate(row.revoked_at),
      revokedBy: row.revoked_by || null,
      paidAt: parseDbDate(row.paid_at),
      allowReuseAfterPaid: Boolean(row.allow_reuse_after_paid),
      metadata
    };
  }
}

/**
 * Parse SQLite / ISO timestamps as UTC. Bare `YYYY-MM-DD HH:MM:SS` values from
 * SQLite datetime() are treated as UTC so expiry checks are not skewed by local TZ.
 * @param {string|null|undefined} value
 * @returns {Date|null}
 */
function parseDbDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2} /.test(raw) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    return new Date(raw.replace(' ', 'T') + 'Z');
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

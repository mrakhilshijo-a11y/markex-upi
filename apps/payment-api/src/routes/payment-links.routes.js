import crypto from 'node:crypto';
import {
  resolveCourseAmount,
  listMarkexCourses,
  formatInrFromPaise,
  isManualVerificationMode,
  resolveActivePaymentProvider,
  PaymentMethod,
  PaymentStatus
} from '@youpi/common';
import { HttpServer } from '../server.js';

const DEFAULT_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';

function checkoutBase(ctx) {
  return String(ctx.checkoutBaseUrl || process.env.BASE_CHECKOUT_URL || 'http://localhost:7000').replace(/\/+$/, '');
}

function publicLinkUrl(ctx, token) {
  return `${checkoutBase(ctx)}/pay/${token}`;
}

function serializeLink(ctx, link) {
  if (!link) return null;
  return {
    id: link.id,
    token: link.token,
    url: publicLinkUrl(ctx, link.token),
    courseId: link.courseId,
    courseName: link.courseName,
    amountPaise: link.amountPaise,
    amountDisplay: formatInrFromPaise(link.amountPaise),
    studentName: link.studentName,
    studentMobile: link.studentMobile,
    studentEmail: link.studentEmail,
    status: link.status,
    expiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
    paymentSessionId: link.paymentSessionId,
    createdBy: link.createdBy,
    createdAt: link.createdAt ? link.createdAt.toISOString() : null,
    revokedAt: link.revokedAt ? link.revokedAt.toISOString() : null,
    paidAt: link.paidAt ? link.paidAt.toISOString() : null,
    allowReuseAfterPaid: link.allowReuseAfterPaid
  };
}

/**
 * Admin + public payment-link routes for MARKEX.
 * Admin routes sit under /api/v1/admin/* (authGuard).
 * Public resolve/open sits under /api/v1/pay-links/* (no admin token).
 */
export function registerPaymentLinkRoutes(server, ctx) {
  // Catalog for admin UI / storefront
  server.get('/api/v1/markex/courses', async (_req, res) => {
    HttpServer.json(res, 200, {
      courses: listMarkexCourses(),
      provider: resolveActivePaymentProvider(),
      currency: 'INR',
      notice: resolveActivePaymentProvider().settlementNote
    });
  });

  server.get('/api/v1/admin/markex/dashboard', async (req, res) => {
    const merchantId = req.query?.merchantId || DEFAULT_MERCHANT_ID;
    const rows = ctx.db.query(`
      SELECT status, method, amount_paise, metadata
      FROM payment_sessions
      WHERE merchant_id = ?
    `, [merchantId]);

    let totalCollectionsPaise = 0;
    let successful = 0;
    let pending = 0;
    let failed = 0;
    const courseTotals = {};

    for (const row of rows) {
      let meta = {};
      try { meta = row.metadata ? JSON.parse(row.metadata) : {}; } catch { meta = {}; }
      const courseId = meta.courseId || meta.markexCourseId || 'other';
      if (!courseTotals[courseId]) {
        courseTotals[courseId] = { courseId, count: 0, collectionsPaise: 0 };
      }

      const status = row.status;
      const amount = Number(row.amount_paise) || 0;
      if (status === PaymentStatus.SUCCESS || status === PaymentStatus.RECONCILED) {
        successful += 1;
        totalCollectionsPaise += amount;
        courseTotals[courseId].count += 1;
        courseTotals[courseId].collectionsPaise += amount;
      } else if (
        status === PaymentStatus.MANUAL_REVIEW
        || status === PaymentStatus.PROCESSING
        || status === PaymentStatus.ACTIVE
        || status === PaymentStatus.QUEUED
        || status === PaymentStatus.INITIATED
        || status === PaymentStatus.OBSERVED_SUCCESS
      ) {
        pending += 1;
      } else if (
        status === PaymentStatus.FAILED
        || status === PaymentStatus.EXPIRED
        || status === PaymentStatus.CANCELLED
      ) {
        failed += 1;
      }
    }

    const links = await ctx.paymentLinkRepo.listByMerchant(merchantId, { limit: 200 });
    const linkStats = {
      active: links.filter((l) => l.status === 'ACTIVE').length,
      used: links.filter((l) => l.status === 'USED').length,
      paid: links.filter((l) => l.status === 'PAID').length,
      revoked: links.filter((l) => l.status === 'REVOKED').length,
      expired: links.filter((l) => l.status === 'EXPIRED').length
    };

    HttpServer.json(res, 200, {
      merchantId,
      totalCollectionsPaise,
      totalCollectionsDisplay: formatInrFromPaise(totalCollectionsPaise),
      successfulPayments: successful,
      pendingPayments: pending,
      failedPayments: failed,
      courseWiseCollections: Object.values(courseTotals).map((c) => ({
        ...c,
        collectionsDisplay: formatInrFromPaise(c.collectionsPaise)
      })),
      paymentLinks: linkStats,
      provider: resolveActivePaymentProvider(),
      verificationMode: isManualVerificationMode() ? 'manual' : 'observer'
      // Bank account / IFSC intentionally omitted
    });
  });

  server.get('/api/v1/admin/payment-links', async (req, res) => {
    const merchantId = req.query?.merchantId || DEFAULT_MERCHANT_ID;
    const status = req.query?.status || undefined;
    const links = await ctx.paymentLinkRepo.listByMerchant(merchantId, { status, limit: Number(req.query?.limit) || 100 });
    HttpServer.json(res, 200, {
      links: links.map((l) => serializeLink(ctx, l))
    });
  });

  server.post('/api/v1/admin/payment-links', async (req, res) => {
    const body = await HttpServer.parseBody(req).catch(() => ({}));
    const merchantId = body.merchantId || DEFAULT_MERCHANT_ID;
    const courseId = String(body.courseId || '').trim();

    let course;
    let amountPaise;
    try {
      ({ course, amountPaise } = resolveCourseAmount(courseId));
    } catch {
      HttpServer.json(res, 400, { error: 'Invalid courseId. Use initial, advanced, or complete.' });
      return;
    }

    // Never trust browser-supplied amount
    if (body.amountPaise != null && Number(body.amountPaise) !== amountPaise) {
      HttpServer.json(res, 400, { error: 'Amount mismatch. Course price is server-controlled.' });
      return;
    }

    const hours = body.expiresInHours != null
      ? Number(body.expiresInHours)
      : Number(process.env.PAYMENT_LINK_DEFAULT_EXPIRY_HOURS || 72);
    let expiresAt = null;
    if (Number.isFinite(hours) && hours > 0) {
      expiresAt = new Date(Date.now() + hours * 3600 * 1000);
    }

    const studentName = body.studentName ? String(body.studentName).trim().slice(0, 120) : null;
    const studentMobile = body.studentMobile ? String(body.studentMobile).replace(/\D/g, '').slice(-10) : null;
    const studentEmail = body.studentEmail ? String(body.studentEmail).trim().slice(0, 160) : null;

    if (studentMobile && !/^\d{10}$/.test(studentMobile)) {
      HttpServer.json(res, 400, { error: 'studentMobile must be a 10-digit Indian mobile number.' });
      return;
    }

    const link = await ctx.paymentLinkRepo.create({
      merchantId,
      courseId: course.id,
      courseName: course.name,
      amountPaise,
      studentName,
      studentMobile,
      studentEmail,
      expiresAt,
      createdBy: body.createdBy || 'admin',
      allowReuseAfterPaid: Boolean(body.allowReuseAfterPaid),
      metadata: {
        markex: true,
        verificationMode: 'manual',
        provider: 'direct_upi'
      }
    });

    if (ctx.auditRepo) {
      await ctx.auditRepo.log({
        merchantId,
        entityType: 'PAYMENT_LINK',
        entityId: link.id,
        action: 'PAYMENT_LINK_CREATED',
        actorType: 'ADMIN',
        actorId: body.createdBy || 'admin',
        details: {
          courseId: course.id,
          amountPaise,
          studentName,
          studentMobile,
          expiresAt: expiresAt ? expiresAt.toISOString() : null
        }
      });
    }

    HttpServer.json(res, 201, {
      success: true,
      link: serializeLink(ctx, link),
      whatsappShareText: buildWhatsAppShareText(serializeLink(ctx, link))
    });
  });

  server.post('/api/v1/admin/payment-links/:id/revoke', async (req, res, params) => {
    const body = await HttpServer.parseBody(req).catch(() => ({}));
    try {
      const link = await ctx.paymentLinkRepo.revoke(params.id, body.actorId || 'admin');
      if (!link) {
        HttpServer.json(res, 404, { error: 'Payment link not found.' });
        return;
      }
      if (ctx.auditRepo) {
        await ctx.auditRepo.log({
          merchantId: link.merchantId,
          entityType: 'PAYMENT_LINK',
          entityId: link.id,
          action: 'PAYMENT_LINK_REVOKED',
          actorType: 'ADMIN',
          actorId: body.actorId || 'admin',
          details: {}
        });
      }
      HttpServer.json(res, 200, { success: true, link: serializeLink(ctx, link) });
    } catch (err) {
      HttpServer.json(res, 409, { error: err.message || 'Could not revoke link.' });
    }
  });

  // Public: resolve link metadata (no bank details, amount locked)
  server.get('/api/v1/pay-links/:token', async (req, res, params) => {
    const resolved = await ctx.paymentLinkRepo.resolvePublicToken(params.token);
    if (!resolved.ok) {
      HttpServer.json(res, resolved.code === 'NOT_FOUND' ? 404 : 410, {
        error: resolved.code,
        message: publicLinkErrorMessage(resolved.code),
        link: resolved.link ? {
          status: resolved.link.status,
          courseName: resolved.link.courseName,
          amountDisplay: formatInrFromPaise(resolved.link.amountPaise)
        } : null
      });
      return;
    }

    const link = resolved.link;
    HttpServer.json(res, 200, {
      token: link.token,
      courseId: link.courseId,
      courseName: link.courseName,
      amountPaise: link.amountPaise,
      amountDisplay: formatInrFromPaise(link.amountPaise),
      studentName: link.studentName,
      studentMobile: link.studentMobile,
      studentEmail: link.studentEmail,
      status: link.status,
      expiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
      provider: resolveActivePaymentProvider(),
      guestCheckout: process.env.CHECKOUT_GUEST_MODE !== 'false',
      notice: 'Direct UPI payment. The merchant UPI ID may be visible on the QR / payment screen. Payment is confirmed only after admin bank verification.'
    });
  });

  // Public: open link → create locked payment session → return checkout URL
  server.post('/api/v1/pay-links/:token/open', async (req, res, params) => {
    const body = await HttpServer.parseBody(req).catch(() => ({}));
    const resolved = await ctx.paymentLinkRepo.resolvePublicToken(params.token);
    if (!resolved.ok) {
      HttpServer.json(res, resolved.code === 'NOT_FOUND' ? 404 : 410, {
        error: resolved.code,
        message: publicLinkErrorMessage(resolved.code)
      });
      return;
    }

    const link = resolved.link;

    // Reuse existing non-terminal session if still open
    if (link.paymentSessionId) {
      const existing = await ctx.sessionRepo.findById(link.paymentSessionId);
      if (existing && ![
        PaymentStatus.SUCCESS,
        PaymentStatus.RECONCILED,
        PaymentStatus.FAILED,
        PaymentStatus.EXPIRED,
        PaymentStatus.CANCELLED
      ].includes(existing.status)) {
        HttpServer.json(res, 200, {
          paymentId: existing.id,
          checkoutUrl: `${checkoutBase(ctx)}/checkout/${existing.id}`,
          amountPaise: existing.amountPaise,
          courseId: link.courseId,
          reused: true
        });
        return;
      }
      if (existing && (existing.status === PaymentStatus.SUCCESS || existing.status === PaymentStatus.RECONCILED)) {
        if (!link.allowReuseAfterPaid) {
          await ctx.paymentLinkRepo.markPaid(link.id);
          HttpServer.json(res, 410, { error: 'ALREADY_PAID', message: 'This payment link was already completed.' });
          return;
        }
      }
    }

    // Server-authoritative amount from locked course
    const { course, amountPaise } = resolveCourseAmount(link.courseId);
    if (amountPaise !== link.amountPaise) {
      HttpServer.json(res, 409, { error: 'Link amount no longer matches catalog. Revoke and recreate the link.' });
      return;
    }

    const studentName = String(body.studentName || link.studentName || '').trim();
    const studentMobile = String(body.studentMobile || link.studentMobile || '').replace(/\D/g, '').slice(-10);
    const studentEmail = String(body.studentEmail || link.studentEmail || '').trim() || null;

    if (!studentName || studentName.length < 2) {
      HttpServer.json(res, 400, { error: 'Student name is required.' });
      return;
    }
    if (!/^\d{10}$/.test(studentMobile)) {
      HttpServer.json(res, 400, { error: 'Valid 10-digit mobile number is required.' });
      return;
    }

    const receivingAccount = await ctx.accountRepo.findActiveForMerchant(link.merchantId);
    if (!receivingAccount) {
      HttpServer.json(res, 500, { error: 'No active UPI receiving account configured. Set MERCHANT_UPI_ID in server .env.' });
      return;
    }
    const receivingAccountSnapshot = {
      id: receivingAccount.id,
      upiId: receivingAccount.upiId,
      payeeName: receivingAccount.payeeName,
      isMerchantEnabled: receivingAccount.isMerchantEnabled
    };

    const orderId = `MARKEX-${link.courseId.toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const paymentId = crypto.randomUUID();

    const session = await ctx.sessionRepo.create({
      id: paymentId,
      merchantId: link.merchantId,
      receivingAccountId: receivingAccount.id,
      orderId,
      amountPaise,
      currency: 'INR',
      method: PaymentMethod.UPI,
      status: PaymentStatus.INITIATED,
      metadata: {
        markex: true,
        markexManualVerification: true,
        verificationMode: 'manual',
        provider: 'direct_upi',
        courseId: course.id,
        courseName: course.name,
        paymentLinkId: link.id,
        paymentLinkToken: link.token,
        studentName,
        studentMobile,
        studentEmail,
        guestCheckout: true,
        receivingAccountSnapshot
      }
    });

    await ctx.paymentLinkRepo.attachPaymentSession(link.id, session.id);

    if (ctx.auditRepo) {
      await ctx.auditRepo.log({
        merchantId: link.merchantId,
        entityType: 'PAYMENT_LINK',
        entityId: link.id,
        action: 'PAYMENT_LINK_OPENED',
        actorType: 'CUSTOMER',
        actorId: studentMobile,
        details: { paymentId: session.id, orderId, courseId: course.id, amountPaise }
      });
    }

    HttpServer.json(res, 201, {
      paymentId: session.id,
      orderId,
      checkoutUrl: `${checkoutBase(ctx)}/checkout/${session.id}`,
      amountPaise,
      amountDisplay: formatInrFromPaise(amountPaise),
      courseId: course.id,
      courseName: course.name,
      studentName,
      studentMobile,
      studentEmail
    });
  });
}

function publicLinkErrorMessage(code) {
  switch (code) {
    case 'REVOKED': return 'This payment link has been revoked by the academy.';
    case 'EXPIRED': return 'This payment link has expired.';
    case 'ALREADY_PAID': return 'This payment link has already been paid.';
    case 'NOT_FOUND': return 'Payment link not found.';
    default: return 'This payment link is unavailable.';
  }
}

function buildWhatsAppShareText(link) {
  if (!link) return '';
  return [
    `MARKEX TRADING ACADEMY`,
    `Course: ${link.courseName}`,
    `Amount: ${link.amountDisplay}`,
    link.studentName ? `Student: ${link.studentName}` : null,
    `Pay securely here: ${link.url}`,
    `Note: Complete payment via UPI. Confirmation happens after academy bank verification.`
  ].filter(Boolean).join('\n');
}

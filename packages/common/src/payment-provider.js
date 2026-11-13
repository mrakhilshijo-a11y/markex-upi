/**
 * Modular payment provider interface for MARKEX.
 *
 * Current provider: direct_upi (YouPI-PG native UPI QR / intent)
 * plus optional BANK_TRANSFER instructions (NEFT/IMPS/RTGS and UPI-to-account).
 *
 * This does NOT debit a student's bank account via API. There is no
 * licensed PSP pull/push settlement API in this stack. Students pay
 * manually via UPI apps or bank transfer; admin confirms credit.
 */

import { buildAccountIfscVpa, buildUpiUri } from './upi.js';

export const PaymentProviderId = Object.freeze({
  DIRECT_UPI: 'direct_upi',
  PSP_HOSTED: 'psp_hosted' // reserved for future authorized merchant integration
});

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveActivePaymentProvider(env = process.env) {
  const requested = String(env.PAYMENT_PROVIDER || PaymentProviderId.DIRECT_UPI).trim().toLowerCase();
  const verificationMode = String(env.PAYMENT_VERIFICATION_MODE || 'manual').trim().toLowerCase();
  const bank = resolveCheckoutBankTransfer(env);

  if (requested === PaymentProviderId.PSP_HOSTED) {
    return {
      id: PaymentProviderId.DIRECT_UPI,
      label: 'Direct UPI (fallback — PSP not configured)',
      supportsCards: false,
      supportsNetbanking: Boolean(bank),
      exposesMerchantVpa: true,
      settlementNote: 'PSP hosted checkout is not configured. Using direct UPI / bank transfer instructions. Merchant payee details may be visible during payment.',
      verificationMode: verificationMode === 'observer' ? 'observer' : 'manual'
    };
  }

  return {
    id: PaymentProviderId.DIRECT_UPI,
    label: bank ? 'Direct UPI + Bank Transfer' : 'Direct UPI',
    supportsCards: false,
    supportsNetbanking: Boolean(bank),
    exposesMerchantVpa: true,
    settlementNote: 'Students pay via UPI QR/intent and/or NEFT/IMPS/RTGS / UPI-to-account. Payee details are shown only on the checkout payment screen. Admin confirms after bank credit.',
    verificationMode: verificationMode === 'observer' ? 'observer' : 'manual'
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isManualVerificationMode(env = process.env) {
  return resolveActivePaymentProvider(env).verificationMode === 'manual';
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveMerchantPayeeConfig(env = process.env) {
  const upiId = String(env.MERCHANT_UPI_ID || env.DEFAULT_PAYEE_VPA || '').trim();
  const merchantName = String(env.MERCHANT_NAME || env.DEFAULT_MERCHANT_NAME || 'MARKEX TRADING ACADEMY').trim();
  return {
    upiId: upiId || null,
    merchantName
  };
}

/**
 * Bank transfer + UPI-to-account payee details for student checkout.
 * Includes NPCI account@IFSC.ifsc.npci addressing so mobile UPI apps can
 * open with the beneficiary / account prefilled.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   accountNumber: string,
 *   ifsc: string,
 *   accountName: string,
 *   bankName: string|null,
 *   accountUpiVpa: string,
 *   instructions: string
 * } | null}
 */
export function resolveCheckoutBankTransfer(env = process.env) {
  if (String(env.MARKEX_SHOW_BANK_TRANSFER || 'true').toLowerCase() === 'false') {
    return null;
  }
  const accountNumber = String(env.MERCHANT_BANK_ACCOUNT || '').trim();
  const ifsc = String(env.MERCHANT_IFSC || '').trim().toUpperCase();
  if (!accountNumber || !ifsc) return null;
  const accountName = String(env.MERCHANT_NAME || env.DEFAULT_MERCHANT_NAME || 'MARKEX TRADING ACADEMY').trim();
  const bankName = String(env.MERCHANT_BANK_NAME || '').trim() || null;
  let accountUpiVpa;
  try {
    accountUpiVpa = buildAccountIfscVpa(accountNumber, ifsc);
  } catch {
    return null;
  }
  return {
    accountNumber,
    ifsc,
    accountName,
    bankName,
    accountUpiVpa,
    instructions:
      'On mobile, tap “Pay to Bank Account via UPI” — your UPI app opens with MARKEX account + IFSC prefilled as the beneficiary. Or copy account/IFSC for NEFT/IMPS. Amount must match exactly. Admin confirms after bank credit.'
  };
}

/**
 * Build a locked-amount upi://pay URI targeting account + IFSC.
 * @param {{
 *   bankTransfer: { accountUpiVpa: string, accountName: string },
 *   amountPaise: bigint | number | string,
 *   orderId: string,
 *   currency?: string
 * }} options
 * @returns {string|null}
 */
export function buildBankTransferUpiUri(options) {
  const bt = options?.bankTransfer;
  if (!bt?.accountUpiVpa) return null;
  try {
    return buildUpiUri({
      payeeVpa: bt.accountUpiVpa,
      payeeName: bt.accountName || 'MARKEX TRADING ACADEMY',
      amountPaise: typeof options.amountPaise === 'bigint' ? options.amountPaise : BigInt(options.amountPaise),
      transactionRef: options.orderId,
      currency: options.currency || 'INR'
    });
  } catch {
    return null;
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolvePrivateSettlementBank(env = process.env) {
  const details = resolveCheckoutBankTransfer(env);
  if (!details) {
    const accountNumber = String(env.MERCHANT_BANK_ACCOUNT || '').trim() || null;
    const ifsc = String(env.MERCHANT_IFSC || '').trim() || null;
    if (!accountNumber && !ifsc) return null;
    return { accountNumber, ifsc };
  }
  return { accountNumber: details.accountNumber, ifsc: details.ifsc };
}

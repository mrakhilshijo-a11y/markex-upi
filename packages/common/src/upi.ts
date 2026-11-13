import { toRupeesString } from './money.js';

export interface BuildUpiUriOptions {
  payeeVpa: string;
  payeeName: string;
  amountPaise: bigint;
  transactionRef: string;
  transactionNote?: string;
  currency?: string;
}

/**
 * Validates whether a given string is a syntactically valid UPI Virtual Payment Address (VPA).
 * Format: username@bank
 */
export function isValidVpa(vpa: string): boolean {
  if (!vpa || typeof vpa !== 'string') return false;
  const clean = vpa.trim();
  return /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z0-9.\-_]{2,64}$/.test(clean);
}

/**
 * NPCI account + IFSC addressing used by UPI apps to prefill a bank beneficiary.
 * Format: {accountNumber}@{IFSC}.ifsc.npci
 */
export function buildAccountIfscVpa(accountNumber: string, ifsc: string): string {
  const acct = String(accountNumber || '').replace(/\s+/g, '').trim();
  const code = String(ifsc || '').replace(/\s+/g, '').trim().toUpperCase();
  if (!/^\d{9,18}$/.test(acct)) {
    throw new Error('Invalid bank account number for UPI account addressing');
  }
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code)) {
    throw new Error('Invalid IFSC for UPI account addressing');
  }
  return `${acct}@${code}.ifsc.npci`;
}

/**
 * Builds a canonical upi://pay URI dynamically from server-validated parameters.
 * Amount is derived exclusively from server-side integer paise.
 */
export function buildUpiUri(options: BuildUpiUriOptions): string {
  if (!isValidVpa(options.payeeVpa)) {
    throw new Error(`Invalid payee VPA: ${options.payeeVpa}`);
  }

  const amountStr = toRupeesString(options.amountPaise);

  const params = new URLSearchParams();
  params.set('pa', options.payeeVpa.trim());
  params.set('pn', options.payeeName.trim());
  params.set('am', amountStr);
  const txnId = (options.transactionRef || options.transactionNote || '').trim();
  if (txnId) {
    params.set('tn', txnId);
  }

  return `upi://pay?${params.toString()}`;
}

export interface BuildUpiIntentUriOptions extends BuildUpiUriOptions {
  packageName: string;
}

/**
 * Builds an Android intent URI for launching a specific UPI application.
 * Format: intent://pay?<UPI_PARAMS>#Intent;scheme=upi;package=<PACKAGE>;end
 */
export function buildUpiIntentUri(options: BuildUpiIntentUriOptions): string {
  if (!options.packageName || !options.packageName.trim()) {
    throw new Error('Package name is required for Android UPI intent URI');
  }
  const upiUri = buildUpiUri(options);
  const query = upiUri.split('?')[1] || '';
  const cleanPackage = options.packageName.trim();
  return `intent://pay?${query}#Intent;scheme=upi;package=${cleanPackage};end`;
}

export interface BuildStandUpiUriOptions {
  payeeVpa: string;
  payeeName: string;
  amountPaise?: bigint | null;
  merchantCategoryCode?: string;
  mode?: string;
  transactionNote?: string;
  transactionRef?: string;
  currency?: string;
}

/**
 * Builds an authentic NPCI-compliant UPI URI specifically formatted for physical payment stands.
 */
export function buildStandUpiUri(options: BuildStandUpiUriOptions): string {
  if (!isValidVpa(options.payeeVpa)) {
    throw new Error(`Invalid payee VPA: ${options.payeeVpa}`);
  }

  const params = new URLSearchParams();
  params.set('pa', options.payeeVpa.trim());
  params.set('pn', options.payeeName.trim());

  if (options.amountPaise !== undefined && options.amountPaise !== null) {
    params.set('am', toRupeesString(options.amountPaise));
  }

  if (options.merchantCategoryCode && options.merchantCategoryCode.trim()) {
    params.set('mc', options.merchantCategoryCode.trim());
  }

  const mode = options.mode ? options.mode.trim() : (options.amountPaise ? '04' : '02');
  params.set('mode', mode);

  const txnId = (options.transactionRef || options.transactionNote || '').trim();
  if (txnId) {
    params.set('tn', txnId);
  }

  params.set('cu', (options.currency || 'INR').toUpperCase());

  return `upi://pay?${params.toString()}`;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAccountIfscVpa, buildUpiUri, isValidVpa } from '../upi.js';
import { resolveCheckoutBankTransfer, buildBankTransferUpiUri } from '../payment-provider.js';

test('buildAccountIfscVpa builds NPCI account addressing', () => {
  const vpa = buildAccountIfscVpa('123456789012', 'HDFC0001234');
  assert.equal(vpa, '123456789012@HDFC0001234.ifsc.npci');
  assert.equal(isValidVpa(vpa), true);
});

test('buildBankTransferUpiUri locks amount to account payee', () => {
  const prevAcct = process.env.MERCHANT_BANK_ACCOUNT;
  const prevIfsc = process.env.MERCHANT_IFSC;
  const prevName = process.env.MERCHANT_NAME;
  process.env.MERCHANT_BANK_ACCOUNT = '123456789012';
  process.env.MERCHANT_IFSC = 'HDFC0001234';
  process.env.MERCHANT_NAME = 'MARKEX TRADING ACADEMY';
  try {
    const bt = resolveCheckoutBankTransfer(process.env);
    assert.ok(bt);
    assert.equal(bt.accountUpiVpa, '123456789012@HDFC0001234.ifsc.npci');
    const uri = buildBankTransferUpiUri({
      bankTransfer: bt,
      amountPaise: 500000,
      orderId: 'ORDER-1'
    });
    assert.ok(uri.startsWith('upi://pay?'));
    assert.ok(uri.includes(encodeURIComponent(bt.accountUpiVpa)) || uri.includes(bt.accountUpiVpa));
    assert.ok(uri.includes('am=5000.00') || uri.includes('am=5000'));
    // Also valid via buildUpiUri directly
    const direct = buildUpiUri({
      payeeVpa: bt.accountUpiVpa,
      payeeName: bt.accountName,
      amountPaise: 500000n,
      transactionRef: 'ORDER-1'
    });
    assert.ok(direct.includes('HDFC0001234.ifsc.npci'));
  } finally {
    if (prevAcct === undefined) delete process.env.MERCHANT_BANK_ACCOUNT;
    else process.env.MERCHANT_BANK_ACCOUNT = prevAcct;
    if (prevIfsc === undefined) delete process.env.MERCHANT_IFSC;
    else process.env.MERCHANT_IFSC = prevIfsc;
    if (prevName === undefined) delete process.env.MERCHANT_NAME;
    else process.env.MERCHANT_NAME = prevName;
  }
});

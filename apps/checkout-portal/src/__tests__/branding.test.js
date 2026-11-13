import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutServer } from '../server.js';
import { BRANDING_CONFIG } from '../config/branding.js';

describe('White-Label Branding & Checkout Identity Tests', () => {
  const server = new CheckoutServer();

  test('renderHtml defaults to MARKEX TRADING ACADEMY branding when state is minimal/demo', () => {
    const html = server.renderHtml('test-payment-123', {
      orderId: 'ORD-999',
      amount: '5000.00'
    });

    assert.ok(html.includes('<title>MARKEX TRADING ACADEMY · MARKEX Checkout</title>')
      || html.includes('MARKEX TRADING ACADEMY')
      || html.includes('MARKEX Checkout'), 'Title/brand must feature MARKEX');

    assert.ok(html.includes('MARKEX TRADING ACADEMY') || html.includes('MARKEX'), 'Merchant/app branding must be MARKEX');
    assert.ok(html.includes(BRANDING_CONFIG.supportEmail) || html.includes('markex-academy.com') || html.includes('MARKEX'), 'Support/brand identity present');
    // Ignore HTML/JS comments when asserting customer-visible branding
    const visible = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!visible.includes('YouPI PG Verified Business'), 'No YouPI PG Verified Business allowed');
    assert.ok(!visible.includes('Mitto Pay'), 'No Mitto Pay branding allowed');
    assert.ok(!visible.includes('V-Visa Business'), 'No V-Visa branding allowed');
  });

  test('renderHtml preserves custom merchant branding when merchant supplies their own brand', () => {
    const html = server.renderHtml('custom-payment-456', {
      merchantName: 'Acme Corp',
      branding: {
        appName: 'Acme Gateway',
        logoUrl: 'https://example.com/logo.png',
        primaryColor: '#ff0000',
        supportEmails: ['help@acme.com'],
        supportMobiles: ['+91 9999999999']
      }
    });

    assert.ok(html.includes('<title>Acme Corp · Acme Gateway Checkout</title>'));
    assert.ok(html.includes('Acme Corp'));
    assert.ok(html.includes('https://example.com/logo.png'));
    assert.ok(html.includes('help@acme.com'));
  });
});

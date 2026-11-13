/**
 * Centralized White-Label Branding Configuration — MARKEX TRADING ACADEMY
 *
 * Configures customer-facing brand identity across checkout-portal,
 * payment-api, and banking observers.
 */
export const BRANDING_CONFIG = Object.freeze({
  businessName: 'MARKEX TRADING ACADEMY',
  poweredBy: 'MARKEX',
  appName: 'MARKEX',
  supportEmail: 'support@markex-academy.com',
  supportEmails: Object.freeze(['support@markex-academy.com']),
  supportPhone: '+91 8137864105',
  supportMobiles: Object.freeze(['+91 8137864105']),
  logoUrl: '',
  primaryColor: '#0B3D2E',
  sidebarNotice: 'Secure UPI payments for MARKEX Trading Academy',
  trustBadgeText: 'MARKEX TRADING ACADEMY · Verified Business',
  counterInstructions: 'Please visit the billing counter and present this screen to the cashier.',
  cardCounterInstructions: 'Please swipe, insert, or tap your credit or debit card on the store POS terminal at the billing desk.',
  website: 'https://markex-academy.com',
  currency: 'INR',
  country: 'IN'
});

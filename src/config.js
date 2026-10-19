// Settings for the checkout page, kept in one place.
//
// The payments service (sandbox-api) listens on http://127.0.0.1:8000 by default.
// To point the checkout at another service, set a global before the checkout
// scripts load, for example in an inline script in the page:
//
//   <script>window.CHECKOUT_CONFIG = { paymentsBaseUrl: 'https://payments.example.com' };</script>
//
// Or call setPaymentsBaseUrl() at start-up.

export const DEFAULT_PAYMENTS_BASE_URL = 'http://127.0.0.1:8000';

let override = null;

function stripTrailingSlashes(url) {
  return url.replace(/\/+$/, '');
}

/** Base URL of the payments service, without a trailing slash. */
export function getPaymentsBaseUrl() {
  const fromPage = globalThis.CHECKOUT_CONFIG && globalThis.CHECKOUT_CONFIG.paymentsBaseUrl;
  const chosen = override ?? fromPage ?? DEFAULT_PAYMENTS_BASE_URL;
  return stripTrailingSlashes(String(chosen));
}

/** Set the base URL in code. Pass null to go back to the page setting or the default. */
export function setPaymentsBaseUrl(url) {
  if (url === null || url === undefined) {
    override = null;
    return;
  }
  if (typeof url !== 'string' || url.trim() === '') {
    throw new TypeError('The payments base URL must be a non-empty string.');
  }
  override = url.trim();
}

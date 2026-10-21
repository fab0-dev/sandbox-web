// Client for the payments service contract: Pay order and Order payment status.
//
// Every call resolves (it does not throw for service answers) to an object with a
// `kind` that tells the three answers of Pay order apart, plus one for failures:
//
//   kind 'succeeded'  { payment, orderPaid: true,  replayed, idempotencyKey }
//   kind 'declined'   { payment, orderPaid: false, replayed, idempotencyKey }
//                     payment.decline_reason and payment.message say why
//   kind 'refused'    { status, code, message, fields, fieldErrors, orderReference }
//                     code is one of validation_failed, invalid_amount, invalid_request,
//                     order_already_paid, order_refunded, idempotency_key_reused. No payment
//                     was tried. For order_refunded, `orderReference` and `refundedAt` (the
//                     refund's time as sent, ISO 8601 UTC, or null) come with it and `message`
//                     is the service's text, to show as it is.
//                     `fields` is [{ field, code, message }] (validation_failed only);
//                     `fieldErrors` maps field name -> message for the same list.
//   kind 'error'      { status, code, message }  the call did not give a usable answer
//                     (network_error, internal_error, unexpected_response, ...). The
//                     payment may or may not have been recorded: read the order's
//                     payment status before submitting again.
//
// getOrderPaymentStatus resolves to kind 'ok'
//   { orderReference, status, paid, refundedAt, payments } or kind 'error'.
//   status is 'unpaid', 'paid' or 'refunded' (what the checkout keys on); paid is true only
//   when status is 'paid'; refundedAt is the refund's time (string) for a refunded order and
//   null otherwise. A service that sends no `status` (an older one) is read by its `paid`
//   boolean: 'paid' or 'unpaid', refundedAt null.
//
// A payment is { payment_reference, order_reference, amount, currency, outcome, decline_reason,
//   message, card: { brand, last4 }, created_at, refunded, refund }. `refund` is null when the
//   payment was not refunded (also when the service sends no refund member at all), else
//   { amount, currency, reason, refunded_at }; `refunded` is true exactly when refund is set.
//
// Card data (D10): the card number and security code go only in the body of the one
// POST to the service. They are not logged, not kept in module state, not put in a
// URL or in storage, and never appear in what these functions return. Payments that
// come back are copied field by field, so only card brand and last four digits stay.

import { getPaymentsBaseUrl } from './config.js';

const REFUSAL_CODES = new Set([
  'validation_failed',
  'invalid_amount',
  'invalid_request',
  'order_already_paid',
  'order_refunded',
  'idempotency_key_reused',
]);
const OUTCOMES = new Set(['succeeded', 'declined']);
const ORDER_STATUSES = new Set(['unpaid', 'paid', 'refunded']);

const NETWORK_MESSAGE = 'We could not reach the payment service. Check your connection and try again.';
const UNEXPECTED_MESSAGE = 'The payment service gave an answer we could not read. Please try again.';
const INTERNAL_MESSAGE = 'Something went wrong on our side. Please try again.';

/** A fresh Idempotency-Key. Use one per submit of the form; reuse it only to resend that same submit. */
export function newIdempotencyKey() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Digit strings from a form become integers; anything else is sent as it is and the service refuses it.
function toInteger(value) {
  if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) return Number(value.trim());
  return value;
}

function buildPayBody(request) {
  const card = isObject(request.card) ? request.card : {};
  return {
    order_reference: request.orderReference,
    amount: toInteger(request.amount),
    currency: request.currency,
    card: {
      cardholder_name: card.cardholderName,
      number: card.number,
      expiry_month: toInteger(card.expiryMonth),
      expiry_year: toInteger(card.expiryYear),
      security_code: card.securityCode,
    },
  };
}

// Copy a refund field by field. `undefined` is read as "not refunded" (a payment from before
// refunds); anything that is not null or a refund as the contract shapes it gives `false`.
function readRefund(raw) {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) return false;
  const { amount, currency, reason, refunded_at: refundedAt } = raw;
  if (!Number.isInteger(amount) || typeof currency !== 'string'
    || typeof reason !== 'string' || typeof refundedAt !== 'string') return false;
  return { amount, currency, reason, refunded_at: refundedAt };
}

// Copy a payment field by field. Returns null when it does not look like a payment.
function readPayment(raw) {
  if (!isObject(raw) || !OUTCOMES.has(raw.outcome)) return null;
  if (typeof raw.payment_reference !== 'string' || !isObject(raw.card)) return null;
  const { brand, last4 } = raw.card;
  if (typeof brand !== 'string' || typeof last4 !== 'string' || !/^\d{4}$/.test(last4)) return null;
  const refund = readRefund(raw.refund);
  if (refund === false) return null;
  return {
    payment_reference: raw.payment_reference,
    order_reference: raw.order_reference,
    amount: raw.amount,
    currency: raw.currency,
    outcome: raw.outcome,
    decline_reason: typeof raw.decline_reason === 'string' ? raw.decline_reason : null,
    message: typeof raw.message === 'string' ? raw.message : '',
    card: { brand, last4 },
    created_at: raw.created_at,
    refunded: refund !== null,
    refund,
  };
}

// The order's state from an Order payment status body: its `status`, else (an older service)
// its `paid` boolean. Returns null when neither fits the contract.
function readOrderState(body) {
  if (body.status === undefined) {
    if (typeof body.paid !== 'boolean') return null;
    return { status: body.paid ? 'paid' : 'unpaid', refundedAt: null };
  }
  if (!ORDER_STATUSES.has(body.status)) return null;
  const refundedAt = body.status === 'refunded' && typeof body.refunded_at === 'string' ? body.refunded_at : null;
  return { status: body.status, refundedAt };
}

function readFields(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObject).map((f) => ({
    field: String(f.field),
    code: String(f.code),
    message: typeof f.message === 'string' ? f.message : '',
  }));
}

function failure(status, code, message) {
  return { kind: 'error', status, code, message };
}

function readErrorBody(status, body) {
  const err = isObject(body) && isObject(body.error) ? body.error : null;
  if (!err || typeof err.code !== 'string') return failure(status, 'unexpected_response', UNEXPECTED_MESSAGE);
  const message = typeof err.message === 'string' ? err.message : '';
  if (!REFUSAL_CODES.has(err.code)) {
    return failure(status, err.code, err.code === 'internal_error' ? INTERNAL_MESSAGE : message || UNEXPECTED_MESSAGE);
  }
  const refused = { kind: 'refused', status, code: err.code, message };
  if (err.code === 'validation_failed') {
    refused.fields = readFields(err.fields);
    refused.fieldErrors = Object.fromEntries(refused.fields.map((f) => [f.field, f.message]));
  }
  if ((err.code === 'order_already_paid' || err.code === 'order_refunded') && typeof err.order_reference === 'string') {
    refused.orderReference = err.order_reference;
  }
  if (err.code === 'order_refunded') {
    refused.refundedAt = typeof err.refunded_at === 'string' ? err.refunded_at : null;
  }
  return refused;
}

// Send one request and parse the JSON answer. Never throws for transport or parse problems.
async function send(fetchFn, url, init) {
  let response;
  try {
    response = await fetchFn(url, { ...init, credentials: 'omit', cache: 'no-store' });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    return { failure: failure(0, 'network_error', NETWORK_MESSAGE) };
  }
  let body = null;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = null;
  }
  return { status: response.status, body, headers: response.headers };
}

/**
 * Make the client. `fetch` and `baseUrl` can be given for tests; by default the global
 * fetch and the base URL from config.js (read at each call) are used.
 */
export function createPaymentsApi({ fetch: fetchImpl, baseUrl } = {}) {
  const getFetch = () => {
    const f = fetchImpl || globalThis.fetch;
    if (typeof f !== 'function') throw new TypeError('No fetch function is available.');
    return (url, init) => f(url, init);
  };
  const getBase = () => (baseUrl ? String(baseUrl).replace(/\/+$/, '') : getPaymentsBaseUrl());

  /**
   * Pay one order by card. request: { orderReference, amount, currency,
   * card: { cardholderName, number, expiryMonth, expiryYear, securityCode } }.
   * options: { idempotencyKey, signal }. Without a key a fresh one is made and returned.
   */
  async function payOrder(request, options = {}) {
    const req = isObject(request) ? request : {};
    const idempotencyKey = options.idempotencyKey || newIdempotencyKey();
    const result = await send(getFetch(), `${getBase()}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(buildPayBody(req)),
      signal: options.signal,
    });
    if (result.failure) return result.failure;
    const { status, body } = result;

    if (status === 200 || status === 201) {
      const payment = isObject(body) ? readPayment(body.payment) : null;
      if (!payment) return failure(status, 'unexpected_response', UNEXPECTED_MESSAGE);
      const replayed = result.headers && typeof result.headers.get === 'function'
        && result.headers.get('Idempotency-Replayed') === 'true';
      return {
        kind: payment.outcome,
        payment,
        orderPaid: payment.outcome === 'succeeded',
        replayed: Boolean(replayed),
        idempotencyKey,
      };
    }
    if (status >= 400) return readErrorBody(status, body);
    return failure(status, 'unexpected_response', UNEXPECTED_MESSAGE);
  }

  /** An order's state (unpaid, paid or refunded), the refund's time, and its payment attempts, newest first. */
  async function getOrderPaymentStatus(orderReference, options = {}) {
    if (typeof orderReference !== 'string' || orderReference === '') {
      return failure(0, 'invalid_order_reference', 'An order reference is needed.');
    }
    const result = await send(
      getFetch(),
      `${getBase()}/orders/${encodeURIComponent(orderReference)}/payments`,
      { method: 'GET', headers: { Accept: 'application/json' }, signal: options.signal },
    );
    if (result.failure) return result.failure;
    const { status, body } = result;

    if (status === 200) {
      const state = isObject(body) ? readOrderState(body) : null;
      if (state && Array.isArray(body.payments)) {
        const payments = body.payments.map(readPayment);
        if (payments.every(Boolean)) {
          return {
            kind: 'ok',
            orderReference: typeof body.order_reference === 'string' ? body.order_reference : orderReference,
            status: state.status,
            paid: state.status === 'paid',
            refundedAt: state.refundedAt,
            payments,
          };
        }
      }
      return failure(status, 'unexpected_response', UNEXPECTED_MESSAGE);
    }
    if (status >= 400) {
      const parsed = readErrorBody(status, body);
      return parsed.kind === 'refused' ? failure(status, parsed.code, parsed.message) : parsed;
    }
    return failure(status, 'unexpected_response', UNEXPECTED_MESSAGE);
  }

  return { payOrder, getOrderPaymentStatus };
}

const defaultApi = createPaymentsApi();

/** Pay one order by card with the global fetch and the configured base URL. See createPaymentsApi. */
export const payOrder = (request, options) => defaultApi.payOrder(request, options);

/** Read an order's payment status with the global fetch and the configured base URL. */
export const getOrderPaymentStatus = (orderReference, options) =>
  defaultApi.getOrderPaymentStatus(orderReference, options);

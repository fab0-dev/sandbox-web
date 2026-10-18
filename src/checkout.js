// Checkout payment step: the card form for one order, taken from the URL.
//
//   checkout.html?order=ORD-1001&amount=2599&currency=USD
//
// `amount` is in minor units (2599 is 25.99), as the payments service expects.
//
// The module has two parts:
//   - createCheckout(): the logic. It has no DOM; it talks to a `view` and to the payments API client,
//     so it can be tested in Node.
//   - mountCheckout(): the DOM binding for checkout.html. It runs by itself when the page loads.
//
// What the page does:
//   - Loads the order's payment status first. If the order is paid, it shows that and no form (D6).
//   - Locks the submit while a payment is processing: the lock is taken synchronously, so a double click
//     or a resubmit makes at most one attempt (D7).
//   - Checks the card details in the browser first (D4, src/card-validation.js). Nothing is sent when
//     a field is wrong.
//   - Shows paid and the amount charged (D2), the decline message as the service sent it, on the same page
//     with the form ready to retry (D3, D5), field errors from the browser or the service (D4), and the
//     already-paid refusal (D6).
//   - Clears the card number and security code after each attempt that was sent (D10).
//
// Card data (D10): the card number and security code are read from the form inside submit(), handed to
// the API client, and not kept anywhere else: not in the state, not in storage, not in the URL, not in
// any message shown. The form is cleared of them when the attempt ends.

import { validateCard } from './card-validation.js';
import { payOrder, getOrderPaymentStatus } from './payments-api.js';

/** Form fields in the order they are shown. Same names as the service's validation_failed fields. */
export const FIELD_NAMES = ['cardholder_name', 'number', 'expiry', 'security_code'];

const BRAND_NAMES = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
};

const LINK_PROBLEM =
  'This checkout link is not complete. Go back to your order and open the payment step again.';
const NOT_SENT_NOTE =
  ' We could not check whether the payment went through, so check your order before you try again.';

/**
 * Read the order from the query string. Returns { ok: true, order, amount, currency } or
 * { ok: false, message }. The amount is an integer in minor units greater than 0.
 */
export function parseOrderParams(search) {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  const order = (params.get('order') ?? '').trim();
  const amountText = (params.get('amount') ?? '').trim();
  const currency = (params.get('currency') ?? '').trim().toUpperCase();
  const amount = /^\d{1,15}$/.test(amountText) ? Number(amountText) : 0;
  if (order === '' || amount < 1 || !/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, message: LINK_PROBLEM };
  }
  return { ok: true, order, amount, currency };
}

/** An amount in minor units as money for the customer, for example 2599 USD -> "$25.99". */
export function formatAmount(amount, currency) {
  try {
    const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    const digits = formatter.resolvedOptions().maximumFractionDigits;
    return formatter.format(amount / 10 ** digits);
  } catch {
    return `${amount} ${currency}`;
  }
}

function cardLabel(card) {
  if (!card || !card.last4) return null;
  const brand = BRAND_NAMES[card.brand] || 'Card';
  return `${brand} ending ${card.last4}`;
}

function paidDetails(payment) {
  if (!payment) return { amountText: null, card: null };
  return { amountText: formatAmount(payment.amount, payment.currency), card: cardLabel(payment.card) };
}

/**
 * The checkout logic.
 *
 * @param {object} options
 * @param {{ok: boolean, order?: string, amount?: number, currency?: string, message?: string}} options.order
 *   from parseOrderParams.
 * @param {object} options.view  { render(state), readForm(), clearSensitive() }.
 *   readForm() returns { cardholder_name, number, expiry_month, expiry_year, security_code } as typed.
 *   clearSensitive() empties the card number and security code in the form.
 * @param {object} [options.api]  { payOrder, getOrderPaymentStatus }; the payments API client by default.
 * @param {Function} [options.validate]  card validation; src/card-validation.js by default.
 * @param {Function} [options.now]  returns the current Date, for the expiry check.
 *
 * State given to view.render():
 *   phase        'invalid_link' | 'loading' | 'load_error' | 'ready' | 'processing' | 'paid'
 *   summary      { order, amountText } or null
 *   message      text for the phase: the link problem, or the load error
 *   notice       a general message above the form (a refusal or a failure), or null
 *   decline      { reason, message } after a declined payment, or null. `message` is the service's, as is.
 *   fieldErrors  { cardholder_name?, number?, expiry?, security_code? } -> message
 *   focusField   the field to focus, or null
 *   paid         { amountText, card, refusal } when phase is 'paid', or null. amountText is the amount
 *                charged, or null when it is not known. refusal is the service's already-paid message
 *                when the customer tried to pay an order that was paid.
 */
export function createCheckout({ order, view, api, validate = validateCard, now = () => new Date() }) {
  const client = api || { payOrder, getOrderPaymentStatus };
  let busy = false;

  let state = {
    phase: order.ok ? 'loading' : 'invalid_link',
    summary: order.ok ? { order: order.order, amountText: formatAmount(order.amount, order.currency) } : null,
    message: order.ok ? null : order.message,
    notice: null,
    decline: null,
    fieldErrors: {},
    focusField: null,
    paid: null,
  };

  function update(changes) {
    state = { ...state, focusField: null, ...changes };
    view.render(state);
  }

  function showPaid(payment, refusal = null) {
    const details = paidDetails(payment);
    update({
      phase: 'paid',
      notice: null,
      decline: null,
      fieldErrors: {},
      paid: { amountText: details.amountText, card: details.card, refusal },
    });
  }

  // Newest first, so the first success is the latest.
  const succeededPayment = (status) => status.payments.find((p) => p.outcome === 'succeeded') || null;

  /** Load the order's payment status and show either the paid order or the form. */
  async function start() {
    if (!order.ok) {
      view.render(state);
      return;
    }
    if (busy) return;
    busy = true;
    update({ phase: 'loading', message: null });
    try {
      const status = await client.getOrderPaymentStatus(order.order);
      if (status.kind === 'ok' && status.paid) {
        showPaid(succeededPayment(status));
      } else if (status.kind === 'ok') {
        update({ phase: 'ready' });
      } else {
        update({ phase: 'load_error', message: status.message });
      }
    } catch (e) {
      update({ phase: 'load_error', message: 'We could not load your order. Please try again.' });
    } finally {
      busy = false;
    }
  }

  // Read the order's status after an answer we cannot trust, so a payment that did go through shows as paid.
  async function recheck() {
    try {
      const status = await client.getOrderPaymentStatus(order.order);
      return status.kind === 'ok' ? status : null;
    } catch {
      return null;
    }
  }

  function applyRefusal(result) {
    if (result.code === 'validation_failed') {
      const fieldErrors = {};
      for (const f of result.fields || []) {
        if (FIELD_NAMES.includes(f.field) && !fieldErrors[f.field]) fieldErrors[f.field] = f.message;
      }
      const first = FIELD_NAMES.find((name) => fieldErrors[name]) || null;
      update({
        phase: 'ready',
        fieldErrors,
        focusField: first,
        // With no field named, the message is all the customer gets.
        notice: first ? null : result.message,
      });
      return Promise.resolve();
    }
    if (result.code === 'order_already_paid') {
      return recheck().then((status) => showPaid(status && succeededPayment(status), result.message));
    }
    update({ phase: 'ready', notice: result.message });
    return Promise.resolve();
  }

  /** Submit the form. Does nothing while the page is loading or a payment is processing. */
  async function submit() {
    if (!order.ok || busy || state.phase !== 'ready') return;
    busy = true; // taken before any await: a second call in the same tick sees it
    try {
      const form = view.readForm();
      const check = validate(form, now());
      if (!check.valid) {
        // Nothing was sent, so the card number and security code stay for the customer to fix.
        const fieldErrors = {};
        for (const e of check.errors) fieldErrors[e.field] = e.message;
        update({
          phase: 'ready',
          notice: null,
          decline: null,
          fieldErrors,
          focusField: check.errors.length ? check.errors[0].field : null,
        });
        return;
      }
      update({ phase: 'processing', notice: null, decline: null, fieldErrors: {} });

      let result;
      try {
        result = await client.payOrder({
          orderReference: order.order,
          amount: order.amount,
          currency: order.currency,
          card: {
            cardholderName: form.cardholder_name,
            number: form.number,
            expiryMonth: form.expiry_month,
            expiryYear: form.expiry_year,
            securityCode: form.security_code,
          },
        });
      } catch (e) {
        result = { kind: 'error', message: 'Something went wrong. Please try again.' };
      } finally {
        view.clearSensitive();
      }

      if (result.kind === 'succeeded') {
        showPaid(result.payment);
      } else if (result.kind === 'declined') {
        const { decline_reason: reason, message } = result.payment;
        update({ phase: 'ready', decline: { reason, message }, focusField: 'number' });
      } else if (result.kind === 'refused') {
        await applyRefusal(result);
      } else {
        // No usable answer: the payment may have been recorded. Look before the customer tries again.
        const status = await recheck();
        if (status && status.paid) {
          showPaid(succeededPayment(status));
        } else {
          update({ phase: 'ready', notice: status ? result.message : result.message + NOT_SENT_NOTE });
        }
      }
    } finally {
      busy = false;
    }
  }

  return { start, submit, getState: () => state };
}

// ---- DOM binding for checkout.html ---------------------------------------------------------------

const INPUTS = ['cardholder_name', 'number', 'expiry_month', 'expiry_year', 'security_code'];
const INPUT_FOR_FIELD = {
  cardholder_name: 'cardholder_name',
  number: 'number',
  expiry: 'expiry_month',
  security_code: 'security_code',
};

/**
 * Bind the checkout logic to the elements of checkout.html and start it.
 * `doc` is the document; `search` is the query string of the page.
 */
export function mountCheckout(doc, search, api) {
  const el = (id) => doc.getElementById(id);
  const show = (id, visible) => { el(id).hidden = !visible; };
  const text = (id, value) => { el(id).textContent = value ?? ''; };

  const view = {
    readForm() {
      const value = (id) => el(id).value;
      return Object.fromEntries(INPUTS.map((id) => [id, value(id)]));
    },
    clearSensitive() {
      el('number').value = '';
      el('security_code').value = '';
    },
    render(state) {
      const { phase } = state;
      show('link-error', phase === 'invalid_link');
      text('link-error', phase === 'invalid_link' ? state.message : '');
      show('order-summary', Boolean(state.summary));
      if (state.summary) {
        text('summary-order', state.summary.order);
        text('summary-amount', state.summary.amountText);
      }
      show('loading', phase === 'loading');
      show('load-error', phase === 'load_error');
      text('load-error-message', phase === 'load_error' ? state.message : '');
      show('paid-panel', phase === 'paid');
      if (state.paid) {
        text('paid-amount', state.paid.amountText ?? '');
        show('paid-amount-row', Boolean(state.paid.amountText));
        text('paid-card', state.paid.card ?? '');
        show('paid-card-row', Boolean(state.paid.card));
        text('paid-refusal', state.paid.refusal ?? '');
        show('paid-refusal', Boolean(state.paid.refusal));
      }

      const formVisible = phase === 'ready' || phase === 'processing';
      show('payment-form', formVisible);
      const processing = phase === 'processing';
      el('payment-fieldset').disabled = processing;
      el('submit-button').disabled = processing;
      text('submit-button', processing ? 'Processing payment…' : 'Pay');
      el('payment-form').setAttribute('aria-busy', processing ? 'true' : 'false');

      text('form-notice', state.notice);
      show('form-notice', Boolean(state.notice));
      show('decline-panel', Boolean(state.decline));
      text('decline-message', state.decline ? state.decline.message : '');
      if (state.decline) el('decline-panel').dataset.reason = state.decline.reason;
      else delete el('decline-panel').dataset.reason;

      for (const name of FIELD_NAMES) {
        const message = state.fieldErrors[name];
        text(`error-${name}`, message);
        show(`error-${name}`, Boolean(message));
        const input = el(INPUT_FOR_FIELD[name]);
        if (message) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
      }
      if (state.focusField) el(INPUT_FOR_FIELD[state.focusField]).focus();
    },
  };

  const checkout = createCheckout({ order: parseOrderParams(search), view, api });
  el('payment-form').addEventListener('submit', (event) => {
    event.preventDefault();
    checkout.submit();
  });
  el('retry-load').addEventListener('click', () => checkout.start());
  checkout.start();
  return checkout;
}

// In the browser, start by ourselves when the page has the checkout form.
if (typeof document !== 'undefined' && document.getElementById('payment-form')) {
  mountCheckout(document, globalThis.location ? globalThis.location.search : '');
}

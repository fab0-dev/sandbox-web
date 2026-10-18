import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createCheckout, mountCheckout, parseOrderParams, formatAmount } from '../src/checkout.js';

const CARD_NUMBER = '4242 4242 4242 4242';
const SECURITY_CODE = '737';

const goodForm = () => ({
  cardholder_name: 'Ada Lovelace',
  number: CARD_NUMBER,
  expiry_month: '12',
  expiry_year: '2099',
  security_code: SECURITY_CODE,
});

const ORDER = parseOrderParams('?order=ORD-1&amount=2599&currency=usd');

const payment = (over = {}) => ({
  payment_reference: 'pay_1',
  order_reference: 'ORD-1',
  amount: 2599,
  currency: 'USD',
  outcome: 'succeeded',
  decline_reason: null,
  message: 'Payment received.',
  card: { brand: 'visa', last4: '4242' },
  created_at: '2026-10-18T14:03:22Z',
  ...over,
});
const declinedPayment = (reason, message) =>
  payment({ outcome: 'declined', decline_reason: reason, message });

const unpaid = { kind: 'ok', orderReference: 'ORD-1', paid: false, payments: [] };
const paidStatus = { kind: 'ok', orderReference: 'ORD-1', paid: true, payments: [payment()] };

// A fake API: records calls, answers from queues.
function fakeApi({ status = [unpaid], pay = [] } = {}) {
  const calls = { status: [], pay: [] };
  const statusQueue = [...status];
  const payQueue = [...pay];
  return {
    calls,
    async getOrderPaymentStatus(ref) {
      calls.status.push(ref);
      const next = statusQueue.length > 1 ? statusQueue.shift() : statusQueue[0];
      if (next instanceof Error) throw next;
      return next;
    },
    async payOrder(request) {
      calls.pay.push(JSON.parse(JSON.stringify(request)));
      const next = payQueue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

// A fake view: keeps every state it was given and a form the test can fill.
function fakeView(form = goodForm()) {
  const states = [];
  return {
    states,
    form,
    cleared: 0,
    render(state) { states.push(state); },
    readForm() { return { ...this.form }; },
    clearSensitive() { this.cleared += 1; this.form.number = ''; this.form.security_code = ''; },
    get last() { return states[states.length - 1]; },
  };
}

async function started(apiOptions, form) {
  const api = fakeApi(apiOptions);
  const view = fakeView(form);
  const checkout = createCheckout({ order: ORDER, view, api, now: () => new Date('2026-10-18T12:00:00Z') });
  await checkout.start();
  return { api, view, checkout };
}

// ---- reading the order from the URL ----

test('parseOrderParams reads order, amount and currency', () => {
  assert.deepEqual(parseOrderParams('?order=ORD-1&amount=2599&currency=usd'), {
    ok: true, order: 'ORD-1', amount: 2599, currency: 'USD',
  });
  assert.equal(parseOrderParams('?order=a%2Fb%20c&amount=1&currency=EUR').order, 'a/b c');
});

test('parseOrderParams rejects a link that is missing or has a bad part', () => {
  for (const search of [
    '', '?order=ORD-1&amount=2599', '?order=ORD-1&currency=USD', '?amount=2599&currency=USD',
    '?order=&amount=2599&currency=USD', '?order=ORD-1&amount=0&currency=USD',
    '?order=ORD-1&amount=-5&currency=USD', '?order=ORD-1&amount=25.99&currency=USD',
    '?order=ORD-1&amount=abc&currency=USD', '?order=ORD-1&amount=2599&currency=US',
    '?order=ORD-1&amount=2599&currency=US1',
  ]) {
    const result = parseOrderParams(search);
    assert.equal(result.ok, false, search);
    assert.ok(result.message.length > 0);
  }
});

test('formatAmount turns minor units into money', () => {
  assert.equal(formatAmount(2599, 'USD'), '$25.99');
  assert.equal(formatAmount(500, 'JPY'), '¥500');
  assert.equal(formatAmount(2599, 'ZZZZ'), '2599 ZZZZ');
});

test('an incomplete link shows the problem, no form, and calls nothing', async () => {
  const api = fakeApi();
  const view = fakeView();
  const checkout = createCheckout({ order: parseOrderParams('?order=ORD-1'), view, api });
  await checkout.start();
  await checkout.submit();
  assert.equal(view.last.phase, 'invalid_link');
  assert.ok(view.last.message);
  assert.deepEqual(api.calls, { status: [], pay: [] });
});

// ---- loading the status first ----

test('loads the order status first and shows the form when unpaid', async () => {
  const api = fakeApi();
  const view = fakeView();
  const checkout = createCheckout({ order: ORDER, view, api });
  const starting = checkout.start();
  assert.equal(view.last.phase, 'loading');
  assert.deepEqual(view.last.summary, { order: 'ORD-1', amountText: '$25.99' });
  await starting;
  assert.equal(view.last.phase, 'ready');
  assert.deepEqual(api.calls.status, ['ORD-1']);
  assert.equal(api.calls.pay.length, 0);
});

test('submit does nothing while the status is loading', async () => {
  const api = fakeApi();
  const view = fakeView();
  const checkout = createCheckout({ order: ORDER, view, api });
  const starting = checkout.start();
  await checkout.submit();
  await starting;
  assert.equal(api.calls.pay.length, 0);
});

test('an order that is already paid shows as paid with the amount charged, no form', async () => {
  const { api, view } = await started({ status: [paidStatus] });
  assert.equal(view.last.phase, 'paid');
  assert.equal(view.last.paid.amountText, '$25.99');
  assert.equal(view.last.paid.card, 'Visa ending 4242');
  assert.equal(view.last.paid.refusal, null);
  assert.equal(api.calls.pay.length, 0);
});

test('the amount charged comes from the payment, not from the link', async () => {
  const status = { ...paidStatus, payments: [declinedPayment('card_declined', 'x'), payment({ amount: 1000 })] };
  const { view } = await started({ status: [status] });
  assert.equal(view.last.paid.amountText, '$10.00');
});

test('a failed status load shows the error and can be tried again', async () => {
  const failure = { kind: 'error', status: 0, code: 'network_error', message: 'We could not reach the payment service.' };
  const { view, checkout, api } = await started({ status: [failure, unpaid] });
  assert.equal(view.last.phase, 'load_error');
  assert.equal(view.last.message, 'We could not reach the payment service.');
  await checkout.submit();
  assert.equal(api.calls.pay.length, 0);
  await checkout.start();
  assert.equal(view.last.phase, 'ready');
});

test('a status call that throws is shown as a load error', async () => {
  const { view } = await started({ status: [new Error('boom')] });
  assert.equal(view.last.phase, 'load_error');
  assert.ok(view.last.message);
});

// ---- paying ----

test('a successful payment shows paid and the amount charged (D2)', async () => {
  const { api, view, checkout } = await started({ pay: [{ kind: 'succeeded', payment: payment(), orderPaid: true }] });
  await checkout.submit();
  assert.deepEqual(api.calls.pay, [{
    orderReference: 'ORD-1',
    amount: 2599,
    currency: 'USD',
    card: {
      cardholderName: 'Ada Lovelace',
      number: CARD_NUMBER,
      expiryMonth: '12',
      expiryYear: '2099',
      securityCode: SECURITY_CODE,
    },
  }]);
  assert.equal(view.last.phase, 'paid');
  assert.equal(view.last.paid.amountText, '$25.99');
  assert.equal(view.last.paid.card, 'Visa ending 4242');
  assert.equal(view.cleared, 1);
});

test('the form is locked from the moment of submit until the answer (D7)', async () => {
  const { view, checkout } = await started({ pay: [{ kind: 'succeeded', payment: payment() }] });
  const pending = checkout.submit();
  assert.equal(view.last.phase, 'processing');
  await pending;
  assert.equal(view.last.phase, 'paid');
});

test('a double click makes one payment attempt (D7)', async () => {
  const api = fakeApi({ pay: [{ kind: 'succeeded', payment: payment() }, { kind: 'succeeded', payment: payment() }] });
  const view = fakeView();
  const checkout = createCheckout({ order: ORDER, view, api, now: () => new Date('2026-10-18T12:00:00Z') });
  await checkout.start();
  await Promise.all([checkout.submit(), checkout.submit(), checkout.submit()]);
  assert.equal(api.calls.pay.length, 1);
});

test('a resubmit while processing is ignored, and a later one after a decline is allowed', async () => {
  const declined = { kind: 'declined', payment: declinedPayment('card_declined', 'Your card was declined. Try another card.') };
  const { api, view, checkout } = await started({ pay: [declined, { kind: 'succeeded', payment: payment() }] });
  const first = checkout.submit();
  await checkout.submit();
  await first;
  assert.equal(api.calls.pay.length, 1);
  view.form = goodForm();
  await checkout.submit();
  assert.equal(api.calls.pay.length, 2);
  assert.equal(view.last.phase, 'paid');
});

test('each decline reason shows the service message as is, on the same page (D3, D5)', async () => {
  const declines = [
    ['card_declined', 'Your card was declined. Try another card.'],
    ['insufficient_funds', 'Your card has insufficient funds. Try another card.'],
    ['expired_card', 'Your card has expired. Check the expiry date or use another card.'],
    ['incorrect_card_details', 'Some of your card details are incorrect. Check them and try again.'],
    ['processing_error', 'We could not process the payment right now. Please try again.'],
  ];
  for (const [reason, message] of declines) {
    const { view, checkout, api } = await started({
      pay: [{ kind: 'declined', payment: declinedPayment(reason, message), orderPaid: false }],
    });
    await checkout.submit();
    assert.equal(view.last.phase, 'ready', reason);
    assert.deepEqual(view.last.decline, { reason, message });
    assert.deepEqual(view.last.fieldErrors, {});
    assert.equal(view.last.focusField, 'number');
    assert.equal(api.calls.status.length, 1, 'the order is not loaded again');
    assert.equal(view.cleared, 1, reason);
  }
});

test('after a decline the customer retries with the same order and a later success marks it paid (D5)', async () => {
  const declined = { kind: 'declined', payment: declinedPayment('insufficient_funds', 'Your card has insufficient funds. Try another card.') };
  const { api, view, checkout } = await started({ pay: [declined, { kind: 'succeeded', payment: payment() }] });
  await checkout.submit();
  assert.equal(view.last.decline.reason, 'insufficient_funds');
  assert.equal(view.form.number, '');
  assert.equal(view.form.security_code, '');
  assert.equal(view.form.cardholder_name, 'Ada Lovelace', 'the name and expiry stay');
  view.form.number = '5555 5555 5555 4444';
  view.form.security_code = '123';
  await checkout.submit();
  assert.equal(view.last.phase, 'paid');
  assert.equal(view.last.decline, null);
  assert.equal(api.calls.pay.length, 2);
  assert.ok(api.calls.pay.every((c) => c.orderReference === 'ORD-1' && c.amount === 2599 && c.currency === 'USD'));
  assert.equal(api.calls.pay[1].card.number, '5555 5555 5555 4444');
});

// ---- field errors ----

test('invalid card details show an error for each field and send nothing (D4)', async () => {
  const bad = { cardholder_name: '', number: '4242 4242 4242 4241', expiry_month: '01', expiry_year: '2020', security_code: '12' };
  const { api, view, checkout } = await started({}, bad);
  await checkout.submit();
  assert.equal(api.calls.pay.length, 0);
  assert.equal(view.last.phase, 'ready');
  assert.deepEqual(Object.keys(view.last.fieldErrors), ['cardholder_name', 'number', 'expiry', 'security_code']);
  assert.equal(view.last.focusField, 'cardholder_name');
  assert.equal(view.cleared, 0, 'nothing was sent, so the customer keeps what they typed');
  assert.equal(view.form.number, '4242 4242 4242 4241');
});

test('local field errors clear when the details are fixed', async () => {
  const bad = { ...goodForm(), security_code: '' };
  const { view, checkout } = await started({ pay: [{ kind: 'succeeded', payment: payment() }] }, bad);
  await checkout.submit();
  assert.deepEqual(Object.keys(view.last.fieldErrors), ['security_code']);
  view.form.security_code = '737';
  await checkout.submit();
  assert.equal(view.last.phase, 'paid');
  assert.deepEqual(view.last.fieldErrors, {});
});

test('field errors from the service are shown next to the fields (D4)', async () => {
  const refused = {
    kind: 'refused', status: 422, code: 'validation_failed', message: 'Some details are wrong.',
    fields: [
      { field: 'number', code: 'invalid_number', message: 'This card number does not look right.' },
      { field: 'expiry', code: 'expired', message: 'This card has expired.' },
    ],
  };
  const { view, checkout } = await started({ pay: [refused] });
  await checkout.submit();
  assert.equal(view.last.phase, 'ready');
  assert.deepEqual(view.last.fieldErrors, {
    number: 'This card number does not look right.',
    expiry: 'This card has expired.',
  });
  assert.equal(view.last.focusField, 'number');
  assert.equal(view.last.notice, null);
  assert.equal(view.cleared, 1, 'a request was sent, so the card number and code are cleared');
});

test('a service validation error with no known field shows its message', async () => {
  const refused = { kind: 'refused', status: 422, code: 'validation_failed', message: 'Some details are wrong.', fields: [] };
  const { view, checkout } = await started({ pay: [refused] });
  await checkout.submit();
  assert.equal(view.last.notice, 'Some details are wrong.');
});

// ---- refusals and failures ----

test('an already-paid refusal shows the order as paid with the service message and no second charge (D6)', async () => {
  const refused = { kind: 'refused', status: 409, code: 'order_already_paid', message: 'This order has already been paid.', orderReference: 'ORD-1' };
  const { api, view, checkout } = await started({ status: [unpaid, paidStatus], pay: [refused] });
  await checkout.submit();
  assert.equal(view.last.phase, 'paid');
  assert.equal(view.last.paid.refusal, 'This order has already been paid.');
  assert.equal(view.last.paid.amountText, '$25.99');
  assert.equal(api.calls.pay.length, 1);
  assert.equal(view.cleared, 1);
  await checkout.submit();
  assert.equal(api.calls.pay.length, 1, 'no form is offered again');
});

test('an already-paid refusal still shows when the status cannot be read', async () => {
  const refused = { kind: 'refused', status: 409, code: 'order_already_paid', message: 'This order has already been paid.' };
  const failure = { kind: 'error', status: 0, code: 'network_error', message: 'No connection.' };
  const { view, checkout } = await started({ status: [unpaid, failure], pay: [refused] });
  await checkout.submit();
  assert.equal(view.last.phase, 'paid');
  assert.equal(view.last.paid.amountText, null);
  assert.equal(view.last.paid.refusal, 'This order has already been paid.');
});

test('other refusals show the service message and keep the form', async () => {
  for (const code of ['invalid_amount', 'invalid_request', 'idempotency_key_reused']) {
    const refused = { kind: 'refused', status: 422, code, message: `Refused: ${code}` };
    const { view, checkout } = await started({ pay: [refused] });
    await checkout.submit();
    assert.equal(view.last.phase, 'ready');
    assert.equal(view.last.notice, `Refused: ${code}`);
  }
});

test('after a failure, the order status is read, and a payment that went through shows as paid', async () => {
  const failure = { kind: 'error', status: 500, code: 'internal_error', message: 'Something went wrong on our side. Please try again.' };
  const { api, view, checkout } = await started({ status: [unpaid, paidStatus], pay: [failure] });
  await checkout.submit();
  assert.equal(api.calls.status.length, 2);
  assert.equal(view.last.phase, 'paid');
  assert.equal(view.last.paid.amountText, '$25.99');
  assert.equal(view.cleared, 1);
});

test('after a failure on an unpaid order the form is back with the message', async () => {
  const failure = { kind: 'error', status: 0, code: 'network_error', message: 'We could not reach the payment service.' };
  const { view, checkout } = await started({ status: [unpaid, unpaid], pay: [failure] });
  await checkout.submit();
  assert.equal(view.last.phase, 'ready');
  assert.equal(view.last.notice, 'We could not reach the payment service.');
  assert.equal(view.cleared, 1);
});

test('when the failure is followed by an unreadable status, the customer is told to check first', async () => {
  const failure = { kind: 'error', status: 0, code: 'network_error', message: 'We could not reach the payment service.' };
  const statusFailure = { kind: 'error', status: 0, code: 'network_error', message: 'No connection.' };
  const { view, checkout } = await started({ status: [unpaid, statusFailure], pay: [failure] });
  await checkout.submit();
  assert.equal(view.last.phase, 'ready');
  assert.match(view.last.notice, /^We could not reach the payment service\./);
  assert.match(view.last.notice, /check/i);
});

test('a payment call that throws unlocks the form and clears the card', async () => {
  const { view, checkout } = await started({ status: [unpaid], pay: [new Error('boom')] });
  await checkout.submit();
  assert.equal(view.last.phase, 'ready');
  assert.ok(view.last.notice);
  assert.equal(view.cleared, 1);
  assert.equal(view.form.number, '');
});

// ---- card data (D10) ----

test('no state given to the view contains the card number or the security code', async () => {
  const declined = { kind: 'declined', payment: declinedPayment('card_declined', 'Your card was declined. Try another card.') };
  const { view, checkout } = await started({ pay: [declined, { kind: 'succeeded', payment: payment() }] });
  await checkout.submit();
  view.form.number = CARD_NUMBER;
  view.form.security_code = SECURITY_CODE;
  await checkout.submit();
  const everything = JSON.stringify(view.states) + JSON.stringify(checkout.getState());
  assert.ok(!everything.includes('4242 4242 4242 4242'));
  assert.ok(!everything.includes('4242424242424242'));
  assert.ok(!everything.includes(`"${SECURITY_CODE}"`));
});

// ---- the DOM binding, against the real checkout.html ----

// A small stand-in for the elements the page uses. Ids come from checkout.html itself.
class FakeElement {
  constructor(id) {
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.value = '';
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.focused = false;
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  focus() { this.focused = true; }
  dispatch(type) {
    const event = { type, prevented: false, preventDefault() { this.prevented = true; } };
    for (const fn of this.listeners[type] || []) fn(event);
    return event;
  }
}

function fakeDocument() {
  const html = readFileSync(new URL('../checkout.html', import.meta.url), 'utf8');
  const elements = new Map();
  for (const [, id] of html.matchAll(/\sid="([^"]+)"/g)) elements.set(id, new FakeElement(id));
  return {
    elements,
    getElementById(id) {
      if (!elements.has(id)) throw new Error(`checkout.html has no element with id "${id}"`);
      return elements.get(id);
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function fillPage(doc, form = goodForm()) {
  for (const [id, value] of Object.entries(form)) doc.getElementById(id).value = value;
}

test('page: unpaid order shows the summary and the form', async () => {
  const doc = fakeDocument();
  mountCheckout(doc, '?order=ORD-1&amount=2599&currency=USD', fakeApi());
  await settle();
  assert.equal(doc.getElementById('order-summary').hidden, false);
  assert.equal(doc.getElementById('summary-order').textContent, 'ORD-1');
  assert.equal(doc.getElementById('summary-amount').textContent, '$25.99');
  assert.equal(doc.getElementById('payment-form').hidden, false);
  assert.equal(doc.getElementById('loading').hidden, true);
  assert.equal(doc.getElementById('paid-panel').hidden, true);
  assert.equal(doc.getElementById('submit-button').disabled, false);
});

test('page: paid order shows paid and the amount, and hides the form', async () => {
  const doc = fakeDocument();
  mountCheckout(doc, '?order=ORD-1&amount=2599&currency=USD', fakeApi({ status: [paidStatus] }));
  await settle();
  assert.equal(doc.getElementById('paid-panel').hidden, false);
  assert.equal(doc.getElementById('paid-amount').textContent, '$25.99');
  assert.equal(doc.getElementById('paid-refusal').hidden, true);
  assert.equal(doc.getElementById('payment-form').hidden, true);
});

test('page: a bad link shows the problem only', async () => {
  const doc = fakeDocument();
  mountCheckout(doc, '?order=ORD-1', fakeApi());
  await settle();
  assert.equal(doc.getElementById('link-error').hidden, false);
  assert.ok(doc.getElementById('link-error').textContent.length > 0);
  assert.equal(doc.getElementById('payment-form').hidden, true);
  assert.equal(doc.getElementById('order-summary').hidden, true);
});

test('page: submitting locks the button, then a decline shows the message and clears the card', async () => {
  const doc = fakeDocument();
  let release;
  const api = fakeApi();
  api.payOrder = (request) => {
    api.calls.pay.push(request);
    return new Promise((resolve) => { release = resolve; });
  };
  mountCheckout(doc, '?order=ORD-1&amount=2599&currency=USD', api);
  await settle();
  fillPage(doc);

  const form = doc.getElementById('payment-form');
  const event = form.dispatch('submit');
  assert.equal(event.prevented, true);
  const second = form.dispatch('submit');
  assert.equal(second.prevented, true);
  await settle();
  assert.equal(api.calls.pay.length, 1, 'a double submit makes one attempt');
  assert.equal(doc.getElementById('submit-button').disabled, true);
  assert.equal(doc.getElementById('payment-fieldset').disabled, true);
  assert.equal(doc.getElementById('submit-button').textContent, 'Processing payment…');
  assert.equal(form.attributes['aria-busy'], 'true');

  release({ kind: 'declined', payment: declinedPayment('insufficient_funds', 'Your card has insufficient funds. Try another card.') });
  await settle();
  assert.equal(doc.getElementById('submit-button').disabled, false);
  assert.equal(doc.getElementById('payment-fieldset').disabled, false);
  assert.equal(doc.getElementById('submit-button').textContent, 'Pay');
  assert.equal(doc.getElementById('decline-panel').hidden, false);
  assert.equal(doc.getElementById('decline-message').textContent, 'Your card has insufficient funds. Try another card.');
  assert.equal(doc.getElementById('decline-panel').dataset.reason, 'insufficient_funds');
  assert.equal(doc.getElementById('number').value, '');
  assert.equal(doc.getElementById('security_code').value, '');
  assert.equal(doc.getElementById('cardholder_name').value, 'Ada Lovelace');
  assert.equal(doc.getElementById('number').focused, true);
  assert.equal(doc.getElementById('payment-form').hidden, false);
});

test('page: field errors show next to the fields and mark them invalid', async () => {
  const doc = fakeDocument();
  const api = fakeApi();
  mountCheckout(doc, '?order=ORD-1&amount=2599&currency=USD', api);
  await settle();
  fillPage(doc, { ...goodForm(), number: '4242 4242 4242 4241', expiry_year: '2020' });
  doc.getElementById('payment-form').dispatch('submit');
  await settle();
  assert.equal(api.calls.pay.length, 0);
  for (const name of ['number', 'expiry']) {
    const error = doc.getElementById(`error-${name}`);
    assert.equal(error.hidden, false, name);
    assert.ok(error.textContent.length > 0, name);
  }
  assert.equal(doc.getElementById('error-cardholder_name').hidden, true);
  assert.equal(doc.getElementById('number').attributes['aria-invalid'], 'true');
  assert.equal(doc.getElementById('cardholder_name').attributes['aria-invalid'], undefined);
  assert.equal(doc.getElementById('number').value, '4242 4242 4242 4241');
});

test('page: success shows paid with the amount charged', async () => {
  const doc = fakeDocument();
  mountCheckout(doc, '?order=ORD-1&amount=2599&currency=USD', fakeApi({ pay: [{ kind: 'succeeded', payment: payment() }] }));
  await settle();
  fillPage(doc);
  doc.getElementById('payment-form').dispatch('submit');
  await settle();
  assert.equal(doc.getElementById('paid-panel').hidden, false);
  assert.equal(doc.getElementById('paid-amount').textContent, '$25.99');
  assert.equal(doc.getElementById('paid-card').textContent, 'Visa ending 4242');
  assert.equal(doc.getElementById('payment-form').hidden, true);
  assert.equal(doc.getElementById('number').value, '');
});

test('page: the retry button after a load error loads the order again', async () => {
  const doc = fakeDocument();
  const failure = { kind: 'error', status: 0, code: 'network_error', message: 'We could not reach the payment service.' };
  const api = fakeApi({ status: [failure, unpaid] });
  mountCheckout(doc, '?order=ORD-1&amount=2599&currency=USD', api);
  await settle();
  assert.equal(doc.getElementById('load-error').hidden, false);
  assert.equal(doc.getElementById('load-error-message').textContent, 'We could not reach the payment service.');
  assert.equal(doc.getElementById('payment-form').hidden, true);
  doc.getElementById('retry-load').dispatch('click');
  await settle();
  assert.equal(doc.getElementById('load-error').hidden, true);
  assert.equal(doc.getElementById('payment-form').hidden, false);
});

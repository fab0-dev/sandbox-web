import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPaymentsApi, payOrder, getOrderPaymentStatus, newIdempotencyKey } from '../src/payments-api.js';
import { DEFAULT_PAYMENTS_BASE_URL, getPaymentsBaseUrl, setPaymentsBaseUrl } from '../src/config.js';

const CARD_NUMBER = '4242 4242 4242 4242';
const SECURITY_CODE = '737';

const request = () => ({
  orderReference: 'order 42/A',
  amount: 2599,
  currency: 'USD',
  card: {
    cardholderName: 'Ada Lovelace',
    number: CARD_NUMBER,
    expiryMonth: '12',
    expiryYear: '2030',
    securityCode: SECURITY_CODE,
  },
});

const payment = (over = {}) => ({
  payment_reference: 'pay_8f3a1c',
  order_reference: 'order 42/A',
  amount: 2599,
  currency: 'USD',
  outcome: 'succeeded',
  decline_reason: null,
  message: 'Payment received.',
  card: { brand: 'visa', last4: '4242' },
  created_at: '2026-10-18T14:03:22Z',
  ...over,
});

// A fake fetch that records calls and answers with the given response.
function fakeFetch(status, body, headers = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      headers: new Headers(headers),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  fn.calls = calls;
  return fn;
}

const apiWith = (fetchFn) => createPaymentsApi({ fetch: fetchFn, baseUrl: 'http://pay.test' });

test('pay order sends the contract request', async () => {
  const f = fakeFetch(201, { payment: payment(), order_paid: true });
  await apiWith(f).payOrder(request(), { idempotencyKey: 'key-1' });
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, 'http://pay.test/payments');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers['Idempotency-Key'], 'key-1');
  assert.equal(init.credentials, 'omit');
  assert.deepEqual(JSON.parse(init.body), {
    order_reference: 'order 42/A',
    amount: 2599,
    currency: 'USD',
    card: {
      cardholder_name: 'Ada Lovelace',
      number: CARD_NUMBER,
      expiry_month: 12,
      expiry_year: 2030,
      security_code: SECURITY_CODE,
    },
  });
});

test('pay order makes a fresh idempotency key when none is given and returns it', async () => {
  const f = fakeFetch(201, { payment: payment(), order_paid: true });
  const a = await apiWith(f).payOrder(request());
  const b = await apiWith(f).payOrder(request());
  assert.equal(f.calls[0].init.headers['Idempotency-Key'], a.idempotencyKey);
  assert.ok(a.idempotencyKey.length >= 1 && a.idempotencyKey.length <= 255);
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
  assert.notEqual(newIdempotencyKey(), newIdempotencyKey());
});

test('succeeded answer', async () => {
  const f = fakeFetch(201, { payment: payment(), order_paid: true });
  const r = await apiWith(f).payOrder(request());
  assert.equal(r.kind, 'succeeded');
  assert.equal(r.orderPaid, true);
  assert.equal(r.replayed, false);
  assert.equal(r.payment.amount, 2599);
  assert.equal(r.payment.currency, 'USD');
  assert.equal(r.payment.decline_reason, null);
  assert.deepEqual(r.payment.card, { brand: 'visa', last4: '4242' });
});

test('replayed answer is marked', async () => {
  const f = fakeFetch(200, { payment: payment(), order_paid: true }, { 'Idempotency-Replayed': 'true' });
  const r = await apiWith(f).payOrder(request(), { idempotencyKey: 'k' });
  assert.equal(r.kind, 'succeeded');
  assert.equal(r.replayed, true);
});

for (const reason of ['card_declined', 'insufficient_funds', 'expired_card', 'incorrect_card_details', 'processing_error']) {
  test(`declined answer keeps reason and message: ${reason}`, async () => {
    const p = payment({ outcome: 'declined', decline_reason: reason, message: `Message for ${reason}` });
    const f = fakeFetch(201, { payment: p, order_paid: false });
    const r = await apiWith(f).payOrder(request());
    assert.equal(r.kind, 'declined');
    assert.equal(r.orderPaid, false);
    assert.equal(r.payment.decline_reason, reason);
    assert.equal(r.payment.message, `Message for ${reason}`);
  });
}

test('refused: validation failed lists the fields', async () => {
  const fields = [
    { field: 'number', code: 'invalid_number', message: 'Check the card number.' },
    { field: 'expiry', code: 'expired', message: 'This card has expired.' },
  ];
  const f = fakeFetch(422, { error: { code: 'validation_failed', message: 'Check your card details.', fields } });
  const r = await apiWith(f).payOrder(request());
  assert.equal(r.kind, 'refused');
  assert.equal(r.status, 422);
  assert.equal(r.code, 'validation_failed');
  assert.equal(r.message, 'Check your card details.');
  assert.deepEqual(r.fields, fields);
  assert.deepEqual(r.fieldErrors, { number: 'Check the card number.', expiry: 'This card has expired.' });
  assert.equal(r.payment, undefined);
});

test('refused: order already paid', async () => {
  const f = fakeFetch(409, {
    error: { code: 'order_already_paid', message: 'This order has already been paid.', order_reference: 'order 42/A' },
  });
  const r = await apiWith(f).payOrder(request());
  assert.equal(r.kind, 'refused');
  assert.equal(r.status, 409);
  assert.equal(r.code, 'order_already_paid');
  assert.equal(r.message, 'This order has already been paid.');
  assert.equal(r.orderReference, 'order 42/A');
});

test('refused: bad amount, invalid request, key reused', async () => {
  for (const [status, code] of [[422, 'invalid_amount'], [400, 'invalid_request'], [422, 'idempotency_key_reused']]) {
    const f = fakeFetch(status, { error: { code, message: `msg ${code}` } });
    const r = await apiWith(f).payOrder(request());
    assert.equal(r.kind, 'refused');
    assert.equal(r.code, code);
    assert.equal(r.message, `msg ${code}`);
  }
});

test('internal error is an error, not a refusal or a decline', async () => {
  const f = fakeFetch(500, { error: { code: 'internal_error', message: 'boom' } });
  const r = await apiWith(f).payOrder(request());
  assert.equal(r.kind, 'error');
  assert.equal(r.code, 'internal_error');
  assert.equal(r.status, 500);
});

test('network failure is an error', async () => {
  const r = await apiWith(async () => { throw new TypeError('Failed to fetch'); }).payOrder(request());
  assert.equal(r.kind, 'error');
  assert.equal(r.code, 'network_error');
  assert.ok(r.message);
});

test('unreadable or odd answers are errors', async () => {
  for (const [status, body] of [
    [201, 'not json'],
    [201, { payment: { outcome: 'maybe' } }],
    [201, {}],
    [502, '<html>bad gateway</html>'],
    [404, { error: { code: 'not_found', message: 'No such path.' } }],
  ]) {
    const r = await apiWith(fakeFetch(status, body)).payOrder(request());
    assert.equal(r.kind, 'error', JSON.stringify([status, body]));
  }
});

test('abort is passed through to the caller', async () => {
  const f = async () => { throw new DOMException('Aborted', 'AbortError'); };
  await assert.rejects(apiWith(f).payOrder(request()), { name: 'AbortError' });
});

test('order payment status: paid with attempts', async () => {
  const attempts = [payment(), payment({ payment_reference: 'pay_1', outcome: 'declined', decline_reason: 'card_declined', message: 'No.' })];
  const f = fakeFetch(200, { order_reference: 'order 42/A', paid: true, payments: attempts });
  const r = await apiWith(f).getOrderPaymentStatus('order 42/A');
  assert.equal(f.calls[0].url, 'http://pay.test/orders/order%2042%2FA/payments');
  assert.equal(f.calls[0].init.method, 'GET');
  assert.equal(f.calls[0].init.body, undefined);
  assert.equal(r.kind, 'ok');
  assert.equal(r.paid, true);
  assert.equal(r.orderReference, 'order 42/A');
  assert.equal(r.payments.length, 2);
  assert.equal(r.payments[1].decline_reason, 'card_declined');
});

test('order payment status: no attempts means unpaid', async () => {
  const f = fakeFetch(200, { order_reference: 'o1', paid: false, payments: [] });
  const r = await apiWith(f).getOrderPaymentStatus('o1');
  assert.deepEqual(r, { kind: 'ok', orderReference: 'o1', paid: false, payments: [] });
});

test('order payment status: errors', async () => {
  const bad = await apiWith(fakeFetch(500, { error: { code: 'internal_error', message: 'x' } })).getOrderPaymentStatus('o1');
  assert.equal(bad.kind, 'error');
  assert.equal(bad.code, 'internal_error');
  const net = await apiWith(async () => { throw new TypeError('x'); }).getOrderPaymentStatus('o1');
  assert.equal(net.code, 'network_error');
  const odd = await apiWith(fakeFetch(200, { paid: 'yes' })).getOrderPaymentStatus('o1');
  assert.equal(odd.code, 'unexpected_response');
  const none = await apiWith(fakeFetch(200, {})).getOrderPaymentStatus('');
  assert.equal(none.kind, 'error');
});

test('base URL comes from config', async () => {
  assert.equal(getPaymentsBaseUrl(), DEFAULT_PAYMENTS_BASE_URL);
  assert.equal(DEFAULT_PAYMENTS_BASE_URL, 'http://127.0.0.1:8000');
  const original = globalThis.fetch;
  const f = fakeFetch(200, { order_reference: 'o1', paid: false, payments: [] });
  globalThis.fetch = f;
  try {
    await getOrderPaymentStatus('o1');
    assert.equal(f.calls[0].url, 'http://127.0.0.1:8000/orders/o1/payments');

    setPaymentsBaseUrl('https://payments.example.com/');
    assert.equal(getPaymentsBaseUrl(), 'https://payments.example.com');
    await payOrder(request(), { idempotencyKey: 'k' }).catch(() => {});
    assert.equal(f.calls[1].url, 'https://payments.example.com/payments');

    setPaymentsBaseUrl(null);
    globalThis.CHECKOUT_CONFIG = { paymentsBaseUrl: 'http://page.test:9000' };
    assert.equal(getPaymentsBaseUrl(), 'http://page.test:9000');
  } finally {
    delete globalThis.CHECKOUT_CONFIG;
    setPaymentsBaseUrl(null);
    globalThis.fetch = original;
  }
  assert.throws(() => setPaymentsBaseUrl(''), TypeError);
});

test('card data goes only to the service and is kept nowhere (D10)', async () => {
  const logged = [];
  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'];
  const saved = Object.fromEntries(consoleMethods.map((m) => [m, console[m]]));
  consoleMethods.forEach((m) => { console[m] = (...args) => logged.push(args); });
  const storageSet = [];
  const savedStorage = { l: globalThis.localStorage, s: globalThis.sessionStorage };
  const spy = { setItem: (...a) => storageSet.push(a), getItem: () => null };
  Object.defineProperty(globalThis, 'localStorage', { value: spy, configurable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: spy, configurable: true });

  // A service that wrongly echoes the card in every possible place.
  const leaky = {
    payment: {
      ...payment({ outcome: 'declined', decline_reason: 'card_declined', message: 'Declined.' }),
      card: { brand: 'visa', last4: '4242', number: '4242424242424242', security_code: SECURITY_CODE },
      number: '4242424242424242',
      security_code: SECURITY_CODE,
    },
    order_paid: false,
    card: { number: '4242424242424242' },
  };
  const results = [];
  try {
    for (const f of [
      fakeFetch(201, leaky),
      fakeFetch(422, { error: { code: 'validation_failed', message: 'Bad.', fields: [{ field: 'number', code: 'invalid_number', message: 'Check it.' }] } }),
      fakeFetch(500, 'boom'),
      async () => { throw new TypeError('Failed to fetch'); },
    ]) {
      results.push(await apiWith(f).payOrder(request()));
      if (f.calls) {
        // One call only, to the payments endpoint, with the card only in the body.
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0].url, 'http://pay.test/payments');
        assert.ok(!f.calls[0].url.includes('4242'));
        const headerText = JSON.stringify(f.calls[0].init.headers);
        assert.ok(!headerText.includes('4242') && !headerText.includes(SECURITY_CODE));
      }
    }
  } finally {
    consoleMethods.forEach((m) => { console[m] = saved[m]; });
    Object.defineProperty(globalThis, 'localStorage', { value: savedStorage.l, configurable: true });
    Object.defineProperty(globalThis, 'sessionStorage', { value: savedStorage.s, configurable: true });
  }

  const text = JSON.stringify(results);
  assert.ok(!text.includes('4242424242424242'));
  assert.ok(!text.includes(CARD_NUMBER));
  assert.ok(!text.includes(SECURITY_CODE));
  assert.deepEqual(results[0].payment.card, { brand: 'visa', last4: '4242' });
  assert.deepEqual(Object.keys(results[0].payment).sort(), [
    'amount', 'card', 'created_at', 'currency', 'decline_reason', 'message',
    'order_reference', 'outcome', 'payment_reference',
  ]);
  assert.deepEqual(logged, []);
  assert.deepEqual(storageSet, []);
});

test('the request object is not changed or kept by the client', async () => {
  const req = request();
  const copy = structuredClone(req);
  const api = apiWith(fakeFetch(201, { payment: payment(), order_paid: true }));
  const r = await api.payOrder(req);
  assert.deepEqual(req, copy);
  assert.ok(!Object.values(api).some((v) => typeof v !== 'function'));
  assert.equal(r.request, undefined);
});

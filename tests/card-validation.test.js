import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCard, passesLuhn, detectBrand, FIELDS } from '../src/card-validation.js';

const NOW = new Date(Date.UTC(2026, 9, 18, 12, 0, 0)); // 18 October 2026

const good = () => ({
  cardholder_name: 'Ada Lovelace',
  number: '4242 4242 4242 4242',
  expiry_month: 12,
  expiry_year: 2030,
  security_code: '123',
});

const errorsOf = (changes) => validateCard({ ...good(), ...changes }, NOW).errors;
const only = (changes, field, code) => {
  const errors = errorsOf(changes);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.equal(errors[0].field, field);
  assert.equal(errors[0].code, code);
  assert.ok(errors[0].message.length > 0);
};

test('valid details give no errors', () => {
  assert.deepEqual(validateCard(good(), NOW), { valid: true, errors: [] });
});

test('every test card number of the service is accepted', () => {
  for (const number of [
    '4242424242424242', '5555555555554444', '4000000000000002', '4000000000009995',
    '4000000000000069', '4000000000000127', '4000000000000119',
  ]) {
    assert.equal(validateCard({ ...good(), number }, NOW).valid, true, number);
  }
});

test('defaults to the current time', () => {
  assert.equal(validateCard({ ...good(), expiry_year: 2000 }).errors[0].code, 'expired');
  assert.equal(validateCard(good()).valid, true);
});

test('missing fields are each reported as required', () => {
  const result = validateCard({}, NOW);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((e) => [e.field, e.code]), [
    ['cardholder_name', 'required'],
    ['number', 'required'],
    ['expiry', 'required'],
    ['security_code', 'required'],
  ]);
});

test('empty strings, blanks, null and a non-object count as missing', () => {
  const blanks = { cardholder_name: '   ', number: '', expiry_month: '', expiry_year: null, security_code: ' ' };
  assert.equal(validateCard(blanks, NOW).errors.length, 4);
  assert.equal(validateCard(null, NOW).errors.length, 4);
  assert.equal(validateCard(undefined, NOW).errors.length, 4);
  assert.equal(validateCard('4242', NOW).errors.length, 4);
});

test('expiry is required when only the month or only the year is given', () => {
  only({ expiry_month: '' }, 'expiry', 'required');
  only({ expiry_year: undefined }, 'expiry', 'required');
});

test('errors come in field order, one per field', () => {
  const errors = errorsOf({
    cardholder_name: '', number: '4242424242424241', expiry_year: 2020, security_code: 'abc',
  });
  assert.deepEqual(errors.map((e) => e.field), FIELDS);
  assert.deepEqual(errors.map((e) => e.code), ['required', 'invalid_number', 'expired', 'invalid_format']);
});

test('cardholder name: at most 100 characters', () => {
  assert.equal(validateCard({ ...good(), cardholder_name: 'a'.repeat(100) }, NOW).valid, true);
  only({ cardholder_name: 'a'.repeat(101) }, 'cardholder_name', 'invalid_format');
});

test('card number: spaces and dashes are ignored', () => {
  assert.equal(validateCard({ ...good(), number: '4242-4242-4242-4242' }, NOW).valid, true);
  assert.equal(validateCard({ ...good(), number: '4242424242424242' }, NOW).valid, true);
});

test('card number: fails the check digit', () => {
  only({ number: '4242424242424241' }, 'number', 'invalid_number');
  only({ number: '4242 4242 4242 4243' }, 'number', 'invalid_number');
});

test('card number: format and length', () => {
  only({ number: '4242 4242 4242 424a' }, 'number', 'invalid_format');
  only({ number: '42424242424' }, 'number', 'invalid_format'); // 11 digits
  only({ number: '4'.repeat(20) }, 'number', 'invalid_format');
  assert.equal(validateCard({ ...good(), number: '4222222222222' }, NOW).valid, true); // 13 digits
  assert.equal(validateCard({ ...good(), number: '4000000000000000006' }, NOW).errors.some((e) => e.field === 'number'), false); // 19 digits
});

test('card number given as a string with a leading zero or as a number', () => {
  only({ number: '0000000000000001' }, 'number', 'invalid_number');
  assert.equal(validateCard({ ...good(), number: 4242424242424242 }, NOW).valid, true);
});

test('expiry: the current month is still good, the month before is expired', () => {
  assert.equal(validateCard({ ...good(), expiry_month: 10, expiry_year: 2026 }, NOW).valid, true);
  only({ expiry_month: 9, expiry_year: 2026 }, 'expiry', 'expired');
  only({ expiry_month: 12, expiry_year: 2025 }, 'expiry', 'expired');
});

test('expiry: month changes at the turn of the month in UTC', () => {
  const lastSecond = new Date(Date.UTC(2026, 9, 31, 23, 59, 59));
  const firstSecond = new Date(Date.UTC(2026, 10, 1, 0, 0, 0));
  const card = { ...good(), expiry_month: 10, expiry_year: 2026 };
  assert.equal(validateCard(card, lastSecond).valid, true);
  assert.equal(validateCard(card, firstSecond).errors[0].code, 'expired');
});

test('expiry: two-digit year means 20xx; strings from form fields work', () => {
  assert.equal(validateCard({ ...good(), expiry_month: '03', expiry_year: '30' }, NOW).valid, true);
  only({ expiry_month: '03', expiry_year: '25' }, 'expiry', 'expired');
  assert.equal(validateCard({ ...good(), expiry_month: 1, expiry_year: 99 }, NOW).valid, true);
});

test('expiry: month out of range or year of the wrong shape', () => {
  only({ expiry_month: 0 }, 'expiry', 'invalid_format');
  only({ expiry_month: 13 }, 'expiry', 'invalid_format');
  only({ expiry_month: 'ab' }, 'expiry', 'invalid_format');
  only({ expiry_month: 1.5 }, 'expiry', 'invalid_format');
  only({ expiry_year: 203 }, 'expiry', 'invalid_format');
  only({ expiry_year: '20300' }, 'expiry', 'invalid_format');
  only({ expiry_year: 'xx' }, 'expiry', 'invalid_format');
});

test('security code: 3 digits, wrong length is invalid_length', () => {
  only({ security_code: '12' }, 'security_code', 'invalid_length');
  only({ security_code: '1234' }, 'security_code', 'invalid_length'); // visa
  only({ security_code: '12345' }, 'security_code', 'invalid_length');
});

test('security code: digits only', () => {
  only({ security_code: '12a' }, 'security_code', 'invalid_format');
  only({ security_code: '1 2' }, 'security_code', 'invalid_format');
});

test('security code: American Express needs 4 digits', () => {
  const amex = { number: '378282246310005' };
  assert.equal(validateCard({ ...good(), ...amex, security_code: '1234' }, NOW).valid, true);
  only({ ...amex, security_code: '123' }, 'security_code', 'invalid_length');
});

test('security code: with an unreadable number, 3 or 4 digits are accepted', () => {
  assert.equal(validateCard({ ...good(), number: '', security_code: '1234' }, NOW).errors.length, 1);
  assert.equal(validateCard({ ...good(), number: '37828224631000', security_code: '1234' }, NOW).errors[0].field, 'number');
  assert.deepEqual(
    errorsOf({ number: '', security_code: '12' }).map((e) => e.field), ['number', 'security_code'],
  );
});

test('passesLuhn', () => {
  assert.equal(passesLuhn('4242424242424242'), true);
  assert.equal(passesLuhn('378282246310005'), true);
  assert.equal(passesLuhn('79927398713'), true);
  assert.equal(passesLuhn('79927398710'), false);
  assert.equal(passesLuhn(''), false);
  assert.equal(passesLuhn('42a2'), false);
  assert.equal(passesLuhn(4242), false);
});

test('detectBrand', () => {
  assert.equal(detectBrand('4242424242424242'), 'visa');
  assert.equal(detectBrand('5555555555554444'), 'mastercard');
  assert.equal(detectBrand('2221000000000009'), 'mastercard');
  assert.equal(detectBrand('2720990000000007'), 'mastercard');
  assert.equal(detectBrand('2721000000000000'), 'unknown');
  assert.equal(detectBrand('378282246310005'), 'amex');
  assert.equal(detectBrand('6011111111111117'), 'discover');
  assert.equal(detectBrand('9999'), 'unknown');
  assert.equal(detectBrand(undefined), 'unknown');
});

test('messages never contain the card number or the security code (D10)', () => {
  const number = '4242 4242 4242 4241';
  const secret = '9876';
  const errors = errorsOf({ number, security_code: secret, expiry_year: 2020, cardholder_name: '' });
  assert.ok(errors.length >= 4);
  for (const e of errors) {
    assert.ok(!e.message.includes('4242'), e.message);
    assert.ok(!e.message.includes(secret), e.message);
    assert.deepEqual(Object.keys(e).sort(), ['code', 'field', 'message']);
  }
});

test('does not change the details it is given', () => {
  const card = good();
  const copy = structuredClone(card);
  validateCard(card, NOW);
  assert.deepEqual(card, copy);
});

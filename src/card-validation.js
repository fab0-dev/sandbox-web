// Card details validation in the browser (D4).
//
// Mirrors the checks of the payments service (contract: pay_order, "validation_failed") so the
// customer sees a wrong field before anything is sent. The service checks again and has the last
// word. Plain ES module, no dependencies; works in the browser and in Node.
//
// Card data (D10): this module keeps nothing, logs nothing, and no message it returns contains
// any part of the card number or the security code.

/** Field names, in the order errors are returned. Same names as the service uses. */
export const FIELDS = ['cardholder_name', 'number', 'expiry', 'security_code'];

/** Error codes, same as the service's validation_failed codes. */
export const CODES = {
  REQUIRED: 'required',
  INVALID_FORMAT: 'invalid_format',
  INVALID_NUMBER: 'invalid_number',
  EXPIRED: 'expired',
  INVALID_LENGTH: 'invalid_length',
};

const MAX_NAME_LENGTH = 100;
const MIN_NUMBER_DIGITS = 12;
const MAX_NUMBER_DIGITS = 19;

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/** Digits of a card number with spaces and dashes removed, or null when other characters remain. */
function normalizeNumber(value) {
  const stripped = String(value).replace(/[\s-]/g, '');
  return /^\d+$/.test(stripped) ? stripped : null;
}

/** Luhn check digit test on a string of digits. */
export function passesLuhn(digits) {
  if (typeof digits !== 'string' || !/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Card brand from the leading digits: visa, mastercard, amex, discover or unknown. */
export function detectBrand(digits) {
  const n = String(digits ?? '').replace(/[\s-]/g, '');
  if (/^3[47]/.test(n)) return 'amex';
  if (/^4/.test(n)) return 'visa';
  if (/^(5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)/.test(n)) return 'mastercard';
  if (/^(6011|65|64[4-9])/.test(n)) return 'discover';
  return 'unknown';
}

function checkName(value) {
  if (isBlank(value)) {
    return { code: CODES.REQUIRED, message: "Enter the cardholder's name as it appears on the card." };
  }
  if (String(value).trim().length > MAX_NAME_LENGTH) {
    return {
      code: CODES.INVALID_FORMAT,
      message: `The cardholder name must be at most ${MAX_NAME_LENGTH} characters.`,
    };
  }
  return null;
}

function checkNumber(value) {
  if (isBlank(value)) {
    return { code: CODES.REQUIRED, message: 'Enter the number from the front of your card.' };
  }
  const digits = normalizeNumber(value);
  if (digits === null || digits.length < MIN_NUMBER_DIGITS || digits.length > MAX_NUMBER_DIGITS) {
    return {
      code: CODES.INVALID_FORMAT,
      message: `The card number must be ${MIN_NUMBER_DIGITS} to ${MAX_NUMBER_DIGITS} digits. Spaces and dashes are fine.`,
    };
  }
  if (!passesLuhn(digits)) {
    return {
      code: CODES.INVALID_NUMBER,
      message: 'This card number does not look right. Check it and try again.',
    };
  }
  return null;
}

/** Whole number from an integer or a string of digits; null when it is neither. */
function toWholeNumber(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  const text = String(value).trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

function checkExpiry(month, year, now) {
  if (isBlank(month) || isBlank(year)) {
    return { code: CODES.REQUIRED, message: 'Enter the expiry month and year of your card.' };
  }
  const m = toWholeNumber(month);
  const y = toWholeNumber(year);
  const yearText = String(year).trim();
  const yearDigits = typeof year === 'number' ? String(year).length : yearText.length;
  if (m === null || y === null || m < 1 || m > 12 || (yearDigits !== 2 && yearDigits !== 4)) {
    return {
      code: CODES.INVALID_FORMAT,
      message: 'Enter the expiry as a month from 1 to 12 and a two or four digit year.',
    };
  }
  const fullYear = yearDigits === 2 ? 2000 + y : y;
  // A card works through the last day of its expiry month. Months are counted in UTC, as the service does.
  const thisMonth = now.getUTCFullYear() * 12 + now.getUTCMonth();
  if (fullYear * 12 + (m - 1) < thisMonth) {
    return { code: CODES.EXPIRED, message: 'This card has expired. Check the expiry date or use another card.' };
  }
  return null;
}

function checkSecurityCode(value, numberValue) {
  if (isBlank(value)) {
    return { code: CODES.REQUIRED, message: 'Enter the security code from your card.' };
  }
  const code = String(value).trim();
  if (!/^\d+$/.test(code)) {
    return { code: CODES.INVALID_FORMAT, message: 'The security code can only contain digits.' };
  }
  // Brand decides the length: 4 digits for American Express, 3 for the others. When the number
  // cannot be read, 3 or 4 is accepted, so a typo in the number does not also flag the code.
  const digits = isBlank(numberValue) ? null : normalizeNumber(numberValue);
  const numberReadable =
    digits !== null && digits.length >= MIN_NUMBER_DIGITS && digits.length <= MAX_NUMBER_DIGITS;
  if (numberReadable) {
    const expected = detectBrand(digits) === 'amex' ? 4 : 3;
    if (code.length !== expected) {
      return {
        code: CODES.INVALID_LENGTH,
        message:
          expected === 4
            ? 'Enter the 4-digit security code from the front of your card.'
            : 'Enter the 3-digit security code from the back of your card.',
      };
    }
  } else if (code.length !== 3 && code.length !== 4) {
    return {
      code: CODES.INVALID_LENGTH,
      message: 'The security code must be 3 digits, or 4 for American Express.',
    };
  }
  return null;
}

/**
 * Check card details before any payment is tried.
 *
 * @param {object} card { cardholder_name, number, expiry_month, expiry_year, security_code }.
 *   Values may be strings (form input) or numbers (month, year).
 * @param {Date} [now] The moment to judge expiry against. Defaults to the current time.
 * @returns {{valid: boolean, errors: Array<{field: string, code: string, message: string}>}}
 *   One error for each invalid field, at most, in the order of FIELDS. `field` and `code` are the
 *   service's names; `message` is plain words for the customer and never contains card data.
 */
export function validateCard(card, now = new Date()) {
  const c = card && typeof card === 'object' ? card : {};
  const found = [
    ['cardholder_name', checkName(c.cardholder_name)],
    ['number', checkNumber(c.number)],
    ['expiry', checkExpiry(c.expiry_month, c.expiry_year, now)],
    ['security_code', checkSecurityCode(c.security_code, c.number)],
  ];
  const errors = found
    .filter(([, error]) => error !== null)
    .map(([field, error]) => ({ field, code: error.code, message: error.message }));
  return { valid: errors.length === 0, errors };
}

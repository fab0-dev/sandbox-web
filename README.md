# sandbox-web

The web checkout of fab0's sandbox for connected factories: plain HTML and JavaScript, no build step.

Its factory is a copy of the `delivery` example, called by `sandbox-home`.

## Checkout payment step

`checkout.html` is the payment step: a card form for one order that already exists. It takes the order from the address:

```
checkout.html?order=ORD-1001&amount=2599&currency=USD
```

- `order`: the order reference, passed to the service as it is.
- `amount`: the amount to charge as a whole number of minor units (cents). `2599` is 25.99.
- `currency`: a three-letter ISO 4217 code, for example `USD`.

If one of them is missing or wrong, the page says the link is not complete and shows no form. `index.html` has a small form that builds such a link for a test checkout.

What the page does:

- It loads the order's payment status first. A paid order shows as paid, with the amount charged, and no form (D6).
- The customer enters cardholder name, card number, expiry month and year, and security code. The details are checked in the browser first (`src/card-validation.js`); nothing is sent while a field is wrong, and each wrong field shows its message (D4).
- While a payment is processing, the form and the Pay button are locked. The lock is taken before anything is awaited, so a double click makes one attempt (D7).
- A successful payment shows that the order is paid and the amount charged (D2).
- A declined payment shows the service's message as it is, on the same page, with the form ready to try again, with the same card or another (D3, D5). The decline reason is set as `data-reason` on the message so the style can follow it.
- Field errors from the service (`validation_failed`) show next to the same fields as the local ones. The `order_already_paid` refusal shows the order as paid with the service's message and no form (D6). Other refusals show the service's message above the form.
- If a payment call fails without a usable answer (no connection, a server error), the page reads the order's status before it offers the form again, so a payment that went through shows as paid.
- The card number and security code are cleared after each attempt that was sent to the service, whatever the answer. When a local check stops the submit, nothing was sent and what the customer typed stays so they can fix it. The card data is read from the form only inside the submit, handed to the API client, and kept nowhere else (D10).

The amount comes from the link, as the service charges the amount it is sent (spec, open question 2).

### Files

- `checkout.html`, `styles.css`: the page and its style.
- `src/checkout.js`: the logic (`createCheckout`, no DOM) and the binding to the page (`mountCheckout`). It starts by itself on `checkout.html`.
- `src/card-validation.js`: local card checks. `src/payments-api.js`, `src/config.js`: the client of the payments service and its base URL.

### Run it

There is no build step. The page uses ES modules, which browsers do not load from `file://`, so serve the folder:

```
python3 -m http.server 8080
```

Start the payments service (`python3 -m payments` in sandbox-api, which listens on `http://127.0.0.1:8000`), then open `http://127.0.0.1:8080/` or go straight to `http://127.0.0.1:8080/checkout.html?order=ORD-1001&amount=2599&currency=USD`.

To use another service address, set it before the module loads, as described in `src/config.js`:

```html
<script>window.CHECKOUT_CONFIG = { paymentsBaseUrl: 'https://payments.example.com' };</script>
```

The test cards that give each outcome are documented in the service repository, `docs/test-cards.md`. For example `4242 4242 4242 4242` succeeds, `4000 0000 0000 0002` is declined, and `4000 0000 0000 9995` has insufficient funds. Use any name, an expiry in the future and a 3-digit security code.

### Tests

```
npm test
```

runs all tests with Node's test runner (`node --test "tests/**/*.test.js"`). `tests/checkout.test.js` covers the logic with a fake API and the page binding with a small stand-in for the elements of `checkout.html`; no browser is needed.

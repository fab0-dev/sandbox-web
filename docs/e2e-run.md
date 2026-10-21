# Browser run of the checkout against the running service

This is the record of the run of the checkout in a real browser against the real payments service (no fake API). The script is `e2e/checkout-run.mjs`, started with `npm run e2e`. It was written for the Story "Refund a paid order in full" (D13 to D17) and also covers what the checkout did before (D15). A person can repeat it from this page.

## What was run

| | Service (sandbox-api) | Checkout (sandbox-web) |
|---|---|---|
| Commit | `3c5293a16540`, branch `sandbox-api/8/base` (run 8: the refund store, Refund payment and the refund documentation merged) | `7a9619548610`, branch `sandbox-web/8/base` plus run 8's T1 and T2 (the client reads refunds, the checkout has the refunded panel), and the files of this task: `e2e/`, `package.json`, this page. No file the page loads was changed by this task. |
| Started with | `python3 -m payments --host 127.0.0.1 --port 8000 --db :memory:`, in the service repository | `python3 -m http.server 8080 --bind 127.0.0.1`, in the checkout repository |
| Address | `http://127.0.0.1:8000` | `http://127.0.0.1:8080` |

The two addresses are two origins (the port differs), so every call of the checkout is a cross-origin call. The checkout's default service address (`src/config.js`) is `http://127.0.0.1:8000`, so nothing was configured. The service was started empty (`--db :memory:`), so a run starts with no orders.

Browser: Chromium 140 (Playwright 1.55.0), time zone `Pacific/Auckland`, locale `en-US`. The time zone is fixed so the refund date can be predicted: the refunds below were made at about 13:32 UTC on 2026-10-21, which is already 22 October in Auckland, and the page showed "October 22, 2026".

## How to repeat it

```
git clone <the service repository> sandbox-api      # check out the commit above
git clone <the checkout repository> sandbox-web     # the commit above, or a later one
cd sandbox-web
npm install                                         # installs Playwright (devDependency, 1.55.0)
npx playwright install chromium                     # once, if Playwright has no browser yet
PAYMENTS_SERVICE_DIR=../sandbox-api npm run e2e
```

The script starts both sides by itself with the commands in the table, waits until they answer, runs the browser, and stops them. It stops with a message when port 8000 or 8080 is in use. Settings, all optional: `PAYMENTS_SERVICE_DIR` (default `../sandbox-api`), `SERVICE_PORT` (8000), `WEB_PORT` (8080), `E2E_TIME_ZONE`, `E2E_SCREENSHOTS` (a folder for screenshots), `E2E_BROWSER_PATH` (a Chromium to use instead of Playwright's own). Its output lists both commits, every check as `PASS` or `FAIL`, and ends with `RESULT: all checks passed` (exit code 0) or the failed checks (exit code 1). Each run uses new order references (`e2e-<run id>-...`), so it can be repeated.

To do the same by hand, start both sides as in the table, open the checkout links below in a browser, and make the refunds with `curl` as `docs/refunds.md` of the service says.

## Test cards used

From the service's `docs/test-cards.md`, with the name Ada Lovelace, expiry 12/2030 and security code 123:

- `4242 4242 4242 4242` (Visa): succeeded.
- `5555 5555 5555 4444` (Mastercard): succeeded. Used from the stale page of D14, where no payment is made.
- `4000 0000 0000 0002` (Visa): declined, `card_declined`, message "Your card was declined. Try another card."

Every order is for `2599` `USD` (checkout link `checkout.html?order=<order>&amount=2599&currency=USD`, shown as $25.99).

## What was done and seen

Order references are shown as `<run>`, the run id the script puts in each. The payment references below are from the recorded run; they differ on every run.

### D15: an unpaid order and a paid, unrefunded order (as before)

Order `e2e-<run>-unpaid`.

1. Opened its checkout. Seen: the card form and the Pay button; no paid panel and no refunded panel.
2. Paid with the declined card `4000 0000 0000 0002`. Seen: "Your card was declined. Try another card." (the service's message as it is), the form still there, the card number and security code fields emptied.
3. Paid again with `4242 4242 4242 4242`. Seen: "This order is paid", amount charged $25.99, card "Visa ending 4242", no form.
4. Order payment status (`GET /orders/e2e-<run>-unpaid/payments`): `status` `paid`, two attempts (the success, then the decline).
5. Opened the checkout of the paid order again. Seen: "This order is paid", no form, not shown as refunded.

### D13: a refunded order, opened

Order `e2e-<run>-refunded`.

1. Paid with `POST /payments` through the service (not through the browser), card `4242 4242 4242 4242`, amount 2599 USD. Payment reference `pay_1400cdbd579b`, outcome `succeeded`.
2. Refunded with the service's Refund payment call, as `docs/refunds.md` ("How to refund") says:

   ```
   curl -X POST http://127.0.0.1:8000/payments/pay_1400cdbd579b/refund \
     -H 'Content-Type: application/json' -d '{"reason": "Out of stock"}'
   ```

   Answer: 200, the payment with `refund` `{amount: 2599, currency: USD, reason: "Out of stock", refunded_at: 2026-10-21T13:32:38Z}`.
3. Opened the checkout of the order in a new browser context. Seen: the heading "This order was refunded" and "Refund date October 22, 2026" (the time above in the Auckland zone). No card form, no input and no button visible, no paid panel, no refusal text. The shop's reason "Out of stock" was not on the page. The page made one call, the status read (`GET /orders/.../payments`, 200), and no payment call.

### D14: the order is refunded while its checkout is open

Order `e2e-<run>-meanwhile`.

1. Opened its checkout in the first browser context. Seen: the card form (unpaid).
2. In a second browser context, opened the same checkout and paid it with the form and `4242 4242 4242 4242`. Seen there: "This order is paid", $25.99.
3. Found the payment (`pay_41aae07f0f83`) in the order's status and refunded it:

   ```
   curl -X POST http://127.0.0.1:8000/payments/pay_41aae07f0f83/refund \
     -H 'Content-Type: application/json' -d '{"reason": "Customer cancelled"}'
   ```

   Answer: 200, `refunded_at` `2026-10-21T13:32:39Z`.
4. Back on the first page, which still showed the form: filled it with `5555 5555 5555 4444` and pressed Pay. Seen: the service's message as it is, "This order was refunded, so it cannot be paid again.", and the refunded panel with "Refund date October 22, 2026". No form, no Pay button, and the reason "Customer cancelled" not shown. The page made one payment call, `POST /payments`, answered 409 (`order_refunded`).
5. Order payment status after that: `status` `refunded`, `refunded_at` `2026-10-21T13:32:39Z`, one payment only (the success from the second context, with its refund). The refused payment recorded no attempt. The list of attempts was the same as before the refusal.
6. Reloaded the first page. Seen: the refunded panel with the same date, no form.

### Console, errors and cross-origin (D15)

- No console error, page error or failed request on any page, apart from one line described next.
- Chromium writes a console error line for a response with a 4xx status: "Failed to load resource: the server responded with a status of 409 (Conflict)". It appeared once, for the refused payment of D14 step 4. It is the browser reporting the 409 that the service is meant to answer with, not an error of the page, and the script accepts exactly this line (a 4xx status), in that scenario only. Any other console error fails the run.
- Every service answer the pages saw (10 of them, 200, 201 and the 409) carried `Access-Control-Allow-Origin: *`, and no cross-origin error was reported.

### Result

`RESULT: all checks passed`, exit code 0, in the last three runs in a row; the payment references above are from the last. The very first run failed three date checks because of a fault in the script (see below), which was fixed. `npm test` passes (120 tests).

## What was wrong on the checkout's side

Nothing. The run found nothing to fix in `src/checkout.js` or `src/payments-api.js`, so this task adds no fix and no unit test for one. The first run of the script failed three checks about the date because the script's browser time zone option was misspelled and the browser used the machine's zone; that was a fault of the script, fixed there.

## Service faults still open

None found in this run. The service answered each call as its contract and `docs/refunds.md` say: Refund payment 200, Order payment status `refunded` with `refunded_at`, Pay order for a refunded order 409 `order_refunded` with the message and time, no attempt recorded, and the cross-origin header on every answer.

Not covered here, and not a fault: the shop's refusals of Refund payment (D2 to D5) are the service's to show; the checkout offers no refund.

## Known limits of this run

- The refund is made by the script with `fetch`, the same call as the `curl` above; the checkout has no refund action.
- Only Chromium was used. The date depends on the browser's time zone; the script fixes it.
- The checkout commit in the table is the base of this task. The task's own files (`e2e/`, `package.json`, this page, the README link) were added on top without changing the page.

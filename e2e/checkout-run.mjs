// Browser run of the checkout against the running payments service, with no fake API.
//
//   npm install        (once: installs Playwright; `npx playwright install chromium` if it has no browser yet)
//   npm run e2e
//
// What it does:
//   1. Starts the payments service from its own repository with its documented command
//      (`python3 -m payments --host 127.0.0.1 --port 8000 --db :memory:`) and the checkout's files with
//      `python3 -m http.server 8080`. Nothing is faked: the page calls the service from another origin.
//   2. Drives Chromium through the checkout: an unpaid order, a paid order, a decline and a retry (D15),
//      a refunded order opened fresh (D13), and an order refunded while its checkout is open (D14).
//      Refunds are made with the service's Refund payment call, as docs/refunds.md in the service says.
//   3. Watches every page for console errors, page errors and failed requests, and every service answer for
//      the cross-origin header (D15).
//   4. Prints what it did and saw, with both commits, so docs/e2e-run.md can be kept from it. Exit code 0
//      when every check passed, 1 otherwise.
//
// Settings, by environment variable:
//   PAYMENTS_SERVICE_DIR  the service repository (default ../sandbox-api, next to this repository)
//   SERVICE_PORT          default 8000, the port the checkout calls by default (src/config.js)
//   WEB_PORT              default 8080
//   E2E_TIME_ZONE         the browser's time zone, default Pacific/Auckland (refund dates are shown in it)
//   E2E_SCREENSHOTS       a folder; when set, a screenshot of each result is saved there
//   E2E_BROWSER_PATH      path of a Chromium executable, when Playwright's own is not installed

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run `npm install` (and `npx playwright install chromium`), then `npm run e2e`.');
  process.exit(2);
}

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serviceDir = path.resolve(process.env.PAYMENTS_SERVICE_DIR || path.join(webDir, '..', 'sandbox-api'));
const SERVICE_PORT = Number(process.env.SERVICE_PORT || 8000);
const WEB_PORT = Number(process.env.WEB_PORT || 8080);
const TIME_ZONE = process.env.E2E_TIME_ZONE || 'Pacific/Auckland';
const SERVICE_URL = `http://127.0.0.1:${SERVICE_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const SCREENSHOTS = process.env.E2E_SCREENSHOTS || '';

const RUN_ID = Date.now().toString(36);
const REFUNDED_MESSAGE = 'This order was refunded, so it cannot be paid again.';

// Test cards from the service's docs/test-cards.md.
const CARD_OK = '4242 4242 4242 4242';
const CARD_OK_MASTERCARD = '5555 5555 5555 4444';
const CARD_DECLINED = '4000 0000 0000 0002';
const DECLINED_MESSAGE = 'Your card was declined. Try another card.';

// ---- reporting ------------------------------------------------------------------------------------

const failures = [];
function log(line = '') { console.log(line); }
function check(name, ok, detail = '') {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
  return ok;
}
function seen(line) { log(`      saw: ${line}`); }

function gitInfo(dir) {
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  try {
    const dirty = git('status', '--porcelain') === '' ? '' : ' (with uncommitted changes)';
    return `${git('rev-parse', '--short=12', 'HEAD')} on ${git('rev-parse', '--abbrev-ref', 'HEAD')}${dirty}`;
  } catch {
    return 'unknown (not a git repository)';
  }
}

// ---- starting both sides --------------------------------------------------------------------------

const children = [];
function start(command, args, cwd, label) {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  child.stdout.on('data', (d) => output.push(String(d)));
  child.stderr.on('data', (d) => output.push(String(d)));
  child.on('error', (e) => output.push(`${label}: ${e.message}`));
  child.output = output;
  child.label = label;
  children.push(child);
  return child;
}

async function waitFor(url, label, child) {
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) {
      throw new Error(`${label} stopped at start-up:\n${child.output.join('')}`);
    }
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${label} did not answer at ${url}`);
}

async function portIsFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`);
    return false; // something answered
  } catch {
    return true;
  }
}

function stopAll() {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
}

// ---- calls to the service, made as the shop does (not through the checkout) ------------------------

async function serviceCall(method, pathname, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${SERVICE_URL}${pathname}`, init);
  return { status: response.status, body: await response.json() };
}

async function payByApi(order, amount, number) {
  const answer = await serviceCall('POST', '/payments', {
    order_reference: order, amount, currency: 'USD',
    card: { cardholder_name: 'Ada Lovelace', number, expiry_month: 12, expiry_year: 2030, security_code: '123' },
  });
  return answer;
}

const refundByApi = (reference, reason) =>
  serviceCall('POST', `/payments/${encodeURIComponent(reference)}/refund`, { reason });

const lookup = (order) => serviceCall('GET', `/orders/${encodeURIComponent(order)}/payments`);

// ---- the browser ------------------------------------------------------------------------------------

// Every page gets a watcher. A 4xx answer shows up in Chromium's console as an error line about the
// resource; those lines are not counted as errors when the run expects that refusal (see `expectRefusals`).
function watch(page, label, problems) {
  const watcher = { label, refusalLines: [], serviceAnswers: [] };
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/Failed to load resource: the server responded with a status of 4\d\d/.test(text)) {
      watcher.refusalLines.push(text);
    } else {
      problems.push(`${label}: console error: ${text}`);
    }
  });
  page.on('pageerror', (error) => problems.push(`${label}: page error: ${error.message}`));
  page.on('requestfailed', (request) => {
    problems.push(`${label}: request failed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`);
  });
  page.on('response', async (response) => {
    if (!response.url().startsWith(SERVICE_URL)) return;
    const headers = response.headers();
    watcher.serviceAnswers.push({
      method: response.request().method(),
      url: response.url().slice(SERVICE_URL.length),
      status: response.status(),
      allowOrigin: headers['access-control-allow-origin'] ?? null,
    });
  });
  return watcher;
}

function checkoutUrl(order, amount = 2599) {
  return `${WEB_URL}/checkout.html?order=${encodeURIComponent(order)}&amount=${amount}&currency=USD`;
}

async function visible(page, id) {
  return page.locator(`#${id}`).isVisible();
}

async function fillCard(page, number) {
  await page.fill('#cardholder_name', 'Ada Lovelace');
  await page.fill('#number', number);
  await page.fill('#expiry_month', '12');
  await page.fill('#expiry_year', '2030');
  await page.fill('#security_code', '123');
}

async function screenshot(page, name) {
  if (!SCREENSHOTS) return;
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`), fullPage: true });
}

// The date the page should show: the refund's time in the browser's time zone, as a long en-US date.
function expectedDate(refundedAt) {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: TIME_ZONE }).format(new Date(refundedAt));
}

// No card form and no way to pay: the form is hidden, so no input or Pay button can be seen or reached.
async function assertNoForm(page, name) {
  const formHidden = !(await visible(page, 'payment-form'));
  const noVisibleInputs = (await page.locator('input:visible, button:visible').count()) === 0;
  check(`${name}: no card form and no Pay button`, formHidden && noVisibleInputs,
    `form hidden ${formHidden}, visible inputs or buttons ${noVisibleInputs ? 0 : 'some'}`);
}

async function pageText(page) {
  return (await page.locator('main').innerText()).replace(/\s+/g, ' ').trim();
}

// ---- the run ------------------------------------------------------------------------------------------

async function run() {
  if (!existsSync(path.join(serviceDir, 'payments', '__main__.py'))) {
    throw new Error(`The payments service is not at ${serviceDir}. Set PAYMENTS_SERVICE_DIR to its repository.`);
  }
  for (const [port, label] of [[SERVICE_PORT, 'SERVICE_PORT'], [WEB_PORT, 'WEB_PORT']]) {
    if (!(await portIsFree(port))) throw new Error(`Port ${port} is in use. Stop what uses it or set ${label}.`);
  }

  log('# Browser run of the checkout against the running payments service');
  log();
  log(`service repository: ${serviceDir}`);
  log(`service commit:     ${gitInfo(serviceDir)}`);
  log(`checkout repository: ${webDir}`);
  log(`checkout commit:     ${gitInfo(webDir)}`);
  const serviceArgs = ['-m', 'payments', '--host', '127.0.0.1', '--port', String(SERVICE_PORT), '--db', ':memory:'];
  log(`service started:    python3 ${serviceArgs.join(' ')}   (in the service repository)`);
  log(`checkout served:    python3 -m http.server ${WEB_PORT} --bind 127.0.0.1   (in the checkout repository)`);
  log(`browser:            Chromium via Playwright, time zone ${TIME_ZONE}`);
  log();

  const service = start('python3', serviceArgs, serviceDir, 'payments service');
  const web = start('python3', ['-m', 'http.server', String(WEB_PORT), '--bind', '127.0.0.1'], webDir, 'checkout server');
  await waitFor(`${SERVICE_URL}/payments`, 'The payments service', service);
  await waitFor(`${WEB_URL}/checkout.html`, 'The checkout server', web);

  const launchOptions = process.env.E2E_BROWSER_PATH ? { executablePath: process.env.E2E_BROWSER_PATH } : {};
  const browser = await chromium.launch(launchOptions);
  log(`browser version:    ${browser.version()}`);
  log();

  const problems = [];
  const contextOptions = { timezoneId: TIME_ZONE, locale: 'en-US' };
  const answers = []; // every service answer the pages saw, for the cross-origin check
  const sawAnswers = (watcher) => answers.push(...watcher.serviceAnswers);

  try {
    // ---- D15: an unpaid order, as before ------------------------------------------------------------
    {
      log('## D15 unpaid order: form, decline, retry, paid');
      const order = `e2e-${RUN_ID}-unpaid`;
      const context = await browser.newContext(contextOptions);
      const page = await context.newPage();
      const watcher = watch(page, 'unpaid', problems);
      await page.goto(checkoutUrl(order));
      await page.locator('#payment-form').waitFor({ state: 'visible' });
      check('unpaid order: card form and Pay button shown', await visible(page, 'submit-button'));
      check('unpaid order: no paid or refunded panel',
        !(await visible(page, 'paid-panel')) && !(await visible(page, 'refunded-panel')));
      await screenshot(page, 'unpaid');

      await fillCard(page, CARD_DECLINED);
      await page.click('#submit-button');
      await page.locator('#decline-panel').waitFor({ state: 'visible' });
      const declineText = (await page.locator('#decline-message').innerText()).trim();
      check('decline shows the service message and the form stays', declineText === DECLINED_MESSAGE && (await visible(page, 'submit-button')), declineText);
      check('after a send the card number and security code are empty',
        (await page.inputValue('#number')) === '' && (await page.inputValue('#security_code')) === '');

      await fillCard(page, CARD_OK);
      await page.click('#submit-button');
      await page.locator('#paid-panel').waitFor({ state: 'visible' });
      check('retry with another card: order shown as paid, amount charged, no form',
        (await page.locator('#paid-amount').innerText()) === '$25.99' && !(await visible(page, 'payment-form')),
        `amount ${await page.locator('#paid-amount').innerText()}, card ${await page.locator('#paid-card').innerText()}`);
      await screenshot(page, 'paid-after-retry');
      const status = await lookup(order);
      check('lookup of the unpaid order: paid, two attempts (the decline and the success)',
        status.body.status === 'paid' && status.body.payments.length === 2,
        `status ${status.body.status}, attempts ${status.body.payments.map((p) => p.outcome).join(', ')}`);

      // A paid, unrefunded order opened afresh.
      await page.goto(checkoutUrl(order));
      await page.locator('#paid-panel').waitFor({ state: 'visible' });
      const paidText = await pageText(page);
      check('paid, unrefunded order opened again: paid panel, no form, not shown as refunded',
        !(await visible(page, 'payment-form')) && !(await visible(page, 'refunded-panel')) && /This order is paid/.test(paidText),
        paidText);
      sawAnswers(watcher);
      check('unpaid/paid pages: no console error, page error or failed request', problems.length === 0, problems.join('; '));
      check('unpaid/paid pages: no 4xx answer (a decline is a 201)', watcher.refusalLines.length === 0, watcher.refusalLines.join('; '));
      await context.close();
      log();
    }

    // ---- D13: a refunded order opened fresh -------------------------------------------------------
    {
      log('## D13 refunded order opened');
      const order = `e2e-${RUN_ID}-refunded`;
      const pay = await payByApi(order, 2599, CARD_OK);
      const reference = pay.body.payment?.payment_reference;
      check('order paid through the service with the test card 4242 4242 4242 4242',
        pay.status === 201 && pay.body.payment?.outcome === 'succeeded', `payment ${reference}`);
      const reason = 'Out of stock';
      const refund = await refundByApi(reference, reason);
      const refundedAt = refund.body.payment?.refund?.refunded_at;
      check('refund made with POST /payments/{payment_reference}/refund',
        refund.status === 200 && refund.body.payment?.refund?.reason === reason,
        `payment ${reference}, reason "${reason}", status ${refund.status}, refunded_at ${refundedAt}`);

      const context = await browser.newContext(contextOptions);
      const page = await context.newPage();
      const watcher = watch(page, 'refunded', problems);
      await page.goto(checkoutUrl(order));
      await page.locator('#refunded-panel').waitFor({ state: 'visible' });
      const text = await pageText(page);
      const date = expectedDate(refundedAt);
      seen(`page text: ${text}`);
      check('refunded order: "This order was refunded" shown', /This order was refunded/.test(text));
      check(`refunded order: the refund date is shown (${date})`, (await page.locator('#refunded-date').innerText()) === date,
        await page.locator('#refunded-date').innerText());
      check('refunded order: the shop reason is not shown', !text.includes(reason));
      check('refunded order: no "This order is paid" and no refusal text',
        !(await visible(page, 'paid-panel')) && !(await visible(page, 'refunded-refusal')));
      await assertNoForm(page, 'refunded order');
      await screenshot(page, 'refunded-opened');
      check('refunded order: no console error, page error or failed request', problems.length === 0, problems.join('; '));
      check('refunded order: the page made no payment call',
        !watcher.serviceAnswers.some((a) => a.method === 'POST'), watcher.serviceAnswers.map((a) => `${a.method} ${a.url} ${a.status}`).join(', '));
      sawAnswers(watcher);
      await context.close();
      log();
    }

    // ---- D14: refunded while the checkout is open -------------------------------------------------
    {
      log('## D14 order refunded while its checkout is open');
      const order = `e2e-${RUN_ID}-meanwhile`;
      const first = await browser.newContext(contextOptions);
      const page = await first.newPage();
      const watcher = watch(page, 'first page', problems);
      await page.goto(checkoutUrl(order));
      await page.locator('#payment-form').waitFor({ state: 'visible' });
      check('first page: unpaid order, form shown', await visible(page, 'submit-button'));

      // Another context (another customer tab) pays the same order through the form.
      const second = await browser.newContext(contextOptions);
      const other = await second.newPage();
      const otherWatcher = watch(other, 'second page', problems);
      await other.goto(checkoutUrl(order));
      await other.locator('#payment-form').waitFor({ state: 'visible' });
      await fillCard(other, CARD_OK);
      await other.click('#submit-button');
      await other.locator('#paid-panel').waitFor({ state: 'visible' });
      check('second context: pays the same order, shown as paid', (await other.locator('#paid-amount').innerText()) === '$25.99');
      sawAnswers(otherWatcher);

      const before = await lookup(order);
      const reference = before.body.payments[0].payment_reference;
      const reason = 'Customer cancelled';
      const refund = await refundByApi(reference, reason);
      const refundedAt = refund.body.payment?.refund?.refunded_at;
      check('refund made with POST /payments/{payment_reference}/refund',
        refund.status === 200 && refund.body.payment?.refund?.reason === reason,
        `payment ${reference}, reason "${reason}", status ${refund.status}, refunded_at ${refundedAt}`);

      // Still on the first page: it shows the form. Pay from it.
      check('first page still shows the form before the customer pays', await visible(page, 'payment-form'));
      await fillCard(page, CARD_OK_MASTERCARD);
      await page.click('#submit-button');
      await page.locator('#refunded-panel').waitFor({ state: 'visible' });
      const refusal = (await page.locator('#refunded-refusal').innerText()).trim();
      const date = expectedDate(refundedAt);
      seen(`page text: ${await pageText(page)}`);
      check('first page: the service refunded message shown as it is', refusal === REFUNDED_MESSAGE && (await visible(page, 'refunded-refusal')), refusal);
      check(`first page: then the order as refunded, with the date (${date})`, (await page.locator('#refunded-date').innerText()) === date,
        await page.locator('#refunded-date').innerText());
      check('first page: the shop reason is not shown', !(await pageText(page)).includes(reason));
      await assertNoForm(page, 'first page');
      await screenshot(page, 'refunded-meanwhile');

      const posts = watcher.serviceAnswers.filter((a) => a.method === 'POST');
      check('first page: Pay order was refused with 409', posts.length === 1 && posts[0].status === 409, posts.map((p) => `${p.method} ${p.url} ${p.status}`).join(', '));
      check('first page: the refusal logged the one 4xx resource line the browser shows for a 409',
        watcher.refusalLines.length === 1 && /409/.test(watcher.refusalLines[0]), watcher.refusalLines.join('; '));

      const after = await lookup(order);
      check('lookup: no new attempt (still one payment), status refunded, same refund time',
        after.body.payments.length === 1 && after.body.status === 'refunded' && after.body.refunded_at === refundedAt
          && after.body.payments[0].refund?.reason === reason,
        `attempts ${after.body.payments.length}, status ${after.body.status}, refunded_at ${after.body.refunded_at}`);
      check('lookup of the order: attempts are as before the refused payment',
        JSON.stringify(after.body.payments.map((p) => p.payment_reference)) === JSON.stringify(before.body.payments.map((p) => p.payment_reference)));

      // The page can be reloaded: still refunded.
      await page.reload();
      await page.locator('#refunded-panel').waitFor({ state: 'visible' });
      check('first page reloaded: refunded with the date, no form', (await page.locator('#refunded-date').innerText()) === date && !(await visible(page, 'payment-form')));

      sawAnswers(watcher);
      await first.close();
      await second.close();
      log();
    }

    // ---- cross-origin and console, over the whole run --------------------------------------------
    log('## Whole run');
    const origin = new URL(WEB_URL).origin;
    check('the page origin is not the service origin', origin !== new URL(SERVICE_URL).origin, `${origin} calls ${SERVICE_URL}`);
    check(`every service answer the pages saw carries Access-Control-Allow-Origin (${answers.length} answers)`,
      answers.length > 0 && answers.every((a) => a.allowOrigin === '*'),
      answers.filter((a) => a.allowOrigin !== '*').map((a) => `${a.method} ${a.url} ${a.status}`).join(', '));
    check('no console error, page error, failed request or cross-origin error in any page', problems.length === 0, problems.join('; '));
  } finally {
    await browser.close();
  }
}

try {
  await run();
} catch (e) {
  failures.push(`the run stopped: ${e.message}`);
  log(`ERROR ${e.stack || e.message}`);
} finally {
  stopAll();
}

log();
if (failures.length === 0) {
  log('RESULT: all checks passed');
} else {
  log(`RESULT: ${failures.length} failed`);
  for (const f of failures) log(`  - ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);

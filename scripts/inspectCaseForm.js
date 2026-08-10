// Read-only diagnostic: log in as the requestor, open the new-case form for a
// given request type (tab + "Begin Request" card), and dump the form's fields
// (type, disabled, value length, label, Party-1/Party-2 grouping). Never submits.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.COMMON_GROUND_URL;
const email = process.env.REQUESTOR_EMAIL;
const password = process.env.REQUESTOR_PASSWORD;
const selectorsPath = path.resolve(rootDir, process.env.SELECTORS_PATH ?? 'config/selectors.example.json');
const selectors = JSON.parse(fs.readFileSync(selectorsPath, 'utf8'));

if (!url || !email || !password) throw new Error('COMMON_GROUND_URL, REQUESTOR_EMAIL and REQUESTOR_PASSWORD must be set.');

// [tab regex source, card regex source] for each request type to inspect.
const targets = [
  { name: 'Raise', tab: 'Discussion Request', card: 'Raise Request|\\bRaise\\b' },
  { name: 'Performance Review', tab: 'Performance Review', card: 'Performance Review' }
];

const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false', slowMo: Number(process.env.SLOW_MO_MS ?? 0) });
try {
  const context = await browser.newContext();
  const page = await context.newPage();

  await signIn(page);

  const results = [];
  for (const target of targets) {
    const snapshot = await inspectForm(page, target).catch((error) => ({ target: target.name, error: error.message }));
    results.push(snapshot);
  }

  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}

// The SPA can flip the URL to /dashboard before the auth token is written and then bounce
// back to /login?message=login_required. Mirror the harness: submit, then drive to
// /dashboard ourselves, re-navigating while the token is still stored.
async function signIn(page) {
  // The site root now serves a marketing landing page (no login form), so navigate to
  // /login explicitly rather than relying on the root redirecting.
  await page.goto(new URL('/login', url).toString(), { waitUntil: 'domcontentloaded' });

  const passwordField = page.locator(selectors.auth.passwordInput).first();
  const submitButton = page.locator(selectors.auth.submitButton).first();
  const hasTokenNow = () => page.evaluate(() => Boolean(window.sessionStorage.getItem('access_token'))).catch(() => false);

  // The login form is a controlled React input that a hydration pass can clear right after
  // typing, and the submit click can land before hydration wires it up. Mirror the harness:
  // re-fill until the value sticks, click, and from attempt 2 also press Enter.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    for (const [selector, value] of [[selectors.auth.emailInput, email], [selectors.auth.passwordInput, password]]) {
      const field = page.locator(selector).first();
      for (let i = 1; i <= 3; i += 1) {
        await field.fill(value).catch(() => {});
        if ((await field.inputValue().catch(() => '')) === value) break;
        await page.waitForTimeout(300);
      }
    }
    await submitButton.scrollIntoViewIfNeeded().catch(() => {});
    await submitButton.click({ timeout: 10000 }).catch(() => {});
    if (attempt >= 2) await passwordField.press('Enter').catch(() => {});

    let stored = false;
    const tokenDeadline = Date.now() + 12000;
    while (Date.now() < tokenDeadline) {
      if (await hasTokenNow()) { stored = true; break; }
      await page.waitForTimeout(300);
    }
    console.log(`[inspect] submit attempt ${attempt}: token=${stored}, url=${page.url()}`);
    if (stored) break;
    await page.waitForTimeout(1000);
  }

  const dashUrl = new URL('/dashboard', url).toString();
  const hasToken = () => page.evaluate(() => Boolean(window.sessionStorage.getItem('access_token'))).catch(() => false);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (!/\/dashboard(?:[/?#]|$)/i.test(page.url())) {
      await page.goto(dashUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const bounced = /login_required/i.test(page.url()) || /\/login(?:[/?#]|$)/i.test(page.url());
    const tokenStored = await hasToken();
    console.log(`[inspect] login attempt ${attempt}: url=${page.url()}, token=${tokenStored}, bounced=${bounced}`);
    if (!bounced && /\/dashboard(?:[/?#]|$)/i.test(page.url())) return;
    if (!tokenStored) break;
    await page.waitForTimeout(750);
  }
  throw new Error(`inspectCaseForm could not reach the dashboard; stuck at ${page.url()}`);
}

async function inspectForm(page, target) {
  await page.goto(new URL('/request/new', url).toString(), { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  // Select the request-type tab (tolerant of tab/button/link/text markup).
  const tabPattern = new RegExp(target.tab, 'i');
  let tabClicked = false;
  for (const role of ['tab', 'button', 'link']) {
    const locator = page.getByRole(role, { name: tabPattern }).first();
    if (await locator.isVisible({ timeout: 1500 }).catch(() => false)) {
      await locator.click().catch(() => {});
      tabClicked = true;
      break;
    }
  }
  if (!tabClicked) {
    const textTab = page.getByText(tabPattern, { exact: false }).first();
    if (await textTab.isVisible({ timeout: 1500 }).catch(() => false)) await textTab.click().catch(() => {});
  }
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  // Click "Begin Request" within the matching card.
  await page.getByRole('button', { name: /Begin Request/i }).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const beganRequest = await page.evaluate(({ cardSource }) => {
    const cardPattern = new RegExp(cardSource, 'i');
    const beginPattern = /Begin Request/i;
    const titles = [...document.querySelectorAll('h1,h2,h3,h4,strong,span,p,a,div')]
      .filter((element) => cardPattern.test((element.innerText || '').trim()))
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    for (const title of titles) {
      let node = title;
      for (let depth = 0; node && depth < 6; depth += 1) {
        const button = [...node.querySelectorAll('button,a,[role="button"]')]
          .find((el) => beginPattern.test((el.innerText || '').trim()) && !el.disabled);
        if (button) { button.click(); return true; }
        node = node.parentElement;
      }
    }
    return false;
  }, { cardSource: target.card });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  // Give the form a moment to render and auto-fill the logged-in party.
  await page.waitForTimeout(2000);

  const form = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const selectorFor = (element) => {
      if (element.id) return `#${element.id}`;
      if (element.getAttribute('data-testid')) return `[data-testid="${element.getAttribute('data-testid')}"]`;
      if (element.getAttribute('name')) return `${element.tagName.toLowerCase()}[name="${element.getAttribute('name')}"]`;
      if (element.getAttribute('type')) return `${element.tagName.toLowerCase()}[type="${element.getAttribute('type')}"]`;
      return element.tagName.toLowerCase();
    };
    const partyContext = (element) => {
      let node = element;
      for (let depth = 0; node && depth < 8; depth += 1) {
        const text = (node.innerText || '');
        if (/party\s*1/i.test(text) && !/party\s*2/i.test(text)) return 'Party 1';
        if (/party\s*2/i.test(text) && !/party\s*1/i.test(text)) return 'Party 2';
        node = node.parentElement;
      }
      return null;
    };

    // Party 1 / Party 2 are no longer plain inputs on the redesigned form, so also dump
    // the interactive widgets (buttons, comboboxes, contenteditable) grouped by party —
    // enumerating only input/textarea/select hides the controls that replaced them.
    const describe = (element) => ({
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      type: element.getAttribute('type'),
      role: element.getAttribute('role'),
      testid: element.getAttribute('data-testid'),
      className: (element.getAttribute('class') || '').slice(0, 60) || null,
      placeholder: element.getAttribute('placeholder'),
      ariaLabel: element.getAttribute('aria-label'),
      text: (element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60) || null,
      value: typeof element.value === 'string' ? element.value.slice(0, 40) : null,
      disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
      party: partyContext(element)
    });
    const WIDGETS = 'input,textarea,select,button,[role="combobox"],[role="listbox"],[role="button"],[contenteditable="true"]';

    return {
      url: window.location.href,
      headings: [...document.querySelectorAll('h1,h2,h3,h4')].filter(visible).map((e) => e.innerText.trim()).filter(Boolean).slice(0, 20),
      bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1500),
      widgets: [...document.querySelectorAll(WIDGETS)].filter(visible).map(describe),
      fields: [...document.querySelectorAll('input,textarea,select')].filter(visible).map((element, index) => ({
        index,
        selector: selectorFor(element),
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type'),
        name: element.getAttribute('name'),
        id: element.id || null,
        placeholder: element.getAttribute('placeholder'),
        label: element.labels?.[0]?.innerText?.trim() ?? null,
        ariaLabel: element.getAttribute('aria-label'),
        disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
        readOnly: Boolean(element.readOnly),
        valueLength: typeof element.value === 'string' ? element.value.length : null,
        valuePreview: typeof element.value === 'string' ? element.value.slice(0, 40) : null,
        party: partyContext(element)
      }))
    };
  });

  return { target: target.name, beganRequest, ...form };
}

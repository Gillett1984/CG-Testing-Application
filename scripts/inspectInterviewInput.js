// Read-only diagnostic: open the newest active case as an actor, enter Getting Started,
// and dump every candidate response input / send control so stale selectors can be fixed.
//
// Usage: node scripts/launch.js scripts/inspectInterviewInput.js [requestor|participant]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.COMMON_GROUND_URL;
const selectors = JSON.parse(fs.readFileSync(path.resolve(rootDir, process.env.SELECTORS_PATH ?? 'config/selectors.example.json'), 'utf8'));
const role = (process.argv[2] ?? 'requestor').toLowerCase();
const creds = role === 'participant'
  ? { email: process.env.PARTICIPANT_EMAIL, password: process.env.PARTICIPANT_PASSWORD }
  : { email: process.env.REQUESTOR_EMAIL, password: process.env.REQUESTOR_PASSWORD };

const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
try {
  const page = await (await browser.newContext()).newPage();
  await signIn(page);

  await page.goto(new URL('/dashboard', url).toString(), { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);

  // Open the newest case, then its Getting Started / interview entry.
  const caseLink = page.locator('a[href*="/cases/"]').first();
  await caseLink.click({ timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
  console.log('[inspect] case page:', page.url());

  const start = page.locator('a[href*="/get-started"]').first()
    .or(page.getByRole('link', { name: /Getting Started|Begin Discussion|Share Your Perspective|Continue/i }).first())
    .or(page.getByRole('button', { name: /Getting Started|Begin Discussion|Share Your Perspective|Continue/i }).first());
  if (await start.isVisible({ timeout: 8000 }).catch(() => false)) {
    await start.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }
  console.log('[inspect] interview page:', page.url());

  const dump = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const describe = (el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      name: el.getAttribute('name'),
      type: el.getAttribute('type'),
      role: el.getAttribute('role'),
      testid: el.getAttribute('data-testid'),
      placeholder: el.getAttribute('placeholder'),
      ariaLabel: el.getAttribute('aria-label'),
      contentEditable: el.getAttribute('contenteditable'),
      className: (el.getAttribute('class') || '').slice(0, 80) || null,
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50) || null,
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true'
    });
    return {
      url: location.href,
      inputs: [...document.querySelectorAll('textarea,input[type="text"],[contenteditable="true"],[role="textbox"]')].filter(visible).map(describe),
      buttons: [...document.querySelectorAll('button,[role="button"]')].filter(visible).map(describe),
      bodyTail: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(-900)
    };
  });
  console.log(JSON.stringify(dump, null, 2));
  await page.screenshot({ path: path.join(rootDir, `.tmp/interview-${role}.png`), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

async function signIn(page) {
  await page.goto(new URL('/login', url).toString(), { waitUntil: 'domcontentloaded' });
  const hasToken = () => page.evaluate(() => Boolean(sessionStorage.getItem('access_token'))).catch(() => false);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    for (const [selector, value] of [[selectors.auth.emailInput, creds.email], [selectors.auth.passwordInput, creds.password]]) {
      const field = page.locator(selector).first();
      for (let i = 0; i < 3; i += 1) {
        await field.fill(value).catch(() => {});
        if ((await field.inputValue().catch(() => '')) === value) break;
        await page.waitForTimeout(300);
      }
    }
    await page.locator(selectors.auth.submitButton).first().click({ timeout: 10000 }).catch(() => {});
    if (attempt >= 2) await page.locator(selectors.auth.passwordInput).first().press('Enter').catch(() => {});
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (await hasToken()) return;
      await page.waitForTimeout(300);
    }
  }
  throw new Error(`Could not log in as ${role}.`);
}

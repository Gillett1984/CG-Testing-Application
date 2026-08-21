// Read-only diagnostic: log in as an actor, open a case, and dump the workflow Status
// list plus whatever screen the "in progress" step lands on (URL, headings, visible text,
// interactive widgets). Used to add newly-introduced workflow steps to the state machine.
//
// Usage:
//   node scripts/launch.js scripts/inspectCaseWorkflow.js <caseUrlOrId> [requestor|participant]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.COMMON_GROUND_URL;
const selectorsPath = path.resolve(rootDir, process.env.SELECTORS_PATH ?? 'config/selectors.example.json');
const selectors = JSON.parse(fs.readFileSync(selectorsPath, 'utf8'));

const target = process.argv[2];
const role = (process.argv[3] ?? 'requestor').toLowerCase();
if (!target) throw new Error('Pass a case URL or case id as the first argument.');

const creds = role === 'participant'
  ? { email: process.env.PARTICIPANT_EMAIL, password: process.env.PARTICIPANT_PASSWORD }
  : { email: process.env.REQUESTOR_EMAIL, password: process.env.REQUESTOR_PASSWORD };
if (!url || !creds.email || !creds.password) throw new Error('COMMON_GROUND_URL and the role credentials must be set.');

const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
try {
  const page = await (await browser.newContext()).newPage();
  await signIn(page);

  const caseUrl = /^https?:\/\//i.test(target) ? target : new URL(`/cases/${target}`, url).toString();
  await page.goto(caseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);

  console.log(JSON.stringify({ role, caseUrl, ...(await snapshot(page)) }, null, 2));

  // Follow the step the case page says is active, so we can see the actual screen.
  const cta = page.getByRole('link', { name: /continue|resume|start|open|add helpful details|review|rate|share/i })
    .or(page.getByRole('button', { name: /continue|resume|start|open|add helpful details|review|rate|share/i }))
    .first();
  if (await cta.isVisible({ timeout: 4000 }).catch(() => false)) {
    const label = (await cta.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    await cta.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);
    console.log(JSON.stringify({ followedCta: label, ...(await snapshot(page)) }, null, 2));
  }

  const shot = path.join(rootDir, `.tmp/workflow-${role}.png`);
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  console.log(`screenshot: ${shot}`);
} finally {
  await browser.close();
}

async function snapshot(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const describe = (el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      type: el.getAttribute('type'),
      role: el.getAttribute('role'),
      testid: el.getAttribute('data-testid'),
      href: el.getAttribute('href'),
      placeholder: el.getAttribute('placeholder'),
      ariaLabel: el.getAttribute('aria-label'),
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 70) || null,
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true'
    });
    return {
      url: location.href,
      headings: [...document.querySelectorAll('h1,h2,h3,h4')].filter(visible).map((e) => e.innerText.trim()).filter(Boolean).slice(0, 25),
      bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 3000),
      widgets: [...document.querySelectorAll('input,textarea,select,button,a,[role="button"],[contenteditable="true"]')]
        .filter(visible).map(describe).filter((w) => w.text || w.placeholder || w.ariaLabel).slice(0, 60)
    };
  });
}

// The site root serves a marketing landing page, so go to /login directly. The form is a
// controlled React input that hydration can clear, so re-fill until the value sticks.
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
    let stored = false;
    while (Date.now() < deadline) {
      if (await hasToken()) { stored = true; break; }
      await page.waitForTimeout(300);
    }
    console.log(`[inspect] ${role} login attempt ${attempt}: token=${stored}`);
    if (stored) return;
    await page.waitForTimeout(1000);
  }
  throw new Error(`Could not log in as ${role}.`);
}

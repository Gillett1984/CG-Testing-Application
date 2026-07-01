// One-off diagnostic: log in as the participant, land on the dashboard, open the
// target case, and dump the real DOM structure (headings, buttons, links, and any
// element mentioning the case id) so we can fix the participant "Getting Started"
// navigation. Read-only against the live app apart from clicking into the case.
//
// Usage: node scripts/probeParticipantDashboard.js [CASE_ID]
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const caseId = process.argv[2] ?? 'CG-0341';
const url = process.env.COMMON_GROUND_URL;
const email = process.env.PARTICIPANT_EMAIL;
const password = process.env.PARTICIPANT_PASSWORD;
const outDir = path.resolve('.tmp/probe');
fs.mkdirSync(outDir, { recursive: true });

function log(...args) { console.log(...args); }

async function dump(page, label) {
  const data = await page.evaluate(() => {
    const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
    const headings = [...document.querySelectorAll('h1,h2,h3,h4')]
      .map((el) => ({ tag: el.tagName, text: clean(el.innerText) }))
      .filter((h) => h.text);
    const controls = [...document.querySelectorAll('button,a,[role="button"]')]
      .map((el) => ({
        tag: el.tagName,
        role: el.getAttribute('role') || '',
        text: clean(el.innerText || el.getAttribute('aria-label') || ''),
        href: el.getAttribute('href') || '',
        testid: el.getAttribute('data-testid') || '',
        disabled: el.disabled ?? el.getAttribute('aria-disabled') === 'true'
      }))
      .filter((c) => c.text || c.href || c.testid);
    return { url: location.href, title: document.title, headings, controls };
  });
  log(`\n===== ${label} =====`);
  log('URL:', data.url);
  log('Headings:');
  for (const h of data.headings) log(`  <${h.tag}> ${h.text}`);
  log('Buttons / links:');
  for (const c of data.controls) {
    log(`  <${c.tag}${c.role ? ` role=${c.role}` : ''}>${c.disabled ? ' [disabled]' : ''} "${c.text}"${c.href ? ` href=${c.href}` : ''}${c.testid ? ` testid=${c.testid}` : ''}`);
  }
  fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(data, null, 2));
  await page.screenshot({ path: path.join(outDir, `${label}.png`), fullPage: true }).catch(() => {});
  return data;
}

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
try {
  log(`Probing participant view for case ${caseId} at ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2500);
  await dump(page, '01-dashboard');

  // Try to open the case: click any element whose text contains the case id.
  const opened = await page.evaluate((id) => {
    const els = [...document.querySelectorAll('h1,h2,h3,h4,a,button,[role="button"]')];
    const hit = els.find((el) => (el.innerText || '').includes(id));
    if (hit) { hit.click(); return (hit.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80); }
    return null;
  }, caseId);
  log(`\nClicked element containing "${caseId}": ${opened ?? '(none found — dumping dashboard only)'}`);
  if (opened) {
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2500);
    await dump(page, '02-after-clicking-case');

    // If a "Case Details" control exists, click it and dump again.
    const wentToDetails = await page.evaluate(() => {
      const el = [...document.querySelectorAll('a,button,[role="button"]')]
        .find((e) => /case details/i.test(e.innerText || ''));
      if (el) { el.click(); return true; }
      return false;
    });
    if (wentToDetails) {
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(2500);
      await dump(page, '03-case-details');
    }
  }
  log(`\nArtifacts written to ${outDir}. Leaving browser open 20s for inspection.`);
  await page.waitForTimeout(20000);
} catch (error) {
  log('Probe error:', error.message);
  await dump(page, '99-error-state').catch(() => {});
} finally {
  await browser.close();
}

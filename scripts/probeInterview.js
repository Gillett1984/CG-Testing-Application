// Probe: click "Begin Discussion" on the target card and inspect the interview
// page — URL, whether the configured partnerAi selectors resolve, prompt text.
// Does NOT submit any response (read-only inspection of the interview view).
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const caseId = process.argv[2] ?? 'CG-0341';
const url = process.env.COMMON_GROUND_URL;
const outDir = path.resolve('.tmp/probe');
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.fill('#email', process.env.PARTICIPANT_EMAIL);
  await page.fill('#password', process.env.PARTICIPANT_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2500);

  // Click "Begin Discussion" within the target card (ascend from the heading).
  const clicked = await page.evaluate((id) => {
    const heading = [...document.querySelectorAll('h1,h2,h3,h4')].find((el) => (el.innerText || '').includes(id));
    if (!heading) return 'no-heading';
    let node = heading.parentElement;
    for (let d = 0; node && d < 8; d += 1) {
      const btn = [...node.querySelectorAll('button,a,[role="button"]')]
        .find((b) => /begin discussion/i.test(b.innerText || ''));
      if (btn) { btn.click(); return 'clicked'; }
      node = node.parentElement;
    }
    return 'no-button';
  }, caseId);
  console.log('Begin Discussion click:', clicked);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(4000);

  const view = await page.evaluate(() => {
    const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
    const textareas = [...document.querySelectorAll('textarea')].map((t) => ({
      placeholder: t.getAttribute('placeholder') || '', id: t.id || '', name: t.name || ''
    }));
    const buttons = [...document.querySelectorAll('button,a,[role="button"]')].map((b) => ({
      text: clean(b.innerText || ''), aria: b.getAttribute('aria-label') || '', href: b.getAttribute('href') || ''
    })).filter((b) => b.text || b.aria || b.href);
    return { url: location.href, textareas, buttons, bodyStart: clean(document.body.innerText).slice(0, 1200) };
  });
  console.log('\nURL:', view.url);
  console.log('\nTEXTAREAS:', JSON.stringify(view.textareas, null, 2));
  console.log('\nBUTTONS:', JSON.stringify([...new Map(view.buttons.map((b) => [b.text + b.aria + b.href, b])).values()], null, 2));
  console.log('\nBODY START:\n', view.bodyStart);

  // Check the exact configured selectors.
  const sel = JSON.parse(fs.readFileSync('config/selectors.example.json', 'utf8')).partnerAi;
  const inputVisible = await page.locator(sel.responseInput).first().isVisible({ timeout: 1000 }).catch(() => false);
  const sendVisible = await page.locator(sel.sendButton).first().isVisible({ timeout: 1000 }).catch(() => false);
  console.log(`\nConfigured responseInput (${sel.responseInput}) visible: ${inputVisible}`);
  console.log(`Configured sendButton (${sel.sendButton}) visible: ${sendVisible}`);

  fs.writeFileSync(path.join(outDir, 'interview.json'), JSON.stringify(view, null, 2));
  await page.screenshot({ path: path.join(outDir, 'interview.png'), fullPage: true }).catch(() => {});
  await page.waitForTimeout(6000);
} catch (error) {
  console.log('Probe error:', error.message);
} finally {
  await browser.close();
}

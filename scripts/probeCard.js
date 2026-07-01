// Focused probe: find the case-id heading, ascend ancestors WITHOUT breaking,
// and list every button/link in the card at each level so we see the real action
// label for that specific card (e.g. "Begin Discussion" vs "Review Invitation").
import 'dotenv/config';
import { chromium } from 'playwright';

const caseId = process.argv[2] ?? 'CG-0341';
const url = process.env.COMMON_GROUND_URL;

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.fill('#email', process.env.PARTICIPANT_EMAIL);
  await page.fill('#password', process.env.PARTICIPANT_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2500);

  const info = await page.evaluate((id) => {
    const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
    const heading = [...document.querySelectorAll('h1,h2,h3,h4')].find((el) => (el.innerText || '').includes(id));
    if (!heading) return { found: false };
    const levels = [];
    let node = heading.parentElement;
    for (let depth = 0; node && depth < 8; depth += 1) {
      const buttons = [...node.querySelectorAll('button,a,[role="button"]')]
        .map((el) => clean(el.innerText || el.getAttribute('aria-label')))
        .filter(Boolean);
      levels.push({ depth, tag: node.tagName, cls: (node.className || '').toString().slice(0, 70), nBtns: buttons.length, buttons });
      node = node.parentElement;
    }
    return { found: true, headingText: clean(heading.innerText), levels };
  }, caseId);
  console.log(JSON.stringify(info, null, 2));
  await page.waitForTimeout(4000);
} catch (error) {
  console.log('Probe error:', error.message);
} finally {
  await browser.close();
}

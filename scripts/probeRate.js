// Probe: as the REQUESTOR, open the case and check whether the rate-facts control
// matcher (new wording) finds the "Rate Employee's/Manager's Statements" control.
// Read-only: reports matches, does not click.
import 'dotenv/config';
import { chromium } from 'playwright';

const caseId = process.argv[2] ?? 'CG-0342';
const url = process.env.COMMON_GROUND_URL;

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.fill('#email', process.env.REQUESTOR_EMAIL);
  await page.fill('#password', process.env.REQUESTOR_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2500);

  // Open the case via its "Discussion Details" button within the card.
  await page.evaluate((id) => {
    const heading = [...document.querySelectorAll('h1,h2,h3,h4')].find((el) => (el.innerText || '').includes(id));
    if (!heading) return;
    let node = heading.parentElement;
    for (let d = 0; node && d < 8; d += 1) {
      const btn = [...node.querySelectorAll('button,a,[role="button"]')]
        .find((b) => /discussion details|case details/i.test(b.innerText || ''));
      if (btn) { btn.click(); return; }
      node = node.parentElement;
    }
  }, caseId);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3000);

  const result = await page.evaluate(() => {
    const norm = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const isDisabled = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true';
    const anyRe = /rate\b[\s\S]*\b(?:facts?|statements?)\b/i;
    const controls = [...document.querySelectorAll('a,button,[role="button"]')];
    const all = controls.map((el) => ({ text: (el.innerText || '').replace(/\s+/g, ' ').trim(), disabled: isDisabled(el) }))
      .filter((c) => c.text);
    const matches = controls.filter((el) => !isDisabled(el) && anyRe.test(norm(el.innerText)))
      .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim());
    return { url: location.href, matches, controls: [...new Map(all.map((c) => [c.text, c])).values()] };
  });
  console.log('URL:', result.url);
  console.log('\n>>> RATE-CONTROL MATCHES (new regex):', JSON.stringify(result.matches, null, 2));
  console.log('\nAll enabled/disabled controls:');
  for (const c of result.controls) console.log(`  ${c.disabled ? '[disabled] ' : ''}"${c.text}"`);
  await page.waitForTimeout(6000);
} catch (error) {
  console.log('Probe error:', error.message);
} finally {
  await browser.close();
}

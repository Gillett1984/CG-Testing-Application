import { chromium } from 'playwright';

const url = process.env.COMMON_GROUND_URL;
const email = process.env.LOGIN_EMAIL;
const password = process.env.LOGIN_PASSWORD;
const caseId = process.env.CASE_ID;

if (!url || !email || !password || !caseId) {
  throw new Error('Set COMMON_GROUND_URL, LOGIN_EMAIL, LOGIN_PASSWORD, and CASE_ID.');
}

const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
const page = await browser.newPage();

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.locator('#email').fill(email);
await page.locator('#password').fill(password);
await page.locator('button[type="submit"]').click();
await page.waitForLoadState('networkidle').catch(() => {});
await page.goto(new URL('/dashboard', url).toString(), { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(2000);

await page.evaluate((targetCaseId) => {
  const heading = [...document.querySelectorAll('h1,h2,h3')].find((element) => element.innerText.includes(targetCaseId));
  if (!heading) throw new Error(`Could not find heading for ${targetCaseId}`);

  let node = heading.parentElement;
  while (node) {
    const button = [...node.querySelectorAll('button')].find((element) => /Review Invitation/i.test(element.innerText));
    if (button) {
      button.click();
      return;
    }
    node = node.parentElement;
  }

  throw new Error(`Could not find Review Invitation button for ${targetCaseId}`);
}, caseId);
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(2000);

const snapshot = await page.evaluate(() => ({
  url: window.location.href,
  bodyText: document.body.innerText.slice(0, 5000),
  buttons: [...document.querySelectorAll('button,a')]
    .map((element) => ({
      text: element.innerText.trim(),
      ariaLabel: element.getAttribute('aria-label'),
      href: element.getAttribute('href')
    }))
    .filter((item) => item.text || item.ariaLabel || item.href)
}));

console.log(JSON.stringify(snapshot, null, 2));
await browser.close();

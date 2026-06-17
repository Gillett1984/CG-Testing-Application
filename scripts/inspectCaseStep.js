import { chromium } from 'playwright';

const url = process.env.COMMON_GROUND_URL;
const email = process.env.LOGIN_EMAIL;
const password = process.env.LOGIN_PASSWORD;
const caseId = process.env.CASE_ID;

if (!url || !email || !password || !caseId) {
  throw new Error('Set COMMON_GROUND_URL, LOGIN_EMAIL, LOGIN_PASSWORD, and CASE_ID.');
}

const browser = await chromium.launch({
  headless: process.env.HEADLESS !== 'false',
  slowMo: Number(process.env.SLOW_MO_MS ?? 0)
});
const page = await browser.newPage();

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.locator('#email').fill(email);
await page.locator('#password').fill(password);
await page.locator('button[type="submit"]').click();
await page.waitForLoadState('networkidle').catch(() => {});
await page.goto(new URL('/dashboard', url).toString(), { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});

await page.evaluate((targetCaseId) => {
  const heading = [...document.querySelectorAll('h1,h2,h3')].find((element) => element.innerText.includes(targetCaseId));
  if (!heading) throw new Error(`Could not find heading for ${targetCaseId}`);

  let node = heading.parentElement;
  while (node) {
    const button = [...node.querySelectorAll('button')].find((element) => /Getting Started/i.test(element.innerText));
    if (button) {
      button.click();
      return;
    }
    node = node.parentElement;
  }

  throw new Error(`Could not find Getting Started button for ${targetCaseId}`);
}, caseId);
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(Number(process.env.WAIT_MS ?? 10000));

const snapshot = await page.evaluate(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };

  const selectorFor = (element) => {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const testId = element.getAttribute('data-testid');
    if (testId) return `[data-testid="${testId}"]`;
    const name = element.getAttribute('name');
    if (name) return `${element.tagName.toLowerCase()}[name="${name}"]`;
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) return `${element.tagName.toLowerCase()}[placeholder="${placeholder}"]`;
    const type = element.getAttribute('type');
    if (type) return `${element.tagName.toLowerCase()}[type="${type}"]`;
    return element.tagName.toLowerCase();
  };

  return {
    url: window.location.href,
    bodyText: document.body.innerText.slice(0, 5000),
    inputs: [...document.querySelectorAll('input,textarea,select,[contenteditable="true"]')]
      .filter(visible)
      .map((element) => ({
        selector: selectorFor(element),
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type'),
        placeholder: element.getAttribute('placeholder'),
        ariaLabel: element.getAttribute('aria-label'),
        text: element.innerText?.trim()
      })),
    buttons: [...document.querySelectorAll('button,[role="button"],a')]
      .filter(visible)
      .map((element) => ({
        selector: selectorFor(element),
        text: element.innerText.trim(),
        ariaLabel: element.getAttribute('aria-label'),
        href: element.getAttribute('href')
      }))
      .filter((item) => item.text || item.ariaLabel || item.href)
  };
});

console.log(JSON.stringify(snapshot, null, 2));
await page.screenshot({ path: `results/${caseId}-getting-started.png`, fullPage: true }).catch(() => {});
await browser.close();

import { chromium } from 'playwright';

const url = process.env.COMMON_GROUND_URL;
const email = process.env.LOGIN_EMAIL;
const password = process.env.LOGIN_PASSWORD;

if (!url || !email || !password) {
  throw new Error('Set COMMON_GROUND_URL, LOGIN_EMAIL, and LOGIN_PASSWORD.');
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

const cards = await page.evaluate(() => {
  const headings = [...document.querySelectorAll('h1,h2,h3')].filter((heading) => /CG-\d+/.test(heading.innerText));
  return headings.map((heading) => {
    let node = heading;
    for (let depth = 0; depth < 6 && node?.parentElement; depth += 1) {
      node = node.parentElement;
      const buttons = [...node.querySelectorAll('button')].map((button) => button.innerText.trim()).filter(Boolean);
      if (buttons.some((text) => /Getting Started|Case Details|Alignment/i.test(text))) {
        return {
          heading: heading.innerText.trim(),
          ancestorTag: node.tagName.toLowerCase(),
          ancestorClass: node.getAttribute('class'),
          text: node.innerText.trim().slice(0, 1000),
          buttons
        };
      }
    }
    return {
      heading: heading.innerText.trim(),
      ancestorTag: null,
      ancestorClass: null,
      text: heading.innerText.trim(),
      buttons: []
    };
  });
});

console.log(JSON.stringify(cards, null, 2));
await browser.close();

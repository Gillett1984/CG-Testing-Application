import { chromium } from 'playwright';

const url = process.env.COMMON_GROUND_URL;
const email = process.env.LOGIN_EMAIL ?? process.env.REQUESTOR_EMAIL;
const password = process.env.LOGIN_PASSWORD ?? process.env.REQUESTOR_PASSWORD;
const inspectPath = process.env.INSPECT_PATH;
const headless = process.env.HEADLESS !== 'false';
const browserChannel = process.env.BROWSER_CHANNEL || undefined;
const inputMode = process.env.LOGIN_INPUT_MODE ?? 'fill';

if (!url) {
  throw new Error('Set COMMON_GROUND_URL before running this script.');
}

const browser = await chromium.launch({
  channel: browserChannel,
  headless,
  slowMo: Number(process.env.SLOW_MO_MS ?? 0),
  args: process.env.STEALTH === 'true' ? ['--disable-blink-features=AutomationControlled'] : []
});
const context = await browser.newContext();
if (process.env.STEALTH === 'true') {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
}
const page = await context.newPage();
const consoleMessages = [];
const pageErrors = [];
const failedRequests = [];
const notableResponses = [];
page.on('console', (message) => {
  if (['error', 'warning'].includes(message.type())) {
    consoleMessages.push(`${message.type()}: ${sanitizeDiagnosticText(message.text())}`.slice(0, 500));
  }
});
page.on('pageerror', (error) => pageErrors.push(error.message.slice(0, 500)));
page.on('requestfailed', (request) => {
  failedRequests.push({
    url: sanitizeDiagnosticText(request.url()),
    method: request.method(),
    failure: request.failure()?.errorText ?? ''
  });
});
page.on('response', (response) => {
  const status = response.status();
  if (status >= 400) {
    notableResponses.push({
      url: sanitizeDiagnosticText(response.url()),
      status,
      statusText: response.statusText()
    });
  }
});

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});

if (email && password) {
  if (inputMode === 'type') {
    await page.getByRole('textbox').first().click();
    await page.keyboard.type(email, { delay: 20 });
    await page.getByRole('textbox').nth(1).click();
    await page.keyboard.type(password, { delay: 20 });
  } else {
    await page.getByRole('textbox').first().fill(email);
    await page.getByRole('textbox').nth(1).fill(password);
  }
  await page.waitForTimeout(1000);
  if (process.env.FORCE_ENABLE_SUBMIT === 'true') {
    await page.locator('button[type="submit"]').first().evaluate((button) => {
      button.disabled = false;
      button.removeAttribute('disabled');
      button.removeAttribute('aria-disabled');
    });
  }
  if (process.env.LOGIN_SUBMIT_MODE === 'requestSubmit') {
    await page.locator('form').first().evaluate((form) => form.requestSubmit());
  } else if (process.env.LOGIN_SUBMIT_MODE === 'enter') {
    await page.getByRole('textbox').nth(1).press('Enter');
  } else {
    await page.locator('button[type="submit"]').first().click();
  }
  await page.waitForLoadState('networkidle').catch(() => {});
  await waitForMeaningfulPage(page, /dashboard|account|create new case|notifications/i, 15000);

  if (inspectPath) {
    await page.goto(new URL(inspectPath, url).toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await waitForMeaningfulPage(page, /create|case|request|dashboard|login|required|raise|performance/i, 15000);
  }
}

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
    const type = element.getAttribute('type');
    if (type) return `${element.tagName.toLowerCase()}[type="${type}"]`;
    return element.tagName.toLowerCase();
  };

  return {
    title: document.title,
    url: window.location.href,
    headings: [...document.querySelectorAll('h1,h2,h3')]
      .filter(visible)
      .map((element) => element.innerText.trim())
      .filter(Boolean)
      .slice(0, 30),
    inputs: [...document.querySelectorAll('input,textarea,select')]
      .filter(visible)
      .map((element) => ({
        selector: selectorFor(element),
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type'),
        name: element.getAttribute('name'),
        id: element.id,
        placeholder: element.getAttribute('placeholder'),
        label: element.labels?.[0]?.innerText?.trim() ?? null,
        ariaLabel: element.getAttribute('aria-label'),
        valueLength: typeof element.value === 'string' ? element.value.length : null,
        valid: typeof element.checkValidity === 'function' ? element.checkValidity() : null
      }))
      .slice(0, 80),
    buttons: [...document.querySelectorAll('button,[role="button"],a')]
      .filter(visible)
      .map((element) => ({
        selector: selectorFor(element),
        tag: element.tagName.toLowerCase(),
        text: element.innerText.trim(),
        ariaLabel: element.getAttribute('aria-label'),
        href: element.getAttribute('href'),
        disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true'
      }))
      .filter((item) => item.text || item.ariaLabel || item.href)
      .slice(0, 100),
    forms: [...document.querySelectorAll('form')]
      .map((element) => ({
        action: element.getAttribute('action'),
        method: element.getAttribute('method'),
        text: element.innerText.trim().slice(0, 300),
        inputCount: element.querySelectorAll('input').length,
        buttonCount: element.querySelectorAll('button').length
      })),
    environment: {
      hasEmail: Boolean(window.__probeHasEmail),
      hasPassword: Boolean(window.__probeHasPassword),
      webdriver: navigator.webdriver
    }
  };
});

console.log(JSON.stringify({
  ...snapshot,
  scriptEnvironment: {
    hasEmail: Boolean(email),
    hasPassword: Boolean(password)
  },
  consoleMessages: consoleMessages.slice(-20),
  pageErrors: pageErrors.slice(-20),
  failedRequests: failedRequests.slice(-20),
  notableResponses: notableResponses.slice(-20)
}, null, 2));
await page.screenshot({ path: 'results/inspect-page.png', fullPage: true }).catch(() => {});
await browser.close();

async function waitForMeaningfulPage(page, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    if (pattern.test(text)) return;
    await page.waitForTimeout(750);
  }
}

function sanitizeDiagnosticText(value) {
  return String(value ?? '')
    .replace(/([?&]token=)[^&\s'"]+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]')
    .replace(/(eyJ[A-Za-z0-9._-]+)/g, '[jwt-redacted]');
}

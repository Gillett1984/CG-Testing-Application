import 'dotenv/config';
import { chromium } from 'playwright';

const baseUrl = process.env.COMMON_GROUND_URL;
const headless = process.env.HEADLESS !== 'false';
const slowMo = Number(process.env.SLOW_MO_MS ?? 0);

const requestor = {
  role: 'requestor',
  email: process.env.REQUESTOR_EMAIL,
  password: process.env.REQUESTOR_PASSWORD
};
const participant = {
  role: 'participant',
  email: process.env.PARTICIPANT_EMAIL,
  password: process.env.PARTICIPANT_PASSWORD
};

if (!baseUrl || !requestor.email || !requestor.password || !participant.email || !participant.password) {
  throw new Error('Set COMMON_GROUND_URL, REQUESTOR_EMAIL, REQUESTOR_PASSWORD, PARTICIPANT_EMAIL, and PARTICIPANT_PASSWORD.');
}

const selectors = {
  emailInput: 'input[type="email"]',
  passwordInput: 'input[type="password"]',
  submitButton: 'button[type="submit"]'
};

const results = [];

await probeSharedBrowserContexts();
await probeSeparateBrowsers();
await probeSeparateBrowserIdentities();
await probeSeparateBrowserChannels();
await probeSequentialFreshBrowsers();

console.log(JSON.stringify({ results }, null, 2));

async function probeSharedBrowserContexts() {
  const browser = await chromium.launch({ headless, slowMo });
  try {
    const requestorContext = await browser.newContext();
    const participantContext = await browser.newContext();
    const requestorPage = await requestorContext.newPage();
    const participantPage = await participantContext.newPage();

    await login(requestorPage, requestor);
    const requestorBefore = await snapshot(requestorPage);
    await login(participantPage, participant);
    const participantAfterLogin = await snapshot(participantPage);
    await requestorPage.goto(new URL('/dashboard', baseUrl).toString(), { waitUntil: 'domcontentloaded' });
    await requestorPage.waitForLoadState('networkidle').catch(() => {});
    const requestorAfterParticipantLogin = await snapshot(requestorPage);

    results.push({
      mode: 'shared_browser_separate_contexts',
      requestorBefore,
      participantAfterLogin,
      requestorAfterParticipantLogin
    });

    await requestorContext.close();
    await participantContext.close();
  } finally {
    await browser.close();
  }
}

async function probeSeparateBrowsers() {
  const requestorBrowser = await chromium.launch({ headless, slowMo });
  const participantBrowser = await chromium.launch({ headless, slowMo });
  try {
    const requestorPage = await (await requestorBrowser.newContext()).newPage();
    const participantPage = await (await participantBrowser.newContext()).newPage();

    await login(requestorPage, requestor);
    const requestorBefore = await snapshot(requestorPage);
    await login(participantPage, participant);
    const participantAfterLogin = await snapshot(participantPage);
    await requestorPage.goto(new URL('/dashboard', baseUrl).toString(), { waitUntil: 'domcontentloaded' });
    await requestorPage.waitForLoadState('networkidle').catch(() => {});
    const requestorAfterParticipantLogin = await snapshot(requestorPage);

    results.push({
      mode: 'separate_browser_instances',
      requestorBefore,
      participantAfterLogin,
      requestorAfterParticipantLogin
    });
  } finally {
    await requestorBrowser.close();
    await participantBrowser.close();
  }
}

async function probeSeparateBrowserIdentities() {
  const requestorBrowser = await chromium.launch({ headless, slowMo });
  const participantBrowser = await chromium.launch({ headless, slowMo });
  try {
    const requestorContext = await requestorBrowser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 1000 }
    });
    const participantContext = await participantBrowser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/125.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 }
    });
    const requestorPage = await requestorContext.newPage();
    const participantPage = await participantContext.newPage();

    await login(requestorPage, requestor);
    const requestorBefore = await snapshot(requestorPage);
    await login(participantPage, participant);
    const participantAfterLogin = await snapshot(participantPage);
    await requestorPage.goto(new URL('/dashboard', baseUrl).toString(), { waitUntil: 'domcontentloaded' });
    await requestorPage.waitForLoadState('networkidle').catch(() => {});
    const requestorAfterParticipantLogin = await snapshot(requestorPage);

    results.push({
      mode: 'separate_browser_instances_distinct_identities',
      requestorBefore,
      participantAfterLogin,
      requestorAfterParticipantLogin
    });
  } finally {
    await requestorBrowser.close();
    await participantBrowser.close();
  }
}

async function probeSeparateBrowserChannels() {
  let requestorBrowser;
  let participantBrowser;
  try {
    requestorBrowser = await chromium.launch({ headless, slowMo });
    participantBrowser = await chromium.launch({ channel: 'msedge', headless, slowMo });
    const requestorPage = await (await requestorBrowser.newContext()).newPage();
    const participantPage = await (await participantBrowser.newContext()).newPage();

    await login(requestorPage, requestor);
    const requestorBefore = await snapshot(requestorPage);
    await login(participantPage, participant);
    const participantAfterLogin = await snapshot(participantPage);
    await requestorPage.goto(new URL('/dashboard', baseUrl).toString(), { waitUntil: 'domcontentloaded' });
    await requestorPage.waitForLoadState('networkidle').catch(() => {});
    const requestorAfterParticipantLogin = await snapshot(requestorPage);

    results.push({
      mode: 'separate_browser_channels_chromium_and_edge',
      requestorBefore,
      participantAfterLogin,
      requestorAfterParticipantLogin
    });
  } catch (error) {
    results.push({
      mode: 'separate_browser_channels_chromium_and_edge',
      error: error.message
    });
  } finally {
    await requestorBrowser?.close().catch(() => {});
    await participantBrowser?.close().catch(() => {});
  }
}

async function probeSequentialFreshBrowsers() {
  const requestorBefore = await loginAndSnapshotInFreshBrowser(requestor);
  const participantAfterLogin = await loginAndSnapshotInFreshBrowser(participant);
  const requestorAfterParticipantLogin = await loginAndSnapshotInFreshBrowser(requestor);

  results.push({
    mode: 'sequential_fresh_browser_per_role_step',
    requestorBefore,
    participantAfterLogin,
    requestorAfterParticipantLogin
  });
}

async function loginAndSnapshotInFreshBrowser(account) {
  const browser = await chromium.launch({ headless, slowMo });
  try {
    const page = await (await browser.newContext()).newPage();
    await login(page, account);
    return snapshot(page);
  } finally {
    await browser.close();
  }
}

async function login(page, account) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator(selectors.emailInput).first().fill(account.email);
  await page.locator(selectors.passwordInput).first().fill(account.password);
  await page.locator(selectors.submitButton).first().click();
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);
}

async function snapshot(page) {
  const bodyText = await waitForMeaningfulBodyText(page);
  return {
    url: page.url(),
    isLoginScreen: /password|sign in|log in/i.test(bodyText) && /email/i.test(bodyText),
    hasDashboard: /dashboard/i.test(bodyText),
    hasAccount: /account/i.test(bodyText),
    textStart: bodyText.replace(/\s+/g, ' ').trim().slice(0, 350)
  };
}

async function waitForMeaningfulBodyText(page) {
  const deadline = Date.now() + 15000;
  let bodyText = '';
  while (Date.now() < deadline) {
    bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    if (bodyText.replace(/\s+/g, '').length > 20) return bodyText;
    await page.waitForTimeout(750);
  }
  return bodyText;
}

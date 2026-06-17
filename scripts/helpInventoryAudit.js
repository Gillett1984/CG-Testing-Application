import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.COMMON_GROUND_URL ?? 'https://prod.commonground.fairnessfactor.com/';
const email = process.env.LOGIN_EMAIL ?? process.env.REQUESTOR_EMAIL;
const password = process.env.LOGIN_PASSWORD ?? process.env.REQUESTOR_PASSWORD;
const headless = process.env.HEADLESS !== 'false';

const pagesToAudit = [
  ['dashboard', '/dashboard', 'Dashboard'],
  ['account', '/account', 'Account Menu'],
  ['profile', '/profile', 'Profile Menu'],
  ['security', '/security', 'Security Menu'],
  ['contact', '/contact', 'Contact Us'],
  ['case-details-cg-0199', '/cases/10649a1b-876c-4624-90ac-c4764c222e6a', 'CG-0199 Case Details'],
  ['alignment-report-cg-0199', '/alignment-report?case_id=10649a1b-876c-4624-90ac-c4764c222e6a', 'CG-0199 Alignment Report']
];

if (!email || !password) {
  throw new Error('Set LOGIN_EMAIL and LOGIN_PASSWORD, or REQUESTOR_EMAIL and REQUESTOR_PASSWORD.');
}

const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const resultDir = path.join('results', `${stamp}-help-inventory`);
await fs.mkdir(resultDir, { recursive: true });

const browser = await chromium.launch({ headless });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

async function settle() {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function login() {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await settle();

  const emailBox = page.locator('#email, input[type="email"], input[name*="email" i]').first();
  const passwordBox = page.locator('#password, input[type="password"], input[name*="password" i]').first();
  await emailBox.fill(email);
  await passwordBox.fill(password);
  await page.locator('button[type="submit"], button').filter({ hasText: /log|sign|continue|submit/i }).first().click();
  await settle();
}

function normalizeText(value) {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function makePriority(item) {
  const text = `${item.label} ${item.text} ${item.placeholder} ${item.headingContext}`.toLowerCase();
  if (/submit|continue|send|start|alignment|case details|security|password|delete|invite|complete|report/.test(text)) {
    return 'High';
  }
  if (/filter|search|status|profile|account|contact|download|view|edit/.test(text)) {
    return 'Medium';
  }
  return 'Low';
}

function helpTypeFor(item, pageName) {
  if (/Dashboard|Case Details|Alignment Report/.test(pageName)) return 'Tooltip or hotspot';
  if (/Getting Started/.test(pageName)) return item.kind === 'field' ? 'Inline coaching or tooltip' : 'Tooltip';
  if (/Fact Label/.test(pageName)) return 'Tooltip';
  if (/Emotion Moderation/.test(pageName)) return 'Hotspot';
  return item.kind === 'field' ? 'Tooltip' : 'Tooltip';
}

function draftHelpFor(item) {
  const label = item.label || item.text || item.placeholder || item.ariaLabel || item.role || item.tag;
  if (/password/i.test(label)) return 'Use this field to manage sign-in security for your Common Ground account.';
  if (/email/i.test(label)) return 'This email is used for account access and Common Ground notifications.';
  if (/contact|message/i.test(label)) return 'Use this to reach the Common Ground team with a question or support request.';
  if (/alignment report/i.test(label)) return 'Open the report to review areas of agreement, difference, and possible next steps.';
  if (/case details/i.test(label)) return 'Open the case overview, status, and available actions for this discussion.';
  if (/submit|send/i.test(label)) return 'Submit this information when you are ready. Review your entries before continuing.';
  if (/edit|update|save/i.test(label)) return 'Use this to update the information shown in this section.';
  return `Explain what "${label}" does and when the user should use it.`;
}

async function auditCurrentPage(name) {
  return await page.evaluate((pageName) => {
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const text = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    const selectorFor = (element) => {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const testId = element.getAttribute('data-testid');
      if (testId) return `[data-testid="${testId}"]`;
      const name = element.getAttribute('name');
      if (name) return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
      const aria = element.getAttribute('aria-label');
      if (aria) return `${element.tagName.toLowerCase()}[aria-label="${aria.replaceAll('"', '\\"')}"]`;
      return element.tagName.toLowerCase();
    };

    const headingContext = (element) => {
      let node = element;
      for (let depth = 0; depth < 5 && node; depth += 1) {
        const heading = node.querySelector?.('h1,h2,h3,h4');
        if (heading && isVisible(heading)) return text(heading.innerText);
        node = node.parentElement;
      }
      return '';
    };

    const controls = [
      ...document.querySelectorAll('button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"]')
    ]
      .filter(isVisible)
      .map((element) => ({
        kind: element.matches('a[href], [role="link"]') ? 'link' : 'button',
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') ?? '',
        selector: selectorFor(element),
        label: text(element.getAttribute('aria-label')),
        text: text(element.innerText),
        href: element.getAttribute('href') ?? '',
        headingContext: headingContext(element)
      }))
      .filter((item) => item.label || item.text || item.href);

    const fields = [...document.querySelectorAll('input, textarea, select')]
      .filter(isVisible)
      .map((element) => ({
        kind: 'field',
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type') ?? '',
        name: element.getAttribute('name') ?? '',
        id: element.id ?? '',
        selector: selectorFor(element),
        label: text(element.labels?.[0]?.innerText),
        placeholder: text(element.getAttribute('placeholder')),
        ariaLabel: text(element.getAttribute('aria-label')),
        headingContext: headingContext(element)
      }));

    const statusLike = [...document.querySelectorAll('[class*="badge" i], [class*="status" i], [role="status"], [aria-live]')]
      .filter(isVisible)
      .map((element) => ({
        kind: 'status',
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') ?? '',
        selector: selectorFor(element),
        text: text(element.innerText),
        headingContext: headingContext(element)
      }))
      .filter((item) => item.text);

    return {
      pageName,
      title: document.title,
      url: window.location.href,
      headings: [...document.querySelectorAll('h1,h2,h3,h4')]
        .filter(isVisible)
        .map((element) => text(element.innerText))
        .filter(Boolean),
      items: [...controls, ...fields, ...statusLike]
    };
  }, name);
}

function toMarkdown(audits) {
  const lines = ['# Common Ground Help Inventory Pilot', ''];
  lines.push(`Generated: ${new Date().toISOString()}`, '');
  lines.push('Scope: Requestor account, read-only pilot audit.', '');

  for (const audit of audits) {
    lines.push(`## ${audit.pageName}`, '');
    lines.push(`URL: ${audit.url}`, '');
    if (audit.headings.length) {
      lines.push(`Headings observed: ${audit.headings.join(' | ')}`, '');
    }
    lines.push('| Element | Type | Section | Recommended help | Priority | Draft help direction |');
    lines.push('|---|---|---|---|---|---|');
    for (const item of audit.items) {
      const elementName = normalizeText(item.label || item.text || item.placeholder || item.ariaLabel || item.href || item.selector);
      lines.push(`| ${elementName.replaceAll('|', '\\|')} | ${item.kind} | ${normalizeText(item.headingContext).replaceAll('|', '\\|')} | ${helpTypeFor(item, audit.pageName)} | ${makePriority(item)} | ${draftHelpFor(item).replaceAll('|', '\\|')} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

const audits = [];
try {
  await login();

  for (const [slug, pagePath, name] of pagesToAudit) {
    await page.goto(new URL(pagePath, baseUrl).toString(), { waitUntil: 'domcontentloaded' });
    await settle();
    const audit = await auditCurrentPage(name);
    audit.items = audit.items
      .map((item) => ({
        ...item,
        recommendedHelpType: helpTypeFor(item, name),
        priority: makePriority(item),
        draftHelpDirection: draftHelpFor(item)
      }))
      .sort((a, b) => ['High', 'Medium', 'Low'].indexOf(a.priority) - ['High', 'Medium', 'Low'].indexOf(b.priority));

    audits.push(audit);
    await page.screenshot({ path: path.join(resultDir, `${slug}.png`), fullPage: true }).catch(() => {});
  }

  await fs.writeFile(path.join(resultDir, 'help-inventory-pilot.json'), JSON.stringify(audits, null, 2));
  await fs.writeFile(path.join(resultDir, 'help-inventory-pilot.md'), toMarkdown(audits));
  console.log(JSON.stringify({ resultDir, pageCount: audits.length }, null, 2));
} finally {
  await browser.close();
}

import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { workflowTestSupport } from '../src/commonGroundAutomation.js';

const browser = await chromium.launch({ headless: true });

try {
  await validatePage('labeled-counter', 11);
  await validatePage('stale-remaining-counter', 12);
  console.log('Fact labeling browser validation passed for both page counter styles.');
} finally {
  await browser.close();
}

async function validatePage(counterStyle, total) {
  const page = await browser.newPage();
  const fixtureUrl = counterStyle === 'labeled-counter'
    ? 'https://fixture.test/cases/test/fact-review'
    : 'https://fixture.test/sessions/test/cross-rate?mode=participant_rates_requestor&case_id=test';
  await page.route('**/*', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: buildFixture(counterStyle, total)
  }));
  await page.goto(fixtureUrl);
  await workflowTestSupport.labelFactStatements(page, {
    run: { postCompletionWaitMs: 30000 }
  }, 'Confident Fact');

  assert.equal(new URL(page.url()).hash, '#submitted');
  const clickCounts = await page.evaluate(() => window.__factLabelClickCounts);
  assert.deepEqual(clickCounts, Array(total).fill(1), `${counterStyle} should click every label exactly once`);
  await page.close();
}

function buildFixture(counterStyle, total) {
  const statements = Array.from({ length: total }, (_, index) => `
    <section>
      <h2>Statement ${index + 1}</h2>
      <button type="button" data-label-clicks="0">Confident Fact</button>
      <button type="button">Likely Fact</button>
      <button type="button">Opinion</button>
      <button type="button">Uncertain</button>
    </section>
  `).join('');
  const counter = counterStyle === 'labeled-counter'
    ? `<p id="counter">0/${total} labeled</p>`
    : `<p id="counter">${total} of ${total} facts still need to be rated.</p>`;
  const submitText = counterStyle === 'labeled-counter' ? 'Submit' : 'Submit Ratings';

  return `<!doctype html><html><body>
    <h1>${counterStyle === 'labeled-counter' ? 'Rate your Confidence Statement Below' : "Rate Requestor's Fact Statements"}</h1>
    ${counter}${statements}
    <button id="submit" disabled>${submitText}</button>
    <script>
      const total = ${total};
      const style = ${JSON.stringify(counterStyle)};
      const labels = [...document.querySelectorAll('[data-label-clicks]')];
      window.__factLabelClickCounts = Array(total).fill(0);
      const submit = document.querySelector('#submit');
      labels.forEach((button, index) => button.addEventListener('click', () => {
        button.dataset.labelClicks = String(Number(button.dataset.labelClicks) + 1);
        window.__factLabelClickCounts[index] += 1;
        button.classList.toggle('selected');
        button.setAttribute('aria-pressed', button.classList.contains('selected') ? 'true' : 'false');
        const selected = labels.filter((item) => item.classList.contains('selected')).length;
        if (style === 'labeled-counter') document.querySelector('#counter').textContent = selected + '/' + total + ' labeled';
        submit.disabled = selected !== total;
      }));
      submit.addEventListener('click', () => {
        if (style === 'stale-remaining-counter') {
          submit.textContent = 'Submitting...';
          submit.disabled = true;
          setTimeout(() => {
            location.hash = 'submitted';
            document.body.innerHTML = '<h1>Fact ratings submitted</h1>';
          }, 1500);
        } else {
          location.hash = 'submitted';
          document.body.innerHTML = '<h1>Fact ratings submitted</h1>';
        }
      });
    </script>
  </body></html>`;
}

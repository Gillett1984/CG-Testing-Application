// Replay every Partner AI page this harness has ever recorded through the live
// prompt parser, and exercise the never-fail response resolver offline.
//
// Why this exists: the two most expensive defects of 2026-08-18/20 were a
// prompt-parser regression (answer guidance silently extracted as empty, so
// every answer under-covered) and response generation aborting a 60-minute run
// over an advisory judge opinion. Both were only ever caught by a full live
// run. Both are checked here in seconds, against real recorded pages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPromptContext } from '../src/promptContext.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = path.join(rootDir, 'results');

function recordedPartnerTurns() {
  if (!fs.existsSync(resultsDir)) return [];
  const turns = [];
  for (const dir of fs.readdirSync(resultsDir)) {
    const file = path.join(resultsDir, dir, 'run.json');
    if (!fs.existsSync(file)) continue;
    let run;
    try { run = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    for (const side of ['requestorGettingStarted', 'participantGettingStarted']) {
      for (const entry of run.transcripts?.[side] ?? []) {
        if (entry.role === 'partnerAi' && entry.text) turns.push({ dir, side, entry });
      }
    }
  }
  return turns;
}

const turns = recordedPartnerTurns();
if (!turns.length) {
  console.log('No recorded Partner AI turns found under results/; nothing to replay.');
  process.exit(0);
}

// 1. PARSER INVARIANTS over every page the tool has actually seen.
let guidancePages = 0;
let guidanceParsed = 0;
let questionPages = 0;
let questionParsed = 0;
const regressions = [];

for (const { dir, side, entry } of turns) {
  const parsed = extractPromptContext(entry.text);
  const raw = String(entry.text);

  // A page that renders an "Answer Guidance:" block must yield guidance points.
  if (/Answer Guidance:/i.test(raw)) {
    guidancePages += 1;
    if (parsed.answerGuidance.length) guidanceParsed += 1;
    else regressions.push(`${dir}/${side} turn ${entry.turn}: page shows "Answer Guidance:" but none was parsed`);
  }
  // A page that renders a primary question must yield one.
  if (/Current Primary Question:/i.test(raw)) {
    questionPages += 1;
    if (parsed.primaryQuestion) questionParsed += 1;
    else regressions.push(`${dir}/${side} turn ${entry.turn}: page shows a primary question but none was parsed`);
  }
  // Whatever we answer must never be empty when the page carries a question.
  if (/Current Primary Question:/i.test(raw)) {
    assert.ok(parsed.activeQuestion, `${dir}/${side} turn ${entry.turn}: no active question resolved`);
  }
}

console.log(`Replayed ${turns.length} recorded Partner AI page(s).`);
console.log(`  Answer-guidance blocks: ${guidanceParsed}/${guidancePages} parsed`);
console.log(`  Primary questions:      ${questionParsed}/${questionPages} parsed`);

if (regressions.length) {
  console.error(`\n${regressions.length} parser regression(s):`);
  for (const line of regressions.slice(0, 10)) console.error('  - ' + line);
  process.exit(1);
}

// Guidance parsing is the coverage contract: an empty list means the responder
// answers without knowing what Partner AI scores. Demand near-total success.
if (guidancePages) {
  const rate = guidanceParsed / guidancePages;
  assert.ok(rate >= 0.98, `Answer-guidance parse rate ${(rate * 100).toFixed(1)}% is below 98%.`);
}

console.log('\nReplay validation passed.');

// 2. THE RESPONSE RESOLVER must never throw, and must prefer a candidate that
// cleared every deterministic check. Exercised on the no-repair path so it
// needs no model call: a non-primary turn demands no opening sentence.
const { resolveWithoutFailing } = await import('../src/llmResponder.js');
const nonPrimaryTurn = { turnClassification: { isPrimaryQuestionTurn: false }, actorPerspective: 'manager_evaluating_employee' };
const judged = (text) => ({ text, check: { pass: false, source: 'judge_llm', reason: 'advisory objection' } });
const deterministic = (text) => ({ text, check: { pass: false, reason: 'The response does not begin with the required plain-language scenario conclusion.' } });

const both = await resolveWithoutFailing(null, nonPrimaryTurn,
  [deterministic('Draft that failed a tool check.'), judged('Retry that cleared every deterministic check.')],
  { activeQuestion: 'q' });
assert.equal(both.text, 'Retry that cleared every deterministic check.', 'The deterministically clean candidate must be preferred.');
assert.ok(both.warnings.some((w) => w.type === 'response_quality_unverified'), 'An unresolved advisory objection must be recorded.');

const truncatedOnly = await resolveWithoutFailing(null, nonPrimaryTurn,
  [judged('A complete earlier sentence.'), judged('A newer answer that stops mid')],
  { activeQuestion: 'q' });
assert.equal(truncatedOnly.text, 'A complete earlier sentence.', 'A truncated newest candidate must not be preferred over a complete one.');

const noneClean = await resolveWithoutFailing(null, nonPrimaryTurn,
  [deterministic('Only candidate, still complete.')], { activeQuestion: 'q' });
assert.equal(noneClean.text, 'Only candidate, still complete.', 'The resolver must still return text when nothing cleared every check.');
assert.ok(noneClean.warnings.some((w) => w.type === 'response_submitted_with_unresolved_check'), 'That case must be recorded distinctly.');

console.log('Response resolver: never throws, prefers deterministically clean, records the concern.');

// 3. THE DOWNGRADE POLICY decides when an advisory objection may be overridden.
// Authority comes from the verdict's SOURCE, never from keywords in its prose:
// an earlier version matched words like "incomplete" and misfired whenever the
// judge quoted the answer's own subject matter back (CG-0083).
const { relevanceOnlyValidationOutcome } = await import('../src/llmResponder.js');
const judgeVerdict = (reason) => ({ pass: false, reason, source: 'judge_llm' });
const toolVerdict = (reason) => ({ pass: false, reason });
const unparsable = { pass: false, reason: 'Validation returned non-JSON: ...', source: 'judge_llm', parseFailure: true };
const whole = 'A complete sentence about the rework rate.';
const cut = 'A sentence that stops mid';

const downgradeCases = [
  ['judge quotes the answer\'s own wording back',
    judgeVerdict('fails to describe how each issue (e.g. incomplete workflow details) affected quality'),
    judgeVerdict('the explanation is general'), whole, true],
  ['draft failed a tool check, retry fixed it',
    toolVerdict('The response does not begin with the required plain-language scenario conclusion.'),
    judgeVerdict('does not fully address the responsibilities'), whole, true],
  ['the retry itself violates the scenario contract',
    judgeVerdict('off target'), toolVerdict('The response contradicts the assigned rating.'), whole, false],
  ['the retry is truncated', judgeVerdict('off target'), judgeVerdict('still off target'), cut, false],
  ['the retry verdict never parsed', judgeVerdict('off target'), unparsable, whole, false],
  ['only the draft verdict never parsed', unparsable, judgeVerdict('off target'), whole, true]
];

for (const [name, first, revised, text, shouldDowngrade] of downgradeCases) {
  const outcome = relevanceOnlyValidationOutcome(first, revised, text, { activeQuestion: 'q' });
  assert.equal(Boolean(outcome), shouldDowngrade, `Downgrade policy wrong for: ${name}`);
}
console.log(`Downgrade policy: ${downgradeCases.length} cases behave correctly.`);

// 4. COVERAGE IS AIMED AT THE SCORED CRITERIA, AND SHAPED BY THE STANCE.
// answerGuidance is UI copy: project_review Q1 shows 7 bullets against 8 scored
// criteria, 4 of them mandatory. An answer aimed at the bullets can miss a
// gate-critical requirement, which caps the turn at 75 and earns another probe.
// The stance then decides what to do with them — an aligned run should complete
// a question in one turn, while a misaligned run SHOULD draw follow-ups, since
// that probing is the product behaviour under test.
const { coverageInstruction } = await import('../src/llmResponder.js');
const projectReview = JSON.parse(fs.readFileSync(path.join(rootDir, 'config/case-types/project-review.json'), 'utf8'));
const firstQuestion = projectReview.primaryQuestions[0];
const mandatoryCount = firstQuestion.highQualityCriteria.filter((c) => c.required === true).length;
const withStance = (ratingId) => ({
  activeQualityCriteria: firstQuestion,
  scenarioTurn: { scenarioContext: { terms: [{ interpretation: { ratingId } }] } }
});

const aligned = coverageInstruction(withStance('outstanding'));
const misaligned = coverageInstruction(withStance('unsatisfactory'));

for (const [name, text] of [['aligned', aligned], ['misaligned', misaligned]]) {
  assert.ok((text.match(/\(\d\)/g) ?? []).length >= mandatoryCount,
    `${name}: every mandatory requirement must be named in the instruction.`);
  assert.ok(text.includes(firstQuestion.highQualityCriteria[0].requirement),
    `${name}: the instruction must quote the real criterion text, not the UI guidance.`);
}
assert.ok(/single answer|one turn/i.test(aligned), 'An aligned stance must aim to complete the question in one turn.');
assert.ok(!/expected for Partner AI to ask a follow-up/i.test(aligned), 'An aligned stance must not invite follow-ups.');
assert.ok(/do NOT manufacture favourable/i.test(misaligned), 'A negative stance must not invent favourable evidence to satisfy a criterion.');
assert.ok(/purely identifying/i.test(misaligned), 'A negative stance must still state undisputed identifying facts so the interview can progress.');
assert.ok(/expected for Partner AI to ask a follow-up/i.test(misaligned), 'A negative stance must treat follow-ups as expected behaviour under test.');
console.log(`Coverage targeting: aimed at ${mandatoryCount} scored mandatory criteria; aligned completes in one turn, misaligned expects follow-ups.`);

// ---------------------------------------------------------------------------
// Pending-step navigation.
//
// The case page names its next step in a "Next:" pointer, but the status row
// for that step does not name its own control: the row reads "Add Missing
// Perspective" while the only clickable thing inside it is called "View".
// Matching a control by the step's name therefore finds nothing to click, and
// CG-0183 sat on that page for ten minutes reporting the step unreachable.
//
// Replayed here against the exact page text that stalled it, so a future
// relabelling shows up in three seconds instead of a ten-minute timeout.
const { WORKFLOW_STEP_LABELS, WORKFLOW_STEP_PATHS } = await import('../src/workflowLabels.js');

const stalledPage = "Discussion Details CG-0183 Performance Review: Focused Improvement Active "
  + "Manager: Esha Employee: Rabia Next:Add Missing Perspective Details Reports Notifications 7 "
  + "Status Review Rabia's Invitation Rabia shares their perspective Add Missing Perspective View "
  + "Review & Approve Excerpts View Rate Foundational Statements View";

// Same expression the engine uses to read the pointer.
const readPointer = (text) => {
  const m = String(text).replace(/\s+/g, ' ').match(/Next:\s*([^.]{3,60}?)(?:\s{2,}|Details|Reports|Status|$)/i);
  return m ? m[1].trim() : '';
};

const pointer = readPointer(stalledPage);
assert.equal(pointer, 'Add Missing Perspective', `pointer misread as "${pointer}"`);

const stepKeys = ['clarify_context', 'missing_perspective', 'excerpt_review', 'fact_rating'];
const steps = stepKeys.map((key) => ({
  key,
  name: WORKFLOW_STEP_LABELS[key].link,
  route: WORKFLOW_STEP_LABELS[key].route,
  path: WORKFLOW_STEP_PATHS[key]
}));

const ordered = [...steps].sort((a, b) => Number(b.name.test(pointer)) - Number(a.name.test(pointer)));
assert.equal(ordered[0].key, 'missing_perspective', 'the pointed-at step must be tried first');

// Every step the engine may open must have a route it can verify landing on,
// and a path it can navigate to when no control matches.
for (const step of steps) {
  assert.ok(step.route, `${step.key} has no route to verify arrival`);
  assert.ok(step.path, `${step.key} has no path to fall back to`);
  const target = `https://example.test/cases/abc123/${step.path}`;
  assert.ok(step.route.test(target), `${step.key} route does not accept its own path (${target})`);
}

// The case page itself must not look like a step route, or the opener
// short-circuits and never navigates anywhere.
const casePage = 'https://example.test/cases/abc123';
assert.ok(!steps.some((s) => s.route.test(casePage)), 'case page must not match any step route');

console.log(`Pending-step navigation: pointer read, ${steps.length} steps each verifiable by route and reachable by path.`);

// A "Next:" pointer naming the counterpart's step is a normal waiting state, not
// a navigation failure. Telling the two apart is subtle enough to pin down: the
// `other` patterns are unanchored, so "adds? missing perspective" also matches
// our own "Add Missing Perspective", and none of them cover "Esha rates YOUR
// supporting statements". An unrecognised label must stay on the "ours" side so
// a rename still surfaces as a warning rather than being silently swallowed.
const ownStep = (p) => Object.values(WORKFLOW_STEP_LABELS)
  .some((s) => s.own && s.own.test(String(p ?? '').trim()));
const otherParty = (p) => {
  const v = String(p ?? '').trim();
  if (!v || ownStep(v)) return false;
  if (Object.values(WORKFLOW_STEP_LABELS).some((s) => s.other && s.other.test(v))) return true;
  return /^\S+\s+(?:adds?|shares?|rates?|reviews?|confirms?|completes?)\b/i.test(v);
};

for (const [label, expected] of [
  ['Esha rates your supporting statements', true],
  ['Rabia adds missing perspective', true],
  ['Rabia shares their perspective', true],
  ['Esha reviews their excerpts', true],
  ['Add Clarity', false],
  ['Add Missing Perspective', false],
  ['Review & Approve Excerpts', false],
  ['Rate Foundational Statements', false],
  ['Share Your Perspective', false],
  ['Contribute Missing Context', false]
]) {
  assert.equal(otherParty(label), expected, `"${label}" classified wrongly`);
}

console.log('Pointer ownership: own steps, counterpart rows and unknown labels each classified correctly.');

// Generation placeholders must never be mistaken for a broken step. The clarify
// step renders its chrome before its questions exist and says so - with no
// "Loading" anywhere in the text, which is what the render wait keyed on. That
// cost CG-0186 a failed stage on a step that had simply not finished generating.
const generating = (t) => /preparing a few questions|preparing your questions|this runs right after your conversation/i
  .test(String(t ?? ''));

const clarifyStillPreparing = 'Clarify & Improve CG-0186 Performance Review: Focused Improvement '
  + 'Clarify & Improve Add Missing Perspective Excerpt Review Statements '
  + 'Preparing a few questions… This runs right after your conversation. It only takes a moment.';

assert.ok(generating(clarifyStillPreparing), 'the clarify generation placeholder must be recognised');
assert.ok(!generating('Clarify & Improve Helpful Detail 1 Skip Save Detail Submit & Continue 0/3 reviewed'),
  'a rendered clarify step must not look like a placeholder');
assert.ok(!generating('Review & Approve Excerpts 12/12 approved Submit'),
  'the excerpt step must not look like a clarify placeholder');

console.log('Generation placeholders: the clarify step is waited out, a rendered step is not.');

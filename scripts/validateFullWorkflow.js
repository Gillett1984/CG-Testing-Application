import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPromptContext } from '../src/promptContext.js';
import { factStatementLabelForStage, workflowTestSupport } from '../src/commonGroundAutomation.js';
import { CANONICAL_WORKFLOW, assertWorkflowLedgerComplete, createWorkflowLedger, updateWorkflowLedger } from '../src/canonicalWorkflow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const automationSource = fs.readFileSync(path.join(rootDir, 'src/commonGroundAutomation.js'), 'utf8');
const topic = JSON.parse(fs.readFileSync(path.join(rootDir, 'config/case-types/performance-review-coaching.json'), 'utf8'));
const scenarios = JSON.parse(fs.readFileSync(path.join(rootDir, 'config/scenarios/alignment-scenarios.json'), 'utf8')).scenarios;
const extremelyMisaligned = scenarios.find((item) => item.id === 'extremely_misaligned');
const fullyAligned = scenarios.find((item) => item.expectedAlignmentRange?.min >= 90);

assert.match(automationSource, /async function openCaseNextUpFromDashboard\(/);
assert.match(automationSource, /via dashboard Next Up:/);
assert.match(automationSource, /if \(nextUp\.status === 'opened'\) return;/);
assert.match(automationSource, /Dashboard controls must always be resolved inside the exact CG card/);
assert.match(automationSource, /Left \$\{createdCase\?\.commonGroundId/);
assert.match(automationSource, /All statements have been successfully rated[\s\S]*return true/);

assert.deepEqual(
  CANONICAL_WORKFLOW.map((step) => `${step.actor}:${step.label}`),
  [
    'manager:Create Discussion',
    'employee:Review Invitation',
    'employee:Share Your Perspective',
    'employee:Clarify & Improve',
    'employee:Excerpt Review',
    'employee:Statements',
    'manager:Rate (Employee Name) Supporting Statements',
    'manager:Share Your Perspective',
    'manager:Clarify & Improve',
    'manager:Add Missing Perspective',
    'manager:Excerpt Review',
    'manager:Statements',
    'employee:Add Missing Perspective',
    'employee:Rate (Manager Name) Supporting Statements',
    'system:Your Alignment Brief',
    'runner:Mark Test Complete'
  ],
  'The executable canonical workflow must match the approved Common Ground order.'
);
const completedLedger = createWorkflowLedger();
for (const step of completedLedger.filter((item) => item.id !== 'runner_complete')) {
  updateWorkflowLedger(completedLedger, step.id, 'completed', 'validation');
}
assert.doesNotThrow(() => assertWorkflowLedgerComplete(completedLedger));
const incompleteLedger = createWorkflowLedger();
for (const step of incompleteLedger.filter((item) => !['employee_missing_perspective', 'runner_complete'].includes(item.id))) {
  updateWorkflowLedger(incompleteLedger, step.id, 'completed', 'validation');
}
assert.throws(
  () => assertWorkflowLedgerComplete(incompleteLedger),
  /employee_missing_perspective=pending/,
  'The runner must not pass before the employee completes Add Missing Perspective.'
);

assert.equal(factStatementLabelForStage({ topic, scenario: extremelyMisaligned, kind: 'own' }), 'Confident Fact');
assert.equal(factStatementLabelForStage({ topic, scenario: extremelyMisaligned, kind: 'cross' }), 'Opinion');
assert.equal(factStatementLabelForStage({ topic, scenario: fullyAligned, kind: 'cross' }), 'Confident Fact');

assert.equal(workflowTestSupport.extractAlignmentScore('Alignment Report Overall Alignment Score: 57%'), 57);
assert.equal(workflowTestSupport.extractAlignmentScore('Your alignment is 93 / 100'), 93);
assert.equal(workflowTestSupport.onAlignmentReportPage(
  '/cases/123',
  'Discussion Details Current Alignment: 67% Next Up: Add Missing Perspective'
), false);
assert.equal(workflowTestSupport.onAlignmentReportPage(
  '/alignment-brief?case_id=123',
  'Your Alignment Brief Alignment Score 67 / 100'
), true);
assert.equal(workflowTestSupport.onAlignmentReportPage(
  '/cases/123',
  'Your Alignment Brief Alignment Score 67 / 100'
), true);
assert.equal(workflowTestSupport.alignmentScoreWithinExpectedRange(39, { min: 0, max: 40, minInclusive: true, maxInclusive: false }), true);
assert.equal(workflowTestSupport.alignmentScoreWithinExpectedRange(40, { min: 0, max: 40, minInclusive: true, maxInclusive: false }), false);
assert.equal(workflowTestSupport.extractLatestQfi('QFI: Moderate (61)\nLater\nQFI: High (79)'), 79);
assert.equal(workflowTestSupport.factLabelingReady('Fact Statement 1 Confident Fact Submit Labels'), true);
assert.equal(workflowTestSupport.gettingStartedAvailable('Getting Started Begin conversation'), true);
assert.equal(workflowTestSupport.gettingStartedAvailable('Getting Started post-processing'), false);
assert.equal(workflowTestSupport.missingPerspectiveReady(
  'Add Missing Perspective Nothing to add here Continue',
  '/cases/123/missing-perspective'
), true);
assert.equal(workflowTestSupport.missingPerspectiveReady(
  'Missing Perspective Item 1 I Don\'t Know Submit',
  '/cases/123/missing-perspective'
), true);
assert.equal(workflowTestSupport.missingPerspectiveReady(
  'Excerpt Review 10/10 approved Submit',
  '/cases/123/excerpt-review'
), false);
assert.equal(workflowTestSupport.confirmAdditionsReady(
  'Confirm your additions Nothing to confirm Continue',
  '/cases/123/confirm-additions'
), true);
assert.equal(workflowTestSupport.confirmAdditionsReady(
  'Excerpt Review 10/10 approved Submit',
  '/cases/123/excerpt-review'
), false);
assert.equal(workflowTestSupport.confirmAdditionsReady(
  'Loading discussion details...',
  '/cases/123/confirm-additions'
), false);
assert.equal(workflowTestSupport.confirmAdditionsCompletedInStatus(
  'Add Missing Perspective View Confirm Your Additions View Rate Esha Supporting Statements'
), true);
assert.equal(workflowTestSupport.confirmAdditionsCompletedInStatus(
  'Add Missing Perspective Confirm Your Additions Rate Esha Supporting Statements'
), false);
assert.deepEqual(
  workflowTestSupport.extractFactRatingProgress(
    'All statements have been successfully rated! Statement 1 Opinion Statement 2 Opinion Statement 3 Opinion'
  ),
  { completed: 3, remaining: 0, total: 3, source: 'success-banner' }
);

const promptContext = extractPromptContext(`
Current Discussion Area:
Progress Since Last Check-In
Request type:
Performance Review
Current Primary Question:
Since the last review or check-in, what progress or wins are you most proud of, and what helped you achieve them?
Answer Guidance:
- Accomplishments, wins, or meaningful progress since the last check-in
Case ID:
CG-TEST
`);
const matchedQuestion = workflowTestSupport.matchScenarioQuestion(topic, promptContext);
assert.equal(matchedQuestion.id, 'performance_review_coaching_q2_progress_since_last_check_in');
const matchedCriterion = workflowTestSupport.matchScenarioCriterion(matchedQuestion, 'What measurable outcomes did those accomplishments produce?');
assert.equal(matchedCriterion.id, 'performance_review_coaching_q2_progress_since_last_check_in_criterion_5');

assert.equal(workflowTestSupport.evaluateExpectedPartnerBehavior(
  { behaviorId: 'clarification_request' },
  'To clarify, I am asking you to focus on the outcome and why it mattered.'
).passed, true);
assert.equal(workflowTestSupport.evaluateExpectedPartnerBehavior(
  { behaviorId: 'off_topic_response' },
  'Let us return to the current performance review question.'
).passed, true);
assert.equal(workflowTestSupport.interviewReadySignal({
  readyInput: true,
  visibleText: 'This support would free capacity for strategic thinking and improve execution reliability.'
}), true);
assert.equal(workflowTestSupport.interviewReadySignal({
  readyInput: false,
  visibleText: 'How are communication and coordination working?'
}), false);
assert.deepEqual(workflowTestSupport.interviewSubmissionAccepted({
  visibleText: 'Clarify & Improve Helpful Detail 1 Add Context Skip Submit & Continue',
  url: '/cases/123/clarify-context',
  inputVisible: false,
  residual: ''
}), { accepted: true, reason: 'advanced to post-interview processing' });
assert.deepEqual(workflowTestSupport.interviewSubmissionAccepted({
  visibleText: 'Saving your answer...',
  url: '/get-started?case_id=123',
  inputVisible: false,
  residual: ''
}), { accepted: true, reason: 'Common Ground is processing the submitted response' });
assert.deepEqual(workflowTestSupport.interviewSubmissionAccepted({
  visibleText: 'What are your current priorities?',
  url: '/get-started?case_id=123',
  inputVisible: true,
  residual: ''
}), { accepted: true, reason: 'response input was cleared' });
assert.deepEqual(workflowTestSupport.interviewSubmissionAccepted({
  visibleText: 'What are your current priorities?',
  url: '/get-started?case_id=123',
  inputVisible: true,
  residual: 'My response is still here.'
}), { accepted: false, reason: 'response remains unconfirmed' });
assert.equal(workflowTestSupport.excerptReviewReady(
  'Excerpt Review Fact Statements 52/52 approved Submit',
  'https://prod.example/cases/123/excerpt-review'
), true);
assert.deepEqual(
  workflowTestSupport.extractExcerptApprovalCount('Unapproved 52/52 approved Submit'),
  { approved: 52, total: 52 }
);
assert.equal(workflowTestSupport.excerptReviewReady('Fact Statements Confident Fact Submit', '/fact-statements'), false);
assert.equal(workflowTestSupport.factLabelingReady('Fact Statements Confident Fact Submit', '/cases/123/fact-statements'), true);
assert.equal(workflowTestSupport.factLabelingReady('Excerpt Review Fact Statements 52/52 approved Submit', '/cases/123/excerpt-review'), false);
assert.equal(workflowTestSupport.excerptReviewReady(
  'Excerpt Review Fact Statements Rate your Confidence Statement Below 0/8 labeled Submit',
  '/cases/123/fact-review'
), false);
assert.equal(workflowTestSupport.factLabelingReady(
  'Excerpt Review Fact Statements Rate your Confidence Statement Below Statement 1 Confident Fact 0/8 labeled Submit',
  '/cases/123/fact-review'
), true);
assert.equal(workflowTestSupport.factLabelingReady(
  'Before you can start, Rate Requestor Facts Confident Fact',
  '/get-started?session_id=123&case_id=456'
), false);
assert.equal(workflowTestSupport.factLabelingReady(
  'Rate the Requestor Facts Statement 1 Confident Fact Likely Fact Opinion Uncertain Submit',
  '/sessions/123/cross-rate?mode=participant_rates_requestor&case_id=456'
), true);
assert.equal(workflowTestSupport.crossRateUrl(
  '/sessions/123/cross-rate?mode=participant_rates_requestor&case_id=456',
  'participant_rates_requestor'
), true);
assert.equal(workflowTestSupport.crossRateUrl(
  '/sessions/123/cross-rate?mode=requestor_rates_participant&case_id=456',
  'requestor_rates_participant'
), true);
assert.equal(workflowTestSupport.factLabelingReady(
  'Rate the Participant Facts Statement 1 Confident Fact Likely Fact Opinion Uncertain Submit',
  '/sessions/123/cross-rate?mode=requestor_rates_participant&case_id=456'
), true);
assert.deepEqual(workflowTestSupport.extractFactLabelCount('0/8 labeled Submit'), { labeled: 0, total: 8 });
assert.deepEqual(workflowTestSupport.extractFactLabelCount('8/8 labeled Submit'), { labeled: 8, total: 8 });
assert.deepEqual(
  workflowTestSupport.extractCrossRateRemainingCount('6 of 6 facts still need to be rated.'),
  { remaining: 6, total: 6 }
);
assert.deepEqual(
  workflowTestSupport.extractCrossRateRemainingCount('1 of 6 facts still need to be rated.'),
  { remaining: 1, total: 6 }
);
assert.deepEqual(
  workflowTestSupport.extractFactRatingProgress('3/8 labeled Submit'),
  { completed: 3, remaining: 5, total: 8, source: 'labeled-counter' }
);
assert.deepEqual(
  workflowTestSupport.extractFactRatingProgress('5 of 8 facts still need to be rated. Submit Ratings'),
  { completed: 3, remaining: 5, total: 8, source: 'remaining-counter' }
);
assert.equal(workflowTestSupport.nextFactLabelControlIndex({ completed: 0 }, 11), 0);
assert.equal(workflowTestSupport.nextFactLabelControlIndex({ completed: 9 }, 11), 9);
assert.equal(workflowTestSupport.nextFactLabelControlIndex({ completed: 10 }, 11), 10);
assert.equal(workflowTestSupport.fullWorkflowResultStatus({ workflowCompleted: true }), 'passed');
assert.equal(workflowTestSupport.fullWorkflowResultStatus({ workflowCompleted: false }), 'failed');
assert.deepEqual(
  workflowTestSupport.findCaseIdsInText('CG-AI-TEST-XATCH4 CG-0258 CG-0257 CG-0258'),
  ['CG-0258', 'CG-0257']
);
assert.equal(workflowTestSupport.onNewDiscussionForm(
  'https://staging.example/request/new',
  'Create New Discussion Party 1 Party 2 Review Period'
), true);
assert.equal(workflowTestSupport.onNewDiscussionForm(
  'https://staging.example/dashboard',
  'Create New Discussion CG-0108'
), false);
assert.equal(
  workflowTestSupport.requestedStartDateIso(new Date('2026-08-21T23:59:00-07:00')),
  '2026-08-22'
);

console.log('Full workflow signal validation passed.');

import assert from 'node:assert/strict';
import { buildBehaviorCompositionPlan, coverageAllowance, validateCompactResponseStyle, validateScenarioResponse, verifyScenarioBehaviors } from '../src/llmResponder.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScenarioFoundation } from '../src/scenarioConfig.js';
import { createScenarioController } from '../src/scenarioController.js';
import { buildExpressionRequirements, generateScenarioDossiers, relationshipForDistance } from '../src/scenarioDossiers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const topic = readJson('config/case-types/performance-review-coaching.json');
const foundation = loadScenarioFoundation(rootDir, topic);
// off_topic_response ships disabled in the default schedule, so only enabled
// behaviors are selectable — the count must not include disabled entries.
const enabledBehaviorCount = foundation.defaultBehaviorSchedule.behaviors
  .filter((item) => item.enabled !== false).length;
const allBehaviorSchedule = {
  ...structuredClone(foundation.defaultBehaviorSchedule),
  id: 'all_behaviors_validation',
  name: 'All Behaviors Validation',
  behaviorCountPerActor: enabledBehaviorCount
};

assert.equal(validateCompactResponseStyle('I met the goal. The project finished on time. The team had fewer delays.').pass, true, 'A concise three-sentence response must pass.');
assert.equal(validateCompactResponseStyle('One. Two. Three. Four.').pass, true, 'A four-sentence response must not hard fail.');
assert.ok(validateCompactResponseStyle('One. Two. Three. Four.').warnings.some((warning) => warning.type === 'response_brevity'), 'A four-sentence response must create a brevity warning.');
assert.equal(validateCompactResponseStyle(Array.from({ length: 76 }, () => 'word').join(' ')).pass, true, 'A response over 75 words must not hard fail.');
assert.ok(validateCompactResponseStyle(Array.from({ length: 76 }, () => 'word').join(' ')).warnings.some((warning) => warning.type === 'response_brevity'), 'A response over 75 words must create a brevity warning.');
assert.equal(validateCompactResponseStyle(`${Array.from({ length: 29 }, () => 'word').join(' ')}.`).pass, true, 'A sentence over 28 words must not hard fail.');
assert.ok(validateCompactResponseStyle(`${Array.from({ length: 29 }, () => 'word').join(' ')}.`).warnings.some((warning) => warning.type === 'response_reading_level'), 'A long sentence must create a reading-level warning.');

// A full-coverage turn must be allowed one sentence per guidance point: Partner
// AI scores every point, and a criterion left partial caps the turn at 75 and
// earns another probe. The compact defaults apply only when no allowance is given.
const sevenPointAllowance = coverageAllowance({ activePrompt: { answerGuidance: new Array(7).fill('point') } });
assert.equal(sevenPointAllowance.sentences, 9, 'Seven guidance points must allow a sentence each plus a lead and a close.');
assert.ok(sevenPointAllowance.words >= 7 * 32, 'The word allowance must scale with the number of guidance points.');
assert.equal(coverageAllowance({}).sentences, 4, 'With no guidance on screen the allowance must still permit a complete answer.');
const coverageAnswer = Array.from({ length: 8 }, (_, index) => `Point ${index + 1} was missed against its stated target, so the milestone slipped.`).join(' ');
assert.equal(
  validateCompactResponseStyle(coverageAnswer, sevenPointAllowance).warnings.filter((warning) => warning.type === 'response_brevity').length,
  0,
  'A coverage answer judged against its own allowance must not raise brevity warnings.'
);
assert.ok(
  validateCompactResponseStyle(coverageAnswer).warnings.some((warning) => warning.type === 'response_brevity'),
  'The same answer judged against the compact defaults must still warn, so the defaults are unchanged.'
);

const first = createScenarioController({
  foundation,
  alignmentScenarioId: 'extremely_misaligned',
  behaviorSchedule: allBehaviorSchedule,
  seed: 'scenario-controller-validation'
});
const second = createScenarioController({
  foundation,
  alignmentScenarioId: 'extremely_misaligned',
  behaviorSchedule: allBehaviorSchedule,
  seed: 'scenario-controller-validation'
});

const dossierScenario = foundation.alignmentScenarios.scenarios.find((item) => item.id === 'extremely_misaligned');
const dossiersA = await generateScenarioDossiers({
  llm: { apiKey: 'offline-test' },
  topic: foundation.topic,
  scenario: dossierScenario,
  seed: 'dossier-case-a',
  completeJson: offlineDossierCompletion
});
const dossiersB = await generateScenarioDossiers({
  llm: { apiKey: 'offline-test' },
  topic: foundation.topic,
  scenario: dossierScenario,
  seed: 'dossier-case-b',
  completeJson: offlineDossierCompletion
});
assert.notEqual(dossiersA.employee.canonicalProfile.employeeRole, dossiersB.employee.canonicalProfile.employeeRole, 'Different case seeds must produce fresh dossier profiles.');
assert.deepEqual(dossiersA.manager.canonicalProfile, dossiersA.employee.canonicalProfile, 'Manager dossier must retain the employee canonical profile exactly.');
assert.deepEqual(dossiersA.evidencePacket.canonicalProfile, dossiersA.employee.canonicalProfile, 'Neutral evidence must own the canonical profile.');
assert.ok(dossiersA.evidencePacket.termEvidence.every((item) => item.favorableEvidence.length >= 2 && item.limitingEvidence.length >= 2), 'Every term must support both favorable and limiting interpretations.');
assert.equal(dossiersA.scenarioExpressionPlan.questionExpressions.length, topic.primaryQuestions.length, 'Every primary question must have an expression record.');
assert.ok(dossiersA.scenarioExpressionPlan.questionExpressions.every((item) => item.expectedRelationship === 'opposite'), 'Extremely Misaligned must create opposite question-level relationships.');
assert.equal(dossiersA.pairValidation.pass, true, 'Paired dossiers must pass the divergence audit.');
const advisoryDossiers = await generateScenarioDossiers({
  llm: { apiKey: 'offline-validation' },
  topic: foundation.topic,
  scenario: dossierScenario,
  seed: 'scenario-dossier-advisory-audit',
  completeJson: advisoryPairAuditCompletion
});
assert.equal(advisoryDossiers.pairValidation.pass, true, 'Subjective pair-audit findings must not block a structurally valid dossier.');
assert.equal(advisoryDossiers.pairValidation.advisoryPass, false, 'Rejected semantic audit checks must be identified as advisory failures.');
assert.ok(advisoryDossiers.pairValidation.warnings.some((warning) => warning.includes('results_impact')), 'Pair-audit warnings must identify the affected term.');

for (const scenario of foundation.alignmentScenarios.scenarios) {
  const requirements = buildExpressionRequirements(topic, scenario);
  assert.equal(requirements.length, topic.primaryQuestions.length, `${scenario.id} must cover every primary question.`);
  for (const requirement of requirements) {
    assert.equal(requirement.expectedRelationship, relationshipForDistance(requirement.ratingDistance), `${scenario.id}/${requirement.primaryQuestionId} must derive its relationship from rating distance.`);
  }
  const generated = await generateScenarioDossiers({
    llm: { apiKey: 'offline-test' },
    topic: foundation.topic,
    scenario,
    seed: `all-scenarios-${scenario.id}`,
    completeJson: offlineDossierCompletion
  });
  const generatedByQuestion = new Map(generated.scenarioExpressionPlan.questionExpressions.map((item) => [item.primaryQuestionId, item]));
  for (const requirement of requirements) {
    assert.equal(generatedByQuestion.get(requirement.primaryQuestionId)?.expectedRelationship, requirement.expectedRelationship, `${scenario.id}/${requirement.primaryQuestionId} must preserve its expected relationship.`);
  }
}

const defaultController = createScenarioController({
  foundation,
  alignmentScenarioId: 'well_aligned_mixed',
  seed: 'default-six-validation'
});
const defaultRequestorBehaviorIds = new Set(defaultController.getPlan().behaviors
  .filter((item) => item.actor === 'requestor')
  .map((item) => item.behaviorId));
assert.equal(defaultRequestorBehaviorIds.size, 6, 'The default schedule must select six behaviors per actor.');

assert.deepEqual(first.getPlan(), second.getPlan(), 'The same seed must materialize the same plan.');

const plan = first.getPlan();
assert.equal(plan.sharedEvents.length, topic.terms.length, 'Each topic term must receive one shared event.');
assert.ok(plan.sharedEvents.every((event) => event.quantitativeEvidence.length && event.qualitativeEvidence.length), 'Every event must mix quantitative and qualitative evidence.');
assert.ok(plan.sharedEvents.every((event) => event.facts.some((fact) => fact.includes("employee's role is"))), 'Every shared event must carry the immutable employee role.');
assert.ok(plan.sharedEvents.every((event) => event.facts.some((fact) => fact.includes('shared project is'))), 'Every shared event must carry the immutable shared project.');
const sharedRoles = new Set(plan.sharedEvents.map((event) => event.facts.find((fact) => fact.includes("employee's role is"))));
const sharedProjects = new Set(plan.sharedEvents.map((event) => event.facts.find((fact) => fact.includes('shared project is'))));
assert.equal(sharedRoles.size, 1, 'All terms must use one employee role.');
assert.equal(sharedProjects.size, 1, 'All terms must use one shared project.');

first.setRequestorRole('manager');
first.setDossiers(dossiersA);
const roleContracts = first.validateRoleContracts();
assert.deepEqual(roleContracts.requestor, {
  domainRole: 'manager',
  dossier: 'manager',
  ratingSource: 'participant',
  perspective: 'manager_evaluating_employee'
}, 'Manager requestor must use the manager dossier and manager scenario ratings.');
assert.deepEqual(roleContracts.participant, {
  domainRole: 'employee',
  dossier: 'employee',
  ratingSource: 'requestor',
  perspective: 'employee_self_assessment'
}, 'Employee participant must use the employee dossier and employee scenario ratings.');
// The canonical workflow resolves the requestor as manager and participant as employee.
const dossierContext = first.getScenarioContext('requestor', topic.primaryQuestions[0].id);
assert.equal(dossierContext.canonicalProfile.employeeRole, dossiersA.employee.canonicalProfile.employeeRole, 'Runtime scenario context must use the generated dossier role.');
assert.ok(dossierContext.dossierAnswer.startsWith('I believe the employee performed poorly'), 'Requestor runtime context must retrieve the manager dossier answer.');
const participantDossierContext = first.getScenarioContext('participant', topic.primaryQuestions[0].id);
assert.ok(participantDossierContext.dossierAnswer.startsWith('I believe my work in this area was excellent'), 'Participant runtime context must retrieve the employee dossier answer.');
assert.equal(dossierContext.scenarioExpression.primaryQuestionId, topic.primaryQuestions[0].id, 'Runtime context must include the active question relationship.');
assert.ok(first.getPlan().sharedEvents.every((event) => event.facts.some((fact) => fact.includes(dossiersA.employee.canonicalProfile.employeeRole))), 'Dossier facts must replace the preliminary scenario role in every shared event.');

const unsatisfactoryTurn = {
  actorRole: 'participant',
  actorPerspective: 'manager_evaluating_employee',
  turnClassification: { isPrimaryQuestionTurn: false },
  activePrompt: {
    activeQuestion: 'How would you assess the employee\'s performance and impact?'
  },
  scenarioTurn: {
    behaviors: [],
    scenarioContext: {
      question: {
        id: 'performance_assessment',
        question: 'How would you assess the employee\'s performance and impact?'
      },
      terms: [{
        interpretation: { ratingId: 'unsatisfactory' },
        sharedEvent: {
          facts: [
            "The employee's role is Senior Project Manager.",
            'The shared project is a cross-functional workflow modernization rollout.'
          ]
        }
      }]
    }
  }
};
assert.equal(
  validateScenarioResponse(unsatisfactoryTurn, 'The employee improved the score and meets expectations, though there is room to improve.').pass,
  false,
  'An unsatisfactory scenario must reject softened meets-expectations language.'
);
assert.equal(
  validateScenarioResponse(unsatisfactoryTurn, "The employee's performance is materially below expectations. Although the workflow modernization rollout improved one metric, deadlines and handoffs remained unreliable and required manager intervention, so the favorable evidence is insufficient.").pass,
  true,
  'An explicit manager-side unsatisfactory interpretation should pass.'
);
const roleVariantTurn = structuredClone(unsatisfactoryTurn);
roleVariantTurn.actorRole = 'requestor';
roleVariantTurn.actorPerspective = 'employee_self_assessment';
roleVariantTurn.scenarioTurn.scenarioContext.terms[0].sharedEvent.facts = [
  "The employee's role is Data Quality Analyst - Customer Insights.",
  'The shared project is an automated data quality alert system.'
];
assert.equal(
  validateScenarioResponse(roleVariantTurn, 'I take full ownership of my role as a Data Quality Analyst focused on accurate customer data. Most of my time goes toward validation rules and monitoring dashboards.').pass,
  true,
  'A concise role variant must not be treated as changing the immutable employee role.'
);
assert.equal(
  validateScenarioResponse(roleVariantTurn, 'I take full ownership of my role as a Product Marketing Lead focused on campaign planning.').pass,
  false,
  'A genuinely different role must still fail immutable-role validation.'
);
assert.equal(
  validateScenarioResponse(unsatisfactoryTurn, 'My performance is materially below expectations, and I need help from my manager.').pass,
  false,
  'A participant response written from the employee perspective must fail.'
);

const outstandingTurn = structuredClone(unsatisfactoryTurn);
outstandingTurn.actorRole = 'requestor';
outstandingTurn.actorPerspective = 'employee_self_assessment';
outstandingTurn.scenarioTurn.scenarioContext.terms[0].interpretation.ratingId = 'outstanding';
assert.equal(
  validateScenarioResponse(outstandingTurn, 'Communication and coordination are highly effective and have made a significant contribution to the success of the shared workflow modernization rollout. Regular updates and proactive issue resolution keep stakeholders aligned.' ).pass,
  true,
  'Strong semantically equivalent outstanding language should pass without requiring a literal rating label.'
);
assert.equal(
  validateScenarioResponse(outstandingTurn, 'Communication is generally effective, although there is room to improve.' ).pass,
  true,
  'Ambiguous rating language should be recorded without failing the response.'
);
assert.equal(
  validateScenarioResponse(outstandingTurn, 'Communication is generally effective, although there is room to improve.' ).warnings.length,
  1,
  'Ambiguous rating language should produce a scenario-rating soft warning.'
);
assert.equal(
  validateScenarioResponse(outstandingTurn, 'My performance is materially below expectations and does not meet the role standard.' ).pass,
  false,
  'A direct contradiction of an outstanding rating must remain a hard failure.'
);
assert.equal(
  validateScenarioResponse(outstandingTurn, 'I led the customer-service process redesign to improve the index from 72 to 83, which significantly exceeds the standard expectation of 80.' ).pass,
  true,
  'Case 274 equivalent outstanding phrasing should be accepted.'
);

const expressionControlledTurn = structuredClone(unsatisfactoryTurn);
expressionControlledTurn.turnClassification.isPrimaryQuestionTurn = true;
expressionControlledTurn.scenarioTurn.scenarioContext.scenarioExpression = {
  managerOpeningStatement: 'I believe the employee performed poorly in this area.',
  employeeOpeningStatement: 'I believe my work in this area was excellent.',
  expectedRelationship: 'opposite'
};
assert.equal(
  validateScenarioResponse(expressionControlledTurn, 'The employee did not meet expectations in this area.').pass,
  false,
  'A primary response must use the exact plain-language scenario opening.'
);
assert.equal(
  validateScenarioResponse(expressionControlledTurn, 'I believe the employee performed poorly in this area. The missed deadline mattered more than the final result.').pass,
  true,
  'A primary response using the required plain-language scenario opening should pass.'
);

const questionOnlyAssignment = { behaviorId: 'embedded_questions', stage: 'question_only' };
assert.equal(buildBehaviorCompositionPlan([questionOnlyAssignment]).mode, 'defer', 'Question-only behavior must defer the scenario answer.');
assert.equal(verifyScenarioBehaviors('Could you explain what success looks like here?', [questionOnlyAssignment])[0].passed, true, 'A visible question-only response must pass behavior verification.');
assert.equal(verifyScenarioBehaviors('I delivered strong results and met the target.', [questionOnlyAssignment])[0].passed, false, 'A normal scenario answer must not count as an embedded question behavior.');
const fatigueAssignmentForVerification = { behaviorId: 'fatigue_expression', stage: 'single', fatigueLevel: 'moderate' };
const fatigueVerification = verifyScenarioBehaviors('Honestly, it is a bit draining to manage these repeated accuracy issues.', [fatigueAssignmentForVerification])[0];
assert.equal(fatigueVerification.passed, null, 'Subjective fatigue language must be routed to semantic review rather than rejected by a keyword gate.');
assert.match(fatigueVerification.reason, /detected/i, 'Common fatigue word forms such as draining should be recognized before semantic review.');
const offTopicAssignmentForVerification = { behaviorId: 'off_topic_response', stage: 'off_topic' };
assert.equal(
  verifyScenarioBehaviors('I recently read a book on urban gardening. Small community gardens can improve city life and help neighbors build green spaces.', [offTopicAssignmentForVerification])[0].passed,
  true,
  'A clear unrelated hobby/community topic must pass off-topic behavior verification without LLM review.'
);
assert.equal(
  verifyScenarioBehaviors('The employee communicates updates clearly and coordinates with peers during incidents.', [offTopicAssignmentForVerification])[0].passed,
  null,
  'A workplace communication answer must not be deterministically accepted as off-topic.'
);
const questionBeginningAssignment = { behaviorId: 'embedded_questions', stage: 'question_at_beginning' };
assert.equal(buildBehaviorCompositionPlan([questionBeginningAssignment]).mode, 'compose', 'A beginning question must compose with the scenario answer.');
assert.equal(verifyScenarioBehaviors('How should we weigh the delayed pilot? I still delivered two pilots on time and improved engagement.', [questionBeginningAssignment])[0].passed, true, 'A question followed by scenario substance must pass beginning-question verification.');
const addPriorAssignment = { behaviorId: 'add_to_previous_response', stage: 'identify_prior_question', scheduleItemId: 'add-prior', primaryQuestionId: topic.primaryQuestions[3].id };
assert.equal(buildBehaviorCompositionPlan([addPriorAssignment]).mode, 'defer', 'Identifying a prior answer must defer the current scenario answer.');
first.deferScenarioAnswer('requestor', addPriorAssignment, 'Preserved scenario answer.');
assert.equal(first.getDeferredScenarioAnswer('requestor', [addPriorAssignment]).response, 'Preserved scenario answer.', 'Deferred scenario answers must remain available to later behavior stages.');
first.clearDeferredScenarioAnswer('requestor', addPriorAssignment);
assert.equal(first.getDeferredScenarioAnswer('requestor', [addPriorAssignment]), null, 'Deferred scenario answers must clear after composition.');

const outstandingSupportTurn = structuredClone(outstandingTurn);
outstandingSupportTurn.activePrompt = {
  activeQuestion: 'What support, clarity, resources, or changes would help you perform at a higher level over the next period?'
};
outstandingSupportTurn.scenarioTurn.scenarioContext.question = {
  id: 'performance_review_coaching_q4_support_needed',
  question: outstandingSupportTurn.activePrompt.activeQuestion
};
assert.equal(
  validateScenarioResponse(outstandingSupportTurn, 'I would benefit from clearer communication protocols, defined ownership during team handoffs, targeted coaching, and more explicit priorities so I can reduce delays and extend the strong results already achieved.' ).pass,
  true,
  'A support-needs answer should not be required to state an explicit performance rating.'
);

const requestorAssignments = plan.behaviors.filter((item) => item.actor === 'requestor');
const participantAssignments = plan.behaviors.filter((item) => item.actor === 'participant');
assert.deepEqual(
  requestorAssignments.map(withoutActor),
  participantAssignments.map(withoutActor),
  'Requestor and participant must receive identical behavior schedules.'
);

const selectedBehaviorIds = new Set(requestorAssignments.map((item) => item.behaviorId));
assert.equal(selectedBehaviorIds.size, allBehaviorSchedule.behaviorCountPerActor, 'Each selected behavior should run once per actor unless repetitions are configured.');

for (const behaviorId of ['clarification_request', 'definition_request', 'example_request', 'uncertainty_expression', 'skip_current_item', 'off_topic_response']) {
  const assignments = requestorAssignments.filter((item) => item.behaviorId === behaviorId);
  if (assignments.length > 1) {
    assert.equal(new Set(assignments.map((item) => item.primaryQuestionId)).size, 1, `${behaviorId} stages must remain on the same interview item so recovery can occur.`);
  }
}

const embeddedAssignments = requestorAssignments.filter((item) => item.behaviorId === 'embedded_questions');
assert.equal(embeddedAssignments.length, 4, 'Embedded questions must materialize all four placements.');
assert.equal(new Set(embeddedAssignments.map((item) => item.primaryQuestionId)).size, 4, 'Embedded question placements must use four different primary questions.');
assert.deepEqual(
  embeddedAssignments.map((item) => questionOrderValue(topic, item.primaryQuestionId)),
  [...embeddedAssignments.map((item) => questionOrderValue(topic, item.primaryQuestionId))].sort((left, right) => left - right),
  'Embedded question stages must occur in interview order.'
);

const firstEmbedded = embeddedAssignments[0];
const secondEmbedded = embeddedAssignments[1];
assert.equal(first.getPendingBehaviors({ actor: 'requestor', primaryQuestionId: secondEmbedded.primaryQuestionId }).some((item) => item.stage === secondEmbedded.stage), false, 'Later behavior stages must stay blocked until earlier stages complete.');
first.activateBehavior(firstEmbedded, 1);
first.completeBehavior(firstEmbedded, 1);
assert.equal(first.getPendingBehaviors({ actor: 'requestor', primaryQuestionId: secondEmbedded.primaryQuestionId }).some((item) => item.stage === secondEmbedded.stage), true, 'Completing an earlier stage must unlock the next stage.');

const questionOrder = new Map(topic.primaryQuestions.map((question, index) => [question.id, index]));
const sourceDependentAssignments = requestorAssignments.filter((item) => item.sourcePrimaryQuestionId);
for (const assignment of sourceDependentAssignments.filter((item) => item.sourcePrimaryQuestionId !== item.primaryQuestionId)) {
  assert.ok(
    questionOrder.get(assignment.sourcePrimaryQuestionId) < questionOrder.get(assignment.primaryQuestionId),
    `${assignment.behaviorId} must retain a fact from an earlier primary question.`
  );
}
for (const behaviorId of ['correction_previous_response', 'add_to_previous_response', 'context_reuse', 'contradiction']) {
  const assignments = sourceDependentAssignments.filter((item) => item.behaviorId === behaviorId);
  assert.ok(assignments.some((item) => item.sourcePrimaryQuestionId !== item.primaryQuestionId), `${behaviorId} must include a later trigger after its retained source fact.`);
}

const requestorContext = first.getScenarioContext('requestor', topic.primaryQuestions[1].id);
const participantContext = first.getScenarioContext('participant', topic.primaryQuestions[1].id);
assert.equal(requestorContext.terms[0].sharedEvent.id, participantContext.terms[0].sharedEvent.id, 'Both actors must receive the same shared event.');
assert.notEqual(requestorContext.terms[0].ratingId, participantContext.terms[0].ratingId, 'The selected misaligned scenario must apply different actor interpretations.');

first.retainFact({
  actor: 'requestor',
  factId: 'validation_fact',
  primaryQuestionId: topic.primaryQuestions[0].id,
  value: 'Original synthetic value',
  context: 'Validation context'
});
first.beginCorrection({ actor: 'requestor', factId: 'validation_fact', correctedValue: 'Corrected synthetic value' });
first.resolveCorrection({ actor: 'requestor', factId: 'validation_fact', confirmed: false, revisedValue: 'Second proposed value' });
first.resolveCorrection({ actor: 'requestor', factId: 'validation_fact', confirmed: false, revisedValue: 'Third proposed value' });
const capped = first.resolveCorrection({ actor: 'requestor', factId: 'validation_fact', confirmed: false, revisedValue: 'Final noted value' });
assert.equal(capped.capped, true, 'Correction handling must cap after three unsuccessful confirmations.');
assert.equal(capped.fact.currentValue, 'Final noted value', 'The final requested correction must be retained after the cap.');

const fatigueAssignment = requestorAssignments.find((item) => item.behaviorId === 'fatigue_expression');
const qfiResult = first.recordBehaviorExecution({
  actor: 'requestor',
  turn: 4,
  primaryQuestionId: fatigueAssignment.primaryQuestionId,
  behaviorIds: ['fatigue_expression'],
  assignedFatigueLevel: 'moderate',
  observedQfi: 75,
  syntheticUserCompliant: true,
  softAssertions: []
});
assert.equal(qfiResult.softAssertions.find((item) => item.type === 'qfi_range').passed, false, 'A QFI outside the assigned fatigue range must be recorded as a soft assertion failure.');

for (const assignment of requestorAssignments) {
  if (assignment.behaviorId === firstEmbedded.behaviorId && assignment.stage === firstEmbedded.stage) continue;
  first.activateBehavior(assignment, assignment.sequence + 1);
  first.completeBehavior(assignment, assignment.sequence + 1);
}
for (const assignment of participantAssignments) {
  first.activateBehavior(assignment, assignment.sequence + 1);
  first.completeBehavior(assignment, assignment.sequence + 1);
}
const coverage = first.getCoverageSummary();
assert.equal(coverage.syntheticUserScenarioCompliant, true, 'Completing every assigned behavior must satisfy scenario compliance.');

console.log('Scenario controller validation passed.');
console.log(`Seed: ${plan.seed}`);
console.log(`Shared events: ${plan.sharedEvents.length}`);
console.log(`Behaviors per actor: ${selectedBehaviorIds.size}`);
console.log(`Materialized stages per actor: ${requestorAssignments.length}`);

async function offlineDossierCompletion(_llm, request) {
  const input = request.input;
  if (!input.actor) {
    return {
      pass: true,
      issues: [],
      termChecks: input.topic.terms.map((term) => ({
        termId: term.id,
        employeeSupportsRating: true,
        managerSupportsRating: true,
        relationshipMatchesRatings: true,
        noPromptLeak: true,
        reason: 'The two actors reach opposite conclusions from mixed evidence.'
      })),
      questionChecks: input.topic.primaryQuestions.map((question) => ({
        primaryQuestionId: question.id,
        openingsPresent: true,
        relationshipMatchesPlan: true,
        plainLanguage: true,
        reason: 'The question pair uses direct opposing conclusions.'
      }))
    };
  }
  const suffix = input.caseSeed.endsWith('a') ? 'Alpha' : 'Beta';
  const profile = {
    employeeName: `Employee ${suffix}`,
    employeeRole: `Program Lead ${suffix}`,
    organizationContext: `Operations Group ${suffix}`,
    reviewPeriod: 'Annual review period',
    responsibilities: ['Lead delivery', 'Coordinate stakeholders', 'Manage quality'],
    goals: ['Improve delivery index', 'Reduce delays', 'Increase stakeholder confidence'],
    sharedEvents: [{ id: 'event-1', description: 'Completed a coordinated process rollout.', evidence: ['Delivery index changed during the period.'] }],
    metrics: [{ termId: input.topic.terms[0].id, name: 'Delivery index', baseline: 70, result: 82, standardExpectation: 80, stretchExpectation: 95, unit: 'points' }]
  };
  if (input.actor === 'neutral') {
    return {
      canonicalProfile: profile,
      termEvidence: input.topic.terms.map((term) => ({
        termId: term.id,
        objectiveFacts: [`The shared project produced a measurable result for ${term.label}.`],
        favorableEvidence: [`The result exceeded the standard expectation for ${term.label}.`, `Stakeholders reported a useful improvement in ${term.label}.`],
        limitingEvidence: [`The result remained below the stretch expectation for ${term.label}.`, `The employee required material support for ${term.label}.`],
        decisiveFavorableCase: {
          conclusionBasis: `Documented outcomes can support the highest evaluation for ${term.label}.`,
          evidence: [`A stretch target was exceeded for ${term.label}.`, `The result created material organizational value for ${term.label}.`]
        },
        decisiveLimitingCase: {
          conclusionBasis: `A separate core expectation can support the lowest evaluation for ${term.label}.`,
          evidence: [`A core duty was materially missed for ${term.label}.`, `Manager intervention was required to recover ${term.label}.`]
        },
        attributionAmbiguity: [`Several team members contributed to ${term.label}.`],
        consistencyEvidence: [`Only one review-period example is available for ${term.label}.`],
        independenceEvidence: [`The manager intervened at a key point involving ${term.label}.`]
      })),
      primaryQuestionEvidence: input.topic.primaryQuestions.map((question) => ({
        primaryQuestionId: question.id,
        relevantTermIds: [question.primaryTermId],
        relevantFactIds: ['event-1']
      }))
    };
  }
  if (input.actor === 'expression') {
    return {
      questionExpressions: input.expressionRequirements.map((requirement) => ({
        ...requirement,
        sharedFacts: ['The project produced a useful result.', 'A separate core expectation was missed.'],
        ...offlineRelationshipLanguage(requirement.expectedRelationship)
      }))
    };
  }
  const expressionByQuestion = new Map(input.scenarioExpressionPlan.questionExpressions.map((item) => [item.primaryQuestionId, item]));
  return {
    canonicalProfile: profile,
    executiveSummary: `${input.actor} executive summary ${suffix}`,
    termPositions: input.assignedRatings.map((rating) => ({
      termId: rating.termId,
      ratingId: rating.ratingId,
      conclusion: `${input.actor} reaches a clear ${rating.ratingLabel} conclusion for ${rating.term}.`,
      supportingFacts: [`Shared result evidence for ${rating.termId}.`, `Shared stakeholder evidence for ${rating.termId}.`],
      counterEvidence: [`Evidence also permits a different view of ${rating.termId}.`],
      counterEvidenceExplanation: `${input.actor} explains why the counter-evidence does not change the conclusion.`,
      attribution: `${input.actor} attribution judgment`,
      consistency: `${input.actor} consistency judgment`,
      independence: `${input.actor} independence judgment`
    })),
    primaryQuestionAnswers: input.topic.primaryQuestions.map((question) => ({
      primaryQuestionId: question.id,
      answer: `${input.actor === 'manager' ? expressionByQuestion.get(question.id).managerOpeningStatement : expressionByQuestion.get(question.id).employeeOpeningStatement} The shared facts support this view in clear terms.`
    }))
  };
}

async function advisoryPairAuditCompletion(llm, request) {
  const response = await offlineDossierCompletion(llm, request);
  if (request.input.actor) return response;
  return {
    ...response,
    pass: false,
    issues: ['The semantic judge wanted stronger wording.'],
    termChecks: response.termChecks.map((check) => ({
      ...check,
      employeeSupportsRating: false,
      relationshipMatchesRatings: false,
      reason: 'The conclusion was present, but the evaluator wanted more explicit wording.'
    }))
  };
}

function offlineRelationshipLanguage(expectedRelationship) {
  const options = {
    aligned: {
      employeeOpeningStatement: 'I believe my work met the expected standard in this area.',
      managerOpeningStatement: 'I agree the employee met the expected standard in this area.',
      employeePosition: 'The employee sees steady work that met the role standard.',
      managerPosition: 'The manager also sees steady work that met the role standard.',
      relationshipExplanation: 'Both parties reach the same overall conclusion from the shared facts.'
    },
    slight_difference: {
      employeeOpeningStatement: 'I believe my work was somewhat stronger than expected in this area.',
      managerOpeningStatement: 'I believe the employee met expectations in this area.',
      employeePosition: 'The employee places slightly more weight on the favorable result.',
      managerPosition: 'The manager agrees the result was sound but sees it as expected work.',
      relationshipExplanation: 'They agree on the direction but differ slightly in confidence.'
    },
    moderate_difference: {
      employeeOpeningStatement: 'I believe my work was strong in this area.',
      managerOpeningStatement: 'I believe the employee only partly met expectations here.',
      employeePosition: 'The employee emphasizes the useful result.',
      managerPosition: 'The manager acknowledges the result but gives more weight to the missed expectation.',
      relationshipExplanation: 'They recognize the same facts but reach noticeably different assessments.'
    },
    strong_difference: {
      employeeOpeningStatement: 'I believe my work was excellent in this area.',
      managerOpeningStatement: 'I believe the employee fell short in this area.',
      employeePosition: 'The employee treats the strong result as the main evidence.',
      managerPosition: 'The manager treats the missed core expectation as more important.',
      relationshipExplanation: 'They reach clearly different conclusions with little common ground.'
    },
    opposite: {
      employeeOpeningStatement: 'I believe my work in this area was excellent.',
      managerOpeningStatement: 'I believe the employee performed poorly in this area.',
      employeePosition: 'The employee focuses on the strong result.',
      managerPosition: 'The manager focuses on the missed expectation.',
      relationshipExplanation: 'They reach opposite conclusions about which shared fact matters most.'
    }
  };
  return options[expectedRelationship];
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'));
}

function withoutActor(assignment) {
  const { actor, ...rest } = assignment;
  return rest;
}

function questionOrderValue(topicDefinition, questionId) {
  return topicDefinition.primaryQuestions.findIndex((question) => question.id === questionId);
}

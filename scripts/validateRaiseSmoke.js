import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadScenarioFoundation } from '../src/scenarioConfig.js';
import { createScenarioController } from '../src/scenarioController.js';
import { buildExpressionRequirements, generateScenarioDossiers, relationshipForDistance } from '../src/scenarioDossiers.js';
import { validateScenarioResponse, verifyScenarioBehaviors } from '../src/llmResponder.js';

const topic = JSON.parse(fs.readFileSync('config/case-types/raise.json', 'utf8'));
const foundation = loadScenarioFoundation(process.cwd(), topic);
const scenario = foundation.alignmentScenarios.scenarios.find((item) => item.id === 'extremely_misaligned')
  ?? foundation.alignmentScenarios.scenarios[0];

assert.equal(foundation.topic.primaryQuestions.length, 7, 'Raise should expose seven primary questions.');
assert.ok(foundation.alignmentScenarios.scenarios.length >= 7, 'Raise should expose generic alignment scenarios.');

const requirements = buildExpressionRequirements(foundation.topic, scenario);
assert.equal(requirements.length, foundation.topic.primaryQuestions.length, 'Every Raise primary question needs an expression requirement.');
for (const requirement of requirements) {
  assert.equal(requirement.expectedRelationship, relationshipForDistance(requirement.ratingDistance), `${requirement.primaryQuestionId} relationship must derive from rating distance.`);
}

const controller = createScenarioController({
  foundation,
  alignmentScenarioId: scenario.id,
  seed: 'raise-offline-smoke'
});
const plan = controller.getPlan();
const requestorPlan = plan.behaviors.filter((item) => item.actor === 'requestor').map(withoutActor);
const participantPlan = plan.behaviors.filter((item) => item.actor === 'participant').map(withoutActor);
assert.deepEqual(requestorPlan, participantPlan, 'Raise requestor and participant behavior schedules must match.');

assert.equal(
  verifyScenarioBehaviors('Could you give an example of the compensation details you want?', [{ behaviorId: 'embedded_questions', stage: 'question_only' }])[0].passed,
  true,
  'Raise embedded-question behavior should validate.'
);
assert.equal(
  verifyScenarioBehaviors('I have been trying new pasta recipes and reading about container gardening.', [{ behaviorId: 'off_topic_response', stage: 'off_topic' }])[0].passed,
  true,
  'Raise off-topic behavior should validate deterministically.'
);

const raiseTurn = {
  actorRole: 'requestor',
  actorPerspective: 'employee_self_assessment',
  turnClassification: { isPrimaryQuestionTurn: false },
  activePrompt: { activeQuestion: 'What exactly are you asking for?' },
  scenarioTurn: {
    behaviors: [],
    scenarioContext: {
      terms: [{
        interpretation: { ratingId: 'outstanding' },
        sharedEvent: {
          facts: [
            "The employee's role is Customer Support Specialist.",
            'The shared project is a service response improvement project.'
          ]
        }
      }]
    }
  }
};
assert.equal(
  validateScenarioResponse(raiseTurn, 'I am asking for a 7 percent base salary increase and a small quarterly bonus tied to service goals.').pass,
  true,
  'A normal Raise requestor response should pass scenario validation.'
);

const dossiers = await generateScenarioDossiers({
  llm: { apiKey: 'offline' },
  topic: foundation.topic,
  scenario,
  seed: 'raise-dossier-smoke',
  completeJson: offlineCompletion
});
assert.equal(dossiers.employee.primaryQuestionAnswers.length, foundation.topic.primaryQuestions.length, 'Employee Raise dossier should cover every primary question.');
assert.equal(dossiers.manager.primaryQuestionAnswers.length, foundation.topic.primaryQuestions.length, 'Manager Raise dossier should cover every primary question.');

console.log('Raise smoke validation passed.');
console.log(JSON.stringify({
  topic: foundation.topic.caseType,
  questions: foundation.topic.primaryQuestions.length,
  scenarios: foundation.alignmentScenarios.scenarios.length,
  behaviorsPerActor: requestorPlan.length,
  dossierQuestions: dossiers.employee.primaryQuestionAnswers.length
}, null, 2));

function withoutActor({ actor, ...rest }) {
  return rest;
}

async function offlineCompletion(_llm, request) {
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
        reason: 'Offline smoke audit passed.'
      })),
      questionChecks: input.topic.primaryQuestions.map((question) => ({
        primaryQuestionId: question.id,
        openingsPresent: true,
        relationshipMatchesPlan: true,
        plainLanguage: true,
        reason: 'Offline smoke audit passed.'
      }))
    };
  }

  const profile = {
    employeeName: 'the employee',
    employeeRole: 'Customer Support Specialist',
    organizationContext: 'Support team',
    reviewPeriod: 'Annual review period',
    responsibilities: ['Handle customer escalations', 'Maintain support reports', 'Train new team members'],
    goals: ['Improve response time', 'Reduce overdue follow-ups', 'Support onboarding'],
    sharedEvents: [{ id: 'event-1', description: 'Improved support follow-up process.', evidence: ['Response time improved.'] }],
    metrics: [{ termId: input.topic.terms[0].id, name: 'Response time', baseline: 5, result: 3, standardExpectation: 4, stretchExpectation: 2, unit: 'days' }]
  };

  if (input.actor === 'neutral') {
    return {
      canonicalProfile: profile,
      termEvidence: input.topic.terms.map((term) => ({
        termId: term.id,
        objectiveFacts: [`Shared facts for ${term.label}.`],
        favorableEvidence: [`Strong evidence for ${term.label}.`, `More support for ${term.label}.`],
        limitingEvidence: [`Limitation for ${term.label}.`, `Second limitation for ${term.label}.`],
        decisiveFavorableCase: { conclusionBasis: `High rating basis for ${term.label}.`, evidence: ['Exceeded target.', 'Helped team.'] },
        decisiveLimitingCase: { conclusionBasis: `Low rating basis for ${term.label}.`, evidence: ['Missed target.', 'Needed support.'] },
        attributionAmbiguity: ['Shared work.'],
        consistencyEvidence: ['Mixed pattern.'],
        independenceEvidence: ['Some manager support.']
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
        primaryQuestionId: requirement.primaryQuestionId,
        relevantTermIds: requirement.relevantTermIds,
        termRelationships: requirement.termRelationships,
        ratingDistance: requirement.ratingDistance,
        expectedRelationship: requirement.expectedRelationship,
        sharedFacts: ['The same compensation request is being discussed.', 'Both sides use the same work history.'],
        employeeOpeningStatement: 'I believe my request is strong.',
        managerOpeningStatement: 'I see major concerns with this request.',
        employeePosition: 'The employee sees the request as well supported.',
        managerPosition: 'The manager sees the request as poorly supported.',
        relationshipExplanation: 'The views differ because they weigh results and limits differently.'
      }))
    };
  }

  return {
    canonicalProfile: profile,
    executiveSummary: 'Short summary.',
    termPositions: input.assignedRatings.map((assignment) => ({
      termId: assignment.termId,
      ratingId: assignment.ratingId,
      conclusion: `${input.actor === 'employee' ? 'Employee' : 'Manager'} ${assignment.ratingLabel} conclusion for ${assignment.term}.`,
      supportingFacts: ['Fact one.', 'Fact two.'],
      counterEvidence: ['Counter fact.'],
      counterEvidenceExplanation: 'Counter evidence does not change this view.',
      attribution: 'Shared attribution.',
      consistency: 'Mixed consistency.',
      independence: 'Some independence.'
    })),
    primaryQuestionAnswers: input.topic.primaryQuestions.map((question) => ({
      primaryQuestionId: question.id,
      answer: `${input.actor === 'employee' ? 'I believe my request is strong.' : 'I see major concerns with this request.'} This answer uses the raise facts and explains the view.`
    }))
  };
}

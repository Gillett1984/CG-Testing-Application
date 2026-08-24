// Offline check of the actor-perspective contract used by the response judge.
//
// Regression target: run 2026-08-10T05-01-20-108Z failed with a false off-target
// rejection. actorPerspective was employee_self_assessment (Raise, requestor =
// employee) and the response was correctly first person, but the judge demanded a
// manager/third-person voice. This script verifies, without calling OpenAI:
//
//   1. domainRoleForActor/perspectiveForDomainRole map both topics correctly.
//   2. The contract handed to the judge states the employee case as forcefully as
//      the manager case, and never asks employee_self_assessment for third person.
//   3. detectPerspectiveViolation is symmetric: correct voices pass, real swaps fail.
//   4. guardPerspectiveVerdict overturns the exact false rejection from that run.
//
// Usage: node scripts/validatePerspectiveContract.js

import {
  actorPerspectiveContract,
  classifyResponseVoice,
  detectPerspectiveViolation,
  validateScenarioResponse
} from '../src/llmResponder.js';
import { domainRoleForActor, perspectiveForDomainRole } from '../src/roleMapping.js';

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Real responses from the failing run (employee side) and its manager mirror.
const EMPLOYEE_FIRST_PERSON = "I suggest a one-off bonus of about 5% of my current salary to bridge the gap this cycle, payable with the next payroll. Alternatively, the raise could be split across two reviews: an immediate 6% increase effective next quarter, with the remaining 6% granted at the following annual review. For performance triggers, I propose tying the remaining raise portion to achieving specific renewal and churn targets.";
const MANAGER_THIRD_PERSON = "The employee's renewal results support a phased increase. I would fund a one-off bonus this cycle, then release the remainder at the next review once the employee holds churn below the agreed target. Their performance on the two enterprise accounts justifies the timing.";
const EMPLOYEE_SPEAKING_AS_MANAGER = "The employee has met their renewal target and their performance justifies the request. The employee's development plan is on track and they need continued support on the enterprise book.";
const MANAGER_SPEAKING_AS_EMPLOYEE = "My performance this year was strong. I exceeded my renewal target and I need a raise because my role expanded and my manager agreed the scope changed.";

console.log('=== 1. Role mapping per topic ===');
check('All topics (requestor=manager): requestor -> manager_evaluating_employee',
  perspectiveForDomainRole(domainRoleForActor('requestor', 'manager')) === 'manager_evaluating_employee');
check('All topics (requestor=manager): participant -> employee_self_assessment',
  perspectiveForDomainRole(domainRoleForActor('participant', 'manager')) === 'employee_self_assessment');

console.log('\n=== 2. Judge contract wording ===');
const employeeContract = actorPerspectiveContract('employee_self_assessment');
const managerContract = actorPerspectiveContract('manager_evaluating_employee');
check('employee contract requires first person',
  /first person/i.test(employeeContract.requiredGrammaticalPerson), employeeContract.requiredGrammaticalPerson);
check('employee contract does NOT request third person',
  !/third person/i.test(employeeContract.requiredGrammaticalPerson));
check('employee contract marks first-person self-description as correct',
  employeeContract.firstPersonAboutOwnWorkIsCorrect === true);
check('employee contract forbids demanding a manager voice',
  /never ask it to speak as a manager/i.test(employeeContract.note), employeeContract.note);
check('manager contract requires third person',
  /third person/i.test(managerContract.requiredGrammaticalPerson), managerContract.requiredGrammaticalPerson);
check('manager contract marks first-person self-description as incorrect',
  managerContract.firstPersonAboutOwnWorkIsCorrect === false);
check('both contracts carry an equally explicit "never fail for" note',
  /never fail/i.test(employeeContract.note) && /never fail/i.test(managerContract.note));

console.log('\n=== 3. Symmetric perspective detection ===');
check('employee_self_assessment + first person -> no violation',
  detectPerspectiveViolation('employee_self_assessment', EMPLOYEE_FIRST_PERSON) === null,
  JSON.stringify(classifyResponseVoice(EMPLOYEE_FIRST_PERSON)));
check('manager_evaluating_employee + third person -> no violation',
  detectPerspectiveViolation('manager_evaluating_employee', MANAGER_THIRD_PERSON) === null,
  JSON.stringify(classifyResponseVoice(MANAGER_THIRD_PERSON)));
check('employee_self_assessment + manager voice -> violation',
  detectPerspectiveViolation('employee_self_assessment', EMPLOYEE_SPEAKING_AS_MANAGER) !== null);
check('manager_evaluating_employee + employee voice -> violation',
  detectPerspectiveViolation('manager_evaluating_employee', MANAGER_SPEAKING_AS_EMPLOYEE) !== null);

console.log('\n=== 4. Scenario-level validator (no scenarioTurn behaviors) ===');
const employeeScenarioInput = {
  actorRole: 'requestor',
  requestorRole: 'employee',
  actorPerspective: 'employee_self_assessment',
  turnClassification: { isPrimaryQuestionTurn: false, isFollowUpTurn: true },
  scenarioTurn: { behaviors: [], scenarioContext: { terms: [] } }
};
const managerScenarioInput = {
  ...employeeScenarioInput,
  actorRole: 'participant',
  actorPerspective: 'manager_evaluating_employee'
};
check('scenario validator accepts first-person employee follow-up',
  validateScenarioResponse(employeeScenarioInput, EMPLOYEE_FIRST_PERSON).pass === true,
  validateScenarioResponse(employeeScenarioInput, EMPLOYEE_FIRST_PERSON).reason ?? '');
check('scenario validator accepts third-person manager follow-up',
  validateScenarioResponse(managerScenarioInput, MANAGER_THIRD_PERSON).pass === true,
  validateScenarioResponse(managerScenarioInput, MANAGER_THIRD_PERSON).reason ?? '');
check('scenario validator rejects manager speaking as employee',
  validateScenarioResponse(managerScenarioInput, MANAGER_SPEAKING_AS_EMPLOYEE).pass === false);
check('scenario validator rejects employee speaking as manager',
  validateScenarioResponse(employeeScenarioInput, EMPLOYEE_SPEAKING_AS_MANAGER).pass === false);

console.log('\n=== 5. False-rejection guard (regression: 2026-08-10T05-01-20-108Z) ===');
// Reproduce the judge verdict that killed the run, then confirm the guard overturns it.
// guardPerspectiveVerdict is internal; exercise it through the same inputs it receives.
const { guardPerspectiveVerdictForTest } = await import('../src/llmResponder.js')
  .then((mod) => ({ guardPerspectiveVerdictForTest: mod.guardPerspectiveVerdictForTest }));
const badVerdict = {
  pass: false,
  reason: "The response discusses the employee's own compensation and performance triggers in first person, which is inconsistent with the actorPerspective 'employee_self_assessment' and the scenario context. The response should be from a manager evaluating the employee, discussing the employee's performance or compensation in third person.",
  correction: 'Rewrite from the manager perspective.'
};
const guarded = guardPerspectiveVerdictForTest(badVerdict, employeeScenarioInput, EMPLOYEE_FIRST_PERSON);
check('false perspective rejection is overturned', guarded.pass === true, guarded.reason);
check('override is recorded as a soft warning',
  (guarded.warnings ?? []).some((w) => w.type === 'perspective_verdict_override'));

const genuineVerdict = {
  pass: false,
  reason: 'The response speaks as the employee in first person instead of the manager perspective required.',
  correction: 'Rewrite from the manager perspective.'
};
const notGuarded = guardPerspectiveVerdictForTest(genuineVerdict, managerScenarioInput, MANAGER_SPEAKING_AS_EMPLOYEE);
check('genuine perspective rejection is NOT overturned', notGuarded.pass === false);

const nonPerspectiveVerdict = {
  pass: false,
  reason: 'The response is cut off mid-sentence and does not answer the latest Partner AI prompt.',
  correction: 'Answer the prompt completely.'
};
const untouched = guardPerspectiveVerdictForTest(nonPerspectiveVerdict, employeeScenarioInput, EMPLOYEE_FIRST_PERSON);
check('non-perspective rejection is left alone', untouched.pass === false);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

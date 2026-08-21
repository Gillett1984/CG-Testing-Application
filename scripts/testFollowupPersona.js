// Cheap isolated check for the persona-drift fix: simulate a follow-up turn in
// scripted mode (scenarioTurn = null) with a transcript that already contains the
// scripted "Controller" answer, and confirm the LLM follow-up stays on that
// persona instead of inventing a new role. One OpenAI call, no browser.
import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { generatePartnerAiResponse } from '../src/llmResponder.js';
import { extractPromptContext } from '../src/promptContext.js';

const config = loadConfig(['--config', 'config/performance-review-evaluation-scripted.json']);

const q1Prompt = 'During this review period, what role responsibilities, priorities, and expectations should your performance be evaluated against?';
const scriptedEmployeeAnswer = "As Controller, my role during this quarter was to manage the accounting function, oversee the monthly close, ensure the accuracy of the financial statements, and support the CFO. My responsibilities included supervising the accounting team, reviewing reconciliations, and monitoring close progress.";
const followupPrompt = 'Thank you. Could you go a bit deeper on which of those responsibilities consumed most of your time, and were there any temporary projects or expanded scope this period?';

const transcript = [
  { role: 'partnerAi', turn: 1, text: q1Prompt, promptContext: extractPromptContext(q1Prompt) },
  { role: 'syntheticUser', turn: 1, text: scriptedEmployeeAnswer, responseSource: 'scripted' },
  { role: 'partnerAi', turn: 2, text: followupPrompt, promptContext: extractPromptContext(followupPrompt) }
];

const context = {
  actorRole: 'participant',
  topic: config.run.topic,
  testBehaviorPolicy: config.run.testBehaviorPolicy,
  qualityCriteria: config.run.qualityCriteria,
  activeManeuver: null,
  scenarioTurn: null, // scripted-mode follow-up: no dossier persona
  scriptedMode: true, // participant = manager (third person)
  latestPrompt: followupPrompt,
  transcript,
  turn: 2,
  llm: config.llm
};

console.log('Generating scripted-mode follow-up (scenarioTurn=null)...\n');
const response = await generatePartnerAiResponse(context);
console.log('--- FOLLOW-UP RESPONSE ---\n' + response + '\n');
const onPersona = /controller|accounting|close|cfo|reconciliation/i.test(response);
const drifted = /innovation catalyst|futurtech|product development/i.test(response);
const firstPerson = /\b(I|I'm|my|me|myself|we|our)\b/.test(response);
const thirdPersonEmployee = /\bthe employee\b/i.test(response);
console.log('Mentions Controller/accounting persona:', onPersona);
console.log('Drifted to a dossier persona:', drifted);
console.log('First person (employee self-assessment):', firstPerson);
console.log('Uses third-person "the employee":', thirdPersonEmployee);
console.log(onPersona && !drifted && firstPerson && !thirdPersonEmployee
  ? '\nPASS: on-persona AND first-person employee self-assessment.'
  : '\nCHECK: review the response above.');

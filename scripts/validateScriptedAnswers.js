// Validates a scripted-answers file WITHOUT a live browser run:
//   1. Schema + topic cross-check (unknown ids, missing sides).
//   2. Dry-run the question matcher against each topic primary question, both
//      verbatim (employee voice) and as a third-person paraphrase (manager
//      voice), to confirm each live prompt would resolve to the correct id.
//
// Usage:
//   node scripts/validateScriptedAnswers.js [scriptedAnswersPath] [topicPath]
// Defaults: the example answers file + the performance-review-coaching topic.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { topicDefinitionSchema } from '../src/scenarioSchemas.js';
import { loadScriptedAnswers, validateScriptedAnswersAgainstTopic } from '../src/scriptedAnswers.js';
import { matchScenarioQuestionScored } from '../src/questionMatching.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptedAnswersPath = process.argv[2] ?? 'config/scripted-answers/performance-review-coaching.example.json';
const topicPath = process.argv[3] ?? 'config/case-types/performance-review-coaching.json';

function loadTopic(relativePath) {
  const resolved = path.resolve(rootDir, relativePath);
  return topicDefinitionSchema.parse(JSON.parse(fs.readFileSync(resolved, 'utf8')));
}

// Crude third-person rewrite to simulate the (unknown) manager prompt wording.
function toManagerVoice(text) {
  return String(text ?? '')
    .replace(/\byou['’]re\b/gi, 'the employee is')
    .replace(/\byourself\b/gi, 'themselves')
    .replace(/\byour\b/gi, "the employee's")
    .replace(/\byou\b/gi, 'the employee');
}

const topic = loadTopic(topicPath);
const scripted = loadScriptedAnswers(rootDir, scriptedAnswersPath);
const { errors, warnings } = validateScriptedAnswersAgainstTopic(scripted, topic);

console.log('=== Scripted-answers validation ===');
console.log('answers file :', scriptedAnswersPath);
console.log('topic        :', topicPath, `(${topic.topicId})`);
console.log('answers       :', scripted.answers.length, 'of', topic.primaryQuestions.length, 'primary questions\n');

let matchFailures = 0;
console.log('--- matcher dry-run (employee verbatim / manager paraphrase) ---');
for (const question of topic.primaryQuestions) {
  for (const [voice, text] of [['employee', question.question], ['manager', toManagerVoice(question.question)]]) {
    const promptContext = { primaryQuestion: text, activeQuestion: text, discussionArea: question.discussionArea };
    const { question: matched, score } = matchScenarioQuestionScored(topic, promptContext);
    const ok = matched?.id === question.id;
    if (!ok) matchFailures++;
    console.log(`  [${ok ? 'OK ' : 'FAIL'}] ${voice.padEnd(8)} score=${score.toFixed(2)} -> ${matched?.id ?? '(no match)'}  (expected ${question.id})`);
  }
}

if (warnings.length) {
  console.log('\n--- warnings ---');
  for (const w of warnings) console.log('  -', w);
}
if (errors.length) {
  console.log('\n--- errors ---');
  for (const e of errors) console.log('  -', e);
}

const failed = errors.length > 0 || matchFailures > 0;
console.log(`\nResult: ${failed ? 'FAILED' : 'OK'} (${errors.length} errors, ${matchFailures} match failures, ${warnings.length} warnings)`);
process.exit(failed ? 1 : 0);

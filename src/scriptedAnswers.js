import fs from 'node:fs';
import path from 'node:path';
import { scriptedAnswersSchema } from './scenarioSchemas.js';
import { domainRoleForActor } from './roleMapping.js';

// Loads and validates a scripted-answers file (see scriptedAnswersSchema).
// Returns the parsed object, or throws on malformed JSON / schema failure.
export function loadScriptedAnswers(rootDir, relativePath) {
  const resolvedPath = path.resolve(rootDir, relativePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Scripted answers file was not found: ${resolvedPath}`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    throw new Error(`Scripted answers file is not valid JSON (${relativePath}): ${error.message}`);
  }
  return scriptedAnswersSchema.parse(raw);
}

// Scripted-answer files are keyed by domain role (`employee` / `manager`), which is
// invariant to who created the case. Which actor speaks each answer depends on the
// per-topic requestorRole: the redesigned Common Ground creates Performance Review from
// the manager's side (requestor = manager), while a Raise is employee-initiated
// (requestor = employee). The routing lives in src/roleMapping.js.
function actorAnswerKey(actorRole, requestorRole) {
  return domainRoleForActor(actorRole, requestorRole); // 'employee' | 'manager'
}

// Returns the scripted answer string for an actor + primary question, or null
// when no answer is scripted for that side (caller then falls back to the LLM).
export function pickScriptedAnswer(scriptedAnswers, primaryQuestionId, actorRole, requestorRole) {
  if (!scriptedAnswers || !primaryQuestionId) return null;
  const entry = scriptedAnswers.answers.find((item) => item.primaryQuestionId === primaryQuestionId);
  if (!entry) return null;
  return entry[actorAnswerKey(actorRole, requestorRole)] ?? null;
}

// Cross-checks a scripted-answers file against a topic definition. Returns
// { errors, warnings } as string arrays. Errors are blocking; warnings are
// advisory (e.g. a primary question with no scripted answer falls back to LLM).
export function validateScriptedAnswersAgainstTopic(scriptedAnswers, topic) {
  const errors = [];
  const warnings = [];

  if (scriptedAnswers.topicId !== topic.topicId) {
    warnings.push(`Scripted answers topicId "${scriptedAnswers.topicId}" does not match topic "${topic.topicId}".`);
  }

  const topicQuestionIds = new Set(topic.primaryQuestions.map((question) => question.id));
  const scriptedQuestionIds = new Set();

  for (const entry of scriptedAnswers.answers) {
    scriptedQuestionIds.add(entry.primaryQuestionId);
    if (!topicQuestionIds.has(entry.primaryQuestionId)) {
      errors.push(`Scripted answer references unknown primary question: ${entry.primaryQuestionId}`);
      continue;
    }
    if (!entry.employee) warnings.push(`No employee (requestor) answer for ${entry.primaryQuestionId}; that side will use the LLM responder.`);
    if (!entry.manager) warnings.push(`No manager (participant) answer for ${entry.primaryQuestionId}; that side will use the LLM responder.`);
  }

  for (const question of topic.primaryQuestions) {
    if (!scriptedQuestionIds.has(question.id)) {
      warnings.push(`Primary question has no scripted answer: ${question.id} (both actors will use the LLM responder).`);
    }
  }

  return { errors, warnings };
}

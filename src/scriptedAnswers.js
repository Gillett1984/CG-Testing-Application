import fs from 'node:fs';
import path from 'node:path';
import { scriptedAnswersSchema } from './scenarioSchemas.js';

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

// In the live Common Ground performance-review flow the invited participant is
// the Employee being reviewed (first-person self-evaluation) and the requestor
// who created the case is the Manager (third-person assessment). So the
// participant speaks with the employee answer and the requestor with the manager
// answer.
function actorAnswerKey(actorRole, actorPersona = null) {
  if (actorPersona === 'employee' || actorPersona === 'manager') return actorPersona;
  return actorRole === 'participant' ? 'employee' : 'manager';
}

// Returns the scripted answer string for an actor + primary question, or null
// when no answer is scripted for that side (caller then falls back to the LLM).
export function pickScriptedAnswer(scriptedAnswers, primaryQuestionId, actorRole, actorPersona = null) {
  if (!scriptedAnswers || !primaryQuestionId) return null;
  const entry = scriptedAnswers.answers.find((item) => item.primaryQuestionId === primaryQuestionId);
  if (!entry) return null;
  return entry[actorAnswerKey(actorRole, actorPersona)] ?? null;
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

// Pure text-matching helpers shared by the interview engine
// (src/commonGroundAutomation.js) and the scripted-answers validator
// (scripts/validateScriptedAnswers.js). No browser/LLM dependencies so it can be
// imported from lightweight tooling.

export function textSimilarity(left, right) {
  const leftTokens = new Set(significantTextTokens(left));
  const rightTokens = new Set(significantTextTokens(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const matches = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return matches / Math.min(leftTokens.size, rightTokens.size);
}

export function significantTextTokens(value) {
  const stop = new Set(['what', 'when', 'where', 'which', 'would', 'could', 'should', 'your', 'their', 'with', 'that', 'this', 'from', 'have', 'been', 'into', 'about', 'please', 'cover']);
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((token) => token.length > 3 && !stop.has(token));
}

export function matchScenarioQuestion(topic, promptContext) {
  const result = matchScenarioQuestionScored(topic, promptContext);
  return result?.question ?? null;
}

// Like matchScenarioQuestion but also returns the winning similarity score, so
// callers (e.g. scripted-answers diagnostics) can record match confidence.
export function matchScenarioQuestionScored(topic, promptContext, threshold = 0.34) {
  const primaryMatch = bestQuestionMatch(topic, promptContext.primaryQuestion);
  const activeMatch = bestQuestionMatch(topic, promptContext.activeQuestion);
  const discussionMatch = bestQuestionMatch(topic, promptContext.discussionArea);
  const activeDiffersFromSidebar = normalizeForCompare(promptContext.activeQuestion)
    !== normalizeForCompare(promptContext.primaryQuestion);

  // The live page can leave Details & Guidance open on a previous sidebar
  // question while the latest Partner AI chat message has already advanced.
  // Prefer a strong latest-message match over stale sidebar text in that case.
  if (activeDiffersFromSidebar && activeMatch.score >= Math.max(threshold, 0.5)) {
    return { question: activeMatch.question, score: activeMatch.score, source: 'activeQuestion' };
  }

  const matches = [
    { ...primaryMatch, source: 'primaryQuestion' },
    { ...activeMatch, source: 'activeQuestion' },
    { ...discussionMatch, source: 'discussionArea' }
  ];
  const best = matches.reduce((winner, current) => (current.score > winner.score ? current : winner), matches[0]);
  return best.score >= threshold
    ? { question: best.question, score: best.score, source: best.source }
    : { question: null, score: best.score, source: best.source };
}

function bestQuestionMatch(topic, candidate) {
  if (!candidate) return { question: null, score: 0 };
  let best = null;
  let bestScore = 0;
  for (const question of topic.primaryQuestions) {
    const values = [
      question.question,
      question.discussionArea,
      ...(question.highQualityCriteria ?? []).map((criterion) => criterion.requirement)
    ].filter(Boolean);
    const score = Math.max(...values.map((value) => textSimilarity(candidate, value)));
    if (score > bestScore) {
      best = question;
      bestScore = score;
    }
  }
  return { question: best, score: bestScore };
}

function normalizeForCompare(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function matchScenarioCriterion(question, activeQuestion) {
  if (!activeQuestion) return null;
  let best = null;
  let bestScore = 0;
  for (const criterion of question.highQualityCriteria) {
    const score = textSimilarity(activeQuestion, criterion.requirement);
    if (score > bestScore) {
      best = criterion;
      bestScore = score;
    }
  }
  return bestScore >= 0.28 ? best : null;
}

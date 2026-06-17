export function extractPromptContext(rawText) {
  const text = normalizeText(rawText);
  const discussionArea = matchLast(text, /Current Discussion Area:\s*([\s\S]*?)\s*Request type:/gi);
  const primaryQuestion = matchLast(text, /Current Primary Question:\s*([\s\S]*?)\s*Answer Guidance:/gi);
  const latestPartnerTurn = extractLatestPartnerTurn(text);
  const answerGuidance = extractAnswerGuidance(text, latestPartnerTurn);
  const followUpQuestion = extractLatestFollowUpQuestion(latestPartnerTurn, primaryQuestion);
  const activeQuestion = followUpQuestion
    || primaryQuestion
    || extractPromptStatement(latestPartnerTurn)
    || extractLastQuestion(latestPartnerTurn);

  return {
    discussionArea,
    primaryQuestion,
    answerGuidance,
    followUpQuestion,
    latestPartnerTurn,
    activeQuestion,
    compactPrompt: [
      discussionArea ? `Discussion Area: ${discussionArea}` : null,
      primaryQuestion ? `Primary Question: ${primaryQuestion}` : null,
      answerGuidance.length ? `Answer Guidance: ${answerGuidance.join('; ')}` : null,
      latestPartnerTurn ? `Latest Partner AI Turn: ${latestPartnerTurn}` : null,
      followUpQuestion ? `Latest Follow-Up: ${followUpQuestion}` : null
    ].filter(Boolean).join('\n')
  };
}

function normalizeText(text) {
  return String(text ?? '')
    .replaceAll('\u00c3\u00a2\u00e2\u201a\u00ac\u00c2\u00a2', '-')
    .replaceAll('\u00e2\u20ac\u00a2', '-')
    .replaceAll('\u2022', '-')
    .replaceAll('\u00c3\u00b0\u00c5\u00b8\u00e2\u20ac\u009d\u00c2\u008d', '')
    .replaceAll('\u00c3\u00b0\u00c5\u00b8\u00e2\u20ac\u2122\u00c2\u00a1', '')
    .replaceAll('\u00c3\u00b0\u00c5\u00b8\u00e2\u20ac\u0153\u00c5\u00a0', '')
    .replaceAll('\u00c3\u00b0\u00c5\u00b8\u00e2\u20ac\u0153\u00cb\u2020', '')
    .replace(/\r/g, '')
    .trim();
}

function matchLast(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[1].trim()).at(-1) ?? '';
}

function extractAnswerGuidance(text, latestPartnerTurn = '') {
  const guidance = matchLast(text, /Answer Guidance:\s*([\s\S]*?)\s*Case ID:/gi)
    || matchLast(latestPartnerTurn, /Please cover:\s*([\s\S]*)$/gi);
  if (!guidance) return [];

  const lines = guidance.includes('\n')
    ? guidance.split(/\n+/)
    : guidance.split(/\s+-\s+/);

  return lines
    .map((item) => item.trim().replace(/^[-\u2022\u00e2\u20ac\u00a2]\s*/, '').trim())
    .filter((item) => item && !/^[-\u2022\u00e2\u20ac\u00a2]$/.test(item))
    .slice(0, 8);
}

function extractLatestFollowUpQuestion(text, primaryQuestion) {
  const guidanceIndex = text.search(/\bPlease cover:/i);
  const questionPatterns = [
    /\b(Can you[\s\S]{0,600}?\?)/gi,
    /\b(Could you[\s\S]{0,600}?\?)/gi,
    /\b(Please (?:provide|explain|describe|share)[\s\S]{0,600}?\?)/gi,
    /\b(What [\s\S]{0,600}?\?)/gi,
    /\b(Why [\s\S]{0,600}?\?)/gi,
    /\b(How [\s\S]{0,600}?\?)/gi,
    /\b(If [\s\S]{0,600}?\?)/gi
  ];

  const matches = questionPatterns
    .flatMap((pattern) => {
      return [...text.matchAll(pattern)].map((match) => ({
        question: match[1].trim(),
        index: match.index ?? 0
      }));
    })
    .filter((match) => guidanceIndex < 0 || match.index < guidanceIndex)
    .filter((match) => !isSyntheticUserQuestion(match.question))
    .filter((match) => normalizeForCompare(match.question) !== normalizeForCompare(primaryQuestion))
    .sort((a, b) => a.index - b.index);

  return matches.at(-1)?.question ?? extractTrailingQuestionLikePrompt(text, primaryQuestion);
}

function extractLatestPartnerTurn(text) {
  const latestAfterQualityBlock = extractAfterLastQualityBlock(text);
  if (latestAfterQualityBlock) return latestAfterQualityBlock;

  const markers = [
    'Current Discussion Area:',
    'Current Primary Question:',
    'Answer Guidance:',
    'Case ID:'
  ];
  const lastMarker = markers
    .map((marker) => text.lastIndexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => b - a)
    .at(0);

  if (lastMarker < 0 || lastMarker === undefined) return text;

  return text.slice(lastMarker).trim();
}

function extractAfterLastQualityBlock(text) {
  const qualityBlockPattern = /QFI:\s*[^\n]+(?:\n+\d{1,2}:\d{2}\s*(?:AM|PM)?)?/gi;
  const matches = [...text.matchAll(qualityBlockPattern)];
  const lastMatch = matches.at(-1);
  if (!lastMatch) return '';

  const start = (lastMatch.index ?? 0) + lastMatch[0].length;
  const candidate = text.slice(start).trim();
  if (!candidate || /^Current Discussion Area:/i.test(candidate)) return '';

  return candidate;
}

function extractLastQuestion(text) {
  const matches = [...text.matchAll(/([^.!?\n][^?\n]{12,700}\?)/g)].map((match) => match[1].trim());
  return matches.filter((question) => !isSyntheticUserQuestion(question)).at(-1)
    ?? extractTrailingQuestionLikePrompt(text, '');
}

function extractPromptStatement(text) {
  const cleaned = String(text ?? '').trim();
  const beforeGuidance = cleaned.split(/\bPlease cover:/i)[0]?.trim() ?? '';
  const sentences = [...beforeGuidance.matchAll(/(^|[\n.!?]\s+)([A-Z][^.!?\n]{8,240}\.)/g)]
    .map((match) => match[2].trim())
    .filter((sentence) => !isChromeOrStatusText(sentence));

  return sentences.at(-1)?.replace(/[.]+$/g, '') ?? '';
}

function extractTrailingQuestionLikePrompt(text, primaryQuestion) {
  const cleaned = String(text ?? '').split(/\bPlease cover:/i)[0].trim();
  const markers = [
    /Now,\s*back to where we were:\s*([\s\S]{15,500})$/i,
    /\b((?:Can|Could|What|Why|How|If)\s+[\s\S]{15,500})$/i
  ];

  for (const pattern of markers) {
    const match = cleaned.match(pattern);
    const candidate = match?.[1]?.trim().replace(/\s+/g, ' ');
    if (!candidate) continue;
    if (isSyntheticUserQuestion(candidate)) continue;
    if (normalizeForCompare(candidate) === normalizeForCompare(primaryQuestion)) continue;
    return candidate.endsWith('?') ? candidate : `${candidate}?`;
  }

  return '';
}

function isSyntheticUserQuestion(question) {
  return /would you like|if you would like|would you like me to|could you please clarify|could you please specify|what specific details|help you structure|help you organize|i recommend/i.test(question);
}

function isChromeOrStatusText(sentence) {
  return /^(Dashboard|Account|Notifications|Step:|Topic:|Case |Details & Guidance|QFI:|Intent:|Captured:|QoR:|Total QoR:)/i.test(sentence);
}

function normalizeForCompare(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s%]/g, '').trim();
}

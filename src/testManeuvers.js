import { extractPromptContext } from './promptContext.js';

export function findActiveManeuver({ latestPrompt, run, seed }) {
  const promptContext = extractPromptContext(latestPrompt);
  const testManeuvers = run.testManeuvers ?? [];
  run.policyState ??= { usedResponses: [], targetCriterionStep: 0 };

  const maneuver = testManeuvers.find((item) => matchesManeuver(item, promptContext));
  if (maneuver) return stripExactResponse({ ...maneuver, promptContext });

  const policyManeuver = buildPolicyManeuver({
    promptContext,
    testBehaviorPolicy: run.testBehaviorPolicy,
    qualityCriteria: run.qualityCriteria,
    seed,
    policyState: run.policyState
  });

  return policyManeuver ? stripExactResponse({ ...policyManeuver, promptContext }) : null;
}

export function buildManeuverFallbackResponse({ activeManeuver, latestPrompt }) {
  throw new Error('Hardcoded maneuver fallback responses have been disabled. Configure OPENAI_API_KEY so responses are generated from the latest Partner AI prompt.');
}

function stripExactResponse(maneuver) {
  if (!maneuver?.response) return maneuver;

  const { response, ...rest } = maneuver;
  return {
    ...rest,
    responseDirective: buildResponseDirective(maneuver)
  };
}

function buildResponseDirective(maneuver) {
  return [
    maneuver.userIntent ? `User intent: ${maneuver.userIntent}` : null,
    maneuver.responseStyle ? `Response style: ${maneuver.responseStyle}` : null,
    maneuver.successExpectation ? `Expected Partner AI behavior: ${maneuver.successExpectation}` : null,
    'Generate fresh wording from the latest Partner AI prompt. Do not reuse stored example text.'
  ].filter(Boolean).join(' ');
}

export function evaluateManeuverSuccess({ latestPrompt, activeManeuver }) {
  if (!activeManeuver) return { matched: false };

  const text = latestPrompt.toLowerCase();
  const expectation = `${activeManeuver.successExpectation ?? ''} ${activeManeuver.userIntent ?? ''} ${activeManeuver.responseStyle ?? ''}`.toLowerCase();
  const successSignals = activeManeuver.successSignals ?? inferredSuccessSignals(expectation);

  const matchedSignal = successSignals.find((signal) => text.includes(String(signal).toLowerCase()));
  if (!matchedSignal) {
    return { matched: false };
  }

  return {
    matched: true,
    reason: `Maneuver success observed: ${activeManeuver.name ?? activeManeuver.userIntent ?? 'Unnamed maneuver'} (${matchedSignal}).`
  };
}

function matchesManeuver(maneuver, promptContext) {
  const when = maneuver.when ?? {};
  const area = promptContext.discussionArea.toLowerCase();
  const question = `${promptContext.primaryQuestion} ${promptContext.activeQuestion}`.toLowerCase();

  if (when.discussionArea && !area.includes(String(when.discussionArea).toLowerCase())) {
    return false;
  }

  if (when.questionContains && !question.includes(String(when.questionContains).toLowerCase())) {
    return false;
  }

  if (when.activeQuestionContains && !question.includes(String(when.activeQuestionContains).toLowerCase())) {
    return false;
  }

  return Boolean(when.discussionArea || when.questionContains || when.activeQuestionContains);
}

function buildPolicyManeuver({ promptContext, testBehaviorPolicy, qualityCriteria, seed, policyState }) {
  if (!testBehaviorPolicy) return null;

  const policy = testBehaviorPolicy.toLowerCase();
  if (isStagedPolicy(testBehaviorPolicy)) {
    const stagedManeuver = buildStagedPolicyManeuver({
      promptContext,
      testBehaviorPolicy,
      qualityCriteria,
      seed,
      policyState
    });
    if (stagedManeuver) return stagedManeuver;
  }

  const quotedTargets = [...testBehaviorPolicy.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const targetMatched = quotedTargets.length === 0
    ? true
    : quotedTargets.some((target) => promptMatchesTarget(promptContext, qualityCriteria, target));

  if (!targetMatched) {
    const response = buildPreTargetHighQualityResponse(promptContext, testBehaviorPolicy);
    if (response) {
      return {
        name: 'Policy: Pre-target high-quality answer',
        source: 'testBehaviorPolicy',
        userIntent: 'Answer with a high-quality response until the target question is reached.',
        responseStyle: 'high-quality-answer',
        responseDirective: response,
        successExpectation: 'Partner AI accepts the answer and advances toward the target question.',
        stopAfterSuccess: false
      };
    }

    return null;
  }

  if (isSingleCriterionPolicy(testBehaviorPolicy)) {
    const response = buildSingleMandatoryCriterionResponse({
      promptContext,
      testBehaviorPolicy,
      seed,
      policyState
    });

    if (response) {
      return {
        name: 'Policy: One mandatory criterion at a time',
        source: 'testBehaviorPolicy',
        userIntent: 'Answer with only one mandatory criterion at a time for the target primary question.',
        responseStyle: 'partial-answer',
        responseDirective: response,
        successExpectation: 'Partner AI asks follow-up questions for missing mandatory criteria until moving to the next primary question.',
        stopAfterSuccess: false
      };
    }
  }

  if (/clarification|clarify/.test(policy)) {
    if (isQuestionActionScopedToPrimaryOnly(testBehaviorPolicy)) {
      if (!isCurrentPrimaryQuestionTurn(promptContext, qualityCriteria)) return null;
      if (hasQuestionActionAlreadyRun(policyState, promptContext, qualityCriteria, 'clarification')) return null;
      markQuestionActionRun(policyState, promptContext, qualityCriteria, 'clarification');
    }

    return {
      name: 'Policy: Ask for clarification',
      source: 'testBehaviorPolicy',
      userIntent: 'Ask Partner AI to clarify the current question before answering.',
      responseStyle: 'question',
      responseDirective: buildQuestionDirective('clarification'),
      successExpectation: 'Partner AI provides a clarification response.',
      successSignals: inferredSuccessSignals('clarification'),
      stopAfterSuccess: /stop|do not answer any more|do not continue/i.test(testBehaviorPolicy)
    };
  }

  if (/example/.test(policy)) {
    if (isQuestionActionScopedToPrimaryOnly(testBehaviorPolicy)) {
      if (!isCurrentPrimaryQuestionTurn(promptContext, qualityCriteria)) return null;
      if (hasQuestionActionAlreadyRun(policyState, promptContext, qualityCriteria, 'example')) return null;
      markQuestionActionRun(policyState, promptContext, qualityCriteria, 'example');
    }

    return {
      name: 'Policy: Ask for example',
      source: 'testBehaviorPolicy',
      userIntent: 'Ask Partner AI for an example before answering.',
      responseStyle: 'question',
      responseDirective: buildQuestionDirective('example'),
      successExpectation: 'Partner AI provides an example.',
      successSignals: inferredSuccessSignals('example'),
      stopAfterSuccess: /stop|do not answer any more|do not continue/i.test(testBehaviorPolicy)
    };
  }

  if (/definition|define|meaning|term|phrase/.test(policy)) {
    if (isQuestionActionScopedToPrimaryOnly(testBehaviorPolicy)) {
      if (!isCurrentPrimaryQuestionTurn(promptContext, qualityCriteria)) return null;
      if (hasQuestionActionAlreadyRun(policyState, promptContext, qualityCriteria, 'definition')) return null;
      markQuestionActionRun(policyState, promptContext, qualityCriteria, 'definition');
    }

    return {
      name: 'Policy: Ask for definition',
      source: 'testBehaviorPolicy',
      userIntent: 'Ask Partner AI for a definition before answering.',
      responseStyle: 'question',
      responseDirective: buildQuestionDirective('definition'),
      successExpectation: 'Partner AI provides a definition.',
      successSignals: inferredSuccessSignals('definition'),
      stopAfterSuccess: /stop|do not answer any more|do not continue/i.test(testBehaviorPolicy)
    };
  }

  return null;
}

function isQuestionActionScopedToPrimaryOnly(testBehaviorPolicy) {
  return /primary questions?/i.test(testBehaviorPolicy)
    && /do not ask .*follow-up|follow-up questions?|each time .*primary question|when .*primary question|if .*primary question/i.test(testBehaviorPolicy);
}

function hasQuestionActionAlreadyRun(policyState, promptContext, qualityCriteria, action) {
  const key = questionActionKey(promptContext, qualityCriteria, action);
  return Boolean(key && policyState.questionActionsAsked?.[key]);
}

function markQuestionActionRun(policyState, promptContext, qualityCriteria, action) {
  const key = questionActionKey(promptContext, qualityCriteria, action);
  if (!key) return;
  policyState.questionActionsAsked ??= {};
  policyState.questionActionsAsked[key] = true;
}

function questionActionKey(promptContext, qualityCriteria, action) {
  const primaryQuestion = findPrimaryQuestion(promptContext, qualityCriteria);
  const question = primaryQuestion?.id || primaryQuestion?.question || promptContext.primaryQuestion || promptContext.activeQuestion;
  const normalizedQuestion = normalize(question);
  return normalizedQuestion ? `${action}:${normalizedQuestion}` : '';
}

function isCurrentPrimaryQuestionTurn(promptContext, qualityCriteria) {
  const activeQuestion = normalize(promptContext.activeQuestion);
  const primaryQuestion = normalize(promptContext.primaryQuestion);
  if (!qualityCriteria?.primaryQuestions?.length) {
    return Boolean(primaryQuestion || activeQuestion) && !looksLikeFollowUpOnly(promptContext);
  }

  return qualityCriteria.primaryQuestions.some((item) => {
    const configuredQuestion = normalize(item.question);
    if (!configuredQuestion) return false;
    return primaryQuestion.includes(configuredQuestion) || activeQuestion.includes(configuredQuestion);
  });
}

function looksLikeFollowUpOnly(promptContext) {
  const activeQuestion = normalize(promptContext.activeQuestion);
  const followUpQuestion = normalize(promptContext.followUpQuestion);
  if (!followUpQuestion) return false;
  return activeQuestion === followUpQuestion
    && /can|could|please|provide|share|explain|clarify|elaborate|specific|try crafting/.test(activeQuestion);
}

function isSingleCriterionPolicy(testBehaviorPolicy) {
  return /only one (?:of the )?mandatory criteria|one mandatory criteria|one mandatory criterion|exactly one\s*(?:\(?1\)?)?\s*(?:additional\s+)?mandatory criterion|exactly one\s*\(?1\)?\s*criterion|one\s*\(?1\)?\s*criterion/i.test(testBehaviorPolicy);
}

function isStagedPolicy(testBehaviorPolicy) {
  return /step\s*8|step\s*9|repeat steps/i.test(testBehaviorPolicy)
    && /clarification|clarify|example|definition|define/i.test(testBehaviorPolicy);
}

function isRaiseJustificationPrompt(promptContext) {
  const prompt = normalize([
    promptContext.discussionArea,
    promptContext.primaryQuestion,
    promptContext.activeQuestion,
    promptContext.followUpQuestion
  ].join(' '));

  return /raise justification|why do you believe this raise request is justified|compensation change is justified/.test(prompt);
}

function buildStagedPolicyManeuver({ promptContext, testBehaviorPolicy, qualityCriteria, seed, policyState }) {
  policyState.stagedPolicy ??= {
    phase: 'preTrigger',
    triggerCriteriaUsed: [],
    postQuestions: {},
    postQuestionActionIndex: 0,
    usedJustifications: []
  };

  const state = policyState.stagedPolicy;
  const atTrigger = isRaiseJustificationPrompt(promptContext)
    || matchesAnyQuotedTrigger(promptContext, testBehaviorPolicy, qualityCriteria);

  if (state.phase === 'preTrigger' && !atTrigger) {
    const response = buildPreTargetHighQualityResponse(promptContext, testBehaviorPolicy);
    if (!response) return null;

    return {
      name: 'Staged Policy: Pre-trigger high-quality answer',
      source: 'testBehaviorPolicy',
      userIntent: 'Answer with a high-quality response until the trigger question is reached.',
      responseStyle: 'high-quality-answer',
      responseDirective: response,
      successExpectation: 'Partner AI accepts the answer and advances toward the trigger question.',
      stopAfterSuccess: false
    };
  }

  if (atTrigger) {
    state.phase = 'triggerPartialSequence';
    const triggerResponse = buildTriggerCriterionResponse({
      promptContext,
      seed,
      state
    });
    if (!triggerResponse) return null;

    return {
      name: 'Staged Policy: Trigger partial criterion answer',
      source: 'testBehaviorPolicy',
      userIntent: 'Answer the trigger question with exactly one new mandatory criterion.',
      responseStyle: 'partial-answer',
      responseDirective: triggerResponse.responseDirective,
      successExpectation: 'Partner AI probes for mandatory criteria not yet met.',
      stopAfterSuccess: false
    };
  }

  if (state.phase === 'triggerPartialSequence') {
    state.phase = 'postTrigger';
  }

  if (state.phase === 'postTrigger') {
    return buildGenericCriteriaStagedCycle({
      promptContext,
      testBehaviorPolicy,
      qualityCriteria,
      seed,
      state
    }) ?? buildPostTriggerQuestionCycle({
      promptContext,
      testBehaviorPolicy,
      seed,
      state
    });
  }

  return null;
}

function buildGenericCriteriaStagedCycle({ promptContext, testBehaviorPolicy, qualityCriteria, seed, state }) {
  const primaryQuestion = findPrimaryQuestion(promptContext, qualityCriteria);
  if (!primaryQuestion) return null;

  const questionKey = primaryQuestion.id ?? buildQuestionKey(promptContext);
  state.genericQuestions ??= {};
  state.genericQuestionCriterionIndex ??= {};
  state.usedQuestionRequests ??= [];

  const questionState = state.genericQuestions[questionKey] ?? {
    phase: 'partial',
    addressedCriteria: []
  };
  const criteria = primaryQuestion.highQualityCriteria ?? [];
  const selectedCriterion = selectCriterionForCurrentPrompt({
    criteria,
    promptContext,
    addressedCriteria: questionState.addressedCriteria,
    preferUnaddressed: questionState.phase !== 'full'
  });

  if (questionState.phase === 'partial') {
    const criterion = selectedCriterion ?? criteria.find((item, index) => item.required && !questionState.addressedCriteria.includes(criterionKey(item, index)))
      ?? criteria.find((item, index) => !questionState.addressedCriteria.includes(criterionKey(item, index)))
      ?? criteria[0];
    if (!criterion) return null;

    const criterionIndex = criteria.indexOf(criterion);
    questionState.addressedCriteria.push(criterionKey(criterion, criterionIndex));
    questionState.phase = 'ask';
    state.genericQuestions[questionKey] = questionState;

    return {
      name: 'Staged Policy: Criteria-driven partial answer',
      source: 'testBehaviorPolicy',
      userIntent: 'Answer the current primary question with only one selected criterion from the high-quality criteria.',
      responseStyle: 'partial-answer',
      responsePlan: buildResponsePlan({
        mode: 'partial',
        intent: 'direct-answer',
        promptContext,
        primaryQuestion,
        targetCriterion: criterion,
        addressedCriteria: questionState.addressedCriteria,
        remainingCriteria: remainingCriteria(criteria, questionState.addressedCriteria)
      }),
      successExpectation: 'Partner AI responds to the partial answer or asks for missing criteria.',
      stopAfterSuccess: false
    };
  }

  if (questionState.phase === 'ask') {
    const action = nextStagedQuestionAction(state);
    questionState.phase = 'full';
    state.genericQuestions[questionKey] = questionState;

    return {
      name: `Staged Policy: Ask for ${action}`,
      source: 'testBehaviorPolicy',
      userIntent: `Ask Partner AI for a ${action} before completing the current primary question.`,
      responseStyle: 'question',
      responseDirective: buildQuestionDirective(action),
      responsePlan: buildResponsePlan({
        mode: 'ask',
        intent: action,
        promptContext,
        primaryQuestion,
        targetCriterion: selectedCriterion,
        addressedCriteria: questionState.addressedCriteria,
        remainingCriteria: remainingCriteria(criteria, questionState.addressedCriteria)
      }),
      successExpectation: `Partner AI provides a ${action} response.`,
      successSignals: inferredSuccessSignals(action),
      stopAfterSuccess: false
    };
  }

  if (questionState.phase === 'full') {
    const intent = classifyFollowUpIntent(normalize([
      promptContext.followUpQuestion,
      promptContext.latestPartnerTurn,
      promptContext.activeQuestion
    ].join(' ')));
    questionState.phase = 'done';
    state.genericQuestions[questionKey] = questionState;

    return {
      name: 'Staged Policy: Criteria-driven complete answer',
      source: 'testBehaviorPolicy',
      userIntent: 'Answer the current Partner AI prompt and fully address the remaining criteria for the active primary question.',
      responseStyle: 'high-quality-answer',
      responsePlan: buildResponsePlan({
        mode: 'full',
        intent,
        promptContext,
        primaryQuestion,
        targetCriterion: selectedCriterion,
        addressedCriteria: questionState.addressedCriteria,
        remainingCriteria: remainingCriteria(criteria, questionState.addressedCriteria)
      }),
      successExpectation: 'Partner AI accepts the completed answer and advances to the next primary question.',
      stopAfterSuccess: false
    };
  }

  return null;
}

function matchesAnyQuotedTrigger(promptContext, testBehaviorPolicy, qualityCriteria) {
  const quotedTargets = [...testBehaviorPolicy.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1])
    .filter((target) => /compensation change is justified|specific reason|raise request is justified|justified/i.test(target));
  return quotedTargets.some((target) => promptMatchesTarget(promptContext, qualityCriteria, target));
}

function buildTriggerCriterionResponse({ promptContext, seed, state }) {
  const partnerTurn = normalize([
    promptContext.latestPartnerTurn,
    promptContext.followUpQuestion,
    promptContext.activeQuestion
  ].join(' '));
  const latestQuestion = normalize(promptContext.followUpQuestion);
  state.triggerFollowUpCounts ??= {};
  const followUpIntent = classifyTriggerFollowUp({
    latestQuestion,
    partnerTurn
  });
  const followUpKey = `${followUpIntent.intent}:${followUpIntent.subject}`;
  const priorFollowUpCount = state.triggerFollowUpCounts[followUpKey] ?? 0;
  state.triggerFollowUpCounts[followUpKey] = priorFollowUpCount + 1;

  const directDirective = buildDirectTriggerFollowUpDirective({
    followUpIntent,
    latestQuestion,
    partnerTurn,
    priorFollowUpCount
  });
  if (directDirective) {
    state.triggerCriteriaUsed.push(`direct-${followUpKey}-${state.triggerFollowUpCounts[followUpKey]}`);
    const criterionId = triggerSubjectCriterionId(followUpIntent.subject);
    if (criterionId) state.triggerCriteriaUsed.push(criterionId);
    return {
      responseDirective: directDirective,
      criterionId
    };
  }

  const used = new Set(state.triggerCriteriaUsed);
  const options = triggerCriterionOptions(seed, state);
  const selected = selectUnusedCriterionForPrompt({
    options,
    partnerTurn,
    latestQuestion,
    used
  }) ?? options.find((option) => !used.has(option.id));

  if (!selected) return null;

  state.triggerCriteriaUsed.push(selected.id);
  return {
    responseDirective: selected.directive,
    criterionId: selected.id
  };
}

function classifyTriggerFollowUp({ latestQuestion, partnerTurn }) {
  const latestQuestionSubject = classifyFollowUpSubject(latestQuestion);
  const combinedText = `${latestQuestion} ${partnerTurn}`;

  return {
    intent: classifyFollowUpIntent(combinedText),
    subject: latestQuestionSubject !== 'general'
      ? latestQuestionSubject
      : classifyFollowUpSubject(combinedText)
  };
}

function triggerSubjectCriterionId(subject) {
  return {
    timing: 'timing',
    impact: 'impact-results',
    bonus: 'bonus-structure',
    amount: 'amount-type',
    market: 'market-detail',
    responsibilities: 'role-responsibilities'
  }[subject] ?? null;
}

function classifyFollowUpIntent(text) {
  if (/example|for instance|concrete|specific examples?/.test(text)) {
    return 'example';
  }

  if (/data|metric|quantif|measure|specific result|specific outcome|evidence/.test(text)) {
    return 'evidence';
  }

  if (/define|definition|what does .* mean|meaning of|term|phrase/.test(text)) {
    return 'definition';
  }

  if (/clarify|explain|elaborate|why|how|what .* looking for|can you share more/.test(text)) {
    return 'explanation';
  }

  return 'direct-answer';
}

function classifyFollowUpSubject(text) {
  const requestedSubject = classifyExplicitRequestedSubject(text);
  if (requestedSubject !== 'general') return requestedSubject;

  if (/timing|july 1|effective|retroactive|review window|compensation review|budget cycle|budget planning|past compensation|salary adjustment|why.*date|why.*when/.test(text)) {
    return 'timing';
  }

  if (/quantif|metric|specific outcome|specific result|efficiency|closure rate|turnaround|achievement|contribution/.test(text)) {
    return 'impact';
  }

  if (/positively impacted|impacted the team|impacted.*organization|benefited the organization|team performance|team's performance|overall performance/.test(text)) {
    return 'impact';
  }

  if (/bonus|quarterly|milestone|project milestone/.test(text)) {
    return 'bonus';
  }

  if (/responsibilit|scope|role|ownership|training|backup coordinator/.test(text)) {
    return 'responsibilities';
  }

  if (/amount|7%|7 percent|base salary|proportional|increase/.test(text)) {
    return 'amount';
  }

  if (/market|benchmark|median|comparable|below market/.test(text)) {
    return 'market';
  }

  return 'general';
}

function classifyExplicitRequestedSubject(text) {
  if (/examples? of (?:your )?(?:contributions?|achievements?|responsibilities?|duties|work|impact)|(?:contributions?|achievements?|responsibilities?) that (?:support|justify|align|demonstrate)/.test(text)) {
    return 'impact';
  }

  if (/(?:share|provide|describe|list).{0,80}(?:responsibilities?|duties|role|scope|ownership|training|backup coordinator)|(?:responsibilities?|duties|role|scope).{0,80}(?:support|justify|align|demonstrate)/.test(text)) {
    return 'responsibilities';
  }

  if (/(?:share|provide|describe|list).{0,80}(?:achievements?|contributions?|impact|results?|outcomes?|metrics?)|(?:achievements?|contributions?|impact|results?|outcomes?|metrics?).{0,80}(?:support|justify|align|demonstrate)/.test(text)) {
    return 'impact';
  }

  return 'general';
}

function buildDirectTriggerFollowUpDirective({ followUpIntent, latestQuestion, partnerTurn, priorFollowUpCount }) {
  const text = `${latestQuestion} ${partnerTurn}`;
  const isRepeated = priorFollowUpCount > 0;
  const { intent, subject } = followUpIntent;

  if (intent === 'example' && subject === 'impact') {
    return isRepeated
      ? 'Generate a fresh concrete example of a contribution or responsibility that created measurable team or organizational value, and connect it to why the compensation review timing is appropriate.'
      : 'Generate a concise example of contributions or responsibilities that created measurable impact, responding directly to the Partner AI follow-up.';
  }

  if (intent === 'example' && subject === 'timing') {
    return 'Generate a concise timing example that explains why the requested effective date fits a normal compensation review, budget, or payroll cycle.';
  }

  if (intent === 'example' && subject === 'bonus') {
    return 'Generate a concise example of how a performance bonus could be tied to measurable project milestones.';
  }

  if (intent === 'example' && subject === 'responsibilities') {
    return 'Generate a concise example of expanded responsibilities and explain why they support the compensation request.';
  }

  if (intent === 'example' && subject === 'amount') {
    return 'Generate a concise example explaining why the requested amount is proportional to the compensation gap, expanded role, or measurable contribution.';
  }

  if (intent === 'evidence' && subject === 'impact') {
    return 'Generate concrete synthetic evidence or metrics showing impact, using numbers that are plausible and relevant to the latest Partner AI prompt.';
  }

  if (intent === 'evidence' && subject === 'timing') {
    return 'Generate concrete synthetic evidence that the requested timing aligns with a normal review, budget, or payroll cycle.';
  }

  if (intent === 'evidence' && subject === 'market') {
    return 'Generate concrete synthetic market evidence that supports the requested compensation amount without claiming real data.';
  }

  if (subject === 'timing' && (isRepeated || /why|explain|clarify/.test(text))) {
    return 'Explain why the requested effective date is appropriate, responding directly to the latest timing question.';
  }

  if (subject === 'bonus' && (isRepeated || /how|fit|complement|align/.test(text))) {
    return 'Explain how the requested bonus component fits with the compensation request and measurable performance milestones.';
  }

  if (subject === 'amount' && (isRepeated || /why|appropriate|justify|relates/.test(text))) {
    return 'Explain why the requested amount is appropriate relative to the user’s stated role changes, impact, or market context.';
  }

  if (subject === 'responsibilities') {
    return 'Describe expanded responsibilities that support the compensation request, and tie them directly to the latest Partner AI follow-up.';
  }

  return null;
}

function findPrimaryQuestion(promptContext, qualityCriteria) {
  if (!qualityCriteria?.primaryQuestions?.length) return null;

  const area = normalize(promptContext.discussionArea);
  const primaryQuestion = normalize(promptContext.primaryQuestion);
  const activeQuestion = normalize(promptContext.activeQuestion);
  const latestPartnerTurn = normalize(promptContext.latestPartnerTurn);

  return qualityCriteria.primaryQuestions.find((item) => {
    const itemArea = normalize(item.discussionArea);
    const itemQuestion = normalize(item.question);

    return (itemQuestion && (primaryQuestion.includes(itemQuestion) || activeQuestion.includes(itemQuestion) || latestPartnerTurn.includes(itemQuestion)))
      || (itemArea && area.includes(itemArea));
  }) ?? null;
}

function selectCriterionForCurrentPrompt({ criteria, promptContext, addressedCriteria, preferUnaddressed }) {
  const promptText = normalize([
    promptContext.followUpQuestion,
    promptContext.latestPartnerTurn,
    promptContext.activeQuestion,
    promptContext.answerGuidance?.join(' ')
  ].join(' '));
  const addressed = new Set(addressedCriteria);
  const scored = criteria
    .map((criterion, index) => {
      const key = criterionKey(criterion, index);
      const criterionText = normalize([
        criterion.requirement,
        criterion.label
      ].join(' '));
      const tokenScore = significantTokens(criterionText)
        .filter((token) => promptText.includes(token))
        .length;
      const requiredBoost = criterion.required ? 4 : 0;
      const unaddressedBoost = !addressed.has(key) ? 6 : 0;
      const addressedPenalty = preferUnaddressed && addressed.has(key) ? -20 : 0;

      return {
        criterion,
        score: tokenScore + requiredBoost + unaddressedBoost + addressedPenalty
      };
    })
    .sort((a, b) => b.score - a.score);

  return scored.at(0)?.score > 0 ? scored.at(0).criterion : null;
}

function significantTokens(text) {
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'they', 'their', 'from', 'into',
    'each', 'such', 'one', 'more', 'will', 'would', 'could', 'should', 'what',
    'when', 'where', 'why', 'how', 'are', 'you', 'your', 'has', 'have', 'had',
    'provides', 'provide', 'providing', 'describes', 'describe', 'cites', 'cited'
  ]);

  return [...new Set(String(text ?? '')
    .toLowerCase()
    .replace(/[^\w\s%]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 3 && !stopWords.has(token)))];
}

function criterionKey(criterion, index) {
  return `${index}:${normalize(criterion?.requirement).slice(0, 80)}`;
}

function remainingCriteria(criteria, addressedCriteria) {
  const addressed = new Set(addressedCriteria);
  return criteria.filter((criterion, index) => !addressed.has(criterionKey(criterion, index)));
}

function buildResponsePlan({ mode, intent, promptContext, primaryQuestion, targetCriterion, addressedCriteria, remainingCriteria }) {
  const promptText = normalize([
    primaryQuestion.discussionArea,
    primaryQuestion.question,
    primaryQuestion.answerGuidance?.join(' '),
    promptContext.answerGuidance?.join(' ')
  ].join(' '));

  return {
    mode,
    intent,
    activePrimaryQuestion: primaryQuestion.question,
    discussionArea: primaryQuestion.discussionArea,
    partnerAiFollowUp: promptContext.followUpQuestion || promptContext.activeQuestion,
    latestPartnerTurn: promptContext.latestPartnerTurn,
    targetCriterion: targetCriterion ? {
      requirement: targetCriterion.requirement,
      required: Boolean(targetCriterion.required),
      label: targetCriterion.label
    } : null,
    addressedCriteria,
    remainingCriteria: remainingCriteria.map((criterion) => ({
      requirement: criterion.requirement,
      required: Boolean(criterion.required),
      label: criterion.label
    })),
    answerGuidance: primaryQuestion.answerGuidance ?? promptContext.answerGuidance ?? [],
    instructions: [
      'Answer as the synthetic Requestor/user in first person.',
      'Use fictional synthetic facts only.',
      'Respond directly to the latest Partner AI prompt.',
      mode === 'partial'
        ? 'Address only the target criterion. Do not satisfy all remaining criteria yet.'
        : 'Fully address the latest Partner AI prompt and cover all remaining mandatory criteria plus enough voluntary criteria to satisfy the coverage requirement.',
      mode === 'full' && /flexibility|alternative|tradeoff|manager cannot approve/.test(promptText)
        ? 'For alternatives, include must-haves plus 3 to 4 concise alternatives covering bonus/PTO/equity, delay or split timing, and performance triggers. Give values/dates, why each is acceptable, and how each connects back to the original request.'
        : null,
      mode !== 'full' && intent === 'example' ? 'Provide an example relevant to the target criterion, not a generic example.' : null,
      mode !== 'full' && intent === 'evidence' ? 'Provide concrete evidence, data, or metrics relevant to the target criterion.' : null,
      mode !== 'full' && intent === 'definition' ? 'Define the requested term briefly, then answer the underlying question if appropriate.' : null
    ].filter(Boolean)
  };
}

function triggerCriterionOptions(seed, state) {
  return [
    {
      id: 'timing',
      priority: 130,
      patterns: [/timing/, /july 1/, /effective/, /right time/, /review window/, /\bwhen\b/, /date/],
      directive: 'Address only the timing criterion. Explain why the requested effective date is appropriate using fresh synthetic facts.'
    },
    {
      id: 'role-responsibilities',
      priority: 120,
      patterns: [/responsibilit/, /increased responsibilities/, /new responsibilities/, /role/, /duties/, /taken on/, /scope/, /evolved/, /expanded/],
      directive: 'Address only the expanded-responsibilities criterion. Describe fresh synthetic role changes that justify the compensation request.'
    },
    {
      id: 'impact-results',
      priority: 140,
      patterns: [/impact/, /outcome/, /metric/, /quantif/, /result/, /achievement/, /specific examples? of achievements/, /contribution/, /performance improvement/, /measurable improvement/],
      directive: 'Address only the impact/results criterion. Provide fresh synthetic metrics or achievements that respond to the latest Partner AI prompt.'
    },
    {
      id: 'amount-type',
      priority: 90,
      patterns: [/specify.*amount/, /amount of the raise/, /what amount/, /which.*increase/, /type of compensation/, /types of compensation/, /overall compensation request/, /requesting any changes/, /compensation strategy/],
      directive: 'Address only the amount/type criterion. Explain why the requested compensation amount and component are appropriate.'
    },
    {
      id: 'market-detail',
      priority: 80,
      patterns: [/market/, /benchmark/, /median/, /comparable/, /salary compar/, /below.*rate/, /data/],
      directive: 'Address only the market-data criterion. Use fictional benchmark context and avoid claiming real market data.'
    },
    {
      id: 'bonus-structure',
      priority: 50,
      patterns: [/bonus/, /quarterly/, /milestone/, /other compensation/, /types? of compensation/, /structure/],
      directive: 'Address only the bonus/other-compensation criterion. Describe a fresh synthetic bonus structure tied to measurable milestones.'
    },
    {
      id: 'justification-types',
      priority: 40,
      patterns: [/market-based/, /timing-based/, /role-based/, /types? of justification/, /different types/],
      directive: 'Address only one justification type requested by the Partner AI, using fresh synthetic facts.'
    },
    {
      id: 'specific-reason',
      priority: 30,
      patterns: [/why.*justif/, /reason/, /support.*request/, /basis/, /justify/],
      directive: 'Address only one specific reason why the compensation change is justified. Vary the reason from prior turns and cases.'
    }
  ];
}

function selectUnusedCriterionForPrompt({ options, partnerTurn, latestQuestion, used }) {
  const latestQuestionMatches = options.filter((option) => {
    return !used.has(option.id) && option.patterns.some((pattern) => pattern.test(latestQuestion));
  });
  const sourceOptions = latestQuestionMatches.length ? latestQuestionMatches : options.filter((option) => !used.has(option.id));

  const scored = options
    .filter((option) => sourceOptions.includes(option))
    .map((option) => {
      const turnMatchCount = option.patterns.filter((pattern) => pattern.test(partnerTurn)).length;
      const latestQuestionMatchCount = option.patterns.filter((pattern) => pattern.test(latestQuestion)).length;
      const score = turnMatchCount + latestQuestionMatchCount > 0
        ? option.priority + (latestQuestionMatchCount > 0 ? 100 : 0) + turnMatchCount + latestQuestionMatchCount
        : 0;

      return { option, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.at(0)?.option ?? null;
}

function buildPostTriggerQuestionCycle({ promptContext, testBehaviorPolicy, seed, state }) {
  const questionKey = buildQuestionKey(promptContext);
  const partialResponse = buildPostTriggerPartialResponse(promptContext);
  const fullResponse = buildPostTriggerFullResponse(promptContext);
  if (!partialResponse || !fullResponse) return null;

  const questionState = state.postQuestions[questionKey] ?? { phase: 'partial' };

  if (questionState.phase === 'partial') {
    state.postQuestions[questionKey] = { phase: 'ask' };
    return {
      name: 'Staged Policy: Post-trigger partial criterion answer',
      source: 'testBehaviorPolicy',
      userIntent: 'Answer the current primary question with only one criterion.',
      responseStyle: 'partial-answer',
      responseDirective: partialResponse,
      successExpectation: 'Partner AI responds to the partial answer or asks for missing criteria.',
      stopAfterSuccess: false
    };
  }

  if (questionState.phase === 'ask') {
    const action = nextStagedQuestionAction(state);
    state.usedQuestionRequests ??= [];
    state.postQuestions[questionKey] = { phase: 'full' };
    return {
      name: `Staged Policy: Ask for ${action}`,
      source: 'testBehaviorPolicy',
      userIntent: `Ask Partner AI for a ${action} before completing the current primary question.`,
      responseStyle: 'question',
      responseDirective: buildQuestionDirective(action),
      successExpectation: `Partner AI provides a ${action} response.`,
      successSignals: inferredSuccessSignals(action),
      stopAfterSuccess: false
    };
  }

  if (questionState.phase === 'full') {
    state.postQuestions[questionKey] = { phase: 'done' };
    return {
      name: 'Staged Policy: Complete remaining criteria',
      source: 'testBehaviorPolicy',
      userIntent: 'Provide a full response that addresses the remaining criteria for the current primary question.',
      responseStyle: 'high-quality-answer',
      responseDirective: fullResponse,
      successExpectation: 'Partner AI accepts the completed answer and advances to the next primary question.',
      stopAfterSuccess: false
    };
  }

  return null;
}

function buildPostTriggerStagedManeuver({ promptContext, testBehaviorPolicy, seed, policyState }) {
  const partialResponse = buildPostTriggerPartialResponse(promptContext);
  if (!partialResponse) return null;

  policyState.postTriggerQuestionState ??= {};
  const questionKey = buildQuestionKey(promptContext);
  const state = policyState.postTriggerQuestionState[questionKey] ?? { phase: 'partial' };

  if (state.phase === 'partial') {
    policyState.postTriggerQuestionState[questionKey] = { phase: 'ask' };
    return {
      name: 'Policy: Post-trigger partial criterion answer',
      source: 'testBehaviorPolicy',
      userIntent: 'Answer the current primary question with only one criterion before requesting help.',
      responseStyle: 'partial-answer',
      responseDirective: partialResponse,
      successExpectation: 'Partner AI responds to the partial answer or asks for missing criteria.',
      stopAfterSuccess: false
    };
  }

  if (state.phase === 'ask') {
    const action = nextPostTriggerQuestionAction(policyState);
    policyState.postTriggerQuestionState[questionKey] = { phase: 'full' };
    return {
      name: `Policy: Post-trigger ask for ${action}`,
      source: 'testBehaviorPolicy',
      userIntent: `Ask Partner AI for a ${action} before completing the current primary question.`,
      responseStyle: 'question',
      responseDirective: buildQuestionDirective(action),
      successExpectation: `Partner AI provides a ${action} response.`,
      successSignals: inferredSuccessSignals(action),
      stopAfterSuccess: false
    };
  }

  return null;
}

function buildPostTriggerPartialResponse(promptContext) {
  const prompt = normalize([
    promptContext.discussionArea,
    promptContext.primaryQuestion,
    promptContext.activeQuestion
  ].join(' '));

  if (/work performance|main goals|performed against/.test(prompt)) {
    return 'Generate a partial answer for work performance that addresses only one criterion from the quality criteria.';
  }

  if (/professionalism|collaboration|communication/.test(prompt)) {
    return 'Generate a partial answer for professionalism or collaboration that addresses only one criterion from the quality criteria.';
  }

  if (/fair|team|organization|organizational fit/.test(prompt)) {
    return 'Generate a partial answer for fairness or organizational fit that addresses only one criterion from the quality criteria.';
  }

  if (/constraints|realistically expect|affect this decision/.test(prompt)) {
    return 'Generate a partial answer for constraints that addresses only one criterion from the quality criteria.';
  }

  if (/tradeoffs|alternative|manager cannot approve|flexibility/.test(prompt)) {
    return 'Generate a partial answer for flexibility or alternatives that addresses only one criterion from the quality criteria.';
  }

  return null;
}

function buildPostTriggerFullResponse(promptContext) {
  const prompt = normalize([
    promptContext.discussionArea,
    promptContext.primaryQuestion,
    promptContext.activeQuestion
  ].join(' '));

  if (/work performance|main goals|performed against/.test(prompt)) {
    return 'Generate a complete work-performance answer that covers all remaining mandatory criteria and enough voluntary criteria.';
  }

  if (/professionalism|collaboration|communication/.test(prompt)) {
    return 'Generate a complete professionalism or collaboration answer that covers all remaining mandatory criteria and enough voluntary criteria.';
  }

  if (/fair|team|organization|organizational fit/.test(prompt)) {
    return 'Generate a complete fairness or organizational-fit answer that covers all remaining mandatory criteria and enough voluntary criteria.';
  }

  if (/constraints|realistically expect|affect this decision/.test(prompt)) {
    return 'Generate a complete constraints answer that covers all remaining mandatory criteria and enough voluntary criteria.';
  }

  if (/tradeoffs|alternative|manager cannot approve|flexibility/.test(prompt)) {
    return 'Generate a complete flexibility or alternatives answer that covers all remaining mandatory criteria and enough voluntary criteria.';
  }

  return null;
}

function nextPostTriggerQuestionAction(policyState) {
  const actions = ['example', 'clarification', 'definition'];
  const index = policyState.postTriggerQuestionActionIndex ?? 0;
  policyState.postTriggerQuestionActionIndex = index + 1;
  return actions[index % actions.length];
}

function nextStagedQuestionAction(state) {
  const actions = ['example', 'clarification', 'definition'];
  const index = state.postQuestionActionIndex ?? 0;
  state.postQuestionActionIndex = index + 1;
  return actions[index % actions.length];
}

function buildQuestionKey(promptContext) {
  return normalize([
    promptContext.discussionArea,
    promptContext.primaryQuestion || promptContext.activeQuestion
  ].join('|'));
}

export function evaluatePolicyAdvanceStop({ latestPrompt, run }) {
  const policy = run.testBehaviorPolicy ?? '';
  if (!/stop|do not answer any more|do not continue/i.test(policy)) {
    return { matched: false };
  }

  const text = normalize(latestPrompt);
  const stopTargets = [
    ...[...policy.matchAll(/looks something like this,\s*"([^"]+)"/gi)].map((match) => match[1]),
    ...[...policy.matchAll(/until .*?"([^"]+)"/gi)].map((match) => match[1])
  ].map(normalize);

  const defaultTargets = ['describe your work performance', 'work performance'];
  const targets = stopTargets.length ? [...stopTargets, ...defaultTargets] : defaultTargets;
  const matchedTarget = targets.find((target) => text.includes(target));

  if (!matchedTarget) return { matched: false };

  return {
    matched: true,
    reason: `Policy stop observed: Partner AI advanced to "${matchedTarget}".`
  };
}

function promptMatchesTarget(promptContext, qualityCriteria, target) {
  const normalizedTarget = normalize(target);
  const promptText = normalize([
    promptContext.discussionArea,
    promptContext.primaryQuestion,
    promptContext.activeQuestion,
    promptContext.answerGuidance?.join(' ')
  ].filter(Boolean).join(' '));

  if (promptText.includes(normalizedTarget)) return true;

  return relevantCriteria(promptContext, qualityCriteria).some((criterion) => {
    return normalize(criterion.requirement ?? '').includes(normalizedTarget);
  });
}

function relevantCriteria(promptContext, qualityCriteria) {
  if (!qualityCriteria?.primaryQuestions?.length) return [];

  const area = normalize(promptContext.discussionArea);
  const question = normalize(promptContext.primaryQuestion);

  const primaryQuestion = qualityCriteria.primaryQuestions.find((item) => {
    return (item.discussionArea && area.includes(normalize(item.discussionArea)))
      || (item.question && question.includes(normalize(item.question)));
  });

  return primaryQuestion?.highQualityCriteria ?? [];
}

function buildSingleMandatoryCriterionResponse({ promptContext, testBehaviorPolicy, seed, policyState }) {
  const prompt = normalize([
    promptContext.discussionArea,
    promptContext.primaryQuestion,
    promptContext.activeQuestion,
    promptContext.followUpQuestion,
    promptContext.compactPrompt
  ].join(' '));

  if (!/raise justification|why do you believe|justified/.test(prompt)) {
    return null;
  }

  policyState.targetCriteriaUsed ??= [];
  policyState.targetCriterionRequests ??= {};
  policyState.usedJustifications ??= [];

  const partnerTurn = normalize([
    promptContext.latestPartnerTurn,
    promptContext.followUpQuestion,
    promptContext.activeQuestion
  ].join(' '));

  const hasFollowUp = Boolean(promptContext.followUpQuestion);
  const responseOptions = [
    {
      id: 'timing',
      priority: 130,
      patterns: [/timing/, /july 1/, /effective/, /right time/, /review window/, /\bwhen\b/, /date/],
      directive: 'Address only the timing criterion using fresh synthetic facts about review windows, budget planning, or effective date.'
    },
    {
      id: 'amount-type',
      priority: 90,
      patterns: [/specify.*amount/, /amount of the raise/, /what amount/, /which.*increase/, /type of compensation/, /types of compensation/, /overall compensation request/, /requesting any changes/, /compensation strategy/],
      directive: 'Address only the amount and compensation-type criterion using fresh synthetic facts.'
    },
    {
      id: 'market-detail',
      priority: 80,
      patterns: [/market/, /benchmark/, /median/, /comparable/, /salary compar/, /below.*rate/, /data/],
      directive: 'Address only the market-data criterion using fictional benchmark data.'
    },
    {
      id: 'role-responsibilities',
      priority: 120,
      patterns: [/responsibilit/, /increased responsibilities/, /new responsibilities/, /role/, /duties/, /taken on/, /scope/, /evolved/, /expanded/],
      directive: 'Address only the expanded-responsibilities criterion using fresh synthetic examples.'
    },
    {
      id: 'impact-results',
      priority: 110,
      patterns: [/impact/, /result/, /achievement/, /specific examples? of achievements/, /organization/, /contribution/, /performance improvement/, /work performance/, /measurable improvement/],
      directive: 'Address only the impact/results criterion using fresh synthetic metrics or achievements.'
    },
    {
      id: 'bonus-structure',
      priority: 50,
      patterns: [/bonus/, /quarterly/, /milestone/, /other compensation/, /types? of compensation/, /structure/],
      directive: 'Address only the bonus or other-compensation criterion using fresh synthetic milestone examples.'
    },
    {
      id: 'justification-types',
      priority: 40,
      patterns: [/market-based/, /timing-based/, /role-based/, /types? of justification/, /different types/],
      directive: 'Address only one justification type requested by the Partner AI using fresh synthetic facts.'
    },
    {
      id: 'specific-reason',
      priority: 30,
      patterns: [/why.*justif/, /reason/, /support.*request/, /basis/, /justify/],
      directive: 'Address only one specific reason why the compensation request is justified, varying the reason from prior responses.'
    }
  ];

  const used = new Set(policyState.targetCriteriaUsed);
  const initialTargetOption = isInitialRaiseJustificationQuestion(promptContext)
    ? responseOptions.find((option) => option.id === 'specific-reason' && !used.has(option.id))
    : null;
  const matchedOption = hasFollowUp
    ? initialTargetOption ?? selectBestCriterionResponse({
      responseOptions,
      partnerTurn,
      latestQuestion: normalize(promptContext.followUpQuestion),
      used,
      policyState
    })
    : initialTargetOption ?? responseOptions.find((option) => option.id === 'specific-reason' && !used.has(option.id));
  const fallbackOption = responseOptions.find((option) => !used.has(option.id))
    ?? responseOptions[Math.min(policyState.targetCriterionStep ?? 0, responseOptions.length - 1)];
  const selected = matchedOption ?? fallbackOption;

  policyState.targetCriteriaUsed.push(selected.id);
  policyState.targetCriterionStep = (policyState.targetCriterionStep ?? 0) + 1;
  return selected.directive;
}

function isInitialRaiseJustificationQuestion(promptContext) {
  const activeQuestion = normalize(promptContext.followUpQuestion || promptContext.activeQuestion);
  if (!/why do you believe this raise request is justified/.test(activeQuestion)) return false;

  return !/can you|could you|clarify|specify|share|provide|explain why.*specifically|additionally/.test(activeQuestion);
}

function selectBestCriterionResponse({ responseOptions, partnerTurn, latestQuestion, used, policyState }) {
  const scored = responseOptions
    .map((option) => {
      const turnMatchCount = option.patterns.filter((pattern) => pattern.test(partnerTurn)).length;
      const latestQuestionMatchCount = option.patterns.filter((pattern) => pattern.test(latestQuestion)).length;
      const matchCount = turnMatchCount + latestQuestionMatchCount;
      const latestQuestionBoost = latestQuestionMatchCount > 0 ? 75 : 0;
      const unusedBoost = used.has(option.id) ? 0 : 25;
      const repeatedAskBoost = (policyState.targetCriterionRequests[option.id] ?? 0) * 50;
      if (latestQuestionMatchCount > 0) {
        policyState.targetCriterionRequests[option.id] = (policyState.targetCriterionRequests[option.id] ?? 0) + 1;
      }

      return {
        option,
        score: matchCount > 0
          ? option.priority + latestQuestionBoost + unusedBoost + repeatedAskBoost + matchCount
          : 0
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.at(0)?.option ?? null;
}

function buildPreTargetHighQualityResponse(promptContext, testBehaviorPolicy) {
  if (!/high-quality|high quality/i.test(testBehaviorPolicy)) return null;

  const prompt = normalize([
    promptContext.discussionArea,
    promptContext.primaryQuestion,
    promptContext.activeQuestion
  ].join(' '));

  if (/raise amount|amount and timing|what exactly are you asking/.test(prompt)) {
    return 'Generate a high-quality synthetic answer that specifies the raise amount, distinguishes compensation components, and gives an approximate effective date.';
  }

  if (/work performance/.test(prompt)) {
    return 'Generate a high-quality synthetic answer that describes role goals, performance against those goals, and specific supporting details.';
  }

  return null;
}

function buildQuestionDirective(action) {
  return `Generate a fresh, concise synthetic-user ${action} request that responds directly to the latest Partner AI prompt. Do not reuse an example phrase from the Test Behavior Policy.`;
}

function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function inferredSuccessSignals(expectation) {
  if (/clarif/.test(expectation)) {
    return [
      'clarify',
      'what I am asking',
      'what I’m asking',
      'focus on',
      'looking for',
      'please include',
      'you should include',
      'you can include',
      'specific details',
      'for this question',
      'in this question',
      'what information',
      'what kind of information',
      'what details'
    ];
  }

  if (/example/.test(expectation)) {
    return ['example', 'for example', 'for instance', 'such as'];
  }

  if (/definition|define|term|phrase|meaning/.test(expectation)) {
    return ['means', 'refers to', 'definition', 'defined as', 'in this context'];
  }

  return ['help', 'guidance', 'you can', 'please include'];
}

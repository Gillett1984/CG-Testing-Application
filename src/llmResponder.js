import { extractPromptContext } from './promptContext.js';
import { generateScenarioDossiers as buildScenarioDossiers } from './scenarioDossiers.js';

export async function generatePartnerAiResponse(context) {
  if (context.llm?.apiKey) {
    return generateOpenAiResponse(context);
  }

  throw new Error('OPENAI_API_KEY is required. The testing system no longer uses hardcoded fallback responses.');
}

export async function verifyOpenAiConnectivity(llm, options = {}) {
  if (!llm?.apiKey) throw new Error('OPENAI_API_KEY is required before starting a production case.');
  // The preflight is a one-time startup gate for a long run, so be patient with a
  // transient network/API blip ("fetch failed", timeouts, ECONNRESET, 5xx). Retry
  // over ~45s before giving up. TLS/cert-interception errors never self-resolve, so
  // they fail fast on first occurrence (isTransientFetchError already excludes them).
  const retryDelaysMs = options.retryDelaysMs ?? [10000, 15000, 20000];
  let lastError = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      await createChatCompletion(llm, {
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        temperature: 0,
        max_tokens: 4
      });
      return;
    } catch (error) {
      lastError = error;
      const roundsLeft = attempt < retryDelaysMs.length;
      if (!roundsLeft || !isTransientFetchError(error)) break;
      const waitMs = retryDelaysMs[attempt];
      console.warn(`[preflight] OpenAI connectivity check failed (${describeError(error)}); retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1} of ${retryDelaysMs.length + 1}).`);
      await delay(waitMs);
    }
  }
  const tlsHint = isTlsInterceptionError(lastError)
    ? ` — TLS interception detected (e.g. Norton Web/Mail Shield re-signing HTTPS). Node must trust the intercepting root CA: NODE_EXTRA_CA_CERTS is currently ${process.env.NODE_EXTRA_CA_CERTS ? `"${process.env.NODE_EXTRA_CA_CERTS}"` : 'not set'}; expected cert at config/certs/norton-root.pem (launch via npm run ui / test:case / preflight so scripts/launch.js applies it — see config/certs/README.md).`
    : '';
  throw new Error(`OpenAI preflight failed before Common Ground case creation: ${describeError(lastError)}${tlsHint}`, { cause: lastError });
}

export async function generateScenarioDossiers({ llm, topic, scenario, seed, variationPrompt = '' }) {
  return buildScenarioDossiers({
    llm,
    topic,
    scenario,
    seed,
    variationPrompt,
    completeJson: async (activeLlm, request) => {
      const text = await createChatCompletion(activeLlm, {
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: JSON.stringify(request.input) }
        ],
        temperature: 0.9,
        max_tokens: request.maxTokens,
        response_format: { type: 'json_object' }
      });
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Scenario dossier generation returned invalid JSON: ${text.slice(0, 300)}`);
      }
    }
  });
}

async function generateOpenAiResponse(context) {
  const promptContext = extractPromptContext(context.latestPrompt);
  const activeQualityCriteria = findRelevantCriteria(promptContext, context.qualityCriteria);
  const baseGenerationInput = buildGenerationInput(context, promptContext, activeQualityCriteria);
  if (context.scenarioTurn) {
    return generateScenarioComposedResponse(context, baseGenerationInput);
  }
  const policyDecision = context.scenarioTurn
    ? buildScenarioPolicyDecision(baseGenerationInput)
    : context.activeManeuver
    ? null
    : await interpretTestBehaviorPolicy(context.llm, baseGenerationInput);
  context.policyDecision = policyDecision;
  const generationInput = {
    ...baseGenerationInput,
    policyDecision
  };
  const firstResponse = await createChatCompletion(context.llm, {
    messages: buildGenerationMessages(generationInput),
    temperature: 0.7,
    max_tokens: responseTokenBudget(generationInput)
  });
  const firstText = sanitizeGeneratedResponse(firstResponse);
  const firstCheck = await validateGeneratedResponse(context.llm, generationInput, firstText);
  if (firstCheck.pass) {
    context.responseValidationWarnings = firstCheck.warnings ?? [];
    return firstText;
  }
  const compactedFirst = await tryCompactResponse(context.llm, generationInput, firstText, firstCheck);
  if (compactedFirst?.validation.pass) {
    context.responseValidationWarnings = compactedFirst.validation.warnings ?? [];
    return compactedFirst.text;
  }

  const revisedResponse = await createChatCompletion(context.llm, {
    messages: buildGenerationMessages(generationInput, firstCheck),
    temperature: 0.55,
    max_tokens: responseTokenBudget(generationInput, true)
  });
  const revisedText = sanitizeGeneratedResponse(revisedResponse);
  const revisedCheck = await validateGeneratedResponse(context.llm, generationInput, revisedText);
  if (revisedCheck.pass) {
    context.responseValidationWarnings = revisedCheck.warnings ?? [];
    return revisedText;
  }
  const compactedRetry = await tryCompactResponse(context.llm, generationInput, revisedText, revisedCheck);
  if (compactedRetry?.validation.pass) {
    context.responseValidationWarnings = compactedRetry.validation.warnings ?? [];
    return compactedRetry.text;
  }

  throw new Error([
    'OpenAI generated an off-target synthetic response after retry.',
    `Initial issue: ${firstCheck.reason}`,
    `Retry issue: ${revisedCheck.reason}`,
    `Latest Partner AI prompt: ${promptContext.activeQuestion || promptContext.latestPartnerTurn}`,
    `Retry response: ${revisedText.slice(0, 500)}`,
    compactedRetry ? `Compression issue: ${compactedRetry.validation.reason}` : null
  ].filter(Boolean).join('\n'));
}

async function generateScenarioComposedResponse(context, baseGenerationInput) {
  const scenarioOnlyTurn = { ...context.scenarioTurn, behaviors: [] };
  const scenarioInput = {
    ...baseGenerationInput,
    scenarioTurn: scenarioOnlyTurn,
    policyDecision: buildScenarioPolicyDecision({ ...baseGenerationInput, scenarioTurn: scenarioOnlyTurn })
  };
  const behaviorPlan = buildBehaviorCompositionPlan(context.scenarioTurn.behaviors ?? []);
  const scenarioResponsePromise = generateCheckedResponse(context.llm, scenarioInput);
  const behaviorDecisionPromise = Promise.resolve(behaviorPlan);
  const [scenarioResult, resolvedBehaviorPlan] = await Promise.all([scenarioResponsePromise, behaviorDecisionPromise]);
  const scenarioResponse = scenarioResult.text;

  if (resolvedBehaviorPlan.mode === 'scenario') {
    context.policyDecision = scenarioInput.policyDecision;
    context.behaviorVerification = [];
    return scenarioResponse;
  }

  const compositionInput = {
    ...baseGenerationInput,
    baseScenarioResponse: scenarioResponse,
    deferredScenarioResponse: context.scenarioTurn.deferredScenarioResponse ?? null,
    behaviorPlan: resolvedBehaviorPlan,
    policyDecision: buildScenarioPolicyDecision(baseGenerationInput, resolvedBehaviorPlan)
  };
  context.policyDecision = compositionInput.policyDecision;
  const compositionResult = await generateCheckedResponse(context.llm, compositionInput);
  const response = compositionResult.text;
  context.behaviorVerification = compositionResult.validation.behaviorVerification ?? verifyScenarioBehaviors(response, context.scenarioTurn.behaviors ?? []);
  context.responseValidationWarnings = compositionResult.validation.warnings ?? [];
  context.deferScenarioResponse = resolvedBehaviorPlan.mode === 'defer' ? scenarioResponse : null;
  return response;
}

async function generateCheckedResponse(llm, generationInput) {
  const firstResponse = await createChatCompletion(llm, {
    messages: buildGenerationMessages(generationInput),
    temperature: 0.7,
    max_tokens: responseTokenBudget(generationInput)
  });
  const firstText = sanitizeGeneratedResponse(firstResponse);
  const firstCheck = await validateGeneratedResponse(llm, generationInput, firstText);
  if (firstCheck.pass) return { text: firstText, validation: firstCheck };
  const compactedFirst = await tryCompactResponse(llm, generationInput, firstText, firstCheck);
  if (compactedFirst?.validation.pass) return compactedFirst;

  const revisedResponse = await createChatCompletion(llm, {
    messages: buildGenerationMessages(generationInput, firstCheck),
    temperature: 0.45,
    max_tokens: responseTokenBudget(generationInput, true)
  });
  const revisedText = sanitizeGeneratedResponse(revisedResponse);
  const revisedCheck = await validateGeneratedResponse(llm, generationInput, revisedText);
  if (revisedCheck.pass) return { text: revisedText, validation: revisedCheck };
  const compactedRetry = await tryCompactResponse(llm, generationInput, revisedText, revisedCheck);
  if (compactedRetry?.validation.pass) return compactedRetry;
  throw new Error([
    'OpenAI generated an off-target synthetic response after retry.',
    `Initial issue: ${firstCheck.reason}`,
    `Retry issue: ${revisedCheck.reason}`,
    `Latest Partner AI prompt: ${generationInput.activePrompt.activeQuestion || generationInput.activePrompt.latestPartnerTurn}`,
    `Retry response: ${revisedText.slice(0, 500)}`,
    compactedRetry ? `Compression issue: ${compactedRetry.validation.reason}` : null
  ].filter(Boolean).join('\n'));
}

async function tryCompactResponse(llm, generationInput, candidateResponse, validation) {
  if (!isCompactStyleFailure(validation)) return null;
  const scenarioExpression = generationInput.scenarioTurn?.scenarioContext?.scenarioExpression;
  const requiredOpening = generationInput.actorPerspective === 'manager_evaluating_employee'
    ? scenarioExpression?.managerOpeningStatement
    : scenarioExpression?.employeeOpeningStatement;
  const behaviorStages = generationInput.behaviorPlan?.stages ?? [];
  const compacted = sanitizeGeneratedResponse(await createChatCompletion(llm, {
    messages: [
      {
        role: 'system',
        content: [
          'Shorten the supplied workplace interview response without changing its meaning or facts.',
          'Return only the rewritten response.',
          'Use 2 or 3 sentences and no more than 75 words total.',
          'Keep every sentence at 28 words or fewer.',
          'Use common words at an eighth-grade reading level.',
          'Do not add facts, advice, headings, bullets, or explanations.',
          requiredOpening ? `Begin with this exact sentence: ${requiredOpening}` : '',
          behaviorStages.length ? `Preserve these visible behavior stages: ${behaviorStages.join(', ')}.` : '',
          generationInput.behaviorPlan?.mode === 'defer' ? 'A behavior-only response may use one sentence when necessary.' : ''
        ].filter(Boolean).join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({
          latestPartnerAiPrompt: generationInput.activePrompt.followUpQuestion || generationInput.activePrompt.activeQuestion || generationInput.activePrompt.latestPartnerTurn,
          actorPerspective: generationInput.actorPerspective,
          candidateResponse
        })
      }
    ],
    temperature: 0.1,
    max_tokens: 220
  }));
  const compactValidation = await validateGeneratedResponse(llm, generationInput, compacted);
  return { text: compacted, validation: compactValidation };
}

function isCompactStyleFailure(validation) {
  return /sentence|word limit|required reading level|too complex/i.test(String(validation?.reason ?? ''));
}

function buildGenerationInput(context, promptContext, activeQualityCriteria) {
  const actorPerspective = resolveActorPerspective({
    actorRole: context.actorRole ?? 'requestor',
    actorPersona: context.actorPersona,
    scriptedMode: context.scriptedMode ?? false,
    promptContext,
    transcript: context.transcript,
    topic: context.topic
  });
  return {
    actorRole: context.actorRole ?? 'requestor',
    actorPerspective,
    topic: context.topic,
    testBehaviorPolicy: context.testBehaviorPolicy,
    turnClassification: classifyTurn(promptContext, context.transcript, context.qualityCriteria),
    isRecoveryTurn: isRecoveryTurn(promptContext, context.transcript),
    activeManeuver: context.activeManeuver ? {
      name: context.activeManeuver.name,
      userIntent: context.activeManeuver.userIntent,
      responseStyle: context.activeManeuver.responseStyle,
      successExpectation: context.activeManeuver.successExpectation,
      responseDirective: context.activeManeuver.responseDirective,
      responsePlan: context.activeManeuver.responsePlan
    } : null,
    activePrompt: promptContext,
    activeQualityCriteria,
    scenarioTurn: context.scenarioTurn ?? null,
    turn: context.turn,
    priorSyntheticUserFacts: extractPriorUserFacts(context.transcript)
  };
}

function buildScenarioPolicyDecision(input, behaviorPlan = buildBehaviorCompositionPlan(input.scenarioTurn?.behaviors ?? [])) {
  const scenarioTurn = input.scenarioTurn;
  const assignments = scenarioTurn.behaviors ?? [];
  const directives = assignments.map((assignment) => scenarioBehaviorDirective(assignment)).filter(Boolean);
  const allowsPlannedContradiction = assignments.some((assignment) => assignment.behaviorId === 'contradiction' && assignment.stage === 'contradict_fact');

  return {
    action: behaviorPlan.mode === 'defer' ? 'perform_behavior_only' : 'answer',
    quality: 'high',
    specificity: 'detailed',
    useQualityCriteria: behaviorPlan.mode !== 'defer',
    perspective: input.actorPerspective,
    instructions: [
      'Follow the materialized scenario turn exactly.',
      'Use the shared event and actor interpretation supplied in scenarioTurn; do not replace them with unrelated facts.',
      'Treat every string in scenarioContext.terms[].sharedEvent.facts as an immutable case fact.',
      'When the latest prompt asks for an assessment of performance, results, effectiveness, impact, or working quality, state an evaluation that clearly matches scenarioContext.terms[].interpretation.ratingId and stance.',
      'When the latest prompt instead asks about responsibilities, obstacles, support, development, or future priorities, answer that question naturally and frame it consistently with the assigned rating without inserting an awkward rating statement.',
      'For evaluative prompts with an unsatisfactory rating, explicitly say performance is materially below expectations and explain why favorable evidence is insufficient; never describe it as meeting expectations.',
      'For evaluative prompts with an outstanding rating, explicitly say performance significantly exceeds expectations and explain why the remaining limitation does not outweigh the result.',
      'Use both quantitative and qualitative evidence when answering substantively.',
      behaviorPlan.mode === 'defer'
        ? 'The scheduled behavior takes precedence. Do not include the substantive scenario answer on this turn; it is preserved for a later response.'
        : 'Use the baseScenarioResponse as the substantive answer, changing only what is necessary to visibly perform the scheduled behavior.',
      allowsPlannedContradiction
        ? 'For contradiction:contradict_fact, contradict only the retained earlier fact for that scheduled behavior. Do not contradict the employee role, shared event, project, rating stance, actor perspective, or unrelated retained facts.'
        : '',
      ...directives
    ].filter(Boolean).join(' '),
    mustAddress: [
      ...(behaviorPlan.mode === 'defer' ? [] : ['the latest Partner AI prompt', 'the assigned actor rating interpretation']),
      ...assignments.map((assignment) => `${assignment.behaviorId}:${assignment.stage}`)
    ],
    mustAvoid: [
      'changing the shared event',
      'changing the employee role',
      'answering from the other actor perspective',
      'softening or reversing the assigned rating',
      ...(allowsPlannedContradiction ? ['contradicting anything except the scheduled retained fact'] : [])
    ],
    stopAfterResponse: false,
    reason: assignments.length
      ? `Materialized scenario behavior controls this turn in ${behaviorPlan.mode} mode.`
      : 'Materialized alignment scenario controls this high-quality turn.',
    scenarioControlled: true,
    turnClassification: input.turnClassification
  };
}

export function buildBehaviorCompositionPlan(assignments = []) {
  if (!assignments.length) return { mode: 'scenario', directives: [], delaysScenarioAnswer: false };
  const delayingStages = new Set([
    'clarification_request:request',
    'definition_request:request',
    'example_request:request',
    'uncertainty_expression:expression',
    'skip_current_item:skip_request',
    'off_topic_response:off_topic',
    'embedded_questions:question_only',
    'correction_previous_response:correction_request',
    'add_to_previous_response:identify_prior_question'
  ]);
  const delaysScenarioAnswer = assignments.some((assignment) => delayingStages.has(`${assignment.behaviorId}:${assignment.stage}`));
  return {
    mode: delaysScenarioAnswer ? 'defer' : 'compose',
    delaysScenarioAnswer,
    directives: assignments.map((assignment) => scenarioBehaviorDirective(assignment)),
    stages: assignments.map((assignment) => `${assignment.behaviorId}:${assignment.stage}`)
  };
}

function scenarioBehaviorDirective(assignment) {
  const key = `${assignment.behaviorId}:${assignment.stage}`;
  const directives = {
    'clarification_request:request': 'Ask one concise clarification question about the current prompt and do not answer it yet.',
    'clarification_request:answer_after_help': 'Answer the clarified prompt directly and completely.',
    'definition_request:request': 'Ask Partner AI to define one specific term from the current prompt and do not answer it yet.',
    'definition_request:answer_after_help': 'Use the definition Partner AI supplied, then answer the prompt directly.',
    'example_request:request': 'Ask for one concrete example relevant to the current prompt and do not answer it yet.',
    'example_request:answer_after_help': 'After the example, answer the prompt directly with fresh scenario facts.',
    'uncertainty_expression:expression': 'Express genuine uncertainty about how to answer while staying on topic; do not provide the complete answer yet.',
    'uncertainty_expression:recovery_answer': 'Use Partner AI assistance and provide a complete substantive answer.',
    'skip_current_item:skip_request': 'Explicitly ask to skip the current item for now.',
    'skip_current_item:resurfaced_response': 'When the skipped item is resurfaced, answer it directly and completely.',
    'off_topic_response:off_topic': 'Give ONE short sentence that is clearly unrelated to the configured topic, and do not introduce a different ongoing work subject the interview might follow. Keep it to a single brief aside.',
    'off_topic_response:recovery_answer': 'Explicitly set the digression aside in your first words, then directly answer the CURRENT performance-review question using the scenario facts and the assigned rating. Ignore the off-topic subject entirely.',
    'embedded_questions:question_only': 'Respond only with one question relevant to the current prompt.',
    'embedded_questions:question_at_beginning': 'Begin with a relevant question, then provide substantive scenario information.',
    'embedded_questions:question_in_middle': 'Provide scenario information, place a relevant question in the middle, then continue the answer.',
    'embedded_questions:question_at_end': 'Provide substantive scenario information and end with a relevant question.',
    'correction_previous_response:correction_request': 'State that a retained earlier fact needs correction and identify the earlier subject without yet supplying the corrected value.',
    'correction_previous_response:provide_corrected_fact': 'Provide the corrected value requested by Partner AI.',
    'correction_previous_response:confirm_or_revise': 'Confirm the corrected fact if Partner AI restated it accurately; otherwise clearly revise it.',
    'add_to_previous_response:identify_prior_question': 'State that you want to add information to an earlier answer and identify its subject.',
    'add_to_previous_response:provide_additional_fact': 'Provide the additional retained fact for the earlier answer.',
    'add_to_previous_response:confirm_or_revise': 'Confirm the combined earlier and additional information if accurate; otherwise revise it.',
    'context_reuse:seed_context': 'Provide a memorable concrete fact that will be relevant to a later primary question.',
    'context_reuse:observe_reuse': 'Answer the later prompt consistently with the retained earlier fact.',
    'contradiction:seed_fact': 'Provide a clear concrete fact that can be compared with a later answer.',
    'contradiction:contradict_fact': 'State a conflicting value for the retained earlier fact without acknowledging the conflict.',
    'contradiction:clarify_fact': 'Clarify which value is correct after Partner AI surfaces the conflict.',
    'fatigue_expression:single': `Express ${assignment.fatigueLevel ?? 'moderate'} cognitive fatigue naturally while still following any compatible assigned behavior.`
  };
  return directives[key] ?? `Execute scenario behavior ${key}.`;
}

async function interpretTestBehaviorPolicy(llm, input) {
  if (!input.testBehaviorPolicy?.trim()) return defaultPolicyDecision(input);
  const deterministicDecision = deterministicPolicyDecision(input);
  if (deterministicDecision) return deterministicDecision;

  const rawDecision = await createChatCompletion(llm, {
    messages: [
      {
        role: 'system',
        content: [
          'You are the policy controller for a QA test runner.',
          'Interpret the free-text Test Behavior Policy for the current Partner AI turn.',
          'Return only valid JSON.',
          'The policy controls the synthetic user response. High-quality criteria are reference material only unless the policy asks for high-quality, complete, or criteria-satisfying answers.',
          'If the policy says to answer vaguely, generally, non-specifically, low-quality, incompletely, omit details, or similar, set quality to "low", specificity to "vague", and useQualityCriteria to false.',
          'If the policy distinguishes primary questions from follow-ups, use turnClassification.isPrimaryQuestionTurn and isFollowUpTurn.',
          'Do not invent a response. Decide how the response should be generated.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({
          testBehaviorPolicy: input.testBehaviorPolicy,
          actorRole: input.actorRole,
          topic: input.topic,
          turn: input.turn,
          turnClassification: input.turnClassification,
          activePrompt: input.activePrompt,
          activeQualityCriteria: input.activeQualityCriteria
        })
      }
    ],
    temperature: 0,
    max_tokens: 500,
    response_format: { type: 'json_object' }
  });

  return sanitizePolicyDecision(rawDecision, input);
}

function deterministicPolicyDecision(input) {
  const policy = input.testBehaviorPolicy ?? '';
  const policyPlan = buildPolicyPlan(policy);
  const policyAsksLowQuality = policyRequestsLowQuality(policy);
  const policyMentionsPrimary = /primary question/i.test(policy);
  const policyAsksExample = /\bexamples?\b/i.test(policy);
  const policyAsksClarification = /\bclarification\b|\bclarify\b/i.test(policy);
  const policyAsksDefinition = /\bdefinition\b|\bdefine\b|\bmeaning\b|\bterm\b|\bphrase\b/i.test(policy);
  const policyAsksQuestionAction = policyAsksExample || policyAsksClarification || policyAsksDefinition;
  const policyAsksInitialAnswerGuidance = Boolean(policyPlan.initialResponse?.source === 'answer_guidance');

  if (policyAsksInitialAnswerGuidance && !input.turnClassification.isPrimaryQuestionTurn) {
    return applyPolicyOverlays({
      action: 'answer',
      quality: 'high',
      specificity: 'detailed',
      useQualityCriteria: false,
      perspective: input.actorRole ?? 'synthetic user',
      instructions: [
        'This is a follow-up turn, not the initial primary-question turn.',
        'Answer the latest Partner AI follow-up directly and completely.',
        'Do not limit the response to the first answer-guidance item on follow-up turns.'
      ].join(' '),
      mustAddress: ['the latest Partner AI follow-up'],
      mustAvoid: [],
      stopAfterResponse: false,
      reason: 'Policy plan: initial answer-guidance limit only applies to primary-question turns.',
      turnClassification: input.turnClassification
    }, input);
  }

  if (policyAsksInitialAnswerGuidance && input.turnClassification.isPrimaryQuestionTurn) {
    const guidance = answerGuidanceForInput(input);
    const count = policyPlan.initialResponse?.count ?? 1;
    const selectedGuidance = guidance.slice(0, count);
    const guidanceLabel = selectedGuidance.length
      ? selectedGuidance.map((item) => `"${item}"`).join('; ')
      : 'the first answer-guidance item';
    return applyPolicyOverlays({
      action: 'answer',
      quality: 'medium',
      specificity: 'moderate',
      useQualityCriteria: false,
      perspective: input.actorRole ?? 'synthetic user',
      instructions: [
        `Answer the current primary question by addressing only ${count === 1 ? 'this answer-guidance item' : `these ${count} answer-guidance items`}: ${guidanceLabel}.`,
        'Do not address the remaining answer-guidance bullets in this initial primary-question response.',
        'Leave the other bullets for Partner AI follow-up questions.'
      ].join(' '),
      mustAddress: selectedGuidance.length
        ? selectedGuidance.map((item) => `selected answer-guidance item: ${item}`)
        : ['only the first answer-guidance item'],
      mustAvoid: guidance.slice(count, count + 8).map((item) => `other answer-guidance item: ${item}`),
      stopAfterResponse: false,
      reason: 'Policy plan: Test Behavior Policy asks initial primary-question answers to address only selected answer-guidance items.',
      policyPlan,
      turnClassification: input.turnClassification
    }, input);
  }

  if (policyAsksQuestionAction && policyMentionsPrimary && !input.turnClassification.isPrimaryQuestionTurn) {
    return applyPolicyOverlays({
      action: 'answer',
      quality: 'high',
      specificity: 'detailed',
      useQualityCriteria: false,
      perspective: input.actorRole ?? 'synthetic user',
      instructions: [
        'The Test Behavior Policy only asks for examples, clarifications, or definitions on primary-question turns.',
        'This is a follow-up or continuation, so do not ask Partner AI for another example, clarification, or definition.',
        'Answer the latest Partner AI follow-up directly and substantively.'
      ].join(' '),
      mustAddress: ['the latest Partner AI follow-up'],
      mustAvoid: ['asking Partner AI for another example', 'asking Partner AI for another clarification', 'asking Partner AI for another definition'],
      stopAfterResponse: false,
      reason: 'Primary-question-only question action was not applied because this turn is a follow-up or continuation.',
      turnClassification: input.turnClassification
    }, input);
  }

  if (policyAsksQuestionAction && policyMentionsPrimary && input.turnClassification.isPrimaryQuestionTurn) {
    const actionType = policyAsksExample ? 'example' : policyAsksClarification ? 'clarification' : 'definition';
    return applyPolicyOverlays({
      action: 'ask_question',
      quality: 'medium',
      specificity: 'moderate',
      useQualityCriteria: false,
      perspective: input.actorRole ?? 'synthetic user',
      instructions: `Ask Partner AI for a concise ${actionType} that is directly related to the current primary question before answering it.`,
      mustAddress: [`request a ${actionType} for the current primary question`],
      mustAvoid: ['answering the primary question substantively'],
      stopAfterResponse: false,
      reason: `Deterministic policy override: Test Behavior Policy asks for a ${actionType} on primary questions.`,
      turnClassification: input.turnClassification
    }, input);
  }

  if (policyAsksLowQuality && policyMentionsPrimary && !input.turnClassification.isPrimaryQuestionTurn) {
    return applyPolicyOverlays({
      action: 'answer',
      quality: 'high',
      specificity: 'detailed',
      useQualityCriteria: false,
      perspective: input.actorRole ?? 'synthetic user',
      instructions: [
        'This is not the initial primary-question turn, so do not continue the primary-question vague-answer behavior.',
        'Answer the latest Partner AI follow-up directly and substantively.',
        'Include concrete details, numbers, dates, examples, benchmarks, or metrics when they are relevant to the follow-up.',
        'If Partner AI asks for specifics, provide specifics rather than another general answer.'
      ].join(' '),
      mustAddress: ['the latest Partner AI follow-up with contextually appropriate concrete detail'],
      mustAvoid: [],
      stopAfterResponse: false,
      reason: 'Primary-question-only vague behavior was not applied because this turn is a follow-up or continuation.',
      turnClassification: input.turnClassification
    }, input);
  }

  if (policyAsksLowQuality && !policyMentionsPrimary) {
    return applyPolicyOverlays({
      action: 'answer',
      quality: 'low',
      specificity: 'vague',
      useQualityCriteria: false,
      perspective: input.actorRole ?? 'synthetic user',
      instructions: [
        'Answer the current Partner AI prompt in a deliberately general, non-specific way.',
        'Give only a surface-level answer.',
        'Do not include numbers, percentages, dollar amounts, exact dates, named metrics, named benchmarks, concrete examples, detailed evidence, project names, or quantified results.',
        'Do not satisfy all high-quality criteria; leave obvious room for Partner AI to ask follow-up questions.'
      ].join(' '),
      mustAddress: ['the latest Partner AI prompt at a surface level'],
      mustAvoid: [
        'specific numbers',
        'percentages',
        'dollar amounts',
        'exact dates',
        'detailed examples',
        'named metrics',
        'market benchmarks',
        'complete criteria coverage'
      ],
      stopAfterResponse: false,
      reason: 'Deterministic policy override: Test Behavior Policy requests general, non-specific answers.',
      turnClassification: input.turnClassification
    }, input);
  }

  if (policyAsksLowQuality && policyMentionsPrimary && input.turnClassification.isPrimaryQuestionTurn) {
    return applyPolicyOverlays({
      action: 'answer',
      quality: 'low',
      specificity: 'vague',
      useQualityCriteria: false,
      perspective: input.actorRole ?? 'synthetic user',
      instructions: [
        'Answer the current Partner AI prompt in a deliberately general, non-specific way.',
        'Give only a surface-level answer.',
        'Do not include numbers, percentages, dollar amounts, exact dates, named metrics, named benchmarks, concrete examples, detailed evidence, project names, or quantified results.',
        'Do not satisfy all high-quality criteria; leave obvious room for Partner AI to ask follow-up questions.'
      ].join(' '),
      mustAddress: ['the latest Partner AI prompt at a surface level'],
      mustAvoid: [
        'specific numbers',
        'percentages',
        'dollar amounts',
        'exact dates',
        'detailed examples',
        'named metrics',
        'market benchmarks',
        'complete criteria coverage'
      ],
      stopAfterResponse: false,
      reason: 'Deterministic policy override: Test Behavior Policy requests general, non-specific answers for primary questions.',
      turnClassification: input.turnClassification
    }, input);
  }

  if (policyRequestsDirectAnswersOnly(policy)) {
    const decision = defaultPolicyDecision(input);
    return {
      ...decision,
      reason: [
        'Deterministic policy override: Test Behavior Policy asks the synthetic user to answer each question directly.',
        decision.reason
      ].filter(Boolean).join(' ')
    };
  }

  if (policyRequestsDirectResponse(policy) || policyRequestsVariedQuality(policy) || policyStyleDirective(policy)) {
    const decision = defaultPolicyDecision(input);
    return {
      ...decision,
      reason: [
        'Deterministic policy override: Test Behavior Policy contains direct response, quality, or style requirements.',
        decision.reason
      ].filter(Boolean).join(' ')
    };
  }

  return null;
}

function sanitizePolicyDecision(rawDecision, input) {
  try {
    const parsed = JSON.parse(rawDecision);
    const action = normalizeEnum(parsed.action, ['answer', 'ask_question', 'refuse', 'stop'], 'answer');
    const interpretedQuality = normalizeEnum(parsed.quality, ['high', 'medium', 'low', 'partial'], 'medium');
    const interpretedSpecificity = normalizeEnum(parsed.specificity, ['detailed', 'moderate', 'vague'], 'moderate');
    const lowQualityAllowed = policyRequestsLowQuality(input.testBehaviorPolicy);
    const quality = !lowQualityAllowed && interpretedQuality === 'low' ? 'medium' : interpretedQuality;
    const specificity = !lowQualityAllowed && interpretedSpecificity === 'vague' ? 'moderate' : interpretedSpecificity;
    const useQualityCriteria = typeof parsed.useQualityCriteria === 'boolean'
      ? parsed.useQualityCriteria
      : /high|complete|criteria|quality/i.test(input.testBehaviorPolicy ?? '');

    return applyPolicyOverlays(applyPolicyScope({
      action,
      quality,
      specificity,
      useQualityCriteria,
      perspective: String(parsed.perspective ?? input.actorRole ?? 'synthetic user').slice(0, 200),
      instructions: String(parsed.instructions ?? '').slice(0, 1000),
      mustAddress: arrayOfStrings(parsed.mustAddress).slice(0, 8),
      mustAvoid: arrayOfStrings(parsed.mustAvoid).slice(0, 8),
      stopAfterResponse: Boolean(parsed.stopAfterResponse),
      reason: String(parsed.reason ?? '').slice(0, 500)
    }, input), input);
  } catch {
    return defaultPolicyDecision(input);
  }
}

function applyPolicyScope(decision, input) {
  const policy = input.testBehaviorPolicy ?? '';
  const lowQuality = decision.quality === 'low' || decision.specificity === 'vague';
  const scopedToPrimaryQuestions = /primary questions?/i.test(policy)
    && /(?:if|when|for each|each|every).{0,80}primary questions?/i.test(policy);

  if (lowQuality && scopedToPrimaryQuestions && !input.turnClassification.isPrimaryQuestionTurn) {
    return {
      ...decision,
      quality: 'high',
      specificity: 'detailed',
      useQualityCriteria: false,
      instructions: [
        'This is a follow-up turn, not a primary-question turn.',
        'Answer the latest Partner AI follow-up directly without applying the primary-question-only vague-answer behavior.',
        'Include concrete details, numbers, dates, examples, benchmarks, or metrics when they are relevant to the follow-up.'
      ].join(' '),
      mustAvoid: [],
      turnClassification: input.turnClassification,
      reason: `${decision.reason} Primary-question-only behavior was not applied because this turn is a follow-up.`.trim()
    };
  }

  return decision;
}

function defaultPolicyDecision(input) {
  const policyAsksHighQuality = /high-quality|high quality|complete|satisf(?:y|ies).*criteria|all criteria/i.test(input.testBehaviorPolicy ?? '');
  const policyAsksLowQuality = policyRequestsLowQuality(input.testBehaviorPolicy);

  if (policyAsksLowQuality) {
    return applyPolicyOverlays({
      action: 'answer',
      quality: 'low',
      specificity: 'vague',
      useQualityCriteria: false,
      perspective: input.actorRole ?? 'synthetic user',
      instructions: 'Answer the current Partner AI prompt with a general, non-specific response. Avoid concrete numbers, dates, examples, named metrics, detailed evidence, and fully satisfying all criteria.',
      mustAddress: ['the latest Partner AI prompt at a surface level'],
      mustAvoid: ['specific numbers', 'specific dates', 'detailed examples', 'market benchmarks', 'complete high-quality criteria coverage'],
      stopAfterResponse: false,
      reason: 'The policy asks for vague or non-specific answers.'
    }, input);
  }

  return applyPolicyOverlays({
    action: 'answer',
    quality: policyAsksHighQuality ? 'high' : 'medium',
    specificity: policyAsksHighQuality ? 'detailed' : 'moderate',
    useQualityCriteria: policyAsksHighQuality,
    perspective: input.actorRole ?? 'synthetic user',
    instructions: 'Answer the latest Partner AI prompt directly according to the Test Behavior Policy.',
    mustAddress: [],
    mustAvoid: [],
    stopAfterResponse: false,
    reason: 'Default policy interpretation.'
  }, input);
}

function applyPolicyOverlays(decision, input) {
  const policy = input.testBehaviorPolicy ?? '';
  const styleDirective = policyStyleDirective(policy);
  const variedQuality = policyRequestsVariedQuality(policy);
  const qualityOverlay = variedQuality ? qualityForTurn(input) : null;
  const instructions = [
    decision.instructions,
    styleDirective?.instructions,
    qualityOverlay?.instructions
  ].filter(Boolean).join(' ');
  const mustAddress = [
    ...(decision.mustAddress ?? []),
    ...styleDirective?.mustAddress ?? [],
    ...qualityOverlay?.mustAddress ?? []
  ];
  const mustAvoid = [
    ...(decision.mustAvoid ?? []),
    ...styleDirective?.mustAvoid ?? []
  ];

  return {
    ...decision,
    quality: qualityOverlay?.quality ?? decision.quality,
    specificity: qualityOverlay?.specificity ?? decision.specificity,
    useQualityCriteria: qualityOverlay?.useQualityCriteria ?? decision.useQualityCriteria,
    instructions,
    mustAddress: [...new Set(mustAddress)].slice(0, 10),
    mustAvoid: [...new Set(mustAvoid)].slice(0, 10),
    reason: [
      decision.reason,
      styleDirective ? 'Style overlay applied from Test Behavior Policy.' : '',
      variedQuality ? 'Quality variation overlay applied from Test Behavior Policy.' : ''
    ].filter(Boolean).join(' ')
  };
}

function policyStyleDirective(policy) {
  const text = String(policy ?? '');
  if (/raw emotion|express emotion|emotional|emotion in (?:the )?responses?/i.test(text)) {
    return {
      instructions: [
        'Express raw, candid emotion in the response while still answering the latest Partner AI prompt.',
        'Use emotionally explicit first-person language such as frustration, worry, relief, disappointment, pride, or urgency when it fits the answer.',
        'Do not make the answer purely analytical or detached.'
      ].join(' '),
      mustAddress: ['visible raw emotional reaction tied to the answer'],
      mustAvoid: ['purely analytical detached tone']
    };
  }

  return null;
}

function policyRequestsVariedQuality(policy) {
  return /different qualities|vary (?:the )?qualit|varied qualit|mixed qualit|mix of (?:high|medium|low)/i.test(policy ?? '');
}

function qualityForTurn(input) {
  if (input.isRecoveryTurn) {
    return {
      quality: 'high',
      specificity: 'detailed',
      useQualityCriteria: true,
      instructions: [
        'This is a recovery follow-up where Partner AI is asking for missing or more specific information.',
        'Temporarily override the quality-variation cycle and provide a stronger, more complete answer so the interview can progress.',
        'Include concrete details, numbers, dates, examples, or criteria coverage when the follow-up asks for them.'
      ].join(' '),
      mustAddress: ['recovery-quality response that answers the repeated or missing-detail follow-up']
    };
  }

  const turn = input.turn;
  const sequence = [
    {
      quality: 'high',
      specificity: 'detailed',
      useQualityCriteria: true,
      instructions: 'For this turn, provide a high-quality response with concrete details and enough criteria coverage.',
      mustAddress: ['high-quality response for this turn']
    },
    {
      quality: 'medium',
      specificity: 'moderate',
      useQualityCriteria: false,
      instructions: 'For this turn, provide a moderate response: answer directly with some useful detail, but do not over-complete every possible criterion.',
      mustAddress: ['moderate-quality response for this turn']
    },
    {
      quality: 'low',
      specificity: 'moderate',
      useQualityCriteria: false,
      instructions: 'For this turn, provide a lower-quality response: answer directly but leave gaps that Partner AI could reasonably follow up on. Broad categories are okay, but do not fully cover every requested criterion.',
      mustAddress: ['lower-quality response for this turn']
    }
  ];
  return sequence[Math.max(0, (Number(turn) || 1) - 1) % sequence.length];
}

function policyRequestsDirectResponse(policy) {
  return /direct user response|direct response|answer each primary question|answer every primary question|respond to each question|answer each question/i.test(policy ?? '');
}

function buildPolicyPlan(policy) {
  const text = String(policy ?? '');
  const normalized = normalize(text);
  const initialAnswerGuidance = /(?:initially|initial|first|start(?:ing)?(?: out)?).{0,80}(?:only|just).{0,60}(?:one|1|single).{0,80}(?:answer guidance|guidance suggestions?|guidance bullets?)/i.test(text)
    || /(?:only|just).{0,60}(?:one|1|single).{0,80}(?:answer guidance|guidance suggestions?|guidance bullets?).{0,80}(?:initially|initial|first)/i.test(text)
    || /answer guidance.{0,80}(?:only|just).{0,40}(?:one|1|single)/i.test(text)
    || /(?:one|1|single).{0,40}(?:of the )?(?:answer guidance|guidance suggestions?|guidance bullets?)/i.test(text);

  if (initialAnswerGuidance) {
    return {
      scope: /follow-up|follow up/i.test(text) ? 'primary_initial_then_followups' : 'primary_initial',
      initialResponse: {
        mode: 'partial',
        source: 'answer_guidance',
        count: extractGuidanceCount(normalized)
      },
      followUps: {
        mode: 'answer_directly',
        quality: 'sufficient_to_progress'
      }
    };
  }

  return {};
}

function extractGuidanceCount(normalizedPolicy) {
  const numericMatch = normalizedPolicy.match(/\b(?:exactly\s+)?(\d+)\s+(?:of the\s+)?(?:answer guidance|guidance suggestions?|guidance bullets?)/i);
  if (numericMatch) return Math.max(1, Math.min(8, Number(numericMatch[1]) || 1));
  if (/\b(?:one|single)\b/.test(normalizedPolicy)) return 1;
  return 1;
}

function policyRequestsLowQuality(policy) {
  return /vague|general|non-specific|nonspecific|low-quality|low quality|incomplete|brief|minimal|omit detail|lack detail/i.test(policy ?? '');
}

function answerGuidanceForInput(input) {
  return [
    ...(input.activePrompt?.answerGuidance ?? []),
    ...(input.activeQualityCriteria?.answerGuidance ?? [])
  ]
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index);
}

function policyRequestsDirectAnswersOnly(policy) {
  const normalized = String(policy ?? '')
    .toLowerCase()
    .replace(/[.!,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return /^answer (?:each|every|all) (?:partner ai )?questions?(?: asked)?$/.test(normalized);
}

function classifyTurn(promptContext, transcript = [], qualityCriteria = null) {
  const hasPrimaryQuestion = Boolean(promptContext.primaryQuestion);
  const priorSyntheticUserExists = transcript.some((entry) => entry.role === 'syntheticUser');
  const matchedPrimaryQuestion = findConfiguredPrimaryQuestion(promptContext, qualityCriteria);
  const activeQuestion = normalize(promptContext.activeQuestion);
  const currentPrimaryKey = primaryQuestionKey(promptContext, matchedPrimaryQuestion);
  const previousPartnerPrompt = [...transcript].reverse().find((entry) => entry.role === 'partnerAi')?.promptContext ?? null;
  const previousMatchedPrimaryQuestion = previousPartnerPrompt
    ? findConfiguredPrimaryQuestion(previousPartnerPrompt, qualityCriteria)
    : null;
  const previousPrimaryKey = previousPartnerPrompt
    ? primaryQuestionKey(previousPartnerPrompt, previousMatchedPrimaryQuestion)
    : '';
  const matchedPrimaryInLatestPrompt = matchedPrimaryQuestion && matchedPrimaryQuestion.source !== 'sidebar';
  const primaryChanged = Boolean(currentPrimaryKey && previousPrimaryKey && currentPrimaryKey !== previousPrimaryKey);
  const hasTransitionToPrimary = primaryChanged
    || Boolean(matchedPrimaryInLatestPrompt && !previousPrimaryKey)
    || /let'?s move on to|current primary question/i.test(promptContext.latestPartnerTurn ?? '');
  const hasFollowUpQuestion = Boolean(promptContext.followUpQuestion) && priorSyntheticUserExists && !hasTransitionToPrimary;
  const inferredPrimaryQuestion = hasPrimaryQuestion
    || (!priorSyntheticUserExists && Boolean(matchedPrimaryQuestion))
    || (!priorSyntheticUserExists && Boolean(activeQuestion))
    || hasTransitionToPrimary;
  return {
    isPrimaryQuestionTurn: inferredPrimaryQuestion && !hasFollowUpQuestion,
    isFollowUpTurn: hasFollowUpQuestion,
    hasPrimaryQuestion: inferredPrimaryQuestion,
    discussionArea: promptContext.discussionArea,
    primaryQuestion: promptContext.primaryQuestion || matchedPrimaryQuestion?.question || '',
    configuredPrimaryQuestionId: matchedPrimaryQuestion?.item?.id ?? '',
    configuredPrimaryQuestion: matchedPrimaryQuestion?.item?.question ?? '',
    configuredPrimaryQuestionSource: matchedPrimaryQuestion?.source ?? '',
    currentPrimaryKey,
    previousPrimaryKey,
    activeQuestion: promptContext.activeQuestion
  };
}

function primaryQuestionKey(promptContext, matchedPrimaryQuestion = null) {
  const value = matchedPrimaryQuestion?.item?.id
    || matchedPrimaryQuestion?.item?.question
    || promptContext.primaryQuestion
    || '';
  return normalizeForPrimaryMatch(value);
}

function findConfiguredPrimaryQuestion(promptContext, qualityCriteria) {
  if (!qualityCriteria?.primaryQuestions?.length) return null;

  const latestPartnerTurn = normalizeForPrimaryMatch(promptContext.latestPartnerTurn);
  const activeQuestion = normalizeForPrimaryMatch(promptContext.activeQuestion);
  const extractedPrimaryQuestion = normalizeForPrimaryMatch(promptContext.primaryQuestion);
  const discussionArea = normalize(promptContext.discussionArea);

  for (const item of qualityCriteria.primaryQuestions) {
    const configuredQuestion = normalizeForPrimaryMatch(item.question);
    const configuredArea = normalize(item.discussionArea);
    if (!configuredQuestion) continue;

    if (activeQuestion.includes(configuredQuestion)) return { item, source: 'activeQuestion' };
    if (latestPartnerTurn.includes(configuredQuestion)) return { item, source: 'latestPartnerTurn' };
    if (extractedPrimaryQuestion.includes(configuredQuestion)) return { item, source: 'sidebar' };
    if (configuredArea && discussionArea.includes(configuredArea) && latestPartnerTurn.includes(configuredQuestion)) {
      return { item, source: 'latestPartnerTurn' };
    }
  }

  return null;
}

function normalizeForPrimaryMatch(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\w\s%$]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return allowed.includes(normalized) ? normalized : fallback;
}

function arrayOfStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function buildGenerationMessages(input, correction = null) {
  // High-quality primary-question turns must cover all mandatory answer-guidance
  // points in one go; vague/behavior-only/partial turns stay tight.
  const wantsFullCoverage = input.policyDecision?.useQualityCriteria !== false
    && input.policyDecision?.quality !== 'low'
    && input.policyDecision?.specificity !== 'vague'
    && input.behaviorPlan?.mode !== 'defer';
  const systemContent = [
    'You generate synthetic Requestor/user responses for QA testing a Partner AI interview.',
    'You are the synthetic user for the actorRole and actorPerspective in the input. The actorPerspective defines whose work is being discussed and is authoritative. You are not Partner AI.',
    'A Participant is not necessarily answering about their own job. When actorPerspective is manager_evaluating_employee, answer as the manager about the employee using third-person references to the employee.',
    'When actorPerspective is employee_self_assessment, answer as the employee about your own work in first person.',
    'The latest Partner AI prompt is the controlling input. Answer that prompt directly before considering broader policy context.',
    'The policyDecision is the highest-priority behavioral control for this turn when present.',
    'If policyDecision says quality is low or specificity is vague, do not satisfy all high-quality criteria and do not add details that the policy asks you to avoid.',
    'If policyDecision.useQualityCriteria is false but quality is high or specificity is detailed, answer the latest Partner AI prompt with concrete, contextually appropriate detail without trying to satisfy unrelated criteria.',
    'If policyDecision says to answer a primary question vaguely or generally, provide a plausible but non-specific answer to the current primary question.',
    'Use high-quality criteria only when policyDecision.useQualityCriteria is true or a maneuver responsePlan explicitly requires a full/high-quality answer.',
    'Do not use memorized canned wording, repeated stock phrases, or fixed templates.',
    'If policyDecision explicitly asks for vague or non-specific answers, avoid specific market data, examples, dates, timing details, metrics, and concrete evidence even if Partner AI asks for them.',
    'If policyDecision says the current turn is a follow-up after a primary-question-only vague response, stop being vague and provide the specific details requested by Partner AI.',
    'Otherwise, if Partner AI asks for market data, provide fictional market data. If Partner AI asks for examples, provide examples. If Partner AI asks for timing, address timing. Do not substitute a different criterion.',
    'Do not ask Partner AI clarifying questions unless the policyDecision or active maneuver explicitly says to ask a question.',
    'If a test maneuver is provided, execute that maneuver as the synthetic Requestor/user, even if it means asking a question instead of answering.',
    'If a test maneuver includes a responsePlan, follow the responsePlan over any generic policy text.',
    'For responsePlan answers, respond directly to the latest Partner AI prompt and target criterion. Do not answer a different primary question or criterion.',
    'For responsePlan mode "partial", address only the target criterion and avoid satisfying all remaining criteria.',
    'For responsePlan mode "full", answer the latest Partner AI prompt and cover all remaining mandatory criteria.',
    'If the maneuver has no responsePlan, infer the correct synthetic-user action from the latest Partner AI prompt, Test Behavior Policy, high-quality criteria, userIntent, responseStyle, and prior transcript.',
    'If no test maneuver is provided, answer directly using the grammatical perspective required by actorPerspective.',
    'Never offer to help structure, organize, coach, summarize, recommend, or capture information.',
    'Never say "Would you like me to", "I recommend", or "Here is what I have captured".',
    'Use only fictional, synthetic facts.',
    'Never include real personal data.',
    'Do not mention that you are an AI or that this is a test unless directly useful as synthetic content.',
    'Write at an eighth-grade reading level using common words and short sentences.',
    wantsFullCoverage
      ? 'For a high-quality answer, cover every mandatory answer-guidance point in one compact reply (up to about 6 short sentences or semicolon-separated clauses, ~150 words); never drop a required point just to stay short.'
      : 'Keep every submitted response to no more than 3 sentences and 75 words total.',
    'A behavior-only request may be a single sentence when one sentence is natural.',
    'Keep the answer concise and plausible, but never cut off mid-sentence.',
    'Return a complete, submit-ready answer. If many criteria are requested, cover each briefly rather than leaving the response incomplete.',
    'For questions with many required parts, use one compact paragraph or short semicolon-separated clauses. Avoid long numbered lists unless explicitly requested.',
    'Follow the Test Behavior Policy for initial responses to primary questions.',
    'When high-quality answer criteria are provided, satisfy all mandatory criteria only if the policyDecision or active maneuver asks for high-quality/full criteria coverage.',
    'Use varied wording across turns and across cases while preserving the requested test behavior.'
  ];

  if (input.scenarioTurn) {
    systemContent.push(
      'This is a structured scenario-engine turn.',
      'The scenarioTurn object is authoritative for shared facts, actor perspective, rating interpretation, retained facts, and assigned behavior stages.',
      'The scenarioContext neutralEvidence, canonicalProfile, executiveSummary, dossierAnswer, dossierTermPositions, and scenarioExpression are authoritative for this actor.',
      'Use dossierAnswer as the factual and evaluative foundation for the current primary question. Adapt it to the exact latest prompt or follow-up, but do not replace its role, goals, events, metrics, or rating conclusion.',
      'For each relevant dossierTermPosition, preserve its conclusion, supportingFacts, counterEvidenceExplanation, attribution, consistency, and independence judgment.',
      'Acknowledge counter-evidence when useful, but explain it exactly as this actor dossier does; never collapse the employee and manager into a shared compromise assessment.',
      'For a primary-question answer, begin with the exact employeeOpeningStatement or managerOpeningStatement in scenarioExpression for this actor.',
      'Preserve scenarioExpression.expectedRelationship throughout follow-up answers. Aligned views must remain compatible, while opposite views must remain unmistakably opposed.',
      'Use short sentences and plain language that an eighth-grade reader can understand. Explain why each fact matters.',
      wantsFullCoverage
        ? 'Cover all mandatory answer-guidance points concisely (about 6 short sentences / ~150 words max); do not omit a required point to stay brief.'
        : 'Use no more than 3 sentences and 75 words in the final submitted response.',
      'Avoid corporate or technical jargon when ordinary words will work.',
      'Do not introduce a different workplace event when scenarioTurn provides one.',
      'The Requestor and Participant must describe the same underlying event while interpreting it according to their assigned rating.',
      'Do not invent a new job title, project, metric, baseline, result, expectation, stakeholder, or review period.',
      'Follow actorPerspective exactly. For manager_evaluating_employee, speak as the manager evaluating the employee; do not speak as the employee. For employee_self_assessment, speak as the employee evaluating their own work.',
      'Use the assigned rating stance plainly. Opposite-end ratings must produce plainly opposing evaluations, not merely different emphasis.',
      'When a term\'s assigned ratingId is "unsatisfactory" or "needs_improvement", lead with that conclusion in plain strong language (e.g. materially below expectations / meaningful gaps requiring focused improvement) and do not soften it into a balanced, mixed, or neutral assessment; mention favorable counter-evidence only briefly and explain why it does not change the rating. When the assigned ratingId is "outstanding" or "exceeds_expectations", state that strong conclusion first and do not hedge it down toward "meets expectations".'
    );
    if (input.behaviorPlan) {
      const allowsPlannedContradiction = input.behaviorPlan.stages.includes('contradiction:contradict_fact');
      systemContent.push(
        `Behavior composition mode: ${input.behaviorPlan.mode}.`,
        `Required visible behavior stages: ${input.behaviorPlan.stages.join(', ')}.`,
        input.behaviorPlan.mode === 'defer'
          ? 'Return only the behavior response. Do not include or summarize baseScenarioResponse yet.'
          : 'Preserve the substance of baseScenarioResponse while visibly applying every required behavior stage.',
        'A behavior counts only when its required words or structure are plainly visible in the submitted response. Make the behavior unmistakable: for a clarification, definition, or example request include a direct question; for uncertainty, say plainly that you are unsure or it is hard to judge; for fatigue, say plainly that this is tiring or hard to focus on.',
        allowsPlannedContradiction
          ? 'For contradiction:contradict_fact, the only allowed inconsistency is with the retained fact attached to that scheduled behavior. Keep all immutable scenario facts, role, project, actor perspective, and rating stance unchanged.'
          : ''
      );
    }
  }

  if (correction) {
    systemContent.push(
      'You are revising a prior failed response.',
      `The prior response failed because: ${correction.reason}`,
      `Correction instruction: ${correction.correction}`,
      'The revised answer must be complete and must not end mid-sentence.',
      'Use a concise complete response. If the prompt has many required parts, use compact numbered clauses so every part is completed.'
    );
  }

  return [
    {
      role: 'system',
      content: systemContent.join(' ')
    },
    {
      role: 'user',
      content: JSON.stringify(input)
    }
  ];
}

async function validateGeneratedResponse(llm, input, candidateResponse) {
  const styleCheck = validateCompactResponseStyle(candidateResponse);
  const styleWarnings = styleCheck.warnings ?? [];
  if (isRoleSwappedResponse(candidateResponse, input.activeManeuver, input.policyDecision)) {
    return {
      pass: false,
      reason: 'The response appears role-swapped: it asks Partner AI a coaching or clarification question instead of answering as the synthetic user.',
      correction: 'Rewrite as the synthetic user. Directly answer the latest Partner AI prompt. Do not ask Partner AI what it wants unless the active maneuver explicitly requires a question.'
    };
  }

  const scenarioCheck = validateScenarioResponse(input, candidateResponse);
  if (!scenarioCheck.pass) return scenarioCheck;
  let behaviorCheck = scenarioCheck;
  if (scenarioCheck.semanticReviewRequired?.length) {
    behaviorCheck = await validateSubjectiveBehaviorsWithLlm(llm, input, candidateResponse, scenarioCheck);
    if (!behaviorCheck.pass) return behaviorCheck;
  }
  if (isBehaviorOnlyTurn(input)) {
    return withValidationWarnings(withBehaviorValidation({
      pass: true,
      reason: 'The scheduled behavior-only turn was performed; substantive prompt coverage is intentionally deferred.'
    }, behaviorCheck), styleWarnings);
  }

  const specificityCheck = validateSpecificityAgainstPolicy(input, candidateResponse);
  if (!specificityCheck.pass) return specificityCheck;
  if (specificityCheck.policySatisfied) return withValidationWarnings(withBehaviorValidation(specificityCheck, behaviorCheck), styleWarnings);

  const answerGuidanceScopeCheck = validateInitialAnswerGuidanceScope(input, candidateResponse);
  if (!answerGuidanceScopeCheck.pass) return answerGuidanceScopeCheck;

  const heuristicWarning = getHeuristicWarning(input, candidateResponse);

  const data = await createChatCompletion(llm, {
    messages: [
      {
        role: 'system',
        content: [
          'You are a strict QA judge for a synthetic user response.',
          'Return only valid JSON with keys: pass, reason, correction.',
          'The policyDecision is the highest-priority behavioral control when present.',
          'The actorPerspective field is authoritative. Do not infer perspective merely from the words Requestor or Participant.',
          'When actorPerspective is manager_evaluating_employee, a manager response discussing the employee in third person is correct, even though actorRole is participant.',
          'When actorPerspective is employee_self_assessment, the response should discuss the synthetic user\'s own work in first person.',
          'Do not fail solely because the assigned scenario rating is implicit, softly worded, or expressed with an equivalent phrase. Rating clarity is handled separately as a soft warning.',
          'Only treat rating direction as a hard problem when the candidate directly contradicts the assigned rating.',
          'If policyDecision.useQualityCriteria is false, do not require high-quality criteria coverage.',
          'If policyDecision.action is perform_behavior_only, the response must visibly perform the scheduled behavior and must not be required to answer the substantive prompt yet.',
          'If scenarioTurn.behaviors includes contradiction:contradict_fact, allow a conflict only with the retained fact for that same scheduled contradiction. Still fail contradictions against immutable sharedEvent facts, employee role, project, actor perspective, assigned rating stance, or unrelated retained facts.',
          'If policyDecision.quality is low or policyDecision.specificity is vague, a vague or general response is correct and a detailed high-quality response should fail if it violates mustAvoid.',
          'pass must be true only if the response directly answers the latest Partner AI prompt and follows the active maneuver or responsePlan.',
          'If the active maneuver says partial-answer or responsePlan mode partial, do not require all quality criteria. Judge only whether the requested partial criterion is answered.',
          'If the active maneuver says high-quality-answer or responsePlan mode full, require a complete answer to the latest Partner AI prompt with the required criteria.',
          'Fail if Partner AI asked for one type of information but the response gives a different type.',
          'Fail if the response sounds like Partner AI coaching, summarizes what was captured, or offers to help.',
          'Fail if the response is cut off mid-sentence or visibly incomplete.',
          'Fail if the response is generic enough that it could ignore the latest Partner AI prompt.',
          'A heuristic warning is advisory only. Use judgment: pass a response if it directly answers the latest Partner AI prompt even when keyword matching is imperfect.',
          'Judge coverage ONLY against the provided activeQualityCriteria and answer guidance. Do not require a framework, methodology, formal structure, or detail beyond those listed items.',
          'If the response addresses each listed required criterion in plain language and answers the latest prompt, pass it even if it is brief, informal, or not exhaustive.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({
          latestPartnerAiPrompt: input.activePrompt.followUpQuestion || input.activePrompt.activeQuestion || input.activePrompt.latestPartnerTurn,
          actorRole: input.actorRole,
          actorPerspective: input.actorPerspective,
          activePrompt: input.activePrompt,
          turnClassification: input.turnClassification,
          policyDecision: input.policyDecision,
          activeManeuver: input.activeManeuver,
          activeQualityCriteria: input.activeQualityCriteria,
          scenarioTurn: input.scenarioTurn,
          heuristicWarning,
          candidateResponse
        })
      }
    ],
    model: llm.judgeModel ?? llm.model,
    temperature: 0,
    max_tokens: 600,
    response_format: { type: 'json_object' }
  });

  return withValidationWarnings(withBehaviorValidation(parseValidationResult(data), behaviorCheck), styleWarnings);
}

function isBehaviorOnlyTurn(input) {
  return input.behaviorPlan?.mode === 'defer' || input.policyDecision?.action === 'perform_behavior_only';
}

export function validateScenarioResponse(input, candidateResponse) {
  if (!input.scenarioTurn) return { pass: true };
  const assignments = input.scenarioTurn.behaviors ?? [];
  const behaviorVerification = verifyScenarioBehaviors(candidateResponse, assignments);
  // Only hard-fail behaviors that are NOT softAssertionOnly. Soft behaviors are still
  // recorded (passed:false flows to coverage + soft assertions) but never block/throw.
  const failedBehavior = behaviorVerification.find((item) => item.passed === false && item.blocking !== false && !item.softAssertionOnly);
  if (failedBehavior) {
    return {
      pass: false,
      reason: `The response did not visibly perform ${failedBehavior.behaviorId}:${failedBehavior.stage}. ${failedBehavior.reason}`,
      correction: `${scenarioBehaviorDirective(failedBehavior)} Make that behavior unmistakably visible in the response.`
    };
  }
  const semanticReviewRequired = behaviorVerification.filter((item) => item.passed === null);
  if (input.behaviorPlan?.mode === 'defer') return { pass: true, behaviorVerification, semanticReviewRequired };

  const response = normalize(candidateResponse);
  const terms = input.scenarioTurn.scenarioContext?.terms ?? [];
  const scenarioExpression = input.scenarioTurn.scenarioContext?.scenarioExpression;
  const ratingIds = [...new Set(terms.map((term) => term.interpretation?.ratingId).filter(Boolean))];
  const warnings = [];
  if (input.turnClassification?.isPrimaryQuestionTurn && scenarioExpression && assignments.length === 0) {
    const requiredOpening = input.actorPerspective === 'manager_evaluating_employee'
      ? scenarioExpression.managerOpeningStatement
      : scenarioExpression.employeeOpeningStatement;
    if (requiredOpening && !response.startsWith(normalize(requiredOpening))) {
      return {
        pass: false,
        reason: 'The response does not begin with the required plain-language scenario conclusion.',
        correction: `Begin with this exact sentence: ${requiredOpening} Then answer the question using short, ordinary language and the shared facts.`
      };
    }
  }
  const missingRating = questionRequiresExplicitScenarioRating(input)
    ? ratingIds.find((ratingId) => !responseMatchesRating(response, ratingId))
    : null;
  if (missingRating) {
    if (responseContradictsRating(response, missingRating)) {
      return {
        pass: false,
        reason: `The response directly contradicts the assigned scenario rating: ${missingRating}.`,
        correction: scenarioRatingCorrection(missingRating, input.actorRole)
      };
    }
    warnings.push({
      type: 'scenario_rating_clarity',
      passed: false,
      expected: `Response clearly conveys the assigned ${missingRating} rating without contradicting it.`,
      observed: `Rating language was ambiguous but not contradictory: ${String(candidateResponse).slice(0, 300)}`
    });
  }

  if (input.actorPerspective === 'manager_evaluating_employee' && /\b(?:my role|my performance|i need|i would benefit|my development|my manager)\b/.test(response)) {
    return {
      pass: false,
      reason: 'The participant response speaks as the employee instead of as the manager evaluating the employee.',
      correction: 'Rewrite from the manager perspective. Refer to the employee as the employee, they, or by the synthetic employee name; do not describe the manager as having the employee performance or development need.'
    };
  }

  const immutableFacts = terms.flatMap((term) => term.sharedEvent?.facts ?? []);
  const roleFact = immutableFacts.find((fact) => /employee's role is/i.test(fact));
  const projectFact = immutableFacts.find((fact) => /shared project is/i.test(fact));
  const conflicts = [];
  if (roleFact) {
    const role = roleFact.replace(/^.*employee's role is\s*/i, '').replace(/\.$/, '');
    const otherRole = response.match(/\b(?:role|position)\s+(?:as|is)\s+(?:an?\s+)?([a-z][a-z ]{3,40})/i)?.[1]?.trim();
    if (otherRole && !sameScenarioRole(role, otherRole, response)) conflicts.push(`employee role (${role})`);
  }
  if (projectFact && /\b(?:dashboard|client portfolio|software platform|product launch)\b/.test(response)) {
    const project = normalize(projectFact);
    const allowed = ['dashboard', 'client portfolio', 'software platform', 'product launch'].some((token) => project.includes(token));
    if (!allowed) conflicts.push('shared project');
  }
  if (conflicts.length) {
    return {
      pass: false,
      reason: `The response changes immutable scenario facts: ${conflicts.join(', ')}.`,
      correction: 'Rewrite using only the role, project, metrics, and observations in scenarioTurn.scenarioContext. Do not invent a different job or initiative.'
    };
  }
  return { pass: true, warnings, behaviorVerification, semanticReviewRequired };
}

export function verifyScenarioBehaviors(candidateResponse, assignments = []) {
  const text = String(candidateResponse ?? '').trim();
  return assignments.map((assignment) => {
    const key = `${assignment.behaviorId}:${assignment.stage}`;
    const questionMarks = (text.match(/\?/g) ?? []).length;
    const firstQuestion = text.indexOf('?');
    const lastQuestion = text.lastIndexOf('?');
    const lower = text.toLowerCase();
    let passed = true;
    let blocking = true;
    let reason = 'The required behavior is visible.';
    switch (key) {
      case 'clarification_request:request':
        passed = questionMarks >= 1 && /clarif|what do you mean|which|are you asking|could you explain|can you explain|help me understand/.test(lower);
        break;
      case 'definition_request:request':
        passed = questionMarks >= 1 && /define|what does|what do you mean by|meaning of|what is meant by/.test(lower);
        break;
      case 'example_request:request':
        passed = questionMarks >= 1 && /example|illustrat|what would.*look like|such as|like what/.test(lower);
        break;
      case 'embedded_questions:question_only':
        passed = questionMarks >= 1 && responseWordCount(text) <= 60 && text.endsWith('?');
        break;
      case 'embedded_questions:question_at_beginning':
        passed = questionMarks >= 1 && firstQuestion >= 0 && firstQuestion < Math.max(80, text.length * 0.35) && text.slice(firstQuestion + 1).trim().length >= 30;
        break;
      case 'embedded_questions:question_in_middle':
        passed = questionMarks >= 1 && firstQuestion > Math.min(40, text.length * 0.2) && lastQuestion < text.length - 30;
        break;
      case 'embedded_questions:question_at_end':
        passed = questionMarks >= 1 && text.endsWith('?') && lastQuestion > text.length * 0.65;
        break;
      case 'skip_current_item:skip_request':
        passed = /skip|come back|move on|later/.test(lower);
        break;
      case 'off_topic_response:off_topic':
        if (isClearlyOffTopicResponse(text)) {
          passed = true;
          reason = 'The response is clearly about an unrelated non-work topic.';
        } else {
          passed = null;
          blocking = false;
          reason = 'Whether the response is off-topic requires semantic comparison with the current question.';
        }
        break;
      case 'uncertainty_expression:expression':
        passed = null;
        blocking = false;
        reason = /not\s+(?:entirely\s+)?sure|uncertain|hard to (?:answer|judge|say)|don.?t know|unsure|need (?:some )?help|hesitant|mixed feelings|struggling to answer/.test(lower)
          ? 'Uncertainty language was detected and will receive semantic confirmation.'
          : 'The behavior is subjective and requires semantic review.';
        break;
      case 'correction_previous_response:correction_request':
        passed = /correct|correction|earlier|previous|said before|need to change/.test(lower);
        break;
      case 'add_to_previous_response:identify_prior_question':
        passed = /add|go back|return to|earlier|previous/.test(lower);
        break;
      case 'fatigue_expression:single':
        passed = null;
        blocking = false;
        reason = /tir(?:ed|ing)|drain(?:ed|ing)|exhaust(?:ed|ing)|overwhelm(?:ed|ing)|fatigu(?:e|ed|ing)|hard to (?:focus|concentrate)|worn out|mentally (?:spent|taxed)|stretched thin|running on empty|burn(?:ed|t) out|wearing me down/.test(lower)
          ? 'Fatigue language was detected and will receive semantic confirmation.'
          : 'The behavior is subjective and requires semantic review.';
        break;
      default:
        passed = text.length > 0;
    }
    if (passed === false) reason = 'The required objective response structure is not present.';
    if (passed === null && !reason) reason = 'The behavior is subjective or ambiguous and requires semantic review.';
    return {
      behaviorId: assignment.behaviorId,
      stage: assignment.stage,
      passed,
      blocking,
      reason,
      assignedFatigueLevel: assignment.fatigueLevel,
      softAssertionOnly: assignment.softAssertionOnly !== false
    };
  });
}

export async function validateSubjectiveBehaviorsWithLlm(llm, input, candidateResponse, scenarioCheck) {
  const reviewItems = scenarioCheck.semanticReviewRequired;
  const raw = await createChatCompletion(llm, {
    messages: [
      {
        role: 'system',
        content: [
          'You judge whether a synthetic interview response visibly performs subjective test behaviors.',
          'Judge meaning, not exact keywords or grammatical word forms.',
          'Return only JSON.',
          'behaviorPresent is the hard decision. intensityMatches is advisory and must never make behaviorPresent false.',
          'For fatigue, language such as draining, mentally taxing, frustrating effort, reduced focus, feeling stretched, tired, or overwhelmed can express fatigue.',
          'For uncertainty, hesitation, mixed confidence, difficulty judging, or asking for help can express uncertainty.',
          'For off-topic behavior, decide whether the response is meaningfully unrelated to the Partner AI question.',
          'Quote or briefly paraphrase the evidence that supports your decision.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({
          latestPartnerAiPrompt: input.activePrompt.followUpQuestion || input.activePrompt.activeQuestion || input.activePrompt.latestPartnerTurn,
          candidateResponse,
          behaviors: reviewItems.map((item) => ({
            behaviorId: item.behaviorId,
            stage: item.stage,
            assignedFatigueLevel: item.assignedFatigueLevel
          })),
          requiredShape: {
            checks: [{ behaviorId: 'behavior id', stage: 'stage', behaviorPresent: true, confidence: 0.95, evidence: 'visible evidence', intensityMatches: true, observedIntensity: 'moderate' }]
          }
        })
      }
    ],
    model: llm.judgeModel ?? llm.model,
    temperature: 0,
    max_tokens: 500,
    response_format: { type: 'json_object' }
  });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      pass: false,
      reason: 'The semantic behavior judge returned invalid JSON.',
      correction: 'Make the assigned behavior explicit in ordinary language.'
    };
  }
  const judged = new Map((parsed.checks ?? []).map((item) => [`${item.behaviorId}:${item.stage}`, item]));
  const behaviorVerification = scenarioCheck.behaviorVerification.map((item) => {
    if (item.passed !== null) return item;
    const check = judged.get(`${item.behaviorId}:${item.stage}`);
    return {
      ...item,
      passed: check?.behaviorPresent === true,
      semanticConfidence: Number(check?.confidence ?? 0),
      evidence: check?.evidence ?? '',
      intensityMatches: check?.intensityMatches,
      observedIntensity: check?.observedIntensity
    };
  });
  // Soft behaviors never hard-fail the response; their misses are recorded downstream.
  const failed = behaviorVerification.find((item) => item.passed === false && !item.softAssertionOnly);
  if (failed) {
    return {
      pass: false,
      reason: `The response did not semantically perform ${failed.behaviorId}:${failed.stage}. ${failed.evidence || 'No visible evidence was found.'}`,
      correction: `Express ${failed.behaviorId.replaceAll('_', ' ')} clearly and naturally without relying on one required phrase.`,
      behaviorVerification
    };
  }
  const warnings = [...(scenarioCheck.warnings ?? [])];
  for (const item of behaviorVerification) {
    if (item.passed === true && Number(item.semanticConfidence ?? 1) < 0.65) {
      warnings.push({
        type: 'behavior_confidence',
        passed: false,
        expected: `${item.behaviorId} expressed with clear confidence (>= 0.65).`,
        observed: `Behavior present but low judge confidence (${item.semanticConfidence}). ${item.evidence ?? ''}`.trim()
      });
    }
    if (item.assignedFatigueLevel && item.intensityMatches === false) {
      warnings.push({
        type: 'behavior_intensity',
        passed: false,
        expected: `${item.assignedFatigueLevel} fatigue expression`,
        observed: `${item.observedIntensity ?? 'unclear'} fatigue; behavior presence passed (${item.evidence ?? 'semantic evidence'}).`
      });
    }
  }
  return { pass: true, behaviorVerification, warnings };
}

function responseWordCount(value) {
  return String(value ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function isClearlyOffTopicResponse(value) {
  const text = normalize(value);
  const unrelatedDomains = [
    /\b(garden|gardening|recipe|recipes|cooking|baking|hiking|camping|movie|movies|book|books|novel|music|concert|sports?|football|basketball|baseball|soccer|travel|vacation|restaurant|painting|knitting|yoga|pets?|dog|cat)\b/,
    /\b(community garden|green spaces|city life|weekends?|hobbies?|relax|unwind)\b/
  ];
  const workAnchors = /\b(employee|manager|work|role|project|team|deadline|feedback|coordination|communication|performance|responsib|priority|stakeholder|customer|client|pipeline|dashboard|quality|support|review)\b/;
  if (!unrelatedDomains.some((pattern) => pattern.test(text))) return false;
  const anchorMatches = text.match(workAnchors) ?? [];
  return anchorMatches.length <= 1;
}

function sameScenarioRole(expectedRole, candidateRole, fullResponse = '') {
  const expected = normalizeRole(expectedRole);
  const candidate = normalizeRole(candidateRole);
  const response = normalizeRole(fullResponse);
  const expectedCore = normalizeRole(String(expectedRole ?? '').split(/\s[-–—]\s/)[0]);
  if (!candidate) return true;
  if (candidate === expected || expected.includes(candidate) || candidate.includes(expected)) return true;
  if (expectedCore && (candidate.includes(expectedCore) || response.includes(expectedCore))) return true;
  const expectedTokens = importantRoleTokens(expected);
  if (!expectedTokens.length) return true;
  const candidateText = `${candidate} ${response}`;
  const matched = expectedTokens.filter((token) => candidateText.includes(token)).length;
  return matched >= Math.max(2, Math.ceil(expectedTokens.length * 0.6));
}

function normalizeRole(value) {
  return normalize(value)
    .replace(/\b(?:focused|responsible|ensuring|managing|leading|supporting|for|on|with|in|to|and|the|a|an)\b.*$/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function importantRoleTokens(value) {
  return normalizeRole(value)
    .split(/\s+/)
    .filter((token) => token.length > 2 && !['and', 'the', 'for', 'with', 'role'].includes(token));
}

function withValidationWarnings(result, warnings = []) {
  return {
    ...result,
    warnings: [...(result.warnings ?? []), ...warnings]
  };
}

function withBehaviorValidation(result, behaviorCheck = {}) {
  return {
    ...withValidationWarnings(result, behaviorCheck.warnings ?? []),
    behaviorVerification: behaviorCheck.behaviorVerification ?? []
  };
}

function resolveActorPerspective({ actorRole, actorPersona, scriptedMode }) {
  if (actorPersona === 'employee') return 'employee_self_assessment';
  if (actorPersona === 'manager') return 'manager_evaluating_employee';
  // Backward-compatible fallback for older configs and direct script calls.
  if (scriptedMode) {
    return actorRole === 'participant' ? 'employee_self_assessment' : 'manager_evaluating_employee';
  }
  return actorRole === 'participant' ? 'manager_evaluating_employee' : 'employee_self_assessment';
}

function questionRequiresExplicitScenarioRating(input) {
  const question = normalize([
    input.activePrompt?.activeQuestion,
    input.activePrompt?.followUpQuestion,
    input.scenarioTurn?.scenarioContext?.question?.question
  ].filter(Boolean).join(' '));

  const nonEvaluativePrompt = /\b(?:responsibilit|time and energy|obstacle|harder than|support|clarity|resources?|changes would help|grow into|development|priorities|success be measured)\b/;
  if (nonEvaluativePrompt.test(question)) return false;

  return /\b(?:assessment|assess|performance|performed|progress|wins?|achievement|accomplishment|results?|impact|effective|effectiveness|working|quality|professionalism|communication|coordination|collaboration|value|contribution)\b/.test(question);
}

function responseMatchesRating(response, ratingId) {
  const directPatterns = {
    unsatisfactory: /\b(?:unsatisfactory|materially below expectations|falls materially short|does not meet expectations|well below expectations)\b/,
    needs_improvement: /\b(?:needs improvement|meaningful gaps|requires focused improvement|below expectations)\b/,
    meets_expectations: /\b(?:meets expectations|reliably fulfills expectations|solid performance|satisfactory)\b/,
    exceeds_expectations: /\b(?:exceeds expectations|surpasses normal expectations|above expectations)\b/,
    outstanding: /\b(?:outstanding|significantly exceeds (?:the )?(?:standard |normal |role )?expectations?|consistently surpasses (?:the )?(?:standard |normal |role )?expectations?|exceptional performance)\b/
  };
  if (directPatterns[ratingId]?.test(response)) return true;

  const signalPatterns = {
    unsatisfactory: [
      /\b(?:serious|material|significant|substantial|persistent|repeated) (?:gap|gaps|shortfall|shortfalls|problem|problems|failure|failures)\b/,
      /\b(?:errors?|incomplete detail|rework|fixes|corrections?|quality issues?)\b/,
      /\b(?:inconsistent|unreliable|insufficient|inadequate|ineffective|poorly|missed|delayed|failed)\b/,
      /\b(?:required|requires|needed|needs) (?:frequent |substantial |continued )?(?:manager )?(?:intervention|correction|oversight|support)\b/,
      /\b(?:favorable|positive) (?:evidence|result|results|improvement) (?:is|was|remains?) (?:not |still not )?(?:enough|sufficient|consistent)\b/
    ],
    needs_improvement: [
      /\b(?:needs|requires|should receive) (?:focused |meaningful |additional )?improvement\b/,
      /\b(?:inconsistent|uneven|gaps?|shortfalls?)\b/,
      /\b(?:coaching|closer oversight|corrective action|development plan)\b/
    ],
    meets_expectations: [
      /\b(?:reliable|dependable|competent|effective|solid|consistent)\b/,
      /\b(?:fulfilled|met|delivered) (?:the |normal |role )?(?:requirements|expectations|standard|standards)\b/,
      /\b(?:appropriate|sufficient) for (?:the |this )?role\b/
    ],
    exceeds_expectations: [
      /\b(?:strong|notable|above-standard|better-than-expected)\b/,
      /\b(?:surpassed|outperformed|went beyond)\b/,
      /\b(?:significant|measurable) (?:value|impact|contribution|improvement)\b/
    ],
    outstanding: [
      /\b(?:highly|exceptionally|consistently) (?:effective|successful|reliable|strong|responsive|proactive|impactful)\b/,
      /\b(?:significant|exceptional|substantial|extraordinary) (?:impact|value|contribution|success|improvement|results?)\b/,
      /\b(?:critical|indispensable|leading) (?:contributor|role|impact|factor)\b/,
      /\b(?:consistently|repeatedly) (?:delivered|achieved|demonstrated|performed|produced)\b/,
      /\b(?:far|well|materially) (?:above|beyond) (?:normal )?(?:expectations|standards|requirements)\b/
    ]
  };
  const minimumSignals = ratingId === 'outstanding' || ratingId === 'unsatisfactory' ? 2 : 1;
  const matchedSignals = (signalPatterns[ratingId] ?? []).filter((pattern) => pattern.test(response)).length;
  return matchedSignals >= minimumSignals;
}

function responseContradictsRating(response, ratingId) {
  const contradictions = {
    outstanding: /\b(?:unsatisfactory|materially below expectations|falls materially short|does not meet expectations|well below expectations|performance remains below expectations)\b/,
    exceeds_expectations: /\b(?:unsatisfactory|materially below expectations|does not meet expectations|well below expectations)\b/,
    meets_expectations: /\b(?:unsatisfactory|materially below expectations|well below expectations|outstanding|exceptional performance|significantly exceeds expectations)\b/,
    needs_improvement: /\b(?:outstanding|exceptional performance|significantly exceeds expectations|consistently surpasses expectations)\b/,
    unsatisfactory: /\b(?:meets? (?:the )?(?:normal |role )?expectations?|satisfactory|outstanding|exceptional performance|significantly exceeds (?:the )?(?:standard |normal |role )?expectations?|consistently surpasses expectations|performance is above expectations)\b/
  };
  return contradictions[ratingId]?.test(response) ?? false;
}

function scenarioRatingCorrection(ratingId, actorRole) {
  const subject = actorRole === 'participant' ? "the employee's performance" : 'my performance';
  const phrases = {
    unsatisfactory: `${subject} is materially below expectations; explain why the favorable evidence is insufficient and do not say it meets expectations.`,
    needs_improvement: `${subject} needs improvement and has meaningful gaps that require focused improvement.`,
    meets_expectations: `${subject} meets expectations reliably without overstating it as exceptional.`,
    exceeds_expectations: `${subject} exceeds normal expectations and the evidence supports that conclusion.`,
    outstanding: `${subject} is outstanding and significantly exceeds expectations; explain why the limitation does not outweigh the result.`
  };
  return `Rewrite the answer so it explicitly states that ${phrases[ratingId] ?? `the assigned rating is ${ratingId}`}`;
}

function validateInitialAnswerGuidanceScope(input, candidateResponse) {
  const decisionText = `${input.policyDecision?.reason ?? ''} ${input.policyDecision?.instructions ?? ''}`;
  if (!/initial answer guidance|first answer-guidance|first answer guidance|selected answer-guidance|answer-guidance items/i.test(decisionText)) {
    return { pass: true };
  }

  if (!input.turnClassification?.isPrimaryQuestionTurn) return { pass: true };

  const guidance = answerGuidanceForInput(input);
  if (guidance.length < 2) return { pass: true };

  const response = normalize(candidateResponse);
  const selectedCount = Math.max(1, input.policyDecision?.policyPlan?.initialResponse?.count ?? 1);
  const extraMatches = guidance.slice(selectedCount).filter((item) => guidanceItemMatchesResponse(item, response));
  if (extraMatches.length === 0) return { pass: true };

  const selectedGuidance = guidance.slice(0, selectedCount).join('; ');
  return {
    pass: false,
    reason: `The policy requires the initial primary-question answer to address only the selected answer-guidance item(s), but the response also addresses: ${extraMatches.slice(0, 3).join('; ')}.`,
    correction: [
      `Rewrite the answer to address only this selected answer-guidance item(s): "${selectedGuidance}".`,
      'Do not mention or answer the other answer-guidance bullets until Partner AI asks follow-up questions.'
    ].join(' ')
  };
}

function guidanceItemMatchesResponse(guidanceItem, normalizedResponse) {
  const guidance = normalize(guidanceItem);
  const semanticMatch = guidanceItemSemanticMatch(guidance, normalizedResponse);
  if (semanticMatch !== null) return semanticMatch;

  const tokens = significantTokens(guidanceItem);
  if (tokens.length === 0) return false;
  const matches = tokens.filter((token) => normalizedResponse.includes(token));
  return matches.length >= Math.min(3, tokens.length);
}

function guidanceItemSemanticMatch(normalizedGuidance, normalizedResponse) {
  if (/how .*performed|performed against|performance against/.test(normalizedGuidance)) {
    return /\b(?:i|we|my|our)\b.{0,80}\b(?:met|exceeded|achieved|delivered|completed|closed|reduced|increased|improved|maintained|performed)\b/.test(normalizedResponse)
      || /\b(?:actual results?|results? achieved|outcomes? achieved|performance results?|measured results?|metrics?|quality score|completion rate|satisfaction score|turnaround (?:time|from)|closed \d+|resolved \d+|on-time rate)\b/.test(normalizedResponse)
      || /\b\d+(?:\.\d+)?\s*(?:%|percent|days?|hours?|items?|tickets?|cases?|projects?)\b/.test(normalizedResponse);
  }

  if (/specific details|key achievements|metrics|numeric values|new skills|difficult situations/.test(normalizedGuidance)) {
    return /\b(?:for example|for instance|specifically|achievement|metric|measured|learned|new skill|difficult situation|challenge|customer quote|manager feedback)\b/.test(normalizedResponse)
      || /\b\d+(?:\.\d+)?\s*(?:%|percent|days?|hours?|items?|tickets?|cases?|projects?)\b/.test(normalizedResponse);
  }

  if (/other types of compensation/.test(normalizedGuidance)) {
    return /\b(?:bonus|equity|stock|pto|paid time off|benefits?|commission|incentive|stipend|allowance|title change)\b/.test(normalizedResponse);
  }

  if (/approximate date|effective date|take effect/.test(normalizedGuidance)) {
    return /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|q[1-4]|quarter|payroll cycle|effective|starting|beginning|retroactive|\d{4})\b/.test(normalizedResponse);
  }

  if (/specific raise amount|amount\/range\/percent|raise amount|percentage/.test(normalizedGuidance)) {
    return /\b\d+(?:\.\d+)?\s*(?:%|percent)\b|\$[\d,]+|\b(?:range|increase|raise)\b.{0,30}\b\d+\b/.test(normalizedResponse);
  }

  return null;
}

function significantTokens(text) {
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'they', 'their', 'from', 'into',
    'each', 'such', 'one', 'more', 'will', 'would', 'could', 'should', 'what',
    'when', 'where', 'why', 'how', 'are', 'you', 'your', 'has', 'have', 'had',
    'any', 'all', 'main', 'most', 'right', 'now', 'answer', 'guidance', 'current'
  ]);

  return [...new Set(String(text ?? '')
    .toLowerCase()
    .replace(/[^\w\s%]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 3 && !stopWords.has(token)))];
}

function validateSpecificityAgainstPolicy(input, candidateResponse) {
  const decision = input.policyDecision;
  if (!policyRequestsLowQuality(input.testBehaviorPolicy) || !(decision?.quality === 'low' || decision?.specificity === 'vague')) {
    return { pass: true };
  }

  const text = String(candidateResponse ?? '');
  const violations = [];
  if (/\$[\d,]+|\b\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?\s*percent\b/i.test(text)) violations.push('numbers, percentages, or dollar amounts');
  if (containsSpecificDateOrTimePeriod(text)) violations.push('specific dates or time periods');
  if (/\b(?:for example|for instance|during|in one case|metric|benchmark|median|survey|project|client|deadline|satisfaction|turnaround|retention|revenue|productivity)\b/i.test(text)) violations.push('concrete examples or metrics');

  if (!violations.length) {
    return {
      pass: true,
      policySatisfied: true,
      reason: 'The response satisfies the vague, non-specific policy.'
    };
  }

  return {
    pass: false,
    reason: `The policy requires a vague, non-specific answer, but the response includes ${[...new Set(violations)].join(', ')}.`,
    correction: 'Rewrite as a deliberately general, non-specific answer. Avoid all numbers, percentages, dollar amounts, dates, benchmarks, named metrics, concrete examples, and detailed evidence. Leave room for Partner AI follow-up.'
  };
}

function containsSpecificDateOrTimePeriod(text) {
  const value = String(text ?? '');
  const monthName = '(?:january|february|march|april|may|june|july|august|september|october|november|december)';
  const dateLikePatterns = [
    new RegExp(`\\b${monthName}\\s+\\d{1,2}(?:,\\s*\\d{4})?\\b`, 'i'),
    new RegExp(`\\b${monthName}\\s+\\d{4}\\b`, 'i'),
    new RegExp(`\\b\\d{1,2}\\s+${monthName}\\b`, 'i'),
    /\bq[1-4]\b/i,
    /\b\d{4}\b/,
    /\bnext\s+(?:week|month|quarter|year|payroll cycle)\b/i,
    /\bwithin\s+(?:the\s+)?(?:next\s+)?\d+\s+(?:days|weeks|months|quarters|years)\b/i
  ];

  return dateLikePatterns.some((pattern) => pattern.test(value));
}

function getHeuristicWarning(input, response) {
  const prompt = normalize([
    input.activePrompt.followUpQuestion,
    input.activePrompt.activeQuestion,
    input.activePrompt.latestPartnerTurn
  ].join(' '));
  const text = normalize(response);
  const checks = [
    {
      prompt: /market|benchmark|industry standard|salary compar|compensation compar|median/,
      response: /market|benchmark|industry|median|percentile|salary survey|compensation survey|range|comparable/
    },
    {
      prompt: /specific examples?|for example|example/,
      response: /example|for instance|one case|one project|specific|when i|during/
    },
    {
      prompt: /responsibilit|role expanded|scope|duties|taken on/,
      response: /responsibilit|role|scope|duties|owned|led|managed|took on|expanded/
    },
    {
      prompt: /timing|effective date|payroll|review cycle|budget cycle|july|when/,
      response: /timing|effective|payroll|review|budget|cycle|date|quarter/
    },
    {
      prompt: /amount|7%|base salary|bonus|compensation component|type of compensation/,
      response: /amount|percent|%|base salary|bonus|compensation|salary|increase/
    },
    {
      prompt: /metric|data|measure|quantif|result|outcome/,
      response: /%|\d|metric|data|measure|result|outcome|improved|reduced|increased/
    }
  ];

  const failed = checks.find((check) => check.prompt.test(prompt) && !check.response.test(text));
  if (!failed) return null;

  return 'Keyword heuristic suggests the response may not include the explicit type of information requested by the latest Partner AI prompt. Confirm semantically before failing.';
}

function parseValidationResult(rawText) {
  try {
    const parsed = JSON.parse(extractJsonObjectText(rawText));
    return {
      pass: Boolean(parsed.pass),
      reason: String(parsed.reason ?? ''),
      correction: String(parsed.correction ?? 'Rewrite the response to directly answer the latest Partner AI prompt.')
    };
  } catch {
    return {
      pass: false,
      reason: `Validation returned non-JSON: ${rawText.slice(0, 200)}`,
      correction: 'Rewrite the response to directly answer the latest Partner AI prompt in a concise complete answer.'
    };
  }
}

function extractJsonObjectText(rawText) {
  const text = String(rawText ?? '').trim();
  if (text.startsWith('{')) return text;
  const fenced = text.match(/```(?:json)?\s*({[\s\S]*?})\s*```/i);
  if (fenced) return fenced[1];
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) return text.slice(firstBrace, lastBrace + 1);
  return text;
}

function responseTokenBudget(input, isRetry = false) {
  const planMode = input.activeManeuver?.responsePlan?.mode;
  const style = `${input.activeManeuver?.responseStyle ?? ''} ${planMode ?? ''}`.toLowerCase();

  // Tight tiers for non-substantive turns.
  if (/partial/.test(style)) return isRetry ? 180 : 150;
  if (/question|ask/.test(style)) return isRetry ? 100 : 80;
  if (input.policyDecision?.quality === 'low' || input.policyDecision?.specificity === 'vague') {
    return isRetry ? 150 : 120;
  }
  if (input.policyDecision?.useQualityCriteria === false) return isRetry ? 220 : 180;

  // Full-coverage turns (high-quality answers covering all mandatory guidance)
  // need room to cover every point in one reply; scale with the number of points.
  const guidanceCount = input.scenarioTurn?.scenarioContext?.question?.answerGuidance?.length
    ?? input.activeQualityCriteria?.length ?? 0;
  const coverageBudget = guidanceCount >= 5 ? 520 : guidanceCount >= 3 ? 440 : 360;
  return isRetry ? coverageBudget + 80 : coverageBudget;
}

export function validateCompactResponseStyle(value) {
  const text = String(value ?? '').trim();
  const sentences = countResponseSentences(text);
  const words = text.split(/\s+/).filter(Boolean);
  const longestSentence = Math.max(0, ...splitResponseSentences(text).map((sentence) => sentence.split(/\s+/).filter(Boolean).length));
  const warnings = [];
  if (sentences > 3) {
    warnings.push({
      type: 'response_brevity',
      passed: false,
      expected: 'No more than 3 sentences when possible.',
      observed: `The response has ${sentences} sentences.`
    });
  }
  if (words.length > 75) {
    warnings.push({
      type: 'response_brevity',
      passed: false,
      expected: 'No more than 75 words when possible.',
      observed: `The response has ${words.length} words.`
    });
  }
  if (longestSentence > 28) {
    warnings.push({
      type: 'response_reading_level',
      passed: false,
      expected: 'Short sentences at about an eighth-grade reading level when possible.',
      observed: `The longest sentence has ${longestSentence} words.`
    });
  }
  return { pass: true, warnings };
}

function countResponseSentences(value) {
  return splitResponseSentences(value).length;
}

function splitResponseSentences(value) {
  return String(value ?? '')
    .split(/(?<=[.!?])(?:["')\]]*)\s+|\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function createChatCompletion(llm, body) {
  const requestBody = JSON.stringify({
    model: llm.model,
    ...body
  });
  let lastError = null;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetchWithDeadline('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${llm.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: requestBody
      }, openAiRequestTimeoutMs());

      if (!response.ok) {
        const bodyText = await response.text();
        const error = new Error(`OpenAI response generation failed: ${response.status} ${bodyText}`);
        if (attempt < 4 && isTransientOpenAiStatus(response.status)) {
          lastError = error;
          await delay(1000 * (2 ** (attempt - 1)));
          continue;
        }

        throw error;
      }

      const data = await response.json();
      const text = extractText(data);
      if (!text) {
        throw new Error('OpenAI response generation returned no text.');
      }

      return text;
    } catch (error) {
      if (attempt >= 4 || !isTransientFetchError(error)) {
        throw error;
      }

      lastError = error;
      await delay(1000 * (2 ** (attempt - 1)));
    }
  }

  throw new Error(`OpenAI response generation failed after retries: ${lastError?.message ?? 'unknown error'}`);
}

function isTransientOpenAiStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isTransientFetchError(error) {
  if (isTlsInterceptionError(error)) return false; // cert errors never self-resolve; fail fast
  return /fetch failed|network|socket|timeout|timed out|aborted|terminated|econnreset|etimedout|enotfound|eai_again/i.test(describeError(error));
}

function isTlsInterceptionError(error) {
  return /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|UNABLE_TO_GET_ISSUER_CERT|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_UNTRUSTED/i.test(describeError(error));
}

function describeError(error) {
  const parts = [];
  let current = error;
  while (current && parts.length < 4) {
    const details = [current.message, current.code].filter(Boolean).join(' ');
    if (details && !parts.includes(details)) parts.push(details);
    current = current.cause;
  }
  return parts.join(' | ') || 'unknown error';
}

async function fetchWithDeadline(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`OpenAI request timed out after ${timeoutMs} ms.`)), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`OpenAI request timed out after ${timeoutMs} ms.`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function openAiRequestTimeoutMs() {
  // Large startup prompts (neutral evidence packet, scenario dossiers) routinely
  // need more than 60s, so default to 120s. Still overridable via
  // OPENAI_REQUEST_TIMEOUT_MS. A timeout is a transient error, so createChatCompletion
  // (4 tries) and generateValidatedDossier (2 tries) already retry with this window.
  const configured = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS ?? 120000);
  return Number.isFinite(configured) ? Math.max(5000, configured) : 120000;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecoveryTurn(promptContext, transcript) {
  const priorUserTurnExists = transcript.some((entry) => entry.role === 'syntheticUser');
  const activeQuestion = `${promptContext.activeQuestion} ${promptContext.followUpQuestion}`.toLowerCase();
  return priorUserTurnExists && /can you|could you|provide more|specific|clarify|details|missing|not provided|unmet|help clarify/.test(activeQuestion);
}

function findRelevantCriteria(promptContext, qualityCriteria) {
  if (!qualityCriteria?.primaryQuestions?.length) return null;

  const currentArea = promptContext.discussionArea?.toLowerCase();
  const currentQuestion = promptContext.primaryQuestion?.toLowerCase();
  const activeQuestion = promptContext.activeQuestion?.toLowerCase();

  return qualityCriteria.primaryQuestions.find((item) => {
    const area = item.discussionArea?.toLowerCase();
    const question = item.question?.toLowerCase();

    return (area && currentArea?.includes(area))
      || (question && currentQuestion?.includes(question))
      || (question && activeQuestion?.includes(question));
  }) ?? null;
}

function extractPriorUserFacts(transcript) {
  return transcript
    .filter((entry) => entry.role === 'syntheticUser')
    .slice(-5)
    .map((entry) => entry.text)
    .join('\n\n')
    .slice(0, 2500);
}

function extractText(data) {
  if (typeof data.output_text === 'string') return data.output_text.trim();

  const chatText = data.choices?.[0]?.message?.content;
  if (typeof chatText === 'string') return chatText.trim();

  const responseText = data.output
    ?.flatMap((item) => item.content ?? [])
    ?.map((content) => content.text)
    ?.filter(Boolean)
    ?.join('\n');

  return responseText?.trim() ?? '';
}

function sanitizeGeneratedResponse(text) {
  return text
    .replace(/^["']|["']$/g, '')
    .replace(/\bAs an AI\b[:,]?\s*/gi, '')
    .trim()
    .slice(0, 4000);
}

function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function isRoleSwappedResponse(text, activeManeuver, policyDecision = null) {
  const policyAllowsQuestion = /ask_question|question|clarif|example|definition|define|meaning|term/i.test(
    `${policyDecision?.action ?? ''} ${policyDecision?.instructions ?? ''}`
  );
  const maneuverAllowsQuestion = activeManeuver && /ask|question|clarif|example|definition|define|meaning|term/i.test(
    `${activeManeuver.userIntent ?? ''} ${activeManeuver.responseStyle ?? ''}`
  );
  const allowsQuestion = policyAllowsQuestion || maneuverAllowsQuestion;
  const patterns = [
    /would you like me to/i,
    /i recommend/i,
    /here is what i have captured/i,
    /to help you (structure|organize)/i,
    /thank you for (confirming|asking|your detailed)/i,
    /what i(?:'|’)m looking for/i,
    /please provide specific reasons supporting your request/i
  ];

  if (!allowsQuestion && /could you please (clarify|specify)/i.test(text)) {
    return true;
  }

  return patterns.some((pattern) => pattern.test(text));
}

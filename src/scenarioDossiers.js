const PROMPT_LEAK_PATTERN = /\b(assigned rating|scenario requirement|test requirement|synthetic (?:test|data)|dossier|system prompt|user prompt)\b/i;

export async function generateScenarioDossiers({ llm, topic, scenario, seed, variationPrompt = '', completeJson }) {
  if (!llm?.apiKey) throw new Error('OPENAI_API_KEY is required to generate scenario dossiers.');
  if (typeof completeJson !== 'function') throw new Error('A JSON completion function is required to generate scenario dossiers.');

  // Role diversity is keyed STRICTLY to caseNumber (never store.runId or scenarioSeed):
  // a deterministic sector per case pushes the LLM off its default roles. Injected ONLY
  // into the neutral evidence packet (the single origin of canonicalProfile), so both
  // actor dossiers inherit the identical profile and validateSharedProfile still holds.
  const roleDiversity = buildRoleDiversity({ caseNumber, persona });
  const topicInput = topicDescription(topic);
  const employeeRatings = ratingAssignments(topic, scenario.ratings.requestor);
  const managerRatings = ratingAssignments(topic, scenario.ratings.participant);
  const expressionRequirements = buildExpressionRequirements(topic, scenario);
  const evidencePacket = await generateValidatedDossier({
    llm,
    completeJson,
    actor: 'neutral evidence',
    request: {
      system: [
        'Create a fresh, viewpoint-neutral evidence packet for one fictional workplace performance review.',
        'Return only valid JSON.',
        'The case must be original for this unique seed: invent a new role, goals, projects, events, and metrics.',
        'If a variationRequest is supplied, use it only to vary the workplace role, project setting, metrics, or accomplishment pattern while preserving all required topic terms and scenario relationships.',
        'Do not invent an employee name. Set canonicalProfile.employeeName to "the employee".',
        'Do not write from either the employee or manager viewpoint and do not decide who is correct.',
        'For every performance term, include objective evidence that can independently support both the highest and lowest evaluation when those endpoints are requested.',
        'For an opposite-end pair, include at least one decisive favorable fact such as materially exceeding a documented stretch expectation and at least one separate decisive limiting fact such as materially missing a core expectation.',
        'Keep those facts simultaneously possible: strong outcomes may coexist with weak consistency, dependence on intervention, poor execution in another core duty, or disputed attribution.',
        'Do not make either viewpoint obviously irrational or unsupported.',
        'Include attribution ambiguity, consistency evidence, and independence evidence so opposite evaluations can remain grounded in identical facts.',
        'Use plain language and spell out abbreviations instead of relying on acronyms.',
        'Do not mention testing, scenarios, dossiers, prompts, or assigned ratings.',
        roleDiversity?.directive
      ].filter(Boolean).join(' '),
      input: {
        caseSeed: seed,
        actor: 'neutral',
        variationRequest: cleanVariationPrompt(variationPrompt),
        topic: topicInput,
        interpretiveRangeNeeded: pairRatings(employeeRatings, managerRatings),
        requiredShape: evidencePacketShapeDescription()
      },
      maxTokens: 7500
    },
    normalize: (candidate) => ({
      ...candidate,
      canonicalProfile: { ...candidate.canonicalProfile, employeeName: 'the employee' }
    }),
    validate: (candidate) => validateEvidencePacket(candidate, topic)
  });
  const scenarioExpressionPlan = await generateScenarioExpressionPlan({
    llm,
    completeJson,
    topic,
    topicInput,
    scenario,
    seed,
    evidencePacket,
    employeeRatings,
    managerRatings,
    expressionRequirements
  });

  let employee;
  let manager;
  let pairIssue;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    employee = await generateActorDossier({
      llm,
      completeJson,
      topic,
      topicInput,
      seed,
      actor: 'employee',
      assignedRatings: employeeRatings,
      evidencePacket,
      scenarioExpressionPlan,
      pairIssue
    });
    manager = await generateActorDossier({
      llm,
      completeJson,
      topic,
      topicInput,
      seed,
      actor: 'manager',
      assignedRatings: managerRatings,
      evidencePacket,
      scenarioExpressionPlan,
      otherDossier: employee,
      pairIssue
    });
    try {
      validateSharedProfile(employee, manager, evidencePacket);
      validatePairStructure(employee, manager, topic, employeeRatings, managerRatings);
      const qa = await validatePairWithLlm({
        llm,
        completeJson,
        topicInput,
        scenario,
        evidencePacket,
        scenarioExpressionPlan,
        employee,
        manager,
        employeeRatings,
        managerRatings
      });
      return {
        schemaVersion: 2,
        caseSeed: seed,
        roleDomain: roleDiversity?.input.sector ?? null,
        generatedAt: new Date().toISOString(),
        evidencePacket,
        scenarioExpressionPlan,
        employee,
        manager,
        pairValidation: qa
      };
    } catch (error) {
      pairIssue = error.message;
    }
  }
  throw new Error(`manager scenario dossier generation failed pairwise validation after retry: ${pairIssue}`);
}

function cleanVariationPrompt(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000);
}

async function generateScenarioExpressionPlan({ llm, completeJson, topic, topicInput, scenario, seed, evidencePacket, employeeRatings, managerRatings, expressionRequirements }) {
  return generateValidatedDossier({
    llm,
    completeJson,
    actor: 'scenario expression plan',
    request: {
      system: [
        'Create a plain-language scenario expression plan for paired employee and manager performance-review interviews.',
        'Return only valid JSON.',
        'Create one expression record for every primary question.',
        'Use the same neutral facts for both parties, but make their conclusions match their respective evaluations.',
        'Follow each supplied expectedRelationship exactly. Aligned means compatible conclusions. Slight difference means the same direction with a small difference in confidence or emphasis. Moderate difference means different assessments with meaningful agreement. Strong difference means clearly different conclusions with limited agreement. Opposite means unmistakably opposing conclusions.',
        'State each conclusion in short, direct language an eighth-grade reader can understand.',
        'Spell out abbreviations. Do not use unexplained acronyms.',
        'The relationship explanation must plainly state why the views agree or differ, using ordinary ideas such as results, deadlines, quality, responsibility, consistency, independence, readiness, or support.',
        'Avoid technical jargon and corporate phrases. Do not mention ratings, testing, scenarios, dossiers, or prompts.',
        'Do not invent an employee name. Use first person for employee statements and "the employee" for manager statements.'
      ].join(' '),
      input: {
        caseSeed: seed,
        actor: 'expression',
        topic: topicInput,
        expectedAlignmentRange: scenario.expectedAlignmentRange,
        employeeEvaluations: employeeRatings,
        managerEvaluations: managerRatings,
        expressionRequirements,
        neutralEvidencePacket: evidencePacket,
        requiredShape: expressionPlanShapeDescription()
      },
      maxTokens: 5000
    },
    validate: (candidate) => validateExpressionPlan(candidate, topic, expressionRequirements)
  });
}

async function generateActorDossier({ llm, completeJson, topic, topicInput, seed, actor, assignedRatings, evidencePacket, scenarioExpressionPlan, otherDossier, pairIssue }) {
  const employee = actor === 'employee';
  return generateValidatedDossier({
    llm,
    completeJson,
    actor,
    request: {
      system: [
        `Create the ${actor} interpretation of the supplied neutral workplace evidence.`,
        'Return only valid JSON.',
        employee
          ? 'Write every primary-question answer in first person as the employee assessing their own work.'
          : 'Write every primary-question answer as the manager evaluating the employee. Refer to "the employee" or use third-person pronouns; do not invent a name.',
        'Use only the supplied canonical profile, events, metrics, and term evidence. Do not invent a different workplace story.',
        'For every term, reach the required evaluation plainly and support it with the decisive evidence supplied for that side of the evaluation.',
        'Acknowledge evidence that could support the other viewpoint, then explicitly explain whether the disagreement concerns significance, attribution, consistency, independence, or expectations and why it does not change this actor\'s conclusion.',
        'Carry that evaluative reasoning into the primary-question answers, not only the structured term positions.',
        'For each primary question, begin with the exact opening statement assigned to this actor in the scenario expression plan.',
        'Preserve the expected relationship in that plan. Do not manufacture disagreement for aligned questions or soften disagreement for opposite questions.',
        'Keep each primary-question answer reasonably concise as source material for a later live response.',
        'Use common words suitable for an eighth-grade reader.',
        'Spell out abbreviations instead of using unexplained acronyms.',
        'Explain technical facts in ordinary words and avoid corporate jargon.',
        employee
          ? 'Describe favorable results as meaningful, repeatable contributions attributable to your work when the required evaluation is high.'
          : 'When the required evaluation is low, explain concrete shortcomings, missed expectations, inconsistency, limited independence, or weak attribution even when some outcomes were positive.',
        'Never discuss whether a required evaluation is justified by the test. Speak as a real employee or manager with a sincere workplace judgment.',
        'Do not mention testing, scenarios, dossiers, prompts, or assigned ratings.'
      ].join(' '),
      input: {
        caseSeed: seed,
        actor,
        topic: topicInput,
        assignedRatings,
        neutralEvidencePacket: evidencePacket,
        scenarioExpressionPlan,
        otherPartyInterpretation: otherDossier ?? undefined,
        pairValidationIssueFromPriorAttempt: pairIssue,
        requiredShape: dossierShapeDescription(actor)
      },
      maxTokens: 8000
    },
    normalize: (candidate) => normalizeActorDossier(candidate, actor, evidencePacket, scenarioExpressionPlan),
    validate: (candidate) => validateDossier(candidate, topic, actor, assignedRatings, scenarioExpressionPlan)
  });
}

async function validatePairWithLlm({ llm, completeJson, topicInput, scenario, evidencePacket, scenarioExpressionPlan, employee, manager, employeeRatings, managerRatings }) {
  const qa = await completeJson(llm, {
    system: [
      'Audit a paired employee and manager performance-review dossier.',
      'Return only valid JSON.',
      'Pass only when both parties use the same objective facts, each term clearly supports its required evaluation, and every question expresses its planned relationship.',
      'Aligned questions must remain compatible. Slight, moderate, strong, and opposite relationships must increase in visible difference in that order.',
      'Do not require the employee to know or directly rebut the manager interpretation; the employee interpretation is authored first.',
      'Different treatment of the same counter-evidence counts as meaningful disagreement. For example, one party may treat defects as isolated or externally caused while the other treats them as overriding evidence of weak quality.',
      'Use the structured conclusion, counterEvidenceExplanation, attribution, consistency, and independence fields when judging divergence, not only the wording of primary-question answers.',
      'Audit every primary-question pair against the scenario expression plan. Confirm the required opening statements are present, the expected relationship is expressed, and the language is easy to understand.',
      'Fail if either party mentions testing mechanics, assigned ratings, scenarios, dossiers, or prompts.',
      'Do not rewrite the dossiers.'
    ].join(' '),
    input: {
      expectedAlignmentRange: scenario.expectedAlignmentRange,
      topic: topicInput,
      neutralEvidencePacket: evidencePacket,
      scenarioExpressionPlan,
      employeeRatings,
      managerRatings,
      employee,
      manager,
      requiredShape: {
        pass: true,
        issues: [],
        termChecks: [{ termId: 'term id', employeeSupportsRating: true, managerSupportsRating: true, relationshipMatchesRatings: true, noPromptLeak: true, reason: 'brief reason' }],
        questionChecks: [{ primaryQuestionId: 'question id', openingsPresent: true, relationshipMatchesPlan: true, plainLanguage: true, reason: 'brief reason' }]
      }
    },
    maxTokens: 3000
  });
  const checks = new Map((qa.termChecks ?? []).map((item) => [item.termId, item]));
  const questionChecks = new Map((qa.questionChecks ?? []).map((item) => [item.primaryQuestionId, item]));
  const warnings = [];
  for (const term of topicInput.terms) {
    const check = checks.get(term.id);
    const failedFields = check ? [
      ['employeeSupportsRating', check.employeeSupportsRating],
      ['managerSupportsRating', check.managerSupportsRating],
      ['relationshipMatchesRatings', check.relationshipMatchesRatings],
      ['noPromptLeak', check.noPromptLeak]
    ].filter(([, passed]) => passed !== true).map(([field]) => field) : ['missingTermCheck'];
    if (failedFields.length) {
      warnings.push(`Pair audit warning for term ${term.id}: ${failedFields.join(', ')}${check?.reason ? `; ${check.reason}` : ''}`);
    }
  }
  for (const question of topicInput.primaryQuestions) {
    const check = questionChecks.get(question.id);
    const failedFields = check ? [
      ['openingsPresent', check.openingsPresent],
      ['relationshipMatchesPlan', check.relationshipMatchesPlan],
      ['plainLanguage', check.plainLanguage]
    ].filter(([, passed]) => passed !== true).map(([field]) => field) : ['missingQuestionCheck'];
    if (failedFields.length) {
      warnings.push(`Pair audit warning for question ${question.id}: ${failedFields.join(', ')}${check?.reason ? `; ${check.reason}` : ''}`);
    }
  }
  warnings.push(...(qa?.issues ?? []).map((issue) => `Pair audit issue: ${typeof issue === 'string' ? issue : JSON.stringify(issue)}`));
  return {
    ...qa,
    pass: true,
    advisoryPass: qa?.pass === true && warnings.length === 0,
    warnings
  };
}

async function generateValidatedDossier({ llm, completeJson, request, actor, normalize: normalizeCandidate = (value) => value, validate }) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const candidate = normalizeCandidate(await completeJson(llm, {
        ...request,
        input: { ...request.input, validationIssueFromPriorAttempt: lastError?.message }
      }));
      validate(candidate);
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${actor} scenario dossier generation failed after retry: ${lastError?.message ?? 'unknown validation error'}`);
}

function topicDescription(topic) {
  return {
    topicId: topic.topicId,
    topicName: topic.caseType ?? topic.description ?? topic.topicId,
    terms: topic.terms,
    ratingScale: topic.ratingScale.map((rating) => ({ id: rating.id, label: rating.label, stance: rating.responseProfile.stance })),
    primaryQuestions: topic.primaryQuestions.map((question) => ({
      id: question.id,
      discussionArea: question.discussionArea,
      question: question.question,
      answerGuidance: question.answerGuidance,
      criteria: question.highQualityCriteria
    }))
  };
}

export function relationshipForDistance(distance) {
  return ['aligned', 'slight_difference', 'moderate_difference', 'strong_difference', 'opposite'][Math.max(0, Math.min(4, Number(distance) || 0))];
}

export function buildExpressionRequirements(topic, scenario) {
  const ratingScores = new Map(topic.ratingScale.map((rating) => [rating.id, Number(rating.score)]));
  return topic.primaryQuestions.map((question) => {
    const relevantTermIds = [...new Set([
      question.primaryTermId,
      ...(question.highQualityCriteria ?? []).flatMap((criterion) => criterion.termIds ?? [])
    ].filter(Boolean))];
    const termRelationships = relevantTermIds.map((termId) => {
      const employeeRatingId = scenario.ratings.requestor[termId];
      const managerRatingId = scenario.ratings.participant[termId];
      const employeeScore = ratingScores.get(employeeRatingId);
      const managerScore = ratingScores.get(managerRatingId);
      if (!Number.isFinite(employeeScore) || !Number.isFinite(managerScore)) {
        throw new Error(`Cannot compute scenario relationship for ${termId}; rating scores are missing.`);
      }
      const ratingDistance = Math.abs(employeeScore - managerScore);
      return {
        termId,
        employeeRatingId,
        managerRatingId,
        employeeScore,
        managerScore,
        ratingDistance,
        expectedRelationship: relationshipForDistance(ratingDistance)
      };
    });
    const ratingDistance = Math.max(0, ...termRelationships.map((item) => item.ratingDistance));
    return {
      primaryQuestionId: question.id,
      relevantTermIds,
      termRelationships,
      ratingDistance,
      expectedRelationship: relationshipForDistance(ratingDistance)
    };
  });
}

function ratingAssignments(topic, assignments) {
  const ratings = new Map(topic.ratingScale.map((rating) => [rating.id, rating]));
  return topic.terms.map((term) => {
    const rating = ratings.get(assignments[term.id]);
    return { termId: term.id, term: term.label, ratingId: rating.id, ratingLabel: rating.label, stance: rating.responseProfile.stance };
  });
}

function pairRatings(employeeRatings, managerRatings) {
  const managers = new Map(managerRatings.map((item) => [item.termId, item]));
  return employeeRatings.map((employee) => ({ termId: employee.termId, employee: employee.ratingLabel, manager: managers.get(employee.termId)?.ratingLabel }));
}

function evidencePacketShapeDescription() {
  return {
    canonicalProfile: {
      employeeName: 'the employee', employeeRole: 'fresh role', organizationContext: 'fictional team context', reviewPeriod: 'review period',
      responsibilities: ['at least three'], goals: ['at least three'],
      sharedEvents: [{ id: 'stable id', description: 'objective event', evidence: ['objective evidence'] }],
      metrics: [{ termId: 'topic term id', name: 'metric', baseline: 0, result: 0, standardExpectation: 0, stretchExpectation: 0, unit: 'unit' }]
    },
    termEvidence: [{
      termId: 'topic term id', objectiveFacts: ['facts'], favorableEvidence: ['at least two items'], limitingEvidence: ['at least two items'],
      decisiveFavorableCase: { conclusionBasis: 'why the highest evaluation is reasonable', evidence: ['at least two decisive facts'] },
      decisiveLimitingCase: { conclusionBasis: 'why the lowest evaluation is reasonable', evidence: ['at least two decisive facts'] },
      attributionAmbiguity: ['what is unclear about causation'], consistencyEvidence: ['evidence about repeatability'], independenceEvidence: ['evidence about support or autonomy']
    }],
    primaryQuestionEvidence: [{ primaryQuestionId: 'exact configured question id', relevantTermIds: ['term id'], relevantFactIds: ['event or metric ids'] }]
  };
}

function expressionPlanShapeDescription() {
  return {
    questionExpressions: [{
      primaryQuestionId: 'exact configured question id',
      relevantTermIds: ['exact relevant term ids supplied in expressionRequirements'],
      termRelationships: [{ termId: 'term id', employeeRatingId: 'rating id', managerRatingId: 'rating id', employeeScore: 0, managerScore: 0, ratingDistance: 0, expectedRelationship: 'aligned' }],
      ratingDistance: 0,
      expectedRelationship: 'aligned, slight_difference, moderate_difference, strong_difference, or opposite',
      sharedFacts: ['two or more plain-language facts both parties use'],
      employeeOpeningStatement: 'short first-person conclusion, 18 words or fewer',
      managerOpeningStatement: 'short manager conclusion about the employee, 18 words or fewer',
      employeePosition: 'plain explanation of the employee view',
      managerPosition: 'plain explanation of the manager view',
      relationshipExplanation: 'one plain sentence explaining exactly why the views agree or differ'
    }]
  };
}

function dossierShapeDescription(actor) {
  return {
    canonicalProfile: 'exact copy supplied by the neutral evidence packet',
    executiveSummary: `${actor} perspective summary with clear overall conclusions`,
    termPositions: [{
      termId: 'topic term id', ratingId: 'required rating id', conclusion: 'plain evaluation', supportingFacts: ['at least two specific facts'],
      counterEvidence: ['evidence favoring the other interpretation'], counterEvidenceExplanation: 'why it does not change this conclusion',
      attribution: 'actor judgment about causation', consistency: 'actor judgment about repeatability', independence: 'actor judgment about autonomy or support'
    }],
    primaryQuestionAnswers: [{ primaryQuestionId: 'exact configured question id', answer: `${actor}-voice answer grounded in the term conclusions and evidence` }]
  };
}

function validateEvidencePacket(packet, topic) {
  if (!packet || typeof packet !== 'object') throw new Error('Neutral evidence packet was not valid JSON.');
  validateProfile(packet.canonicalProfile, 'Neutral evidence packet');
  const evidence = new Map((packet.termEvidence ?? []).map((item) => [item.termId, item]));
  const missing = topic.terms.filter((term) => !evidence.has(term.id)).map((term) => term.id);
  if (missing.length) throw new Error(`Neutral evidence packet is missing terms: ${missing.join(', ')}.`);
  for (const term of topic.terms) {
    const item = evidence.get(term.id);
    for (const key of ['objectiveFacts', 'favorableEvidence', 'limitingEvidence', 'attributionAmbiguity', 'consistencyEvidence', 'independenceEvidence']) {
      if (!Array.isArray(item[key]) || item[key].length < (['favorableEvidence', 'limitingEvidence'].includes(key) ? 2 : 1)) {
        throw new Error(`Neutral evidence for ${term.id} needs sufficient ${key}.`);
      }
    }
    for (const key of ['decisiveFavorableCase', 'decisiveLimitingCase']) {
      if (!String(item[key]?.conclusionBasis ?? '').trim() || !Array.isArray(item[key]?.evidence) || item[key].evidence.length < 2) {
        throw new Error(`Neutral evidence for ${term.id} needs a complete ${key}.`);
      }
    }
  }
  const questionEvidence = new Set((packet.primaryQuestionEvidence ?? []).map((item) => item.primaryQuestionId));
  const missingQuestions = topic.primaryQuestions.filter((question) => !questionEvidence.has(question.id)).map((question) => question.id);
  if (missingQuestions.length) throw new Error(`Neutral evidence packet is missing primary-question mappings: ${missingQuestions.join(', ')}.`);
  rejectPromptLeak(packet, 'Neutral evidence packet');
}

function validateExpressionPlan(plan, topic, expressionRequirements) {
  const expressions = new Map((plan?.questionExpressions ?? []).map((item) => [item.primaryQuestionId, item]));
  const requirements = new Map(expressionRequirements.map((item) => [item.primaryQuestionId, item]));
  const missing = topic.primaryQuestions.filter((question) => !expressions.has(question.id)).map((question) => question.id);
  if (missing.length) throw new Error(`Scenario expression plan is missing questions: ${missing.join(', ')}.`);
  for (const question of topic.primaryQuestions) {
    const expression = expressions.get(question.id);
    const requirement = requirements.get(question.id);
    if (!Array.isArray(expression.sharedFacts) || expression.sharedFacts.length < 2) throw new Error(`Expression ${question.id} needs two shared facts.`);
    for (const key of ['employeeOpeningStatement', 'managerOpeningStatement', 'employeePosition', 'managerPosition', 'relationshipExplanation']) {
      if (!String(expression[key] ?? '').trim()) throw new Error(`Expression ${question.id} is missing ${key}.`);
    }
    if (wordCount(expression.employeeOpeningStatement) > 18 || wordCount(expression.managerOpeningStatement) > 18) {
      throw new Error(`Expression ${question.id} opening statements must be 18 words or fewer.`);
    }
    if (expression.expectedRelationship !== requirement.expectedRelationship || Number(expression.ratingDistance) !== requirement.ratingDistance) {
      throw new Error(`Expression ${question.id} changed its computed relationship.`);
    }
    if (stableJson(expression.relevantTermIds) !== stableJson(requirement.relevantTermIds)
      || stableJson(expression.termRelationships) !== stableJson(requirement.termRelationships)) {
      throw new Error(`Expression ${question.id} changed its configured term ratings.`);
    }
    if (requirement.expectedRelationship !== 'aligned'
      && normalize(expression.employeeOpeningStatement) === normalize(expression.managerOpeningStatement)) {
      throw new Error(`Expression ${question.id} does not visibly express its ${requirement.expectedRelationship} relationship.`);
    }
    validatePlainLanguage([expression.employeeOpeningStatement, expression.managerOpeningStatement, expression.relationshipExplanation].join(' '), `Expression ${question.id}`);
  }
  rejectPromptLeak(plan, 'Scenario expression plan');
}

function normalizeActorDossier(candidate, actor, evidencePacket, scenarioExpressionPlan) {
  const expressions = new Map((scenarioExpressionPlan?.questionExpressions ?? []).map((item) => [item.primaryQuestionId, item]));
  return {
    ...candidate,
    canonicalProfile: structuredClone(evidencePacket.canonicalProfile),
    primaryQuestionAnswers: (candidate.primaryQuestionAnswers ?? []).map((item) => {
      const expression = expressions.get(item.primaryQuestionId);
      const opening = actor === 'employee' ? expression?.employeeOpeningStatement : expression?.managerOpeningStatement;
      const answer = String(item.answer ?? '').trim();
      return {
        ...item,
        answer: opening && !normalize(answer).startsWith(normalize(opening)) ? `${opening} ${answer}`.trim() : answer
      };
    })
  };
}

function validateDossier(dossier, topic, actor, assignedRatings, scenarioExpressionPlan) {
  if (!dossier || typeof dossier !== 'object') throw new Error(`${actor} dossier was not valid JSON.`);
  validateProfile(dossier.canonicalProfile, `${actor} dossier`);
  const answers = new Map((dossier.primaryQuestionAnswers ?? []).map((item) => [item.primaryQuestionId, item.answer]));
  const expressions = new Map((scenarioExpressionPlan?.questionExpressions ?? []).map((item) => [item.primaryQuestionId, item]));
  const missing = topic.primaryQuestions.filter((question) => !String(answers.get(question.id) ?? '').trim()).map((question) => question.id);
  if (missing.length) throw new Error(`${actor} dossier is missing primary-question answers: ${missing.join(', ')}.`);
  for (const question of topic.primaryQuestions) {
    const answer = String(answers.get(question.id) ?? '').trim();
    const expression = expressions.get(question.id);
    const opening = actor === 'employee' ? expression?.employeeOpeningStatement : expression?.managerOpeningStatement;
    if (opening && !normalize(answer).startsWith(normalize(opening))) {
      throw new Error(`${actor} answer for ${question.id} does not begin with its required plain-language conclusion.`);
    }
  }
  const positions = new Map((dossier.termPositions ?? []).map((item) => [item.termId, item]));
  const missingTerms = topic.terms.filter((term) => !positions.has(term.id)).map((term) => term.id);
  if (missingTerms.length) throw new Error(`${actor} dossier is missing term positions: ${missingTerms.join(', ')}.`);
  for (const assignment of assignedRatings) {
    const position = positions.get(assignment.termId);
    if (position.ratingId !== assignment.ratingId) throw new Error(`${actor} dossier changed assigned rating ${assignment.termId}=${assignment.ratingId}.`);
    if (!String(position.conclusion ?? '').trim()) throw new Error(`${actor} dossier lacks a conclusion for ${assignment.termId}.`);
    if (!Array.isArray(position.supportingFacts) || position.supportingFacts.length < 2) throw new Error(`${actor} dossier needs two supporting facts for ${assignment.termId}.`);
    if (!Array.isArray(position.counterEvidence) || position.counterEvidence.length < 1 || !String(position.counterEvidenceExplanation ?? '').trim()) {
      throw new Error(`${actor} dossier must reconcile counter-evidence for ${assignment.termId}.`);
    }
  }
  rejectPromptLeak(dossier, `${actor} dossier`);
}

function validateProfile(profile, label) {
  if (!profile?.employeeRole || !profile?.organizationContext) throw new Error(`${label} is missing its canonical profile.`);
  if (!Array.isArray(profile.responsibilities) || profile.responsibilities.length < 3) throw new Error(`${label} needs at least three responsibilities.`);
  if (!Array.isArray(profile.goals) || profile.goals.length < 3) throw new Error(`${label} needs at least three goals.`);
  if (!Array.isArray(profile.sharedEvents) || profile.sharedEvents.length < 1) throw new Error(`${label} needs at least one shared event.`);
  if (!Array.isArray(profile.metrics) || profile.metrics.length < 1) throw new Error(`${label} needs at least one metric.`);
}

function validateSharedProfile(employee, manager, evidencePacket) {
  const canonical = stableJson(evidencePacket.canonicalProfile);
  if (stableJson(employee.canonicalProfile) !== canonical) throw new Error('Employee dossier changed the neutral canonical profile.');
  if (stableJson(manager.canonicalProfile) !== canonical) throw new Error('Manager dossier changed the neutral canonical profile.');
}

function validatePairStructure(employee, manager, topic, employeeRatings, managerRatings) {
  const employeePositions = new Map(employee.termPositions.map((item) => [item.termId, item]));
  const managerPositions = new Map(manager.termPositions.map((item) => [item.termId, item]));
  const employeeAssignments = new Map(employeeRatings.map((item) => [item.termId, item]));
  const managerAssignments = new Map(managerRatings.map((item) => [item.termId, item]));
  for (const term of topic.terms) {
    const employeePosition = employeePositions.get(term.id);
    const managerPosition = managerPositions.get(term.id);
    if (employeeAssignments.get(term.id)?.ratingId !== managerAssignments.get(term.id)?.ratingId
      && normalize(employeePosition.conclusion) === normalize(managerPosition.conclusion)) {
      throw new Error(`Employee and manager reached the same conclusion for differently rated term ${term.id}.`);
    }
  }
}

function rejectPromptLeak(value, label) {
  const text = JSON.stringify(value);
  if (PROMPT_LEAK_PATTERN.test(text)) throw new Error(`${label} leaked test or prompt mechanics.`);
}

function validatePlainLanguage(value, label) {
  const text = String(value ?? '');
  const banned = /\b(?:execution discipline|operational efficiency|material shortfall|architectural decision-making|strategic enablement|cross-functional synergies|value realization|organizational leverage)\b/i;
  if (banned.test(text)) throw new Error(`${label} uses avoidable corporate or technical jargon.`);
  const sentences = text.split(/[.!?]+/).map((item) => item.trim()).filter(Boolean);
  if (sentences.some((sentence) => wordCount(sentence) > 28)) throw new Error(`${label} contains a sentence longer than 28 words.`);
}

function wordCount(value) {
  return String(value ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function normalize(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function stableJson(value) {
  return JSON.stringify(value ?? null);
}

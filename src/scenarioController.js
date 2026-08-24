import {
  behaviorExecutionResultSchema,
  behaviorScheduleSchema,
  materializedScenarioPlanSchema
} from './scenarioSchemas.js';
import { domainRoleForActor } from './roleMapping.js';

const SOURCE_DEPENDENT_BEHAVIORS = new Set([
  'correction_previous_response',
  'add_to_previous_response',
  'context_reuse',
  'contradiction'
]);

export function createScenarioController({
  foundation,
  alignmentScenarioId,
  behaviorSchedule = foundation?.defaultBehaviorSchedule,
  seed,
  requestorRole
}) {
  if (!foundation?.topic || !foundation?.alignmentScenarios || !foundation?.behaviorCatalog) {
    throw new Error('A validated scenario foundation is required.');
  }

  const schedule = behaviorScheduleSchema.parse(behaviorSchedule);
  const scenario = foundation.alignmentScenarios.scenarios.find((item) => item.id === alignmentScenarioId);
  if (!scenario) throw new Error(`Unknown alignment scenario: ${alignmentScenarioId}`);

  const resolvedSeed = resolveSeed(schedule, seed);
  const random = createSeededRandom(resolvedSeed);
  const plan = materializedScenarioPlanSchema.parse({
    schemaVersion: 1,
    seed: resolvedSeed,
    topicId: foundation.topic.topicId,
    alignmentScenarioId: scenario.id,
    behaviorScheduleId: schedule.id,
    sharedEvents: buildSharedEvents({ topic: foundation.topic, scenario, random }),
    behaviors: materializeBehaviors({
      topic: foundation.topic,
      catalog: foundation.behaviorCatalog,
      schedule,
      random
    })
  });

  return new ScenarioController({
    plan,
    topic: foundation.topic,
    scenario,
    behaviorCatalog: foundation.behaviorCatalog,
    requestorRole
  });
}

export class ScenarioController {
  constructor({ plan, topic, scenario, behaviorCatalog, requestorRole }) {
    this.plan = structuredClone(plan);
    this.topic = topic;
    this.scenario = scenario;
    this.behaviorCatalog = behaviorCatalog;
    this.requestorRole = requestorRole ?? 'manager';
    this.behaviorProgress = new Map(
      this.plan.behaviors.map((assignment) => [behaviorAssignmentKey(assignment), {
        status: 'pending',
        activatedAtTurn: null,
        completedAtTurn: null
      }])
    );
    this.retainedFacts = new Map();
    this.corrections = new Map();
    this.deferredScenarioAnswers = new Map();
    this.executionResults = [];
    this.dossiers = null;
  }

  setRequestorRole(requestorRole) {
    if (!['employee', 'manager'].includes(requestorRole)) {
      throw new Error(`Invalid resolved requestor role: ${requestorRole}`);
    }
    this.requestorRole = requestorRole;
  }

  getRequestorRole() {
    return this.requestorRole;
  }

  getPlan() {
    return structuredClone(this.plan);
  }

  setDossiers(dossiers) {
    this.dossiers = structuredClone(dossiers);
    const profile = this.dossiers.evidencePacket?.canonicalProfile ?? this.dossiers.employee.canonicalProfile;
    const neutralEvidence = new Map((this.dossiers.evidencePacket?.termEvidence ?? []).map((item) => [item.termId, item]));
    const employeePositions = new Map(this.dossiers.employee.termPositions.map((item) => [item.termId, item]));
    const managerPositions = new Map(this.dossiers.manager.termPositions.map((item) => [item.termId, item]));
    const canonicalFacts = [
      `The employee's name is ${profile.employeeName}.`,
      `The employee's role is ${profile.employeeRole}.`,
      `The organization context is ${profile.organizationContext}.`,
      `The review period is ${profile.reviewPeriod}.`,
      ...profile.responsibilities.map((item) => `Employee responsibility: ${item}`),
      ...profile.goals.map((item) => `Employee goal: ${item}`),
      ...profile.sharedEvents.flatMap((event) => [
        `Shared event ${event.id}: ${event.description}`,
        ...(event.evidence ?? []).map((item) => `Shared evidence: ${item}`)
      ])
    ];
    for (const event of this.plan.sharedEvents) {
      const employeePosition = employeePositions.get(event.termId);
      const managerPosition = managerPositions.get(event.termId);
      const termEvidence = neutralEvidence.get(event.termId);
      event.facts = [...canonicalFacts];
      event.qualitativeEvidence = [
        ...(termEvidence?.objectiveFacts ?? []),
        ...(termEvidence?.favorableEvidence ?? []),
        ...(termEvidence?.limitingEvidence ?? [])
      ];
      const metric = profile.metrics.find((item) => item.termId === event.termId) ?? profile.metrics[0];
      if (metric && ['baseline', 'result', 'standardExpectation', 'stretchExpectation'].every((key) => Number.isFinite(Number(metric[key])))) {
        event.quantitativeEvidence = [{
          metricId: String(metric.name ?? `${event.termId}_metric`).toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          baseline: Number(metric.baseline),
          result: Number(metric.result),
          standardExpectation: Number(metric.standardExpectation),
          stretchExpectation: Number(metric.stretchExpectation),
          unit: String(metric.unit ?? 'synthetic performance units')
        }];
      }
      // Route each actor to the employee/manager position for the domain role they hold
      // (requestorRole-driven), rather than assuming requestor = employee.
      const interpretationFrom = (position) => ({
        ratingId: position.ratingId,
        stance: position.conclusion,
        evidenceEmphasis: position.supportingFacts,
        counterEvidence: position.counterEvidence,
        counterEvidenceExplanation: position.counterEvidenceExplanation,
        attribution: position.attribution,
        consistency: position.consistency,
        independence: position.independence
      });
      const positionForActor = (actor) =>
        domainRoleForActor(actor, this.requestorRole) === 'employee' ? employeePosition : managerPosition;
      event.actorInterpretations.requestor = interpretationFrom(positionForActor('requestor'));
      event.actorInterpretations.participant = interpretationFrom(positionForActor('participant'));
    }
  }

  getDossiers() {
    return this.dossiers ? structuredClone(this.dossiers) : null;
  }

  validateRoleContracts() {
    if (!this.dossiers) throw new Error('Scenario dossiers must be loaded before validating actor role contracts.');

    const contracts = {};
    for (const actor of ['requestor', 'participant']) {
      const domainRole = domainRoleForActor(actor, this.requestorRole);
      const dossierKey = domainRole;
      const ratingActor = domainRole === 'employee' ? 'requestor' : 'participant';
      const dossier = this.dossiers[dossierKey];
      if (!dossier) throw new Error(`${actor} resolved to ${domainRole}, but the ${dossierKey} dossier is missing.`);

      const positions = new Map((dossier.termPositions ?? []).map((item) => [item.termId, item.ratingId]));
      const mismatches = this.topic.terms.flatMap((term) => {
        const expected = this.scenario.ratings[ratingActor]?.[term.id];
        const actual = positions.get(term.id);
        return expected === actual ? [] : [`${term.id}: expected ${expected}, dossier has ${actual ?? 'no rating'}`];
      });
      if (mismatches.length) {
        throw new Error(`${actor} role contract is invalid (${domainRole}/${dossierKey} dossier): ${mismatches.join('; ')}.`);
      }

      contracts[actor] = {
        domainRole,
        dossier: dossierKey,
        ratingSource: ratingActor,
        perspective: domainRole === 'employee' ? 'employee_self_assessment' : 'manager_evaluating_employee'
      };
    }

    if (contracts.requestor.domainRole === contracts.participant.domainRole) {
      throw new Error('Requestor and participant resolved to the same domain role.');
    }
    return contracts;
  }

  getScenarioContext(actor, primaryQuestionId, criterionId = undefined) {
    const question = this.topic.primaryQuestions.find((item) => item.id === primaryQuestionId);
    if (!question) throw new Error(`Unknown primary question: ${primaryQuestionId}`);
    const criterion = criterionId
      ? question.highQualityCriteria.find((item) => item.id === criterionId)
      : null;
    if (criterionId && !criterion) throw new Error(`Unknown criterion ${criterionId} for ${primaryQuestionId}`);

    const termIds = criterion?.termIds ?? [question.primaryTermId];
    const termIdSet = new Set(termIds);
    const actorDossier = domainRoleForActor(actor, this.requestorRole) === 'employee'
      ? this.dossiers?.employee : this.dossiers?.manager;
    const scenarioExpression = this.dossiers?.scenarioExpressionPlan?.questionExpressions
      ?.find((item) => item.primaryQuestionId === primaryQuestionId);
    // Scope the neutral evidence packet to this question's term(s) so each turn's
    // prompt stays small. The current question's term evidence and its own
    // evidence mapping are kept; only off-question terms/questions are dropped
    // (the per-turn `terms` array below is already scoped to the same term ids).
    const fullPacket = this.dossiers?.evidencePacket ?? null;
    const neutralEvidence = fullPacket
      ? {
          ...fullPacket,
          termEvidence: (fullPacket.termEvidence ?? []).filter((item) => termIdSet.has(item.termId)),
          primaryQuestionEvidence: (fullPacket.primaryQuestionEvidence ?? []).filter((item) => item.primaryQuestionId === primaryQuestionId)
        }
      : null;
    return {
      actor,
      question: structuredClone(question),
      criterion: criterion ? structuredClone(criterion) : null,
      canonicalProfile: actorDossier?.canonicalProfile ? structuredClone(actorDossier.canonicalProfile) : null,
      neutralEvidence: structuredClone(neutralEvidence),
      executiveSummary: actorDossier?.executiveSummary ?? '',
      dossierAnswer: actorDossier?.primaryQuestionAnswers?.find((item) => item.primaryQuestionId === primaryQuestionId)?.answer ?? '',
      dossierTermPositions: structuredClone((actorDossier?.termPositions ?? []).filter((item) => termIdSet.has(item.termId))),
      scenarioExpression: structuredClone(scenarioExpression ?? null),
      terms: termIds.map((termId) => {
        const term = this.topic.terms.find((item) => item.id === termId);
        const sharedEvent = this.plan.sharedEvents.find((item) => item.termId === termId);
        const domainRole = domainRoleForActor(actor, this.requestorRole);
        const scenarioRatingActor = domainRole === 'employee' ? 'requestor' : 'participant';
        return {
          ...structuredClone(term),
          ratingId: this.scenario.ratings[scenarioRatingActor][termId],
          sharedEvent: structuredClone(sharedEvent),
          interpretation: structuredClone(sharedEvent.actorInterpretations[actor])
        };
      })
    };
  }

  getPendingBehaviors({ actor, primaryQuestionId, criterionId = undefined }) {
    // B: criterion-bound stages become eligible on ANY turn of their primary
    // question. Common Ground asks at the primary-question level, so requiring the
    // exact criterion match kept criterion-bound behaviors from ever firing.
    return this.plan.behaviors
      .filter((assignment) => assignment.actor === actor)
      .filter((assignment) => assignment.primaryQuestionId === primaryQuestionId)
      .filter((assignment) => this.behaviorProgress.get(behaviorAssignmentKey(assignment))?.status === 'pending')
      .filter((assignment) => this.isNextBehaviorStage(assignment))
      .sort((left, right) => left.sequence - right.sequence)
      .map((assignment) => structuredClone(assignment));
  }

  activateBehavior(assignment, turn) {
    const progress = this.requireBehaviorProgress(assignment);
    if (progress.status !== 'pending') throw new Error(`Behavior is not pending: ${behaviorAssignmentKey(assignment)}`);
    progress.status = 'active';
    progress.activatedAtTurn = turn;
  }

  completeBehavior(assignment, turn) {
    const progress = this.requireBehaviorProgress(assignment);
    if (progress.status === 'completed') return;
    progress.status = 'completed';
    progress.completedAtTurn = turn;
  }

  deferScenarioAnswer(actor, assignment, response) {
    this.deferredScenarioAnswers.set(deferredAnswerKey(actor, assignment.scheduleItemId), {
      actor,
      scheduleItemId: assignment.scheduleItemId,
      primaryQuestionId: assignment.primaryQuestionId,
      response,
      deferredAt: new Date().toISOString()
    });
  }

  getDeferredScenarioAnswer(actor, assignments = []) {
    for (const assignment of assignments) {
      const deferred = this.deferredScenarioAnswers.get(deferredAnswerKey(actor, assignment.scheduleItemId));
      if (deferred) return structuredClone(deferred);
    }
    return null;
  }

  clearDeferredScenarioAnswer(actor, assignment) {
    this.deferredScenarioAnswers.delete(deferredAnswerKey(actor, assignment.scheduleItemId));
  }

  recordBehaviorExecution(result) {
    const softAssertions = [...(result.softAssertions ?? [])];
    if (result.assignedFatigueLevel && Number.isFinite(result.observedQfi)) {
      const [minimum, maximum] = this.behaviorCatalog.fatigueRanges[result.assignedFatigueLevel];
      softAssertions.push({
        type: 'qfi_range',
        passed: result.observedQfi >= minimum && result.observedQfi <= maximum,
        expected: `${result.assignedFatigueLevel} QFI (${minimum}-${maximum})`,
        observed: `QFI ${result.observedQfi}`
      });
    }
    const parsed = behaviorExecutionResultSchema.parse({ ...result, softAssertions });
    this.executionResults.push(parsed);
    return structuredClone(parsed);
  }

  retainFact({ actor, factId, primaryQuestionId, criterionId, value, context = '' }) {
    const key = retainedFactKey(actor, factId);
    const record = {
      actor,
      factId,
      primaryQuestionId,
      criterionId,
      originalValue: value,
      currentValue: value,
      context,
      history: [{ value, reason: 'initial', at: new Date().toISOString() }]
    };
    this.retainedFacts.set(key, record);
    return structuredClone(record);
  }

  getRetainedFact(actor, factId) {
    const fact = this.retainedFacts.get(retainedFactKey(actor, factId));
    return fact ? structuredClone(fact) : null;
  }

  beginCorrection({ actor, factId, correctedValue }) {
    const key = retainedFactKey(actor, factId);
    const fact = this.retainedFacts.get(key);
    if (!fact) throw new Error(`Cannot correct unknown retained fact: ${factId}`);
    const correction = {
      actor,
      factId,
      originalValue: fact.currentValue,
      proposedValue: correctedValue,
      attempts: 0,
      status: 'awaiting_confirmation'
    };
    this.corrections.set(key, correction);
    return structuredClone(correction);
  }

  resolveCorrection({ actor, factId, confirmed, revisedValue }) {
    const key = retainedFactKey(actor, factId);
    const correction = this.corrections.get(key);
    const fact = this.retainedFacts.get(key);
    if (!correction || !fact) throw new Error(`No active correction for retained fact: ${factId}`);

    correction.attempts += 1;
    if (confirmed) {
      fact.currentValue = correction.proposedValue;
      fact.history.push({ value: fact.currentValue, reason: 'confirmed_correction', at: new Date().toISOString() });
      correction.status = 'confirmed';
      return { correction: structuredClone(correction), fact: structuredClone(fact), capped: false };
    }

    if (revisedValue) correction.proposedValue = revisedValue;
    if (correction.attempts >= 3) {
      fact.currentValue = correction.proposedValue;
      fact.history.push({ value: fact.currentValue, reason: 'correction_cap_reached', at: new Date().toISOString() });
      correction.status = 'noted_after_cap';
      return { correction: structuredClone(correction), fact: structuredClone(fact), capped: true };
    }

    correction.status = 'awaiting_confirmation';
    return { correction: structuredClone(correction), fact: structuredClone(fact), capped: false };
  }

  addToRetainedFact({ actor, factId, additionalValue }) {
    const key = retainedFactKey(actor, factId);
    const fact = this.retainedFacts.get(key);
    if (!fact) throw new Error(`Cannot add to unknown retained fact: ${factId}`);
    fact.currentValue = `${fact.currentValue} ${additionalValue}`.trim();
    fact.history.push({ value: fact.currentValue, reason: 'additional_information', at: new Date().toISOString() });
    return structuredClone(fact);
  }

  getCoverageSummary() {
    const byActor = {};
    for (const actor of ['requestor', 'participant']) {
      const assignments = this.plan.behaviors.filter((item) => item.actor === actor);
      const completed = assignments.filter((item) => this.behaviorProgress.get(behaviorAssignmentKey(item))?.status === 'completed');
      const behaviorIds = [...new Set(assignments.map((item) => item.behaviorId))];
      const completedBehaviorIds = behaviorIds.filter((behaviorId) => {
        const behaviorAssignments = assignments.filter((item) => item.behaviorId === behaviorId);
        // A: count a behavior as covered when its key (lowest-sequence) stage has
        // fired — partial credit. Later stages often depend on Common Ground
        // resurfacing/following up, so requiring every stage scored real firings as 0.
        const primaryStage = behaviorAssignments.reduce((earliest, item) => (item.sequence < earliest.sequence ? item : earliest));
        return this.behaviorProgress.get(behaviorAssignmentKey(primaryStage))?.status === 'completed';
      });
      byActor[actor] = {
        assignedBehaviors: behaviorIds.length,
        completedBehaviors: completedBehaviorIds.length,
        assignedStages: assignments.length,
        completedStages: completed.length,
        missingBehaviorIds: behaviorIds.filter((id) => !completedBehaviorIds.includes(id))
      };
    }

    const softAssertions = this.executionResults.flatMap((result) => result.softAssertions);
    return {
      byActor,
      syntheticUserScenarioCompliant: Object.values(byActor).every((summary) => summary.missingBehaviorIds.length === 0)
        && this.executionResults.every((result) => result.syntheticUserCompliant),
      softAssertions: {
        total: softAssertions.length,
        passed: softAssertions.filter((item) => item.passed).length,
        failed: softAssertions.filter((item) => !item.passed).length
      }
    };
  }

  requireBehaviorProgress(assignment) {
    const key = behaviorAssignmentKey(assignment);
    const progress = this.behaviorProgress.get(key);
    if (!progress) throw new Error(`Unknown materialized behavior: ${key}`);
    return progress;
  }

  isNextBehaviorStage(assignment) {
    const earlierStages = this.plan.behaviors.filter((item) => item.actor === assignment.actor
      && item.scheduleItemId === assignment.scheduleItemId
      && item.behaviorId === assignment.behaviorId
      && item.sequence < assignment.sequence);
    return earlierStages.every((item) => this.behaviorProgress.get(behaviorAssignmentKey(item))?.status === 'completed');
  }
}

function materializeBehaviors({ topic, catalog, schedule, random }) {
  const definitions = new Map(catalog.behaviors.map((behavior) => [behavior.id, behavior]));
  const enabledCandidates = schedule.behaviors.filter((item) => item.enabled);
  const selectedItems = shuffle(enabledCandidates, random).slice(0, schedule.behaviorCountPerActor);
  const baseAssignments = [];

  for (const item of selectedItems) {
    const definition = definitions.get(item.behaviorId);
    if (!definition) throw new Error(`Unknown behavior definition: ${item.behaviorId}`);
    for (let repetition = 0; repetition < item.repetitionsPerActor; repetition += 1) {
      baseAssignments.push(...materializeBehaviorItem({ topic, item, definition, random, repetition }));
    }
  }

  return ['requestor', 'participant'].flatMap((actor) => baseAssignments.map((assignment) => ({
    ...structuredClone(assignment),
    actor
  })));
}

function materializeBehaviorItem({ topic, item, definition, random, repetition }) {
  const stages = definition.stages;
  const usedQuestionIds = new Set();
  const usedCriterionIds = new Set();
  const requiresSource = SOURCE_DEPENDENT_BEHAVIORS.has(item.behaviorId);
  const relationship = requiresSource ? resolveOrderedRelationship(topic, item.target, random) : null;
  const orderedStageTargets = item.behaviorId === 'embedded_questions'
    ? resolveOrderedEmbeddedQuestionTargets(topic, stages, item, random)
    : null;
  const sharedStageTarget = !relationship && !orderedStageTargets
    ? resolveTarget(topic, item.target, random, usedQuestionIds, usedCriterionIds)
    : null;

  return stages.map((stage, sequence) => {
    let resolvedTarget;
    if (relationship) {
      resolvedTarget = relationshipTargetForStage(item.behaviorId, stage, relationship);
    } else if (orderedStageTargets) {
      resolvedTarget = orderedStageTargets[sequence];
    } else if (sharedStageTarget) {
      resolvedTarget = sharedStageTarget;
    } else {
      const stageTarget = item.stageTargets?.[stage] ?? item.target;
      resolvedTarget = resolveTarget(topic, stageTarget, random, usedQuestionIds, usedCriterionIds);
    }

    usedQuestionIds.add(resolvedTarget.primaryQuestionId);
    if (resolvedTarget.criterionId) usedCriterionIds.add(resolvedTarget.criterionId);
    return {
      scheduleItemId: repetition ? `${item.id}#${repetition + 1}` : item.id,
      behaviorId: item.behaviorId,
      actor: 'requestor',
      primaryQuestionId: resolvedTarget.primaryQuestionId,
      criterionId: resolvedTarget.criterionId,
      sourcePrimaryQuestionId: relationship?.source.primaryQuestionId,
      sourceCriterionId: relationship?.source.criterionId,
      stage,
      sequence,
      fatigueLevel: item.fatigueLevel,
      combinedBehaviorIds: item.combineWith
    };
  });
}

function resolveOrderedEmbeddedQuestionTargets(topic, stages, item, random) {
  if (topic.primaryQuestions.length < stages.length) {
    throw new Error(`embedded_questions requires at least ${stages.length} primary questions.`);
  }
  const excluded = new Set(item.target.excludePrimaryQuestionIds ?? []);
  const candidates = topic.primaryQuestions.filter((question) => !excluded.has(question.id));
  if (candidates.length < stages.length) {
    throw new Error(`embedded_questions requires ${stages.length} eligible primary questions after exclusions.`);
  }
  const selectedIds = new Set(shuffle(candidates, random).slice(0, stages.length).map((question) => question.id));
  return topic.primaryQuestions
    .filter((question) => selectedIds.has(question.id))
    .map((question) => ({ primaryQuestionId: question.id }));
}

function relationshipTargetForStage(behaviorId, stage, relationship) {
  if (behaviorId === 'context_reuse' && stage === 'seed_context') return relationship.source;
  if (behaviorId === 'contradiction' && stage === 'seed_fact') return relationship.source;
  return relationship.trigger;
}

function resolveOrderedRelationship(topic, target, random) {
  const questions = topic.primaryQuestions;
  if (questions.length < 2) throw new Error('Source-dependent behaviors require at least two primary questions.');

  let trigger;
  if (target.mode === 'primary_question' || target.mode === 'criterion') {
    trigger = resolveTarget(topic, target, random, new Set(), new Set());
  } else {
    const eligibleQuestions = questions.slice(1);
    const triggerQuestion = choose(eligibleQuestions, random);
    trigger = target.mode === 'random_criterion'
      ? chooseCriterionTarget(triggerQuestion, target.excludeCriterionIds ?? [], random)
      : { primaryQuestionId: triggerQuestion.id };
  }

  const triggerIndex = questions.findIndex((question) => question.id === trigger.primaryQuestionId);
  if (triggerIndex < 1) throw new Error(`Source-dependent behavior target ${trigger.primaryQuestionId} has no earlier primary question.`);
  const sourceQuestion = choose(questions.slice(0, triggerIndex), random);
  const source = {
    primaryQuestionId: sourceQuestion.id,
    criterionId: choose(sourceQuestion.highQualityCriteria, random)?.id
  };
  return { source, trigger };
}

function resolveTarget(topic, target, random, usedQuestionIds, usedCriterionIds) {
  if (target.mode === 'primary_question') {
    requireQuestion(topic, target.primaryQuestionId);
    return { primaryQuestionId: target.primaryQuestionId };
  }

  if (target.mode === 'criterion') {
    const question = requireQuestion(topic, target.primaryQuestionId);
    requireCriterion(question, target.criterionId);
    return { primaryQuestionId: question.id, criterionId: target.criterionId };
  }

  if (target.mode === 'random_primary_question') {
    const excluded = new Set([...(target.excludePrimaryQuestionIds ?? []), ...usedQuestionIds]);
    const candidates = topic.primaryQuestions.filter((question) => !excluded.has(question.id));
    if (!candidates.length) throw new Error('No unused primary question remains for randomized behavior placement.');
    return { primaryQuestionId: choose(candidates, random).id };
  }

  const excluded = new Set([...(target.excludeCriterionIds ?? []), ...usedCriterionIds]);
  const candidates = topic.primaryQuestions.flatMap((question) => question.highQualityCriteria
    .filter((criterion) => !excluded.has(criterion.id))
    .map((criterion) => ({ primaryQuestionId: question.id, criterionId: criterion.id })));
  if (!candidates.length) throw new Error('No unused criterion remains for randomized behavior placement.');
  return choose(candidates, random);
}

function chooseCriterionTarget(question, excludedCriterionIds, random) {
  const excluded = new Set(excludedCriterionIds);
  const candidates = question.highQualityCriteria.filter((criterion) => !excluded.has(criterion.id));
  if (!candidates.length) return { primaryQuestionId: question.id };
  return { primaryQuestionId: question.id, criterionId: choose(candidates, random).id };
}

function buildSharedEvents({ topic, scenario, random }) {
  const ratingById = new Map(topic.ratingScale.map((rating) => [rating.id, rating]));
  const caseAnchor = buildCaseAnchor(topic, random);

  return topic.terms.map((term, index) => {
    const relatedQuestions = topic.primaryQuestions.filter((question) => question.primaryTermId === term.id
      || question.highQualityCriteria.some((criterion) => criterion.termIds.includes(term.id)));
    const requestorRating = ratingById.get(scenario.ratings.requestor[term.id]);
    const participantRating = ratingById.get(scenario.ratings.participant[term.id]);
    const evidence = buildNeutralEvidence(requestorRating.score, participantRating.score, random);

    return {
      id: `shared_event_${index + 1}_${term.id}`,
      termId: term.id,
      relatedPrimaryQuestionIds: relatedQuestions.map((question) => question.id),
      synthesisDirective: [
        `Use the existing synthetic workplace record about ${term.label}; do not create a different role, project, or organization.`,
        `Ground it in these topic questions: ${relatedQuestions.map((question) => question.question).join(' | ')}.`,
        'Preserve the same objective event, people, dates, and evidence for both actors.',
        'Include both favorable evidence and a credible limitation so rating-dependent interpretations remain meaningful.',
        'Use fresh contextual wording and do not copy this directive into an interview response.'
      ].join(' '),
      facts: [
        `The employee's role is ${caseAnchor.role}.`,
        `The shared project is ${caseAnchor.project}.`,
        `The employee and manager are discussing the same ${caseAnchor.reviewPeriod} performance review.`,
        `The shared event concerns ${term.label.toLowerCase()} during that project.`,
        `The objective outcome index improved from ${evidence.baseline} to ${evidence.result}; the normal expectation is ${evidence.standardExpectation} and the stretch expectation is ${evidence.stretchExpectation}.`,
        `Both parties observed ${caseAnchor.favorableObservation}.`,
        `Both parties also observed ${caseAnchor.limitationObservation}.`
      ],
      quantitativeEvidence: [{
        metricId: `${term.id}_outcome_index`,
        baseline: evidence.baseline,
        result: evidence.result,
        standardExpectation: evidence.standardExpectation,
        stretchExpectation: evidence.stretchExpectation,
        unit: 'synthetic performance index points'
      }],
      qualitativeEvidence: [
        'A stakeholder observed a useful contribution associated with the event.',
        'A stakeholder also observed a limitation involving consistency, execution, quality, communication, or judgement.'
      ],
      actorInterpretations: {
        requestor: buildActorInterpretation(requestorRating, evidence),
        participant: buildActorInterpretation(participantRating, evidence)
      }
    };
  });
}

function buildCaseAnchor(topic, random) {
  const projectOptions = [
    'a cross-functional workflow modernization rollout',
    'a customer-service process redesign',
    'an internal delivery and reporting improvement initiative'
  ];
  const roleOptions = ['Senior Project Manager', 'Senior Operations Manager', 'Program Delivery Lead'];
  return {
    topicLabel: topic.name ?? topic.topicId,
    role: choose(roleOptions, random),
    project: choose(projectOptions, random),
    reviewPeriod: 'annual',
    favorableObservation: 'the employee completed important deliverables and produced measurable improvement',
    limitationObservation: 'deadlines, handoffs, and communication were not consistently reliable without manager intervention'
  };
}

function buildNeutralEvidence(requestorScore, participantScore, random) {
  const aligned = requestorScore === participantScore;
  const average = (requestorScore + participantScore) / 2;
  const jitter = Math.floor(random() * 5) - 2;
  const standardExpectation = 80;
  const stretchExpectation = 95;
  const result = aligned
    ? [58, 70, 82, 91, 101][requestorScore] + jitter
    : Math.round(70 + average * 6) + jitter;
  return {
    baseline: Math.max(40, result - 11),
    result,
    standardExpectation,
    stretchExpectation
  };
}

function buildActorInterpretation(rating, evidence) {
  const high = rating.score >= 3;
  const low = rating.score <= 1;
  const emphasis = high
    ? [
        `Emphasize the ${evidence.result - evidence.baseline}-point improvement from baseline.`,
        `Explain the favorable organizational value while acknowledging the ${Math.max(0, evidence.stretchExpectation - evidence.result)}-point stretch gap when relevant.`
      ]
    : low
      ? [
          `Emphasize the ${Math.max(0, evidence.standardExpectation - evidence.result)}-point standard gap and the ${Math.max(0, evidence.stretchExpectation - evidence.result)}-point stretch gap.`,
          'Explain why the favorable evidence was not sufficiently consistent, complete, or impactful.'
        ]
      : [
          `Balance the ${evidence.result - evidence.baseline}-point improvement against the remaining expectation gaps.`,
          'Describe competent performance without exaggerating strengths or weaknesses.'
        ];
  return {
    ratingId: rating.id,
    stance: rating.responseProfile.stance,
    evidenceEmphasis: emphasis
  };
}

function requireQuestion(topic, questionId) {
  const question = topic.primaryQuestions.find((item) => item.id === questionId);
  if (!question) throw new Error(`Unknown primary question target: ${questionId}`);
  return question;
}

function requireCriterion(question, criterionId) {
  const criterion = question.highQualityCriteria.find((item) => item.id === criterionId);
  if (!criterion) throw new Error(`Unknown criterion target ${criterionId} for ${question.id}`);
  return criterion;
}

function resolveSeed(schedule, seed) {
  if (schedule.seedStrategy === 'fixed') return schedule.fixedSeed || seed || 'fixed-scenario-seed';
  if (schedule.seedStrategy === 'random') return seed || `${Date.now()}-${Math.random()}`;
  return seed || `run-${Date.now()}`;
}

function createSeededRandom(seed) {
  let state = hashSeed(seed);
  return () => {
    state |= 0;
    state = state + 0x6D2B79F5 | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function hashSeed(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function shuffle(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function choose(values, random) {
  if (!values.length) return null;
  return values[Math.floor(random() * values.length)];
}

function behaviorAssignmentKey(assignment) {
  return [assignment.actor, assignment.scheduleItemId, assignment.behaviorId, assignment.stage, assignment.sequence].join(':');
}

function deferredAnswerKey(actor, scheduleItemId) {
  return `${actor}:${scheduleItemId}`;
}

function retainedFactKey(actor, factId) {
  return `${actor}:${factId}`;
}

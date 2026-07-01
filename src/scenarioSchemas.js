import { z } from 'zod';

export const ratingLevelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  score: z.number().int().nonnegative(),
  responseProfile: z.object({
    stance: z.string().min(1),
    evidenceStrength: z.enum(['weak', 'moderate', 'strong']),
    evidenceMix: z.array(z.enum(['quantitative', 'qualitative'])).min(1)
  })
});

export const topicTermSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1)
});

export const highQualityCriterionSchema = z.object({
  id: z.string().min(1),
  requirement: z.string().min(1),
  required: z.boolean(),
  label: z.string().optional(),
  termIds: z.array(z.string().min(1)).min(1)
});

export const primaryQuestionSchema = z.object({
  id: z.string().min(1),
  discussionArea: z.string().min(1),
  question: z.string().min(1),
  primaryTermId: z.string().min(1),
  answerGuidance: z.array(z.string().min(1)).min(1),
  highQualityCriteria: z.array(highQualityCriterionSchema).min(1),
  voluntaryCoverageRequirement: z.string().min(1)
});

export const topicDefinitionSchema = z.object({
  schemaVersion: z.literal(2),
  topicId: z.string().min(1),
  caseType: z.string().min(1),
  description: z.string().min(1),
  workflow: z.object({
    actors: z.array(z.enum(['requestor', 'participant'])).min(1),
    factStatementLabel: z.string().min(1),
    postProcessingTimeoutMs: z.number().int().positive()
  }),
  terms: z.array(topicTermSchema).min(1),
  ratingScale: z.array(ratingLevelSchema).min(2),
  primaryQuestions: z.array(primaryQuestionSchema).min(1)
}).superRefine((topic, ctx) => {
  const termIds = new Set(topic.terms.map((term) => term.id));
  const seenQuestionIds = new Set();
  const seenCriterionIds = new Set();

  for (const [questionIndex, question] of topic.primaryQuestions.entries()) {
    if (seenQuestionIds.has(question.id)) {
      ctx.addIssue({ code: 'custom', path: ['primaryQuestions', questionIndex, 'id'], message: `Duplicate primary question ID: ${question.id}` });
    }
    seenQuestionIds.add(question.id);
    if (!termIds.has(question.primaryTermId)) {
      ctx.addIssue({ code: 'custom', path: ['primaryQuestions', questionIndex, 'primaryTermId'], message: `Unknown term ID: ${question.primaryTermId}` });
    }

    for (const [criterionIndex, criterion] of question.highQualityCriteria.entries()) {
      if (seenCriterionIds.has(criterion.id)) {
        ctx.addIssue({ code: 'custom', path: ['primaryQuestions', questionIndex, 'highQualityCriteria', criterionIndex, 'id'], message: `Duplicate criterion ID: ${criterion.id}` });
      }
      seenCriterionIds.add(criterion.id);
      for (const termId of criterion.termIds) {
        if (!termIds.has(termId)) {
          ctx.addIssue({ code: 'custom', path: ['primaryQuestions', questionIndex, 'highQualityCriteria', criterionIndex, 'termIds'], message: `Unknown term ID: ${termId}` });
        }
      }
    }
  }
});

const actorRatingsSchema = z.record(z.string().min(1), z.string().min(1));

export const alignmentScenarioSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  builtIn: z.boolean(),
  editableCopy: z.boolean().default(true),
  expectedAlignmentRange: z.object({
    min: z.number().min(0).max(100),
    max: z.number().min(0).max(100),
    minInclusive: z.boolean().default(true),
    maxInclusive: z.boolean().default(true)
  }),
  ratings: z.object({
    requestor: actorRatingsSchema,
    participant: actorRatingsSchema
  })
});

export const alignmentScenarioCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  ratingScaleId: z.string().min(1),
  scenarios: z.array(alignmentScenarioSchema).min(1)
});

export const fatigueLevelSchema = z.enum(['low', 'moderate', 'high', 'critical']);

export const behaviorDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  stages: z.array(z.string().min(1)).min(1).default(['single']),
  compatibleWith: z.array(z.string()).default([]),
  incompatibleWith: z.array(z.string()).default([]),
  expectedPartnerAiBehavior: z.string().min(1),
  softAssertionOnly: z.boolean().default(true)
});

export const behaviorCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  fatigueRanges: z.object({
    low: z.tuple([z.literal(0), z.literal(39)]),
    moderate: z.tuple([z.literal(40), z.literal(69)]),
    high: z.tuple([z.literal(70), z.literal(84)]),
    critical: z.tuple([z.literal(85), z.literal(100)])
  }),
  behaviors: z.array(behaviorDefinitionSchema).min(1)
});

export const behaviorTargetSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('primary_question'), primaryQuestionId: z.string().min(1) }),
  z.object({ mode: z.literal('criterion'), primaryQuestionId: z.string().min(1), criterionId: z.string().min(1) }),
  z.object({ mode: z.literal('random_primary_question'), excludePrimaryQuestionIds: z.array(z.string()).default([]) }),
  z.object({ mode: z.literal('random_criterion'), excludeCriterionIds: z.array(z.string()).default([]) })
]);

export const scheduledBehaviorSchema = z.object({
  id: z.string().min(1),
  behaviorId: z.string().min(1),
  enabled: z.boolean().default(true),
  target: behaviorTargetSchema,
  stageTargets: z.record(z.string(), behaviorTargetSchema).optional(),
  fatigueLevel: fatigueLevelSchema.optional(),
  combineWith: z.array(z.string()).default([]),
  repetitionsPerActor: z.number().int().positive().default(1)
});

export const behaviorScheduleSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  builtIn: z.boolean(),
  editableCopy: z.boolean().default(true),
  seedStrategy: z.enum(['run_id', 'fixed', 'random']),
  fixedSeed: z.string().optional(),
  actors: z.literal('identical'),
  behaviorCountPerActor: z.number().int().positive().default(6),
  behaviors: z.array(scheduledBehaviorSchema).min(1)
});

export const materializedBehaviorSchema = z.object({
  scheduleItemId: z.string().min(1),
  behaviorId: z.string().min(1),
  actor: z.enum(['requestor', 'participant']),
  primaryQuestionId: z.string().min(1),
  criterionId: z.string().optional(),
  sourcePrimaryQuestionId: z.string().optional(),
  sourceCriterionId: z.string().optional(),
  stage: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  fatigueLevel: fatigueLevelSchema.optional(),
  combinedBehaviorIds: z.array(z.string()).default([])
});

export const materializedScenarioPlanSchema = z.object({
  schemaVersion: z.literal(1),
  seed: z.string().min(1),
  topicId: z.string().min(1),
  alignmentScenarioId: z.string().min(1),
  behaviorScheduleId: z.string().min(1),
  sharedEvents: z.array(z.object({
    id: z.string().min(1),
    termId: z.string().min(1),
    relatedPrimaryQuestionIds: z.array(z.string().min(1)).min(1),
    synthesisDirective: z.string().min(1),
    facts: z.array(z.string().min(1)).min(1),
    quantitativeEvidence: z.array(z.object({
      metricId: z.string().min(1),
      baseline: z.number(),
      result: z.number(),
      standardExpectation: z.number(),
      stretchExpectation: z.number(),
      unit: z.string().min(1)
    })).min(1),
    qualitativeEvidence: z.array(z.string().min(1)).min(1),
    actorInterpretations: z.object({
      requestor: z.object({
        ratingId: z.string().min(1),
        stance: z.string().min(1),
        evidenceEmphasis: z.array(z.string().min(1)).min(1)
      }),
      participant: z.object({
        ratingId: z.string().min(1),
        stance: z.string().min(1),
        evidenceEmphasis: z.array(z.string().min(1)).min(1)
      })
    })
  })).default([]),
  behaviors: z.array(materializedBehaviorSchema)
});

export const behaviorExecutionResultSchema = z.object({
  actor: z.enum(['requestor', 'participant']),
  turn: z.number().int().positive(),
  primaryQuestionId: z.string().min(1),
  criterionId: z.string().optional(),
  behaviorIds: z.array(z.string().min(1)).min(1),
  assignedFatigueLevel: fatigueLevelSchema.optional(),
  observedQfi: z.number().min(0).max(100).optional(),
  observedIntent: z.string().optional(),
  observedQor: z.string().optional(),
  syntheticUserCompliant: z.boolean(),
  partnerAiExpectationObserved: z.boolean().optional(),
  softAssertions: z.array(z.object({
    type: z.string().min(1),
    passed: z.boolean(),
    expected: z.string().min(1),
    observed: z.string().min(1)
  })).default([])
});

export const scenarioRunResultSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(['started', 'passed', 'failed']),
  scenarioPlan: materializedScenarioPlanSchema,
  behaviorExecutions: z.array(behaviorExecutionResultSchema),
  syntheticUserScenarioCompliant: z.boolean(),
  alignmentReport: z.object({
    score: z.number().min(0).max(100).optional(),
    expectedRange: z.object({ min: z.number(), max: z.number() }),
    withinExpectedRange: z.boolean().optional(),
    affectsCaseResult: z.literal(false)
  }).optional()
});

// Scripted primary-question answers: an alternative run mode where a tester
// supplies the first response to each primary question for each actor. The
// employee answer is used when the requestor is interviewed; the manager answer
// when the participant is interviewed. Either side may be omitted for a given
// question (that side then falls back to the LLM responder).
export const scriptedAnswerEntrySchema = z.object({
  primaryQuestionId: z.string().min(1),
  employee: z.string().min(1).optional(),
  manager: z.string().min(1).optional()
}).refine((entry) => entry.employee || entry.manager, {
  message: 'Each scripted answer must provide at least one of employee or manager.'
});

export const scriptedAnswersSchema = z.object({
  schemaVersion: z.literal(1),
  topicId: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  answers: z.array(scriptedAnswerEntrySchema).min(1)
}).superRefine((file, ctx) => {
  const seen = new Set();
  for (const [index, entry] of file.answers.entries()) {
    if (seen.has(entry.primaryQuestionId)) {
      ctx.addIssue({ code: 'custom', path: ['answers', index, 'primaryQuestionId'], message: `Duplicate primary question ID: ${entry.primaryQuestionId}` });
    }
    seen.add(entry.primaryQuestionId);
  }
});

export function validateBehaviorCompatibility(schedule, catalog) {
  const definitions = new Map(catalog.behaviors.map((behavior) => [behavior.id, behavior]));
  const issues = [];

  for (const item of schedule.behaviors) {
    const definition = definitions.get(item.behaviorId);
    if (!definition) {
      issues.push(`Unknown behavior ID: ${item.behaviorId}`);
      continue;
    }
    for (const combinedId of item.combineWith ?? []) {
      const combined = definitions.get(combinedId);
      if (!combined) {
        issues.push(`Unknown combined behavior ID: ${combinedId}`);
        continue;
      }
      if (definition.incompatibleWith.includes(combinedId) || combined.incompatibleWith.includes(item.behaviorId)) {
        issues.push(`${item.behaviorId} is incompatible with ${combinedId}`);
      }
    }
  }

  return issues;
}

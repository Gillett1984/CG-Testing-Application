import fs from 'node:fs';
import path from 'node:path';
import {
  alignmentScenarioCatalogSchema,
  behaviorCatalogSchema,
  behaviorScheduleSchema,
  topicDefinitionSchema,
  validateBehaviorCompatibility
} from './scenarioSchemas.js';

export function loadScenarioFoundation(rootDir, topicDefinition) {
  if (topicDefinition?.schemaVersion !== 2) return null;

  const topic = topicDefinitionSchema.parse(topicDefinition);
  const alignmentScenarioTemplates = alignmentScenarioCatalogSchema.parse(readJson(rootDir, 'config/scenarios/alignment-scenarios.json'));
  const alignmentScenarios = materializeAlignmentScenarios(topic, alignmentScenarioTemplates);
  const behaviorCatalog = behaviorCatalogSchema.parse(readJson(rootDir, 'config/behaviors/catalog.json'));
  const defaultBehaviorSchedule = behaviorScheduleSchema.parse(readJson(rootDir, 'config/behavior-schedules/default-six.json'));

  validateAlignmentScenarioReferences(topic, alignmentScenarios);
  validateBehaviorScheduleReferences(behaviorCatalog, defaultBehaviorSchedule);

  return {
    topic,
    alignmentScenarios,
    behaviorCatalog,
    defaultBehaviorSchedule
  };
}

export function loadBehaviorSchedule(rootDir, relativePath) {
  return behaviorScheduleSchema.parse(readJson(rootDir, relativePath));
}

function readJson(rootDir, relativePath) {
  const resolvedPath = path.resolve(rootDir, relativePath);
  if (!fs.existsSync(resolvedPath)) throw new Error(`Scenario configuration was not found: ${resolvedPath}`);
  return JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
}

function validateAlignmentScenarioReferences(topic, catalog) {
  const termIds = new Set(topic.terms.map((term) => term.id));
  const ratingIds = new Set(topic.ratingScale.map((rating) => rating.id));

  for (const scenario of catalog.scenarios) {
    for (const actor of ['requestor', 'participant']) {
      const ratings = scenario.ratings[actor];
      for (const termId of termIds) {
        if (!ratings[termId]) throw new Error(`${scenario.id} is missing a ${actor} rating for ${termId}.`);
      }
      for (const [termId, ratingId] of Object.entries(ratings)) {
        if (!termIds.has(termId)) throw new Error(`${scenario.id} references unknown term ${termId}.`);
        if (!ratingIds.has(ratingId)) throw new Error(`${scenario.id} references unknown rating ${ratingId}.`);
      }
    }
  }
}

function materializeAlignmentScenarios(topic, catalog) {
  const topicTermIds = topic.terms.map((term) => term.id);
  return {
    ...catalog,
    scenarios: catalog.scenarios.map((scenario) => ({
      ...scenario,
      ratings: {
        requestor: mapRatingPattern(topicTermIds, scenario.ratings.requestor, topic.ratingScale),
        participant: mapRatingPattern(topicTermIds, scenario.ratings.participant, topic.ratingScale)
      }
    }))
  };
}

function mapRatingPattern(topicTermIds, templateRatings, ratingScale) {
  const ratingIds = new Set(ratingScale.map((rating) => rating.id));
  if (topicTermIds.every((termId) => templateRatings[termId])
    && Object.keys(templateRatings).length === topicTermIds.length
    && Object.values(templateRatings).every((ratingId) => ratingIds.has(ratingId))) {
    return templateRatings;
  }
  const pattern = Object.values(templateRatings);
  return Object.fromEntries(topicTermIds.map((termId, index) => [
    termId,
    mapTemplateRating(pattern[index % pattern.length], ratingScale)
  ]));
}

function mapTemplateRating(templateRatingId, ratingScale) {
  const standardOrder = ['unsatisfactory', 'needs_improvement', 'meets_expectations', 'exceeds_expectations', 'outstanding'];
  const sortedRatings = [...ratingScale].sort((a, b) => a.score - b.score);
  const standardIndex = Math.max(0, standardOrder.indexOf(templateRatingId));
  const mappedIndex = Math.round((standardIndex / (standardOrder.length - 1)) * (sortedRatings.length - 1));
  return sortedRatings[mappedIndex].id;
}

function validateBehaviorScheduleReferences(catalog, schedule) {
  const behaviorIds = new Set(catalog.behaviors.map((behavior) => behavior.id));
  const enabled = schedule.behaviors.filter((behavior) => behavior.enabled);
  if (enabled.length < schedule.behaviorCountPerActor) {
    throw new Error(`${schedule.id} requests ${schedule.behaviorCountPerActor} behaviors per actor but only ${enabled.length} are enabled.`);
  }

  for (const item of schedule.behaviors) {
    if (!behaviorIds.has(item.behaviorId)) throw new Error(`${schedule.id} references unknown behavior ${item.behaviorId}.`);
  }

  const compatibilityIssues = validateBehaviorCompatibility(schedule, catalog);
  if (compatibilityIssues.length) throw new Error(`Behavior schedule compatibility errors: ${compatibilityIssues.join('; ')}`);
}

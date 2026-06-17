import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { topicDefinitionSchema } from '../src/scenarioSchemas.js';
import { loadScenarioFoundation } from '../src/scenarioConfig.js';
import { buildPublishedTopic, topicDraftSchema } from '../src/topicOnboarding.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const now = new Date().toISOString();
const draft = topicDraftSchema.parse({
  schemaVersion: 1,
  id: 'onboarding-validation',
  status: 'draft',
  topicId: 'onboarding_validation',
  caseType: 'Onboarding Validation',
  description: 'Validation topic for the draft-to-publish contract.',
  sourceFileName: 'validation.docx',
  sourceExtractPath: 'topic-drafts/sources/validation.json',
  workflow: {
    actors: ['requestor', 'participant'],
    factStatementLabel: 'Confident Fact',
    postProcessingTimeoutMs: 420000
  },
  terms: [
    { id: 'capacity', label: 'Capacity', description: 'Workload and available capacity.' },
    { id: 'planning', label: 'Planning', description: 'Prioritization and delivery planning.' }
  ],
  ratingScale: [
    { id: 'low', label: 'Low', score: 0, responseProfile: { stance: 'Below the expected level.', evidenceStrength: 'strong', evidenceMix: ['quantitative', 'qualitative'] } },
    { id: 'expected', label: 'Expected', score: 1, responseProfile: { stance: 'At the expected level.', evidenceStrength: 'moderate', evidenceMix: ['quantitative', 'qualitative'] } },
    { id: 'high', label: 'High', score: 2, responseProfile: { stance: 'Above the expected level.', evidenceStrength: 'strong', evidenceMix: ['quantitative', 'qualitative'] } }
  ],
  primaryQuestions: [{
    discussionArea: 'Current Capacity',
    question: 'What work are you currently responsible for?',
    answerGuidance: ['Main responsibilities', 'Current workload'],
    primaryTermId: 'capacity',
    voluntaryCoverageRequirement: '50%',
    highQualityCriteria: [
      { requirement: 'States the main responsibilities.', required: true, termIds: ['capacity'] },
      { requirement: 'Explains the current priorities.', required: false, termIds: ['capacity', 'planning'] }
    ]
  }],
  createdAt: now,
  updatedAt: now,
  approvedAt: null,
  publishedAt: null,
  publishedPath: null,
  generationNotes: []
});

const topic = topicDefinitionSchema.parse(buildPublishedTopic(draft));
const foundation = loadScenarioFoundation(rootDir, topic);
if (foundation.alignmentScenarios.scenarios.length !== 7) throw new Error('Expected seven generic alignment scenarios.');
for (const scenario of foundation.alignmentScenarios.scenarios) {
  for (const actor of ['requestor', 'participant']) {
    for (const term of topic.terms) {
      if (!scenario.ratings[actor][term.id]) throw new Error(`${scenario.id} is missing ${actor}/${term.id}.`);
    }
  }
}

console.log('Topic onboarding validation passed.');
console.log(`Questions: ${topic.primaryQuestions.length}`);
console.log(`Terms: ${topic.terms.length}`);
console.log(`Generic scenarios: ${foundation.alignmentScenarios.scenarios.length}`);

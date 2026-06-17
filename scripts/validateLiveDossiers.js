import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { loadScenarioFoundation } from '../src/scenarioConfig.js';
import { generateScenarioDossiers } from '../src/llmResponder.js';

dotenv.config();
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const topic = JSON.parse(fs.readFileSync(path.join(rootDir, 'config/case-types/performance-review-coaching.json'), 'utf8'));
const foundation = loadScenarioFoundation(rootDir, topic);
const scenarioId = process.env.SCENARIO_ID ?? 'extremely_misaligned';
const scenario = foundation.alignmentScenarios.scenarios.find((item) => item.id === scenarioId);
if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);
const dossiers = await generateScenarioDossiers({
  llm: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'
  },
  topic: foundation.topic,
  scenario,
  seed: `live-dossier-validation-${Date.now()}`
});

console.log(JSON.stringify({
  employeeRole: dossiers.employee.canonicalProfile.employeeRole,
  organizationContext: dossiers.employee.canonicalProfile.organizationContext,
  employeeAnswers: dossiers.employee.primaryQuestionAnswers.length,
  managerAnswers: dossiers.manager.primaryQuestionAnswers.length,
  neutralTerms: dossiers.evidencePacket.termEvidence.length,
  mixedEvidenceTerms: dossiers.evidencePacket.termEvidence.filter((item) => item.favorableEvidence.length >= 2 && item.limitingEvidence.length >= 2).length,
  scenarioId,
  questionExpressions: dossiers.scenarioExpressionPlan.questionExpressions.map((item) => ({
    primaryQuestionId: item.primaryQuestionId,
    employee: item.employeeOpeningStatement,
    manager: item.managerOpeningStatement,
    relationship: item.expectedRelationship,
    explanation: item.relationshipExplanation
  })),
  employeeRatings: dossiers.employee.termPositions.map((item) => `${item.termId}:${item.ratingId}`),
  managerRatings: dossiers.manager.termPositions.map((item) => `${item.termId}:${item.ratingId}`),
  employeeConclusions: dossiers.employee.termPositions.map((item) => `${item.termId}:${item.conclusion}`),
  managerConclusions: dossiers.manager.termPositions.map((item) => `${item.termId}:${item.conclusion}`),
  pairValidationPassed: dossiers.pairValidation.pass,
  canonicalProfileShared: JSON.stringify(dossiers.employee.canonicalProfile) === JSON.stringify(dossiers.manager.canonicalProfile)
}, null, 2));

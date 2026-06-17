import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const topicPath = path.join(rootDir, 'config', 'case-types', 'performance-review-coaching.json');
const topic = JSON.parse(fs.readFileSync(topicPath, 'utf8'));

const mappings = {
  performance_review_coaching_q1_current_role_focus_priorities: {
    primaryTermId: 'execution_ownership',
    criteria: [
      ['execution_ownership'], ['execution_ownership'], ['execution_ownership'], ['execution_ownership'],
      ['execution_ownership'], ['execution_ownership'], ['execution_ownership'], ['judgement_growth']
    ]
  },
  performance_review_coaching_q2_progress_since_last_check_in: {
    primaryTermId: 'results_impact',
    criteria: [
      ['results_impact'], ['results_impact'], ['results_impact'], ['execution_ownership'],
      ['results_impact'], ['results_impact'], ['communication_collaboration'], ['judgement_growth']
    ]
  },
  performance_review_coaching_q3_current_challenges_obstacles: {
    primaryTermId: 'execution_ownership',
    criteria: [
      ['execution_ownership'], ['execution_ownership'], ['execution_ownership', 'quality_craft', 'results_impact'],
      ['execution_ownership'], ['execution_ownership'], ['judgement_growth'], ['execution_ownership']
    ]
  },
  performance_review_coaching_q4_support_needed: {
    primaryTermId: 'judgement_growth',
    criteria: [
      ['judgement_growth'], ['judgement_growth'], ['results_impact', 'quality_craft'], ['judgement_growth'],
      ['results_impact'], ['communication_collaboration'], ['judgement_growth']
    ]
  },
  performance_review_coaching_q5_communication_working_relationship: {
    primaryTermId: 'communication_collaboration',
    criteria: Array.from({ length: 8 }, () => ['communication_collaboration'])
  },
  performance_review_coaching_q6_growth_development: {
    primaryTermId: 'judgement_growth',
    criteria: [
      ['judgement_growth'], ['judgement_growth'], ['results_impact'], ['judgement_growth'],
      ['judgement_growth'], ['judgement_growth']
    ]
  },
  performance_review_coaching_q7_next_period_priorities: {
    primaryTermId: 'execution_ownership',
    criteria: [
      ['execution_ownership'], ['execution_ownership'], ['results_impact'], ['results_impact'],
      ['execution_ownership'], ['judgement_growth'], ['communication_collaboration'], ['judgement_growth']
    ]
  }
};

topic.schemaVersion = 2;
topic.topicId = 'performance_review_coaching';
topic.caseType = 'Performance Review - Coaching';
topic.description = 'High-quality answer criteria for the Performance Review - Coaching Getting Started interview.';
topic.workflow = {
  actors: ['requestor', 'participant'],
  factStatementLabel: 'Confident Fact',
  postProcessingTimeoutMs: 420000
};
topic.terms = [
  { id: 'results_impact', label: 'Results & Impact', description: 'Outcomes achieved and the value those outcomes created for customers, teams, or the organization.' },
  { id: 'execution_ownership', label: 'Execution & Ownership', description: 'Planning, prioritization, follow-through, accountability, and effective delivery of responsibilities.' },
  { id: 'quality_craft', label: 'Quality & Craft', description: 'Accuracy, completeness, professional standards, and care applied to work products and decisions.' },
  { id: 'communication_collaboration', label: 'Communication & Collaboration', description: 'Clarity, responsiveness, coordination, trust, and effectiveness when working with others.' },
  { id: 'judgement_growth', label: 'Judgement & Growth', description: 'Decision quality, self-awareness, learning, adaptability, development, and readiness for broader responsibility.' }
];
topic.ratingScale = [
  rating('unsatisfactory', 'Unsatisfactory', 0, 'Performance consistently falls materially short of expectations.', 'strong'),
  rating('needs_improvement', 'Needs Improvement', 1, 'Performance has meaningful gaps and requires focused improvement.', 'moderate'),
  rating('meets_expectations', 'Meets Expectations', 2, 'Performance reliably fulfills the expectations of the role.', 'moderate'),
  rating('exceeds_expectations', 'Exceeds Expectations', 3, 'Performance frequently surpasses normal expectations.', 'strong'),
  rating('outstanding', 'Outstanding', 4, 'Performance significantly and consistently surpasses expectations.', 'strong')
];

for (const question of topic.primaryQuestions) {
  const mapping = mappings[question.id];
  if (!mapping) throw new Error(`Missing term mapping for ${question.id}`);
  if (mapping.criteria.length !== question.highQualityCriteria.length) {
    throw new Error(`Criterion mapping count mismatch for ${question.id}`);
  }
  question.primaryTermId = mapping.primaryTermId;
  question.highQualityCriteria = question.highQualityCriteria.map((criterion, index) => ({
    id: `${question.id}_criterion_${index + 1}`,
    ...criterion,
    termIds: mapping.criteria[index]
  }));
}

const ordered = {
  schemaVersion: topic.schemaVersion,
  topicId: topic.topicId,
  caseType: topic.caseType,
  description: topic.description,
  workflow: topic.workflow,
  terms: topic.terms,
  ratingScale: topic.ratingScale,
  primaryQuestions: topic.primaryQuestions
};

fs.writeFileSync(topicPath, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');

function rating(id, label, score, stance, evidenceStrength) {
  return {
    id,
    label,
    score,
    responseProfile: {
      stance,
      evidenceStrength,
      evidenceMix: ['quantitative', 'qualitative']
    }
  };
}

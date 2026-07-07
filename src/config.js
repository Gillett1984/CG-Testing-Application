import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';
import { loadBehaviorSchedule, loadScenarioFoundation } from './scenarioConfig.js';
import { loadScriptedAnswers, validateScriptedAnswersAgainstTopic } from './scriptedAnswers.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const envSchema = z.object({
  COMMON_GROUND_URL: z.string().url(),
  REQUESTOR_EMAIL: z.string().email(),
  REQUESTOR_PASSWORD: z.string().min(1),
  PARTICIPANT_EMAIL: z.string().email(),
  PARTICIPANT_PASSWORD: z.string().min(1),
  SELECTORS_PATH: z.string().default('config/selectors.example.json'),
  COMPLETION_PHRASES: z.string().default('Getting Started Complete,Getting Started is complete,completed the Getting Started,wrapped up the Getting Started,we have enough information'),
  HEADLESS: z.string().default('true'),
  SLOW_MO_MS: z.coerce.number().int().nonnegative().default(0),
  MAX_TURNS: z.coerce.number().int().positive().default(20),
  POST_COMPLETION_WAIT_MS: z.coerce.number().int().positive().default(300000)
}).passthrough();

const runConfigSchema = z.object({
  topic: z.string().optional(),
  caseType: z.string().optional(),
  runMode: z.enum(['requestor_getting_started', 'participant_getting_started', 'full_workflow', 'fact_labeling_smoke']).optional(),
  existingCaseId: z.string().optional(),
  factRatingStage: z.enum(['requestor_own', 'participant_rates_requestor', 'participant_own', 'requestor_rates_participant']).optional(),
  workflowScope: z.enum(['requestor', 'participant', 'requestor_participant']).optional(),
  interviewStartActor: z.enum(['employee', 'manager']).optional(),
  dossierMode: z.enum(['fresh', 'auto', 'cached']).optional(),
  dossierVariationPrompt: z.string().optional(),
  screenshotMode: z.enum(['all', 'failures_only', 'none']).optional(),
  reuseAuthState: z.boolean().optional(),
  testObjective: z.string().optional(),
  testBehaviorPolicy: z.string().optional(),
  numberOfCases: z.number().int().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  stopOnFailure: z.boolean().optional(),
  qualityCriteriaPath: z.string().optional(),
  alignmentScenarioId: z.string().optional(),
  behaviorSchedulePath: z.string().optional(),
  scriptedAnswersPath: z.string().optional(),
  scenarioSeed: z.string().optional()
}).passthrough();

export function loadConfig(args) {
  const env = envSchema.parse(process.env);
  const selectorsPath = path.resolve(rootDir, env.SELECTORS_PATH);

  if (!fs.existsSync(selectorsPath)) {
    throw new Error(`Selector config was not found: ${selectorsPath}`);
  }

  const selectors = JSON.parse(fs.readFileSync(selectorsPath, 'utf8'));
  const cli = parseArgs(args);
  const runConfig = cli.configPath ? loadRunConfig(cli.configPath) : {};
  const qualityCriteriaPath = cli.qualityCriteriaPath
    ?? runConfig.qualityCriteriaPath
    ?? defaultQualityCriteriaPath(runConfig.caseType ?? runConfig.topic ?? cli.topic);
  const qualityCriteria = qualityCriteriaPath ? loadQualityCriteria(qualityCriteriaPath) : null;
  const scenarioFoundation = loadScenarioFoundation(rootDir, qualityCriteria);
  const behaviorSchedulePath = cli.behaviorSchedulePath ?? runConfig.behaviorSchedulePath ?? 'config/behavior-schedules/default-six.json';
  const behaviorSchedule = scenarioFoundation ? loadBehaviorSchedule(rootDir, behaviorSchedulePath) : null;

  // Scripted-answers mode (alternative run path): when a file is supplied, its
  // pre-authored answers are used as the first response to each matched primary
  // question. Behaviors are not injected in this mode (clean run).
  const scriptedAnswersPath = cli.scriptedAnswersPath ?? runConfig.scriptedAnswersPath ?? null;
  let scriptedAnswers = null;
  if (scriptedAnswersPath) {
    if (!scenarioFoundation) {
      throw new Error('Scripted-answers mode requires a topic definition. Set a caseType/topic that maps to a config/case-types/*.json file.');
    }
    scriptedAnswers = loadScriptedAnswers(rootDir, scriptedAnswersPath);
    const { errors, warnings } = validateScriptedAnswersAgainstTopic(scriptedAnswers, scenarioFoundation.topic);
    for (const warning of warnings) console.warn(`[scripted-answers] ${warning}`);
    if (errors.length) {
      throw new Error(`Scripted answers file is invalid:\n - ${errors.join('\n - ')}`);
    }
  }

  const requestedRunMode = cli.runMode
    ?? runConfig.runMode
    ?? (normalizeCaseId(cli.existingCaseId ?? runConfig.existingCaseId)
      ? 'participant_getting_started'
      : workflowScopeToRunMode(cli.workflowScope ?? runConfig.workflowScope));
  const runMode = requestedRunMode;
  const existingCaseId = ['participant_getting_started', 'fact_labeling_smoke'].includes(runMode)
    ? normalizeCaseId(cli.existingCaseId ?? runConfig.existingCaseId)
    : '';
  if (['participant_getting_started', 'fact_labeling_smoke'].includes(runMode) && !existingCaseId) {
    throw new Error(`${runMode === 'fact_labeling_smoke' ? 'Fact Labeling Smoke Test' : 'Participant Getting Started'} mode requires a Common Ground Case ID.`);
  }
  const workflowScope = runModeToWorkflowScope(runMode);

  return {
    rootDir,
    productionUrl: env.COMMON_GROUND_URL,
    credentials: {
      requestor: {
        email: env.REQUESTOR_EMAIL,
        password: env.REQUESTOR_PASSWORD
      },
      participant: {
        email: env.PARTICIPANT_EMAIL,
        password: env.PARTICIPANT_PASSWORD
      }
    },
    selectors,
    completionPhrases: env.COMPLETION_PHRASES.split(',').map((phrase) => phrase.trim()).filter(Boolean),
    browser: {
      headless: cli.headed ? false : env.HEADLESS.toLowerCase() !== 'false',
      slowMo: env.SLOW_MO_MS
    },
    run: {
      topic: cli.topic ?? runConfig.topic ?? 'Synthetic test topic',
      caseType: cli.caseType ?? runConfig.caseType ?? cli.topic ?? runConfig.topic ?? 'Raise',
      runMode,
      existingCaseId,
      factRatingStage: cli.factRatingStage ?? runConfig.factRatingStage ?? 'participant_rates_requestor',
      workflowScope,
      interviewStartActor: cli.interviewStartActor ?? runConfig.interviewStartActor ?? 'employee',
      dossierMode: cli.dossierMode ?? runConfig.dossierMode ?? 'fresh',
      dossierVariationPrompt: cli.dossierVariationPrompt ?? runConfig.dossierVariationPrompt ?? '',
      screenshotMode: cli.screenshotMode ?? runConfig.screenshotMode ?? 'failures_only',
      reuseAuthState: cli.reuseAuthState ?? runConfig.reuseAuthState ?? true,
      testObjective: cli.testObjective ?? runConfig.testObjective ?? 'Complete the Getting Started interview using only synthetic data.',
      testBehaviorPolicy: cli.testBehaviorPolicy ?? runConfig.testBehaviorPolicy ?? 'Answer each Partner AI question according to the high-quality criteria.',
      numberOfCases: cli.count ?? runConfig.numberOfCases ?? 1,
      stopOnFailure: cli.stopOnFailure ?? runConfig.stopOnFailure ?? true,
      qualityCriteriaPath,
      qualityCriteria,
      scenarioFoundation,
      alignmentScenarioId: cli.alignmentScenarioId ?? runConfig.alignmentScenarioId ?? scenarioFoundation?.alignmentScenarios.scenarios[0]?.id ?? '',
      behaviorSchedulePath,
      behaviorSchedule,
      scriptedAnswersPath,
      scriptedAnswers,
      scenarioSeed: cli.scenarioSeed ?? runConfig.scenarioSeed ?? '',
      validateConfigOnly: cli.validateConfig,
      maxTurns: cli.maxTurns ?? runConfig.maxTurns ?? env.MAX_TURNS,
      postCompletionWaitMs: scenarioFoundation?.topic.workflow.postProcessingTimeoutMs
        ?? (workflowScope === 'requestor_participant' ? Math.max(env.POST_COMPLETION_WAIT_MS, 420000) : env.POST_COMPLETION_WAIT_MS)
    },
    llm: {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
      // Pass/fail gatekeeper judges run on a faster model to cut per-turn latency.
      // Response GENERATION stays on `model`, so synthetic response content is
      // unchanged. Set OPENAI_JUDGE_MODEL equal to OPENAI_MODEL to disable this.
      judgeModel: process.env.OPENAI_JUDGE_MODEL ?? 'gpt-4.1-nano'
    }
  };
}

function parseArgs(args) {
  const parsed = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--headed') parsed.headed = true;
    if (arg === '--validate-config') parsed.validateConfig = true;
    if (arg === '--config') parsed.configPath = args[index + 1];
    if (arg === '--topic') parsed.topic = args[index + 1];
    if (arg === '--case-type') parsed.caseType = args[index + 1];
    if (arg === '--run-mode') parsed.runMode = args[index + 1];
    if (arg === '--existing-case-id') parsed.existingCaseId = args[index + 1];
    if (arg === '--fact-rating-stage') parsed.factRatingStage = args[index + 1];
    if (arg === '--workflow-scope') parsed.workflowScope = args[index + 1];
    if (arg === '--interview-start-actor') parsed.interviewStartActor = args[index + 1];
    if (arg === '--dossier-mode') parsed.dossierMode = args[index + 1];
    if (arg === '--dossier-variation-prompt') parsed.dossierVariationPrompt = args[index + 1];
    if (arg === '--screenshot-mode') parsed.screenshotMode = args[index + 1];
    if (arg === '--reuse-auth-state') parsed.reuseAuthState = true;
    if (arg === '--no-reuse-auth-state') parsed.reuseAuthState = false;
    if (arg === '--test-objective') parsed.testObjective = args[index + 1];
    if (arg === '--test-behavior-policy') parsed.testBehaviorPolicy = args[index + 1];
    if (arg === '--quality-criteria') parsed.qualityCriteriaPath = args[index + 1];
    if (arg === '--alignment-scenario') parsed.alignmentScenarioId = args[index + 1];
    if (arg === '--behavior-schedule') parsed.behaviorSchedulePath = args[index + 1];
    if (arg === '--scripted-answers') parsed.scriptedAnswersPath = args[index + 1];
    if (arg === '--scenario-seed') parsed.scenarioSeed = args[index + 1];
    if (arg === '--count') parsed.count = Number(args[index + 1]);
    if (arg === '--max-turns') parsed.maxTurns = Number(args[index + 1]);
    if (arg === '--continue-on-failure') parsed.stopOnFailure = false;
    if (arg === '--stop-on-failure') parsed.stopOnFailure = true;
  }

  return parsed;
}

function normalizeCaseId(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw) return '';
  if (/^CG-\d+$/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `CG-${raw.padStart(4, '0')}`;
  return raw;
}

function workflowScopeToRunMode(workflowScope) {
  if (workflowScope === 'participant') return 'participant_getting_started';
  if (workflowScope === 'requestor_participant') return 'full_workflow';
  return 'requestor_getting_started';
}

function runModeToWorkflowScope(runMode) {
  if (runMode === 'fact_labeling_smoke') return 'requestor_participant';
  if (runMode === 'participant_getting_started') return 'participant';
  if (runMode === 'full_workflow') return 'requestor_participant';
  return 'requestor';
}

function loadRunConfig(configPath) {
  const resolvedPath = path.resolve(rootDir, configPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Run config was not found: ${resolvedPath}`);
  }

  return runConfigSchema.parse(JSON.parse(fs.readFileSync(resolvedPath, 'utf8')));
}

function loadQualityCriteria(criteriaPath) {
  const resolvedPath = path.resolve(rootDir, criteriaPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Quality criteria file was not found: ${resolvedPath}`);
  }

  return JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
}

function defaultQualityCriteriaPath(caseType) {
  if (!caseType) return null;
  const fileName = `${caseType.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
  const candidate = path.join('config', 'case-types', fileName);
  return fs.existsSync(path.resolve(rootDir, candidate)) ? candidate : null;
}

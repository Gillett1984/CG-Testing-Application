import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';
import { loadBehaviorSchedule, loadScenarioFoundation } from './scenarioConfig.js';
import { loadScriptedAnswers, validateScriptedAnswersAgainstTopic } from './scriptedAnswers.js';
import { loadPersonaCatalog, loadPersonaRotation } from './personas.js';
import { WORKFLOW_PHASES } from './workflowPhases.js';

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
  requestorRole: z.enum(['employee', 'manager']).optional(),
  runMode: z.enum(['requestor_getting_started', 'participant_getting_started', 'full_workflow', 'fact_labeling_smoke', 'resume_case']).optional(),
  resumePhase: z.string().optional(),
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

    // A scripted file may pin the alignment scenario so its cross-party fact labels
    // come out correctly (e.g. an aligned file → "Confident Fact"). Validate the id
    // against the topic catalog, and warn if a runConfig value is being overridden
    // (the CG-0357 bug: aligned file silently paired with extremely_misaligned).
    if (scriptedAnswers.alignmentScenarioId) {
      const known = scenarioFoundation.alignmentScenarios.scenarios.some(
        (scenario) => scenario.id === scriptedAnswers.alignmentScenarioId
      );
      if (!known) {
        throw new Error(`Scripted answers file references unknown alignmentScenarioId "${scriptedAnswers.alignmentScenarioId}". Known scenarios: ${scenarioFoundation.alignmentScenarios.scenarios.map((scenario) => scenario.id).join(', ')}.`);
      }
      if (!cli.alignmentScenarioId
        && runConfig.alignmentScenarioId
        && runConfig.alignmentScenarioId !== scriptedAnswers.alignmentScenarioId) {
        console.warn(`[scripted-answers] Overriding run-config alignment scenario "${runConfig.alignmentScenarioId}" with the scripted file's "${scriptedAnswers.alignmentScenarioId}". Pass --alignment-scenario to force a different one.`);
      }
    }
  }

  const requestedRunMode = cli.runMode
    ?? runConfig.runMode
    ?? (normalizeCaseId(cli.existingCaseId ?? runConfig.existingCaseId)
      ? 'participant_getting_started'
      : workflowScopeToRunMode(cli.workflowScope ?? runConfig.workflowScope));
  const runMode = requestedRunMode;
  const caseIdModes = ['participant_getting_started', 'fact_labeling_smoke', 'resume_case'];
  const existingCaseId = caseIdModes.includes(runMode)
    ? normalizeCaseId(cli.existingCaseId ?? runConfig.existingCaseId)
    : '';
  if (caseIdModes.includes(runMode) && !existingCaseId) {
    const modeLabel = { fact_labeling_smoke: 'Fact Labeling Smoke Test', resume_case: 'Resume Case' }[runMode] ?? 'Participant Getting Started';
    throw new Error(`${modeLabel} mode requires a Common Ground Case ID.`);
  }

  // Resume mode replays the full workflow against an EXISTING case, skipping every phase
  // before resumePhase. Defaults to the participant interview, the usual restart point
  // after the requestor side has completed.
  const resumePhase = runMode === 'resume_case'
    ? (cli.resumePhase ?? runConfig.resumePhase ?? 'participant_interview')
    : null;
  if (resumePhase && !WORKFLOW_PHASES.includes(resumePhase)) {
    throw new Error(`Unknown --resume-phase "${resumePhase}". Valid phases: ${WORKFLOW_PHASES.join(', ')}.`);
  }
  const workflowScope = runModeToWorkflowScope(runMode);
  const numberOfCases = cli.count ?? runConfig.numberOfCases ?? 1;
  // A single case fails fast; a multi-case batch continues past failures by
  // default so one bad case doesn't abort an unattended run. An explicit
  // --stop-on-failure / --continue-on-failure flag or runConfig value wins.
  const stopOnFailure = (cli.stopOnFailure ?? runConfig.stopOnFailure) ?? (numberOfCases <= 1);
  const personaCatalog = loadPersonaCatalog(rootDir);
  const personaPin = cli.personaId ?? runConfig.personaId ?? null;
  const personaPlan = personaPin ? null : loadPersonaRotation(rootDir, cli.personaRotationPath ?? runConfig.personaRotationPath);
  const personasEnabled = !cli.personasDisabled && Boolean(personaCatalog) && (Boolean(personaPin) || Boolean(personaPlan));

  // Precedence: CLI flag > scripted file > runConfig > topic default.
  const alignmentScenarioId = cli.alignmentScenarioId ?? scriptedAnswers?.alignmentScenarioId
    ?? runConfig.alignmentScenarioId ?? scenarioFoundation?.alignmentScenarios.scenarios[0]?.id ?? '';

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
      slowMo: env.SLOW_MO_MS,
      // TCP-only networking: when UDP 443 is silently dropped (observed after a
      // reboot with Norton's firewall mid-initialization), Chromium's QUIC and
      // DNS-over-HTTPS attempts stall every page load to its timeout while
      // curl/Node fetch work fine. Neither protocol benefits a test harness.
      args: ['--disable-quic', '--disable-features=DnsOverHttps']
    },
    run: {
      topic: cli.topic ?? runConfig.topic ?? 'Synthetic test topic',
      caseType: cli.caseType ?? runConfig.caseType ?? cli.topic ?? runConfig.topic ?? 'Raise',
      requestorRole: cli.requestorRole ?? runConfig.requestorRole
        ?? defaultRequestorRole(cli.caseType ?? runConfig.caseType ?? cli.topic ?? runConfig.topic ?? 'Raise'),
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
      numberOfCases,
      stopOnFailure,
      resumeRunId: cli.resumeRunId ?? null,
      resumePhase,
      personas: {
        enabled: personasEnabled,
        catalog: personaCatalog,
        plan: personaPlan,
        pinnedId: personaPin
      },
      qualityCriteriaPath,
      qualityCriteria,
      scenarioFoundation,
      alignmentScenarioId,
      behaviorSchedulePath,
      behaviorSchedule,
      scriptedAnswersPath,
      scriptedAnswers,
      scenarioSeed: cli.scenarioSeed ?? runConfig.scenarioSeed ?? '',
      validateConfigOnly: cli.validateConfig,
      // Measured across 14 manager-side interviews, turn count ranges 9-30 and is
      // NOT predicted by answer length: a misaligned manager disputes the premise,
      // so how far Partner AI drills depends mostly on how much concrete evidence
      // the generated dossier gives them to cite. A ceiling at the top of that
      // observed range fails healthy runs (CG-0068, CG-0099 both stopped at 30),
      // so it sits well clear of it and the loop guard remains the real protection
      // against a genuine non-terminating interview.
      // A misaligned scenario is DESIGNED to produce gap-heavy, premise-disputing
      // answers, so Partner AI legitimately drills deeper than the calibrated
      // one-turn-per-question baseline (observed: ~11 follow-ups on one impact
      // topic with an unlucky dossier). Give those runs headroom unless the
      // ceiling was set explicitly; runaway loops are the loop-guard's job, not
      // this ceiling's.
      maxTurns: cli.maxTurns ?? runConfig.maxTurns
        ?? (/misaligned/i.test(alignmentScenarioId) ? Math.max(env.MAX_TURNS, 45) : env.MAX_TURNS),
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
    if (arg === '--requestor-role') parsed.requestorRole = args[index + 1];
    if (arg === '--run-mode') parsed.runMode = args[index + 1];
    if (arg === '--existing-case-id') parsed.existingCaseId = args[index + 1];
    if (arg === '--resume-phase') { parsed.resumePhase = args[index + 1]; parsed.runMode = parsed.runMode ?? 'resume_case'; }
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
    if (arg === '--resume') parsed.resumeRunId = args[index + 1];
    if (arg === '--persona') parsed.personaId = args[index + 1];
    if (arg === '--persona-rotation') parsed.personaRotationPath = args[index + 1];
    if (arg === '--no-personas') parsed.personasDisabled = true;
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
  if (runMode === 'resume_case') return 'requestor_participant';
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

// Per-topic default for which role the requestor holds — not a single global default.
// Performance Review is manager-initiated (requestor = manager); a Raise Request is
// employee-initiated in the natural case (requestor = employee, asking their manager).
// Each is overridable per run (--requestor-role / runConfig.requestorRole) because a Raise
// can be initiated from either side (e.g. a manager-role account creating one on staging).
const REQUESTOR_ROLE_BY_CASE_TYPE = [
  { pattern: /performance|review|coaching|evaluation|90.?day/i, role: 'manager' },
  { pattern: /raise/i, role: 'employee' }
];
function defaultRequestorRole(caseType = '') {
  const hit = REQUESTOR_ROLE_BY_CASE_TYPE.find((entry) => entry.pattern.test(String(caseType)));
  return hit ? hit.role : 'manager';
}

import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import { behaviorScheduleSchema, validateBehaviorCompatibility } from '../src/scenarioSchemas.js';
import { loadScenarioFoundation } from '../src/scenarioConfig.js';
import {
  approveAndPublishTopicDraft,
  generateTopicDraft,
  listTopicDrafts,
  readTopicDraft,
  saveTopicDraft
} from '../src/topicOnboarding.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const tmpDir = path.join(rootDir, '.tmp');
const port = Number(process.env.UI_PORT ?? 4317);
const uiBuild = 'production-hardening-milestone-6';

let activeRun = null;
let lastRun = null;

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === 'GET' && url.pathname === '/api/defaults') {
      return sendJson(response, await loadDefaults());
    }

    if (request.method === 'GET' && url.pathname === '/api/criteria') {
      return sendJson(response, await loadCriteriaForCaseType(url.searchParams.get('caseType')));
    }

    if (request.method === 'GET' && url.pathname === '/api/scenario-data') {
      return sendJson(response, await loadScenarioData(url.searchParams.get('caseType')));
    }

    if (request.method === 'GET' && url.pathname === '/api/topic-drafts') {
      return sendJson(response, { drafts: await listTopicDrafts(rootDir) });
    }

    if (request.method === 'GET' && url.pathname === '/api/topic-draft') {
      return sendJson(response, { draft: await readTopicDraft(rootDir, url.searchParams.get('id')) });
    }

    if (request.method === 'POST' && url.pathname === '/api/topic-draft/generate') {
      const body = await readJsonBody(request, 25 * 1024 * 1024);
      return sendJson(response, { draft: await generateTopicDraft({ rootDir, ...body }) });
    }

    if (request.method === 'POST' && url.pathname === '/api/topic-draft/save') {
      return sendJson(response, { draft: await saveTopicDraft(rootDir, (await readJsonBody(request)).draft) });
    }

    if (request.method === 'POST' && url.pathname === '/api/topic-draft/publish') {
      return sendJson(response, await approveAndPublishTopicDraft(rootDir, (await readJsonBody(request)).draft));
    }

    if (request.method === 'POST' && url.pathname === '/api/run') {
      return sendJson(response, await startRun(await readJsonBody(request)));
    }

    if (request.method === 'GET' && url.pathname === '/api/run') {
      return sendJson(response, await getRunStatus());
    }

    if (request.method === 'POST' && url.pathname === '/api/stop') {
      return sendJson(response, stopRun());
    }

    return serveStatic(url.pathname, response);
  } catch (error) {
    sendJson(response, { error: error.message }, 500);
  }
});

server.listen(port, () => {
  console.log(`Common Ground Test UI running at http://localhost:${port}`);
});

async function loadDefaults() {
  const runConfig = await readJson(path.join(rootDir, 'config', 'full-workflow.example.json'));
  const qualityCriteria = await readJson(path.join(rootDir, runConfig.qualityCriteriaPath));
  const scenarioData = await loadScenarioData(runConfig.caseType);

  return {
    runConfig,
    qualityCriteria,
    scenarioData,
    caseTypes: await listCaseTypes(),
    hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    productionUrl: process.env.COMMON_GROUND_URL ?? null,
    uiBuild
  };
}

async function listCaseTypes() {
  const dir = path.join(rootDir, 'config', 'case-types');
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const caseTypes = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const criteria = await readJson(path.join(dir, entry.name));
    caseTypes.push({
      caseType: criteria.caseType ?? titleFromSlug(entry.name.replace(/\.json$/i, '')),
      criteriaPath: path.posix.join('config', 'case-types', entry.name)
    });
  }
  return caseTypes.sort((a, b) => a.caseType.localeCompare(b.caseType));
}

async function loadCriteriaForCaseType(caseType) {
  const criteriaPath = criteriaPathForCaseType(caseType);
  const qualityCriteria = await readJson(path.join(rootDir, criteriaPath));
  return {
    criteriaPath,
    qualityCriteria
  };
}

async function loadScenarioData(caseType) {
  const criteriaPath = criteriaPathForCaseType(caseType);
  const qualityCriteria = await readJson(path.join(rootDir, criteriaPath));
  const foundation = loadScenarioFoundation(rootDir, qualityCriteria);
  if (!foundation) {
    return {
      supported: false,
      criteriaPath,
      message: 'This topic has not been upgraded to the structured scenario format.'
    };
  }

  return {
    supported: true,
    criteriaPath,
    topic: foundation.topic,
    alignmentScenarios: foundation.alignmentScenarios.scenarios,
    behaviorCatalog: foundation.behaviorCatalog,
    defaultBehaviorSchedule: foundation.defaultBehaviorSchedule
  };
}

async function startRun(body) {
  if (activeRun) {
    throw new Error('A run is already active.');
  }

  const runConfig = sanitizeRunConfig(body.runConfig);
  const qualityCriteria = body.qualityCriteria;
  const behaviorSchedule = behaviorScheduleSchema.parse(body.behaviorSchedule);
  const scenarioData = loadScenarioFoundation(rootDir, qualityCriteria);
  if (!scenarioData) throw new Error('Structured runs require a schemaVersion 2 topic definition.');
  const scenarioExists = scenarioData.alignmentScenarios.scenarios.some((item) => item.id === runConfig.alignmentScenarioId);
  if (!scenarioExists) throw new Error(`Unknown alignment scenario: ${runConfig.alignmentScenarioId}`);
  const compatibilityIssues = validateBehaviorCompatibility(behaviorSchedule, scenarioData.behaviorCatalog);
  if (compatibilityIssues.length) throw new Error(`Behavior compatibility errors: ${compatibilityIssues.join('; ')}`);
  const headed = Boolean(body.headed);

  await fs.mkdir(tmpDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const criteriaPath = path.join(tmpDir, `quality-criteria-${stamp}.json`);
  const configPath = path.join(tmpDir, `test-run-${stamp}.json`);
  const behaviorSchedulePath = path.join(tmpDir, `behavior-schedule-${stamp}.json`);

  await fs.writeFile(criteriaPath, `${JSON.stringify(qualityCriteria, null, 2)}\n`, 'utf8');
  runConfig.qualityCriteriaPath = path.relative(rootDir, criteriaPath).replaceAll('\\', '/');
  await fs.writeFile(behaviorSchedulePath, `${JSON.stringify(behaviorSchedule, null, 2)}\n`, 'utf8');
  runConfig.behaviorSchedulePath = path.relative(rootDir, behaviorSchedulePath).replaceAll('\\', '/');
  await fs.writeFile(configPath, `${JSON.stringify(runConfig, null, 2)}\n`, 'utf8');

  const args = ['src/index.js', '--config', path.relative(rootDir, configPath)];
  if (headed) args.splice(1, 0, '--headed');

  const run = {
    id: stamp,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    artifactDir: null,
    logs: [],
    configPath,
    criteriaPath,
    behaviorSchedulePath
  };

  activeRun = run;
  lastRun = run;

  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    env: testProcessEnvironment(),
    shell: false
  });
  run.child = child;

  child.stdout.on('data', (chunk) => appendLog(run, chunk.toString()));
  child.stderr.on('data', (chunk) => appendLog(run, chunk.toString()));
  child.on('close', (code) => {
    run.exitCode = code;
    run.status = code === 0 ? 'passed' : 'failed';
    run.finishedAt = new Date().toISOString();
    activeRun = null;
  });

  return publicRun(run);
}

function testProcessEnvironment() {
  const env = { ...process.env };
  const localCertificate = path.join(rootDir, '.tmp', 'norton-root.pem');
  if (!env.NODE_EXTRA_CA_CERTS && fsSync.existsSync(localCertificate)) {
    env.NODE_EXTRA_CA_CERTS = localCertificate;
  }
  return env;
}

function sanitizeRunConfig(runConfig) {
  const runMode = normalizeRunMode(runConfig.runMode, runConfig.workflowScope, runConfig.existingCaseId);
  const existingCaseId = ['participant_getting_started', 'fact_labeling_smoke'].includes(runMode)
    ? normalizeCaseId(runConfig.existingCaseId)
    : '';
  if (['participant_getting_started', 'fact_labeling_smoke'].includes(runMode) && !existingCaseId) {
    throw new Error('This run mode requires a Common Ground Case ID.');
  }

  return {
    topic: String(runConfig.topic ?? 'Raise'),
    caseType: String(runConfig.caseType ?? runConfig.topic ?? 'Raise'),
    runMode,
    existingCaseId,
    factRatingStage: String(runConfig.factRatingStage ?? 'participant_rates_requestor'),
    workflowScope: runModeToWorkflowScope(runMode),
    testObjective: String(runConfig.testObjective ?? ''),
    testBehaviorPolicy: '',
    alignmentScenarioId: String(runConfig.alignmentScenarioId ?? ''),
    scenarioSeed: String(runConfig.scenarioSeed ?? ''),
    numberOfCases: ['participant_getting_started', 'fact_labeling_smoke'].includes(runMode)
      ? 1
      : Math.max(1, Number(runConfig.numberOfCases ?? 1)),
    maxTurns: Math.max(1, Number(runConfig.maxTurns ?? 25)),
    stopOnFailure: Boolean(runConfig.stopOnFailure),
    qualityCriteriaPath: String(runConfig.qualityCriteriaPath ?? criteriaPathForCaseType(runConfig.caseType ?? runConfig.topic))
  };
}

function criteriaPathForCaseType(caseType) {
  const slug = slugify(caseType || 'Raise');
  const candidate = path.join(rootDir, 'config', 'case-types', `${slug}.json`);
  if (fsSync.existsSync(candidate)) {
    return path.posix.join('config', 'case-types', `${slug}.json`);
  }
  return 'config/case-types/raise.json';
}

function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleFromSlug(value) {
  return String(value ?? '')
    .split('-')
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function normalizeRunMode(value, workflowScope, existingCaseId = '') {
  const raw = String(value ?? '').trim();
  if (raw === 'full_workflow') return raw;
  if (raw === 'participant_getting_started') return raw;
  if (raw === 'requestor_getting_started') return raw;
  if (raw === 'fact_labeling_smoke') return raw;
  if (normalizeCaseId(existingCaseId)) return 'participant_getting_started';
  return workflowScope === 'requestor_participant'
    ? 'full_workflow'
    : 'requestor_getting_started';
}

function normalizeCaseId(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw) return '';
  if (/^CG-\d+$/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `CG-${raw.padStart(4, '0')}`;
  return raw;
}

function runModeToWorkflowScope(runMode) {
  if (runMode === 'fact_labeling_smoke') return 'requestor_participant';
  if (runMode === 'participant_getting_started') return 'participant';
  if (runMode === 'full_workflow') return 'requestor_participant';
  return 'requestor';
}

function normalizeWorkflowScope(value, testBehaviorPolicy) {
  const raw = String(value ?? '').trim();
  if (raw === 'requestor_participant') return raw;
  if (raw === 'requestor') {
    return policyRequiresParticipant(testBehaviorPolicy) ? 'requestor_participant' : raw;
  }

  if (/participant/i.test(raw)) return 'requestor_participant';
  if (/requestor/i.test(raw)) return policyRequiresParticipant(testBehaviorPolicy) ? 'requestor_participant' : 'requestor';
  return policyRequiresParticipant(testBehaviorPolicy) ? 'requestor_participant' : 'requestor';
}

function policyRequiresParticipant(testBehaviorPolicy) {
  return /participant getting started|fact statement|fact labels?|respond as the participant|requestor\s*\+\s*participant/i.test(testBehaviorPolicy);
}

async function getRunStatus() {
  const run = activeRun ?? lastRun;
  if (!run) return { status: 'idle' };

  const payload = publicRun(run);
  if (run.artifactDir) {
    const summaryPath = path.join(run.artifactDir, 'summary.json');
    if (fsSync.existsSync(summaryPath)) {
      payload.summary = await readJson(summaryPath);
    }
    payload.artifactView = await loadArtifactView(run.artifactDir);
  }
  return payload;
}

async function loadArtifactView(artifactDir) {
  const candidates = [path.join(artifactDir, 'run.json')];
  if (fsSync.existsSync(artifactDir)) {
    const entries = await fs.readdir(artifactDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && /^case-\d+$/i.test(entry.name)) candidates.push(path.join(artifactDir, entry.name, 'run.json'));
    }
  }

  const cases = [];
  for (const candidate of candidates) {
    if (!fsSync.existsSync(candidate)) continue;
    const artifact = await readJson(candidate);
    cases.push({
      caseId: artifact.case?.commonGroundId ?? artifact.case?.id ?? null,
      status: artifact.status,
      workflowCompleted: artifact.workflowCompleted ?? false,
      statusBasis: artifact.statusBasis ?? null,
      stages: artifact.stages ?? [],
      behaviorExecutions: artifact.behaviorExecutions ?? [],
      behaviorCoverage: artifact.behaviorCoverage ?? null,
      scenarioExpressionPlan: artifact.scenarioExpressionPlan ?? artifact.scenarioDossiers?.scenarioExpressionPlan ?? null,
      softAssertions: artifact.softAssertions ?? [],
      alignmentReport: artifact.alignmentReport ?? null,
      scenarioPlan: artifact.scenarioPlan ? {
        seed: artifact.scenarioPlan.seed,
        alignmentScenarioId: artifact.scenarioPlan.alignmentScenarioId,
        behaviorScheduleId: artifact.scenarioPlan.behaviorScheduleId
      } : null
    });
  }
  return { cases };
}

function stopRun() {
  if (!activeRun?.child) {
    return { status: 'idle' };
  }

  activeRun.child.kill();
  activeRun.status = 'stopping';
  return publicRun(activeRun);
}

function appendLog(run, text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    run.logs.push(line);
    const artifactMatch = line.match(/Artifacts:\s*(.*)$/);
    if (artifactMatch) run.artifactDir = artifactMatch[1].trim();
  }
  run.logs = run.logs.slice(-500);
}

function publicRun(run) {
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    exitCode: run.exitCode,
    artifactDir: run.artifactDir,
    logs: run.logs
  };
}

async function serveStatic(urlPath, response) {
  const cleanPath = urlPath === '/' ? '/index.html' : urlPath;
  const resolved = path.resolve(publicDir, `.${cleanPath}`);

  if (!resolved.startsWith(publicDir) || !fsSync.existsSync(resolved)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  const ext = path.extname(resolved);
  const contentType = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8'
  }[ext] ?? 'application/octet-stream';

  response.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  response.end(await fs.readFile(resolved));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function readJsonBody(request, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`Request body exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response, data, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data, null, 2));
}

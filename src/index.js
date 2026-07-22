import { loadConfig } from './config.js';
import { runAutomation } from './commonGroundAutomation.js';
import { createRunStore } from './resultStore.js';
import { selectPersona } from './personas.js';

async function main() {
  const config = loadConfig(process.argv.slice(2));

  if (config.run.validateConfigOnly) {
    console.log('Configuration is valid.');
    console.log(`Target: ${config.productionUrl}`);
    console.log(`Selectors: ${process.env.SELECTORS_PATH ?? 'config/selectors.example.json'}`);
    return;
  }

  const resumeRunId = config.run.resumeRunId;
  const store = await createRunStore(config.rootDir, resumeRunId ? { runId: resumeRunId } : {});
  console.log(`Starting Common Ground automation run ${store.runId}`);
  console.log(`Run mode: ${formatRunMode(config.run.runMode)}`);
  if (config.run.runMode === 'full_workflow') {
    console.log(`Alignment scenario: ${config.run.alignmentScenarioId}`);
    console.log(`Behavior schedule: ${config.run.behaviorSchedule?.name ?? config.run.behaviorSchedulePath}`);
    console.log(`Post-processing wait: ${Math.round(config.run.postCompletionWaitMs / 60000)} minutes per stage`);
  }
  if (config.run.existingCaseId) console.log(`Existing case ID: ${config.run.existingCaseId}`);
  if (config.run.runMode === 'fact_labeling_smoke') console.log(`Fact labeling stage: ${config.run.factRatingStage}`);
  if (config.run.scriptedAnswersPath) console.log(`Scripted answers: ${config.run.scriptedAnswersPath} (behaviors disabled)`);

  let summary = resumeRunId ? await store.readJson('summary.json') : null;
  const resuming = Boolean(summary && Array.isArray(summary.cases));
  if (!resuming) {
    summary = {
      runId: store.runId,
      startedAt: new Date().toISOString(),
      topic: config.run.topic,
      caseType: config.run.caseType,
      runMode: config.run.runMode,
      existingCaseId: config.run.existingCaseId,
      workflowScope: config.run.workflowScope,
      numberOfCases: config.run.numberOfCases,
      stopOnFailure: config.run.stopOnFailure,
      qualityCriteriaPath: config.run.qualityCriteriaPath,
      scriptedAnswersPath: config.run.scriptedAnswersPath ?? null,
      cases: []
    };
  }

  const completedCaseNumbers = new Set(summary.cases.map((item) => item.caseNumber));
  if (resuming) {
    console.log(`Resuming run ${store.runId}: ${completedCaseNumbers.size} of ${config.run.numberOfCases} case(s) already recorded.`);
  }

  // Rewrite the batch rollups after every case so an interrupted run still has
  // an up-to-date summary/report/CSV (R1). `final` marks the terminal write.
  const persistSummary = async ({ final = false } = {}) => {
    summary.finishedAt = new Date().toISOString();
    const allRecorded = summary.cases.length >= config.run.numberOfCases;
    const allPassed = summary.cases.length > 0 && summary.cases.every((item) => item.status === 'passed');
    summary.status = (final || allRecorded)
      ? (allRecorded && allPassed ? 'passed' : 'failed')
      : 'in_progress';
    await store.writeJson('summary.json', summary);
    await store.writeText('run-report.txt', buildRunReport(config, summary));
    await store.writeText('cases.csv', buildCasesCsv(summary));
  };

  for (let caseNumber = 1; caseNumber <= config.run.numberOfCases; caseNumber += 1) {
    if (completedCaseNumbers.has(caseNumber)) {
      console.log(`Skipping case ${caseNumber} (already recorded in resumed run).`);
      continue;
    }
    const caseStore = config.run.numberOfCases === 1 ? store : store.caseStore(caseNumber);
    // Persona rotation is keyed to caseNumber only — never store.runId/scenarioSeed.
    const persona = selectPersona({ ...config.run.personas, caseNumber });

    let caseRow;
    try {
      console.log(`Starting case ${caseNumber} of ${config.run.numberOfCases}`);
      if (persona) console.log(`Case ${caseNumber} persona: ${persona.id} (${persona.polish}/${persona.detail})`);
      const result = await runAutomation(config, caseStore, { persona, caseNumber });
      caseRow = summarizeCase({ caseNumber, artifacts: result, artifactDir: caseStore.runDir, config });
      console.log(`Case ${caseNumber} finished with status: ${result.status}`);
    } catch (error) {
      // Record every case, including errors thrown before runAutomation's own
      // try/catch attaches artifacts (preflight, browser launch) — R3.
      caseRow = summarizeCase({ caseNumber, artifacts: error.artifacts ?? null, artifactDir: caseStore.runDir, errorMessage: error.message, config });
      console.error(error.message);
    }

    summary.cases.push(caseRow);
    completedCaseNumbers.add(caseNumber);
    await persistSummary();

    if (caseRow.status !== 'passed' && config.run.stopOnFailure) {
      console.log(`Stopping batch after case ${caseNumber} (stopOnFailure enabled).`);
      break;
    }
  }

  await persistSummary({ final: true });
  console.log(`Run finished with status: ${summary.status}`);
  console.log(`Artifacts: ${store.runDir}`);
  process.exitCode = summary.status === 'passed' ? 0 : 1;
}

main();

function buildRunReport(config, summary) {
  const lines = [
    'Common Ground Test Run Report',
    '=============================',
    '',
    'Run Setup',
    '---------',
    `Run ID: ${summary.runId}`,
    `Started At: ${summary.startedAt}`,
    `Finished At: ${summary.finishedAt}`,
    `Overall Status: ${summary.status}`,
    `Production URL: ${config.productionUrl}`,
    `Topic: ${config.run.topic}`,
    `Case Type / Template: ${config.run.caseType}`,
    `Run Mode: ${formatRunMode(config.run.runMode)}`,
    `Existing Case ID: ${config.run.existingCaseId ?? ''}`,
    `Fact Labeling Stage: ${config.run.factRatingStage ?? ''}`,
    `Number Of Cases: ${config.run.numberOfCases}`,
    `Max Conversation Turns: ${config.run.maxTurns}`,
    `Batch Failure Behavior: ${config.run.stopOnFailure ? 'Stop on failure' : 'Continue batch'}`,
    `Test Objective Metadata: ${config.run.testObjective}`,
    `Test Behavior Policy: ${config.run.testBehaviorPolicy}`,
    `Quality Criteria Path: ${config.run.qualityCriteriaPath ?? ''}`,
    `Alignment Scenario: ${config.run.alignmentScenarioId ?? ''}`,
    `Behavior Schedule: ${config.run.behaviorSchedule?.name ?? ''}`,
    `Scripted Answers: ${config.run.scriptedAnswersPath ?? 'none (LLM responder)'}`,
    `Post-Processing Timeout Per Stage: ${Math.round(config.run.postCompletionWaitMs / 60000)} minutes`,
    '',
    'Case Results',
    '------------'
  ];

  for (const item of summary.cases) {
    lines.push(
      `Case ${item.caseNumber}: ${item.status.toUpperCase()}`,
      `  Common Ground Case ID: ${item.caseId ?? 'not detected'}`,
      `  Synthetic Reference: ${item.syntheticReference ?? ''}`,
      `  Completed Getting Started: ${item.completedGettingStarted ?? false}`,
      `  Workflow Completed Through Final Fact Rating: ${item.workflowCompleted ?? false}`,
      `  Status Basis: ${item.statusBasis ?? 'interview result'}`,
      `  Requestor Getting Started: ${item.requestorGettingStartedCompleted ?? false}`,
      `  Participant Getting Started: ${item.participantGettingStartedCompleted ?? false}`,
      `  Synthetic User Scenario Compliant: ${item.syntheticUserScenarioCompliant ?? false}`,
      `  Behavior Coverage: ${item.behaviorCoverage?.behaviorsInjected === false
        ? 'N/A (scripted run — behaviors not injected)'
        : item.behaviorCoverage?.byActor
        ? `Employee ${item.behaviorCoverage.byActor.requestor.completedBehaviors}/${item.behaviorCoverage.byActor.requestor.assignedBehaviors}, Manager ${item.behaviorCoverage.byActor.participant.completedBehaviors}/${item.behaviorCoverage.byActor.participant.assignedBehaviors}`
        : 'not recorded'}`,
      `  Scripted Answers Used: ${item.scriptedAnswerCoverage
        ? `${item.scriptedAnswerCoverage.scriptedTurns} turns (${item.scriptedAnswerCoverage.sequentialFallbacks} sequential fallback), ${item.scriptedAnswerCoverage.llmTurns} LLM follow-ups`
        : 'n/a'}`,
      `  Soft Assertion Failures: ${item.softAssertionFailures ?? 0}`,
      `  Alignment Score: ${item.alignmentScore ?? 'not detected'}`,
      `  Alignment In Expected Range (record only): ${item.alignmentWithinExpectedRange ?? 'not evaluated'}`,
      `  Policy/Internal Stop Triggered: ${item.policyStopTriggered ?? false}`,
      `  Stop Reason: ${item.stopReason ?? ''}`,
      `  Manual Next Step: ${item.manualNextStep ?? ''}`,
      `  Error: ${item.error ?? ''}`,
      `  Artifacts: ${item.artifactDir}`,
      ''
    );
    for (const stage of item.stages ?? []) {
      lines.splice(lines.length - 1, 0, `    Stage - ${stage.name}: ${stage.status}${stage.detail ? ` (${stage.detail})` : ''}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

// Rolls up scripted-answer usage from a case's transcripts. Returns null when
// scripted-answers mode was not used (no scripted turns recorded).
function summarizeScriptedAnswers(result) {
  const transcripts = result?.transcripts ?? {};
  const entries = Object.values(transcripts).flat().filter((entry) => entry && entry.role === 'syntheticUser');
  const scripted = entries.filter((entry) => entry.responseSource === 'scripted');
  if (!scripted.length) return null;
  return {
    scriptedTurns: scripted.length,
    llmTurns: entries.filter((entry) => entry.responseSource === 'llm').length,
    sequentialFallbacks: scripted.filter((entry) => entry.scriptedAnswer?.matchConfidence === 'sequential-fallback').length,
    questionsAnswered: [...new Set(scripted.map((entry) => entry.scriptedAnswer?.primaryQuestionId).filter(Boolean))]
  };
}

// Single source of truth for a case's summary row, used by both the success and
// failure paths so failure rows carry the same fields (R3). `artifacts` is null
// when the case died before producing any (e.g. preflight failure).
function summarizeCase({ caseNumber, artifacts, artifactDir, errorMessage = null, config }) {
  return {
    caseNumber,
    status: artifacts?.status ?? 'failed',
    caseId: artifacts?.case?.commonGroundId ?? artifacts?.case?.id ?? null,
    syntheticReference: artifacts?.case?.syntheticReference ?? null,
    manualNextStep: artifacts?.manualNextStep ?? null,
    completedGettingStarted: artifacts?.completedGettingStarted ?? null,
    workflowCompleted: artifacts?.workflowCompleted ?? null,
    statusBasis: artifacts?.statusBasis ?? null,
    requestorGettingStartedCompleted: artifacts?.requestorGettingStarted?.completed ?? null,
    participantGettingStartedCompleted: artifacts?.participantGettingStarted?.completed ?? null,
    syntheticUserScenarioCompliant: artifacts?.syntheticUserScenarioCompliant ?? null,
    behaviorCoverage: artifacts?.behaviorCoverage ?? null,
    scriptedAnswerCoverage: artifacts ? summarizeScriptedAnswers(artifacts) : null,
    softAssertionFailures: artifacts?.softAssertions?.filter((item) => !item.passed).length ?? 0,
    alignmentScore: artifacts?.alignmentReport?.score ?? null,
    alignmentWithinExpectedRange: artifacts?.alignmentReport?.withinExpectedRange ?? null,
    stages: artifacts?.stages ?? null,
    stopReason: artifacts?.stopReason ?? errorMessage ?? null,
    policyStopTriggered: artifacts?.policyStopTriggered ?? null,
    alignmentScenarioId: artifacts?.alignmentScenarioId ?? config.run.alignmentScenarioId ?? null,
    personaId: artifacts?.persona?.id ?? null,
    scriptedAnswersPath: config.run.scriptedAnswersPath ?? null,
    error: errorMessage,
    artifactDir
  };
}

// Flat one-row-per-case rollup for pattern analysis across a batch (R4).
function buildCasesCsv(summary) {
  const header = [
    'case', 'caseId', 'status', 'alignmentScore', 'alignmentInExpectedRange',
    'stopReason', 'behaviorCoverage', 'scenario', 'persona', 'scriptedAnswersFile', 'error', 'artifactDir'
  ];
  const rows = summary.cases
    .slice()
    .sort((a, b) => a.caseNumber - b.caseNumber)
    .map((item) => [
      item.caseNumber,
      item.caseId ?? '',
      item.status ?? '',
      item.alignmentScore ?? '',
      item.alignmentWithinExpectedRange ?? '',
      item.stopReason ?? '',
      behaviorCoverageCell(item.behaviorCoverage),
      item.alignmentScenarioId ?? '',
      item.personaId ?? '',
      item.scriptedAnswersPath ?? '',
      item.error ?? '',
      item.artifactDir ?? ''
    ].map(csvCell).join(','));
  return `${[header.join(','), ...rows].join('\n')}\n`;
}

function behaviorCoverageCell(coverage) {
  if (!coverage) return '';
  if (coverage.behaviorsInjected === false) return 'N/A (scripted)';
  const byActor = coverage.byActor ?? {};
  const fmt = (actor) => byActor[actor]
    ? `${byActor[actor].completedBehaviors}/${byActor[actor].assignedBehaviors}`
    : '-';
  return `requestor ${fmt('requestor')}; participant ${fmt('participant')}`;
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function formatRunMode(runMode) {
  if (runMode === 'full_workflow') return 'Full Requestor + Participant Workflow';
  if (runMode === 'fact_labeling_smoke') return 'Fact Labeling Smoke Test';
  return runMode === 'participant_getting_started'
    ? 'Participant Getting Started'
    : 'Requestor Getting Started';
}

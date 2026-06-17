import { loadConfig } from './config.js';
import { runAutomation } from './commonGroundAutomation.js';
import { createRunStore } from './resultStore.js';

async function main() {
  const config = loadConfig(process.argv.slice(2));

  if (config.run.validateConfigOnly) {
    console.log('Configuration is valid.');
    console.log(`Target: ${config.productionUrl}`);
    console.log(`Selectors: ${process.env.SELECTORS_PATH ?? 'config/selectors.example.json'}`);
    return;
  }

  const store = await createRunStore(config.rootDir);
  console.log(`Starting Common Ground automation run ${store.runId}`);
  console.log(`Run mode: ${formatRunMode(config.run.runMode)}`);
  if (config.run.runMode === 'full_workflow') {
    console.log(`Alignment scenario: ${config.run.alignmentScenarioId}`);
    console.log(`Behavior schedule: ${config.run.behaviorSchedule?.name ?? config.run.behaviorSchedulePath}`);
    console.log(`Post-processing wait: ${Math.round(config.run.postCompletionWaitMs / 60000)} minutes per stage`);
  }
  if (config.run.existingCaseId) console.log(`Existing case ID: ${config.run.existingCaseId}`);
  if (config.run.runMode === 'fact_labeling_smoke') console.log(`Fact labeling stage: ${config.run.factRatingStage}`);

  const summary = {
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
    cases: []
  };

  for (let caseNumber = 1; caseNumber <= config.run.numberOfCases; caseNumber += 1) {
    const caseStore = config.run.numberOfCases === 1 ? store : store.caseStore(caseNumber);

    try {
      console.log(`Starting case ${caseNumber} of ${config.run.numberOfCases}`);
      const result = await runAutomation(config, caseStore);
      summary.cases.push({
        caseNumber,
        status: result.status,
        caseId: result.case?.commonGroundId ?? result.case?.id ?? null,
        syntheticReference: result.case?.syntheticReference ?? null,
        manualNextStep: result.manualNextStep,
        completedGettingStarted: result.completedGettingStarted,
        workflowCompleted: result.workflowCompleted,
        statusBasis: result.statusBasis,
        requestorGettingStartedCompleted: result.requestorGettingStarted?.completed,
        participantGettingStartedCompleted: result.participantGettingStarted?.completed,
        syntheticUserScenarioCompliant: result.syntheticUserScenarioCompliant,
        behaviorCoverage: result.behaviorCoverage,
        softAssertionFailures: result.softAssertions?.filter((item) => !item.passed).length ?? 0,
        alignmentScore: result.alignmentReport?.score,
        alignmentWithinExpectedRange: result.alignmentReport?.withinExpectedRange,
        stages: result.stages,
        stopReason: result.stopReason,
        policyStopTriggered: result.policyStopTriggered,
        artifactDir: caseStore.runDir
      });
      console.log(`Case ${caseNumber} finished with status: ${result.status}`);

      if (result.status !== 'passed' && config.run.stopOnFailure) {
        break;
      }
    } catch (error) {
      if (error.artifacts) {
        summary.cases.push({
          caseNumber,
          status: 'failed',
          caseId: error.artifacts.case?.commonGroundId ?? error.artifacts.case?.id ?? null,
          syntheticReference: error.artifacts.case?.syntheticReference ?? null,
          manualNextStep: error.artifacts.manualNextStep,
          error: error.message,
          stopReason: error.artifacts.stopReason,
          artifactDir: caseStore.runDir
        });
      }
      console.error(error.message);

      if (config.run.stopOnFailure) {
        break;
      }
    }
  }

  summary.finishedAt = new Date().toISOString();
  summary.status = summary.cases.length === config.run.numberOfCases
    && summary.cases.every((result) => result.status === 'passed')
    ? 'passed'
    : 'failed';

  await store.writeJson('summary.json', summary);
  await store.writeText('run-report.txt', buildRunReport(config, summary));
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

function formatRunMode(runMode) {
  if (runMode === 'full_workflow') return 'Full Requestor + Participant Workflow';
  if (runMode === 'fact_labeling_smoke') return 'Fact Labeling Smoke Test';
  return runMode === 'participant_getting_started'
    ? 'Participant Getting Started'
    : 'Requestor Getting Started';
}

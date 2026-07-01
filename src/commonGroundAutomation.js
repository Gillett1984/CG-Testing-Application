import { chromium } from 'playwright';
import { buildSyntheticCase } from './syntheticData.js';
import { generatePartnerAiResponse, generateScenarioDossiers, verifyOpenAiConnectivity } from './llmResponder.js';
import { extractPromptContext } from './promptContext.js';
import { evaluateManeuverSuccess, evaluatePolicyAdvanceStop, findActiveManeuver } from './testManeuvers.js';
import { createScenarioController } from './scenarioController.js';
import { matchScenarioQuestion, matchScenarioQuestionScored, matchScenarioCriterion, textSimilarity } from './questionMatching.js';
import { pickScriptedAnswer } from './scriptedAnswers.js';

export async function runAutomation(config, store) {
  if (config.run.runMode !== 'fact_labeling_smoke') await verifyOpenAiConnectivity(config.llm);
  const browser = await chromium.launch(config.browser);
  const requestorTranscript = [];
  const participantTranscript = [];
  const artifacts = {
    runId: store.runId,
    productionUrl: config.productionUrl,
    topic: config.run.topic,
    caseType: config.run.caseType,
    runMode: config.run.runMode,
    workflowScope: config.run.workflowScope,
    existingCaseId: config.run.existingCaseId,
    testObjective: config.run.testObjective,
    testBehaviorPolicy: config.run.testBehaviorPolicy,
    qualityCriteriaPath: config.run.qualityCriteriaPath,
    status: 'started',
    startedAt: new Date().toISOString(),
    case: null,
    stages: [],
    transcripts: {
      requestorGettingStarted: requestorTranscript,
      participantGettingStarted: participantTranscript
    },
    behaviorExecutions: [],
    softAssertions: []
  };

  try {
    const syntheticCase = buildSyntheticCase({
      topic: config.run.topic,
      caseType: config.run.caseType,
      participantEmail: config.credentials.participant.email
    });

    if (config.run.runMode === 'full_workflow') {
      return await runFullWorkflow({ browser, config, store, artifacts, syntheticCase, requestorTranscript, participantTranscript });
    }

    if (config.run.runMode === 'fact_labeling_smoke') {
      artifacts.case = existingCaseFromConfig(config, syntheticCase);
      return await runFactLabelingSmoke({ browser, config, store, artifacts, syntheticCase });
    }

    if (config.run.runMode === 'participant_getting_started') {
      artifacts.case = existingCaseFromConfig(config, syntheticCase);
      recordStage(artifacts, 'Open existing case', 'started', artifacts.case.commonGroundId);
      const participantInterviewContext = await browser.newContext();
      const participantInterviewPage = await participantInterviewContext.newPage();
      await login(participantInterviewPage, config, 'participant');
      await openCaseAsParticipant(participantInterviewPage, config, artifacts.case, syntheticCase);
      recordStage(artifacts, 'Open existing case', 'passed', artifacts.case.commonGroundId);

      recordStage(artifacts, 'Participant Getting Started', 'started');
      await startGettingStarted(participantInterviewPage, config, artifacts.case);
      const participantResult = await runPartnerAiInterview(participantInterviewPage, config, participantTranscript, {
        seed: `${artifacts.case.commonGroundId ?? store.runId}:participant`,
        actorRole: 'participant',
        scriptedAnswers: config.run.scriptedAnswers
      });
      artifacts.participantGettingStarted = participantResult;
      artifacts.completedGettingStarted = participantResult.completed;
      artifacts.stopReason = participantResult.stopReason;
      artifacts.policyStopTriggered = participantResult.policyStopTriggered;
      artifacts.status = participantResult.passed ? 'passed' : 'failed';
      artifacts.finalUrl = participantInterviewPage.url();
      artifacts.finalVisibleText = await readVisibleBodyText(participantInterviewPage);
      recordStage(artifacts, 'Participant Getting Started', participantResult.passed ? 'passed' : 'failed', participantResult.stopReason);
      await participantInterviewPage.screenshot({ path: `${store.runDir}/participant-final.png`, fullPage: true });
      await participantInterviewContext.close();
      artifacts.finishedAt = new Date().toISOString();
      return artifacts;
    }

    recordStage(artifacts, 'Create case', 'started');
    const requestorContext = await browser.newContext();
    const requestorPage = await requestorContext.newPage();
    await login(requestorPage, config, 'requestor');
    artifacts.case = await createCase(requestorPage, config, syntheticCase);
    await requestorContext.close();
    recordStage(artifacts, 'Create case', 'passed', artifacts.case?.commonGroundId ?? artifacts.case?.syntheticReference ?? '');

    recordStage(artifacts, 'Accept participant invitation', 'started');
    const participantContext = await browser.newContext();
    const participantPage = await participantContext.newPage();
    await login(participantPage, config, 'participant');
    await acceptCaseRequest(participantPage, config, syntheticCase, artifacts.case);
    await participantContext.close();
    recordStage(artifacts, 'Accept participant invitation', 'passed');

    recordStage(artifacts, 'Requestor Getting Started', 'started');
    const interviewContext = await browser.newContext();
    const interviewPage = await interviewContext.newPage();
    await login(interviewPage, config, 'requestor');
    await openCaseAsRequestor(interviewPage, config, artifacts.case, syntheticCase);
    await startGettingStarted(interviewPage, config, artifacts.case);
    updateArtifactCaseId(artifacts, await findCaseId(interviewPage));

    const requestorResult = await runPartnerAiInterview(interviewPage, config, requestorTranscript, {
      seed: artifacts.case?.commonGroundId ?? artifacts.case?.syntheticReference ?? store.runId,
      actorRole: 'requestor',
      scriptedAnswers: config.run.scriptedAnswers
    });
    updateArtifactCaseId(artifacts, findCaseIdInText(JSON.stringify(requestorTranscript)));
    artifacts.requestorGettingStarted = requestorResult;
    artifacts.completedGettingStarted = requestorResult.completed;
    artifacts.stopReason = requestorResult.stopReason;
    artifacts.policyStopTriggered = requestorResult.policyStopTriggered;
    recordStage(artifacts, 'Requestor Getting Started', requestorResult.passed ? 'passed' : 'failed', requestorResult.stopReason);

    artifacts.finalUrl = interviewPage.url();
    artifacts.finalVisibleText = await readVisibleBodyText(interviewPage);
    updateArtifactCaseId(artifacts, findCaseIdInText(artifacts.finalVisibleText));
    artifacts.manualNextStep = requestorResult.passed
      ? 'Complete Common Ground post-processing and fact statement labeling manually, then run Participant Getting Started mode with this Common Ground Case ID.'
      : '';
    artifacts.status = requestorResult.passed ? 'passed' : 'failed';
    artifacts.finishedAt = new Date().toISOString();
    await interviewPage.screenshot({ path: `${store.runDir}/final.png`, fullPage: true });
    await interviewContext.close();
    return artifacts;
  } catch (error) {
    artifacts.status = 'failed';
    artifacts.error = {
      message: error.message,
      stack: error.stack
    };
    artifacts.finishedAt = new Date().toISOString();
    throw Object.assign(error, { artifacts });
  } finally {
    await store.writeJson('run.json', artifacts);
    await browser.close();
  }
}

export function factStatementLabelForStage({ topic, scenario, kind }) {
  const ownLabel = topic?.workflow?.factStatementLabel ?? 'Confident Fact';
  if (kind !== 'cross' || !scenario) return ownLabel;
  const averageDistance = scenarioAverageRatingDistance(topic, scenario);
  if (averageDistance === 0) return 'Confident Fact';
  if (averageDistance <= 1) return 'Likely Fact';
  if (averageDistance <= 2) return 'Uncertain';
  return 'Opinion';
}

export function scenarioAverageRatingDistance(topic, scenario) {
  const scores = new Map((topic?.ratingScale ?? []).map((rating) => [rating.id, Number(rating.score)]));
  const distances = (topic?.terms ?? []).map((term) => {
    const requestorScore = scores.get(scenario?.ratings?.requestor?.[term.id]);
    const participantScore = scores.get(scenario?.ratings?.participant?.[term.id]);
    if (!Number.isFinite(requestorScore) || !Number.isFinite(participantScore)) {
      throw new Error(`Cannot compute cross-party fact label for ${term.id}; rating scores are missing.`);
    }
    return Math.abs(requestorScore - participantScore);
  });
  return distances.length ? distances.reduce((sum, distance) => sum + distance, 0) / distances.length : 0;
}

async function runFactLabelingSmoke({ browser, config, store, artifacts, syntheticCase }) {
  const stages = {
    requestor_own: { actorRole: 'requestor', kind: 'own', label: 'Requestor labels own facts' },
    participant_rates_requestor: {
      actorRole: 'participant', kind: 'cross', ratedParty: 'requestor',
      linkText: /Rate Requestor'?s Facts/i, mode: 'participant_rates_requestor', label: 'Participant rates Requestor facts'
    },
    participant_own: { actorRole: 'participant', kind: 'own', label: 'Participant labels own facts' },
    requestor_rates_participant: {
      actorRole: 'requestor', kind: 'cross', ratedParty: 'participant',
      linkText: /Rate Participant'?s Facts/i, mode: 'requestor_rates_participant', label: 'Requestor rates Participant facts'
    }
  };
  const stage = stages[config.run.factRatingStage];
  if (!stage) throw new Error(`Unknown fact labeling smoke-test stage: ${config.run.factRatingStage}`);

  recordStage(artifacts, stage.label, 'started', artifacts.case.commonGroundId);
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, config, stage.actorRole);
  if (stage.actorRole === 'participant') await openCaseAsParticipant(page, config, artifacts.case, syntheticCase);
  else await openCaseAsRequestor(page, config, artifacts.case, syntheticCase);

  const smokeScenario = config.run.scenarioFoundation?.alignmentScenarios?.scenarios
    ?.find((item) => item.id === config.run.alignmentScenarioId);
  const labelText = factStatementLabelForStage({
    topic: config.run.scenarioFoundation?.topic,
    scenario: smokeScenario,
    kind: stage.kind
  });
  if (stage.kind === 'cross') {
    await completeCrossPartyFactReview(page, config, artifacts.case, labelText, {
      raterRole: stage.actorRole,
      ratedParty: stage.ratedParty,
      linkText: stage.linkText,
      mode: stage.mode
    });
  } else {
    await openOwnFactReviewForSmokeTest(page, config, artifacts.case);
    await labelFactStatements(page, config, labelText);
  }

  artifacts.status = 'passed';
  artifacts.completedGettingStarted = false;
  artifacts.stopReason = `${stage.label} smoke test completed.`;
  artifacts.finalUrl = page.url();
  artifacts.finalVisibleText = await readVisibleBodyText(page);
  recordStage(artifacts, stage.label, 'passed', 'All facts labeled and submitted.');
  await page.screenshot({ path: `${store.runDir}/fact-labeling-smoke-final.png`, fullPage: true });
  await context.close();
  artifacts.finishedAt = new Date().toISOString();
  return artifacts;
}

async function openOwnFactReviewForSmokeTest(page, config, createdCase) {
  const deadline = Date.now() + config.run.postCompletionWaitMs;
  while (Date.now() < deadline) {
    const text = await readVisibleBodyText(page);
    if (factLabelingReady(text, page.url())) return;
    if (excerptReviewReady(text, page.url())) {
      await submitExcerptReview(page, config);
      continue;
    }
    const direct = page.locator('a[href*="/fact-review"], a[href*="/fact-statements"]').first();
    if (await direct.isVisible({ timeout: 500 }).catch(() => false)) {
      await direct.click();
      await page.waitForLoadState('networkidle').catch(() => {});
      continue;
    }
    if (isDashboardPage(page.url(), text)) {
      await openCaseDetailsFromDashboard(page, createdCase, config.run.caseType).catch(() => {});
    } else {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1000);
  }
  throw new Error(`Own-fact labeling page did not become available for ${createdCase.commonGroundId}.`);
}

async function runFullWorkflow({ browser, config, store, artifacts, syntheticCase, requestorTranscript, participantTranscript }) {
  if (!config.run.scenarioFoundation) throw new Error('Full workflow mode requires a schemaVersion 2 topic definition.');
  const scenarioController = createScenarioController({
    foundation: config.run.scenarioFoundation,
    alignmentScenarioId: config.run.alignmentScenarioId,
    behaviorSchedule: config.run.behaviorSchedule,
    seed: config.run.scenarioSeed || store.runId
  });
  const selectedScenario = config.run.scenarioFoundation.alignmentScenarios.scenarios
    .find((scenario) => scenario.id === config.run.alignmentScenarioId);
  const ownFactLabel = factStatementLabelForStage({
    topic: config.run.scenarioFoundation.topic,
    scenario: selectedScenario,
    kind: 'own'
  });
  const crossPartyFactLabel = factStatementLabelForStage({
    topic: config.run.scenarioFoundation.topic,
    scenario: selectedScenario,
    kind: 'cross'
  });
  // Start dossier generation concurrently with browser setup. The dossier is only
  // needed once the first interview begins (create-case and accept-invitation do
  // not use it), so overlapping it with that browser work hides most of its
  // latency. This changes ONLY timing — the dossier content is unchanged.
  recordStage(artifacts, 'Generate Scenario Dossiers', 'started');
  const dossiersPromise = generateScenarioDossiers({
    llm: config.llm,
    topic: config.run.scenarioFoundation.topic,
    scenario: selectedScenario,
    seed: `${store.runId}:${syntheticCase.reference}`
  });
  // Avoid an unhandled rejection if browser setup throws before we await it.
  dossiersPromise.catch(() => {});

  recordStage(artifacts, 'Create case', 'started');
  const requestorSetupContext = await browser.newContext();
  const requestorSetupPage = await requestorSetupContext.newPage();
  await login(requestorSetupPage, config, 'requestor');
  artifacts.case = await createCase(requestorSetupPage, config, syntheticCase);
  await requestorSetupContext.close();
  recordStage(artifacts, 'Create case', 'passed', artifacts.case?.commonGroundId ?? artifacts.case?.syntheticReference ?? '');

  recordStage(artifacts, 'Accept participant invitation', 'started');
  const participantSetupContext = await browser.newContext();
  const participantSetupPage = await participantSetupContext.newPage();
  await login(participantSetupPage, config, 'participant');
  await acceptCaseRequest(participantSetupPage, config, syntheticCase, artifacts.case);
  await participantSetupContext.close();
  recordStage(artifacts, 'Accept participant invitation', 'passed');

  // New Common Ground order: the conversation is sequential and gated by
  // requestor/participant role (participant = invitee, requestor = creator).
  // The participant completes their interview + facts FIRST. Then the requestor
  // rates the participant's facts, does their own interview + facts, and finally
  // the participant rates the requestor's facts. Roles drive the order,
  // independent of employee/manager.
  artifacts.case.requireExactCaseMatch = true;

  // Steps 3-4: Participant interview, then Participant fact section.
  // Open the participant's case page BEFORE awaiting the dossier, so a real
  // window stays visible during the dossier wait instead of a blank one.
  const participantContext = await browser.newContext();
  const participantPage = await participantContext.newPage();
  await login(participantPage, config, 'participant');
  await openCaseAsParticipant(participantPage, config, artifacts.case, syntheticCase);

  // D8: click into Getting Started as soon as its link is available on the Case
  // Details page — do NOT wait on the dossier first. ensureGettingStartedOpen
  // clicks the link the moment it is visible; the dossier then finishes while
  // Common Ground loads the interview page (it is only needed once we read the
  // first prompt and generate a response, just below).
  recordStage(artifacts, 'Participant Getting Started', 'started');
  await ensureGettingStartedOpen(participantPage, config, artifacts.case);

  // The dossier is required before the first response is generated. The wait now
  // overlaps the Getting Started interview-page load instead of blocking on Case Details.
  const dossiers = await dossiersPromise;
  scenarioController.setDossiers(dossiers);
  artifacts.scenarioDossiers = dossiers;
  artifacts.scenarioExpressionPlan = dossiers.scenarioExpressionPlan;
  for (const warning of dossiers.pairValidation?.warnings ?? []) {
    artifacts.softAssertions.push({
      type: 'scenario_dossier_pair_audit',
      passed: false,
      expected: 'Employee and manager interpretations clearly express the named scenario while sharing objective facts.',
      observed: warning
    });
  }
  await store.writeJson('scenario-dossiers.json', dossiers);
  await store.writeJson('scenario-expression-plan.json', dossiers.scenarioExpressionPlan);
  recordStage(
    artifacts,
    'Generate Scenario Dossiers',
    'passed',
    `${dossiers.employee.canonicalProfile.employeeRole}; ${dossiers.scenarioExpressionPlan.questionExpressions.length} question relationships; fresh case seed ${dossiers.caseSeed}; pair audit warnings ${dossiers.pairValidation?.warnings?.length ?? 0}.`
  );
  artifacts.scenarioPlan = scenarioController.getPlan();
  artifacts.alignmentScenarioId = config.run.alignmentScenarioId;
  artifacts.behaviorScheduleId = config.run.behaviorSchedule.id;

  const participantResult = await runPartnerAiInterview(participantPage, config, participantTranscript, {
    seed: `${artifacts.case?.commonGroundId ?? store.runId}:participant`,
    actorRole: 'participant',
    scenarioController,
    scriptedAnswers: config.run.scriptedAnswers,
    artifacts
  });
  artifacts.participantGettingStarted = participantResult;
  recordStage(artifacts, 'Participant Getting Started', participantResult.passed ? 'passed' : 'failed', participantResult.stopReason);
  if (!participantResult.passed) throw new Error(participantResult.stopReason);

  recordStage(artifacts, 'Participant Fact Section', 'started');
  await completeActorPostProcessing(participantPage, config, artifacts, 'Participant', ownFactLabel);
  recordStage(artifacts, 'Participant Fact Section', 'passed', `All fact statements labeled ${ownFactLabel}.`);
  await participantPage.screenshot({ path: `${store.runDir}/participant-post-processing.png`, fullPage: true });
  await participantContext.close();

  // Steps 5-8: Requestor rates the participant's facts, waits for Getting Started
  // to become available, then does their own interview and fact section. One
  // requestor session covers all four steps.
  const requestorContext = await browser.newContext();
  const requestorPage = await requestorContext.newPage();
  await login(requestorPage, config, 'requestor');
  await openCaseAsRequestor(requestorPage, config, artifacts.case, syntheticCase);

  recordStage(artifacts, 'Requestor Rates Participant Facts', 'started');
  await completeCrossPartyFactReview(
    requestorPage,
    config,
    artifacts.case,
    crossPartyFactLabel,
    {
      raterRole: 'requestor',
      ratedParty: 'participant',
      linkText: /Rate Participant'?s Facts/i,
      mode: 'requestor_rates_participant'
    }
  );
  recordStage(artifacts, 'Requestor Rates Participant Facts', 'passed', `Participant facts labeled ${crossPartyFactLabel}.`);
  await requestorPage.screenshot({ path: `${store.runDir}/requestor-rates-participant-facts.png`, fullPage: true });

  // Step 6: the Getting Started button does not appear immediately after rating;
  // re-open the case from the dashboard and poll until it is available.
  await waitForRequestorGettingStarted(requestorPage, config, artifacts.case, syntheticCase);
  await startGettingStarted(requestorPage, config, artifacts.case);
  updateArtifactCaseId(artifacts, await findCaseId(requestorPage));

  recordStage(artifacts, 'Requestor Getting Started', 'started');
  const requestorResult = await runPartnerAiInterview(requestorPage, config, requestorTranscript, {
    seed: `${artifacts.case?.commonGroundId ?? store.runId}:requestor`,
    actorRole: 'requestor',
    scenarioController,
    scriptedAnswers: config.run.scriptedAnswers,
    artifacts
  });
  artifacts.requestorGettingStarted = requestorResult;
  recordStage(artifacts, 'Requestor Getting Started', requestorResult.passed ? 'passed' : 'failed', requestorResult.stopReason);
  if (!requestorResult.passed) throw new Error(requestorResult.stopReason);

  recordStage(artifacts, 'Requestor Fact Section', 'started');
  await completeActorPostProcessing(requestorPage, config, artifacts, 'Requestor', ownFactLabel);
  recordStage(artifacts, 'Requestor Fact Section', 'passed', `All fact statements labeled ${ownFactLabel}.`);
  await requestorPage.screenshot({ path: `${store.runDir}/requestor-post-processing.png`, fullPage: true });
  await requestorContext.close();

  // Step 9: Participant rates the requestor's facts.
  recordStage(artifacts, 'Participant Rates Requestor Facts', 'started');
  const participantReviewContext = await browser.newContext();
  const participantReviewPage = await participantReviewContext.newPage();
  await login(participantReviewPage, config, 'participant');
  await openCaseAsParticipant(participantReviewPage, config, artifacts.case, syntheticCase);
  await completeParticipantFactReview(
    participantReviewPage,
    config,
    artifacts.case,
    crossPartyFactLabel
  );
  recordStage(artifacts, 'Participant Rates Requestor Facts', 'passed', `Requestor facts labeled ${crossPartyFactLabel}.`);
  await participantReviewPage.screenshot({ path: `${store.runDir}/participant-rates-requestor-facts.png`, fullPage: true });
  await participantReviewContext.close();

  artifacts.workflowCompleted = true;
  artifacts.workflowCompletionStage = 'Participant Rates Requestor Facts';

  recordStage(artifacts, 'Alignment Report', 'started');
  const reportContext = await browser.newContext();
  const reportPage = await reportContext.newPage();
  let alignmentReportIssue = null;
  try {
    await login(reportPage, config, 'requestor');
    await openCaseAsRequestor(reportPage, config, artifacts.case, syntheticCase);
    const alignmentReportConfig = {
      ...config,
      run: { ...config.run, postCompletionWaitMs: Math.min(config.run.postCompletionWaitMs, 180000) }
    };
    const alignmentReport = await waitForAndReadAlignmentReport(reportPage, alignmentReportConfig, artifacts.case);
    artifacts.alignmentReport = {
      ...alignmentReport,
      expectedRange: config.run.scenarioFoundation.alignmentScenarios.scenarios
        .find((scenario) => scenario.id === config.run.alignmentScenarioId).expectedAlignmentRange,
      affectsCaseResult: false
    };
    artifacts.alignmentReport.withinExpectedRange = alignmentScoreWithinExpectedRange(
      alignmentReport.score,
      artifacts.alignmentReport.expectedRange
    );
    recordStage(artifacts, 'Alignment Report', 'passed', alignmentReport.score === null ? 'Score not detected.' : `Score ${alignmentReport.score}.`);
    await reportPage.screenshot({ path: `${store.runDir}/alignment-report.png`, fullPage: true });
  } catch (error) {
    alignmentReportIssue = {
      type: 'alignment_report_availability',
      passed: false,
      expected: 'Alignment Report becomes available after workflow completion.',
      observed: error.message
    };
    artifacts.alignmentReport = {
      score: null,
      withinExpectedRange: undefined,
      affectsCaseResult: false,
      unavailableReason: error.message
    };
    recordStage(artifacts, 'Alignment Report', 'not_available', `${error.message} (record only)`);
  } finally {
    await reportContext.close();
  }

  const coverage = scenarioController.getCoverageSummary();
  artifacts.behaviorCoverage = coverage;
  artifacts.behaviorExecutions = scenarioController.executionResults;
  artifacts.softAssertions = [
    ...artifacts.softAssertions,
    ...scenarioController.executionResults.flatMap((result) => result.softAssertions)
  ];
  if (alignmentReportIssue) artifacts.softAssertions.push(alignmentReportIssue);
  artifacts.completedGettingStarted = requestorResult.completed && participantResult.completed;
  artifacts.syntheticUserScenarioCompliant = coverage.syntheticUserScenarioCompliant;
  artifacts.status = fullWorkflowResultStatus({
    workflowCompleted: artifacts.workflowCompleted
  });
  artifacts.statusBasis = 'workflow_completion';
  artifacts.stopReason = artifacts.workflowCompleted
    ? 'Full workflow completed through Requestor rating of Participant facts.'
    : 'The Common Ground workflow did not complete.';
  artifacts.finishedAt = new Date().toISOString();
  return artifacts;
}

function fullWorkflowResultStatus({ workflowCompleted, behaviorScheduleCompleted = true }) {
  return workflowCompleted && behaviorScheduleCompleted ? 'passed' : 'failed';
}

function recordStage(artifacts, name, status, detail = '') {
  artifacts.stages.push({
    name,
    status,
    detail,
    at: new Date().toISOString()
  });
}

function existingCaseFromConfig(config, syntheticCase) {
  const commonGroundId = normalizeCaseId(config.run.existingCaseId);
  if (!commonGroundId) {
    throw new Error('Participant Getting Started mode requires a Common Ground Case ID.');
  }

  return {
    id: commonGroundId,
    commonGroundId,
    syntheticReference: '',
    title: syntheticCase.title,
    requireExactCaseMatch: true
  };
}

function normalizeCaseId(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw) return '';
  if (/^CG-\d+$/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `CG-${raw.padStart(4, '0')}`;
  return raw;
}

async function login(page, config, role) {
  const selectors = config.selectors.auth;
  const credentials = config.credentials[role];

  await page.goto(config.productionUrl, { waitUntil: 'domcontentloaded' });
  await fill(page, selectors.emailInput, credentials.email, `${role} email`);
  await fill(page, selectors.passwordInput, credentials.password, `${role} password`);
  await click(page, selectors.submitButton, `${role} login submit`);
  await waitForIdle(page);
  await assertLoggedIn(page, config, role);
  await verifyAuthenticatedRoute(page, config, role);
}

async function logout(page, config) {
  await click(page, config.selectors.auth.logoutButton, 'logout');
  await page.waitForLoadState('networkidle').catch(() => {});
}

async function createCase(page, config, syntheticCase) {
  const selectors = config.selectors.requestor;

  await page.goto(new URL('/dashboard', config.productionUrl).toString(), { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  const existingCaseIds = findCaseIdsInText(await readVisibleBodyText(page));

  await page.goto(new URL('/request/new', config.productionUrl).toString(), { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await assertNotLoginRequired(page, 'open new case page');
  await selectCaseType(page, syntheticCase.caseType);
  // The New Case Request form auto-fills the logged-in user's party and leaves the
  // other party empty. Fill every present date with today, then fill the empty
  // party's Name/Email by detecting empty, editable fields (not a fixed party id).
  await fillPresentDates(page, todayIso());
  await fillFirstEmpty(page, 'input[type="text"]', syntheticCase.participantName, 'empty party name');
  await fillFirstEmpty(page, 'input[type="email"]', syntheticCase.participantEmail, 'empty party email');
  await click(page, selectors.createCaseButton, 'create case submit');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2000);

  const commonGroundId = await waitForCreatedCaseId(page, config, existingCaseIds);
  if (!commonGroundId) {
    throw new Error('Common Ground case creation completed, but the new Common Ground ID could not be detected. Refusing to continue without an exact case identity.');
  }

  return {
    id: commonGroundId,
    commonGroundId,
    requireExactCaseMatch: true,
    caseUrl: page.url(),
    syntheticReference: syntheticCase.reference,
    title: syntheticCase.title
  };
}

async function waitForCreatedCaseId(page, config, existingCaseIds = []) {
  const knownIds = new Set(existingCaseIds.map((id) => id.toUpperCase()));
  const deadline = Date.now() + 90000;
  let lastText = '';

  while (Date.now() < deadline) {
    lastText = await readVisibleBodyText(page);
    const currentIds = findCaseIdsInText(`${page.url()}\n${lastText}`);
    const newId = currentIds.find((id) => !knownIds.has(id));
    if (newId) return newId;

    if (!isDashboardPage(page.url(), lastText)) {
      const directId = findCaseIdInText(`${page.url()}\n${lastText}`);
      if (directId && !knownIds.has(directId)) return directId;
      await page.goto(new URL('/dashboard', config.productionUrl).toString(), { waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitForIdle(page);
    } else {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitForIdle(page);
    }
    await page.waitForTimeout(1500);
  }

  return null;
}

async function acceptCaseRequest(page, config, syntheticCase, createdCase) {
  await ensureOnDashboard(page, config);
  await clickCaseCardButton(page, createdCase, /Review Invitation|Review|Invitation/i);
  await waitForIdle(page);
  await click(page, config.selectors.participant.acceptRequestButton, 'accept case request');
  await waitForIdle(page);
}

async function openCaseAsRequestor(page, config, createdCase, syntheticCase) {
  await ensureOnDashboard(page, config);
  await openCaseFromDashboard(page, createdCase, syntheticCase.caseType);
  await waitForIdle(page);
}

async function openCaseAsParticipant(page, config, createdCase, syntheticCase) {
  await ensureOnDashboard(page, config);
  await openCaseDetailsFromDashboard(page, createdCase, syntheticCase.caseType);
  await waitForIdle(page);
}

async function startGettingStarted(page, config, createdCase) {
  const directLink = page.locator('a[href*="/get-started"]').first();
  if (await directLink.isVisible({ timeout: 750 }).catch(() => false)) {
    await directLink.click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);
    return;
  }
  for (const role of ['link', 'button']) {
    const control = page.getByRole(role, { name: /^(Getting Started|Begin Discussion)$/i }).first();
    const visible = await control.isVisible({ timeout: 500 }).catch(() => false);
    const enabled = visible && await control.isEnabled({ timeout: 500 }).catch(() => false);
    if (enabled) {
      await control.click();
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(2000);
      return;
    }
  }
  if (!isDashboardPage(page.url(), await readVisibleBodyText(page))) {
    await page.goto(new URL('/dashboard', config.productionUrl).toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  await clickCaseCardButton(page, createdCase, /Getting Started|Begin Discussion/i);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2000);
}

async function runPartnerAiInterview(page, config, transcript, options = {}) {
  await waitForInterviewReady(page, config);

  // Scripted-answers mode: which primary questions this actor has already
  // answered from the supplied script (so only the FIRST turn of each primary
  // question uses the scripted answer; follow-ups fall back to the responder).
  const scriptedAnswers = options.scriptedAnswers ?? null;
  const answeredScriptedQuestions = new Set();

  for (let turn = 1; turn <= config.run.maxTurns; turn += 1) {
    const latestPrompt = await readLatestPrompt(page, config);
    if (participantFactRatingRequired(latestPrompt)) {
      throw new Error('Participant Getting Started is not available yet. Common Ground is requiring the participant to rate the requestor fact statements first. Complete the participant fact-statement rating for this case, then rerun Participant Getting Started mode.');
    }
    transcript.push({
      role: 'partnerAi',
      turn,
      text: latestPrompt,
      promptContext: extractPromptContext(latestPrompt),
      at: new Date().toISOString()
    });

    if (isCompletionPrompt(latestPrompt, config.completionPhrases)) {
      return {
        completed: true,
        passed: true,
        stopReason: 'Partner AI indicated Getting Started is complete.',
        policyStopTriggered: false
      };
    }

    const responseInput = await findReadyResponseInput(page, config.selectors.partnerAi.responseInput, 5000);
    if (!responseInput) {
      throw new Error(`Could not find Partner AI response input. Update selector: ${config.selectors.partnerAi.responseInput}`);
    }

    const scenarioTurn = options.scenarioController
      ? buildScenarioTurn(options.scenarioController, options.actorRole, latestPrompt)
      : null;
    // Scripted-answers runs are "clean": no behaviors and no maneuvers are
    // injected. The scenario dossier describes a randomly generated persona that
    // conflicts with the scripted answers' persona, so scripted follow-up turns
    // must NOT use it (that caused the interviewee's role to drift, e.g. from
    // "Controller" to the dossier's role). We still build scenarioTurn for
    // scripted-question matching, but the LLM follow-up responder is grounded in
    // the transcript (which already contains the scripted answers) instead.
    if (scriptedAnswers && scenarioTurn) scenarioTurn.behaviors = [];
    const activeManeuver = (scenarioTurn || scriptedAnswers) ? null : findActiveManeuver({
      latestPrompt,
      run: config.run,
      seed: options.seed
    });

    // Decide whether this turn is answered from the script. We use the first
    // response to each primary question; the manager/employee answer is chosen
    // by actor. Matching reuses the same fuzzy matcher as scenario turns, with a
    // sequential fallback when the live prompt can't be matched confidently.
    const scriptedSelection = scriptedAnswers
      ? selectScriptedAnswer({ config, scriptedAnswers, scenarioTurn, latestPrompt, actorRole: options.actorRole, answeredScriptedQuestions })
      : null;

    const responseContext = {
      actorRole: options.actorRole ?? 'requestor',
      topic: config.run.topic,
      testBehaviorPolicy: config.run.testBehaviorPolicy,
      qualityCriteria: config.run.qualityCriteria,
      activeManeuver,
      // In scripted mode, follow-ups must stay consistent with the scripted
      // persona (grounded in the transcript), not the dossier persona.
      scenarioTurn: scriptedAnswers ? null : scenarioTurn,
      // Scripted mode uses the live-app role assignment (participant = employee in
      // first person, requestor = manager in third person).
      scriptedMode: Boolean(scriptedAnswers),
      latestPrompt,
      transcript,
      turn,
      llm: config.llm
    };
    const responseSource = scriptedSelection ? 'scripted' : 'llm';
    const response = scriptedSelection
      ? scriptedSelection.text
      : await generatePartnerAiResponse(responseContext);
    const responseValidationWarnings = responseContext.responseValidationWarnings ?? [];
    const behaviorVerification = responseContext.behaviorVerification ?? [];
    transcript.push({
      role: 'syntheticUser',
      turn,
      text: response,
      policyDecision: responseContext.policyDecision ?? null,
      activeManeuver: activeManeuver ? {
        name: activeManeuver.name,
        source: activeManeuver.source ?? 'policyEngine',
        userIntent: activeManeuver.userIntent,
        responseStyle: activeManeuver.responseStyle,
        stopAfterSuccess: activeManeuver.stopAfterSuccess
      } : null,
      scenarioBehaviors: scenarioTurn?.behaviors ?? [],
      behaviorVerification,
      scenarioContext: scenarioTurn?.scenarioContext ?? null,
      validationWarnings: responseValidationWarnings,
      responseSource,
      scriptedAnswer: scriptedSelection
        ? {
            primaryQuestionId: scriptedSelection.primaryQuestionId,
            matchConfidence: scriptedSelection.matchConfidence,
            matchScore: scriptedSelection.matchScore
          }
        : null,
      at: new Date().toISOString()
    });
    options.artifacts?.softAssertions.push(...responseValidationWarnings.map((warning) => ({
      ...warning,
      observed: `${options.actorRole ?? 'requestor'} turn ${turn}: ${warning.observed}`
    })));

    if (!scriptedAnswers && options.scenarioController && scenarioTurn?.primaryQuestionId) {
      retainPlannedSourceFacts(options.scenarioController, options.actorRole, scenarioTurn.primaryQuestionId, response);
    }

    for (const assignment of scenarioTurn?.behaviors ?? []) {
      options.scenarioController.activateBehavior(assignment, turn);
      if (responseContext.deferScenarioResponse) {
        options.scenarioController.deferScenarioAnswer(options.actorRole, assignment, responseContext.deferScenarioResponse);
      } else {
        options.scenarioController.clearDeferredScenarioAnswer(options.actorRole, assignment);
      }
    }

    await responseInput.fill(response);
    await click(page, config.selectors.partnerAi.sendButton, 'Partner AI send');
    await waitForInterviewReady(page, config);

    const visibleAfterResponse = await readVisibleBodyText(page);
    if (scenarioTurn?.behaviors?.length) {
      const observedQfi = extractLatestQfi(visibleAfterResponse);
      // Common Ground's own classification of the response just submitted.
      const observedIntent = extractLatestIntent(visibleAfterResponse);
      const observedQor = extractLatestQor(visibleAfterResponse);
      const nextPromptForAssertion = isCompletionPrompt(visibleAfterResponse, config.completionPhrases) || isPostInterviewState(visibleAfterResponse)
        ? visibleAfterResponse
        : await readLatestPrompt(page, config).catch(() => visibleAfterResponse);
      for (const assignment of scenarioTurn.behaviors) {
        const verification = behaviorVerification.find((item) => item.behaviorId === assignment.behaviorId && item.stage === assignment.stage);
        const behaviorDefinition = config.run.scenarioFoundation.behaviorCatalog.behaviors
          .find((item) => item.id === assignment.behaviorId);
        const partnerAssertion = evaluateExpectedPartnerBehavior(assignment, nextPromptForAssertion);
        const syntheticUserCompliant = Boolean(verification?.passed);

        // An unverified behavior is recorded as a soft failure and the interview
        // continues; it is no longer a hard stop. The behavior is left incomplete
        // so coverage still reflects the miss (missingBehaviorIds).
        const softAssertions = [{
          type: 'partner_ai_behavior',
          passed: partnerAssertion.passed,
          expected: behaviorDefinition?.expectedPartnerAiBehavior ?? assignment.behaviorId,
          observed: partnerAssertion.observed
        }];
        if (!syntheticUserCompliant) {
          softAssertions.push({
            type: 'synthetic_user_behavior',
            passed: false,
            expected: `Synthetic user performs ${assignment.behaviorId}:${assignment.stage}.`,
            observed: verification?.reason ?? 'Behavior was not visibly performed in the synthetic response.'
          });
        }

        if (syntheticUserCompliant) {
          options.scenarioController.completeBehavior(assignment, turn);
          updateScenarioCorrectionState(options.scenarioController, assignment, response);
        }

        const execution = options.scenarioController.recordBehaviorExecution({
          actor: options.actorRole,
          turn,
          primaryQuestionId: assignment.primaryQuestionId,
          criterionId: assignment.criterionId,
          behaviorIds: [assignment.behaviorId, ...assignment.combinedBehaviorIds],
          assignedFatigueLevel: assignment.fatigueLevel,
          observedQfi: observedQfi ?? undefined,
          observedIntent: observedIntent ?? undefined,
          observedQor: observedQor ?? undefined,
          syntheticUserCompliant,
          partnerAiExpectationObserved: partnerAssertion.passed,
          softAssertions
        });
        options.artifacts?.behaviorExecutions.push(execution);
      }
    }
    if (isCompletionPrompt(visibleAfterResponse, config.completionPhrases) || isPostInterviewState(visibleAfterResponse)) {
      transcript.push({
        role: 'partnerAi',
        turn,
        text: visibleAfterResponse,
        promptContext: extractPromptContext(visibleAfterResponse),
        at: new Date().toISOString()
      });
      return {
        completed: true,
        passed: true,
        stopReason: isPostInterviewState(visibleAfterResponse)
          ? 'Getting Started advanced to post-interview processing.'
          : 'Partner AI indicated Getting Started is complete.',
        policyStopTriggered: false
      };
    }

    const afterResponsePrompt = await readLatestPrompt(page, config);
    const policyAdvanceStop = evaluatePolicyAdvanceStop({
      latestPrompt: afterResponsePrompt,
      run: config.run
    });
    if (policyAdvanceStop.matched) {
      transcript.push({
        role: 'partnerAi',
        turn,
        text: afterResponsePrompt,
        promptContext: extractPromptContext(afterResponsePrompt),
        policyStop: policyAdvanceStop.reason,
        at: new Date().toISOString()
      });
      return {
        completed: true,
        passed: true,
        stopReason: policyAdvanceStop.reason,
        policyStopTriggered: true
      };
    }

    const maneuverSuccess = evaluateManeuverSuccess({
      latestPrompt: afterResponsePrompt,
      activeManeuver
    });
    if (maneuverSuccess.matched && activeManeuver?.stopAfterSuccess) {
      transcript.push({
        role: 'partnerAi',
        turn,
        text: afterResponsePrompt,
        promptContext: extractPromptContext(afterResponsePrompt),
        maneuverSuccess: maneuverSuccess.reason,
        at: new Date().toISOString()
      });
      return {
        completed: true,
        passed: true,
        stopReason: maneuverSuccess.reason,
        policyStopTriggered: true
      };
    }

  }

  return {
    completed: false,
    passed: false,
    stopReason: `Max conversation turns reached (${config.run.maxTurns}).`,
    policyStopTriggered: false
  };
}

function buildScenarioTurn(controller, actor, latestPrompt) {
  const promptContext = extractPromptContext(latestPrompt);
  const question = matchScenarioQuestion(controller.topic, promptContext);
  if (!question) return null;
  const criterion = matchScenarioCriterion(question, promptContext.activeQuestion);
  const pending = controller.getPendingBehaviors({
    actor,
    primaryQuestionId: question.id,
    criterionId: criterion?.id
  });
  const behaviors = selectCompatibleTurnBehaviors(pending, controller.behaviorCatalog)
    .map((assignment) => ({
      ...assignment,
      softAssertionOnly: controller.behaviorCatalog.behaviors
        .find((definition) => definition.id === assignment.behaviorId)?.softAssertionOnly !== false
    }));
  const retainedFacts = behaviors
    .map((assignment) => controller.getRetainedFact(actor, assignment.scheduleItemId))
    .filter(Boolean);
  const deferredScenarioResponse = controller.getDeferredScenarioAnswer(actor, behaviors);
  return {
    primaryQuestionId: question.id,
    criterionId: criterion?.id,
    scenarioContext: controller.getScenarioContext(actor, question.id, criterion?.id),
    behaviors,
    retainedFacts,
    deferredScenarioResponse
  };
}

// Resolves the scripted answer (if any) for the current turn. Returns null when
// the turn should be answered by the normal responder (follow-up, unmatched
// prompt with no fallback left, or no scripted answer for this actor/question).
function selectScriptedAnswer({ config, scriptedAnswers, scenarioTurn, latestPrompt, actorRole, answeredScriptedQuestions }) {
  const topic = config.run.scenarioFoundation?.topic;
  let primaryQuestionId = scenarioTurn?.primaryQuestionId ?? null;
  let matchConfidence = primaryQuestionId ? 'fuzzy' : null;
  let matchScore = null;

  if (topic) {
    // Re-score against the topic so we capture a confidence number; this agrees
    // with scenarioTurn.primaryQuestionId when both are present.
    const scored = matchScenarioQuestionScored(topic, extractPromptContext(latestPrompt));
    if (scored.question) {
      primaryQuestionId = scored.question.id;
      matchConfidence = 'fuzzy';
      matchScore = scored.score;
    }
  }

  // Sequential fallback: if the live prompt can't be matched confidently, assign
  // the next unanswered scripted question in file order (manager prompts mirror
  // the employee questions, so the ordering is preserved across actors).
  if (!primaryQuestionId) {
    const next = scriptedAnswers.answers.find((entry) => !answeredScriptedQuestions.has(entry.primaryQuestionId));
    if (next) {
      primaryQuestionId = next.primaryQuestionId;
      matchConfidence = 'sequential-fallback';
    }
  }

  if (!primaryQuestionId || answeredScriptedQuestions.has(primaryQuestionId)) return null;

  const text = pickScriptedAnswer(scriptedAnswers, primaryQuestionId, actorRole ?? 'requestor');
  if (!text) return null;

  answeredScriptedQuestions.add(primaryQuestionId);
  return { text, primaryQuestionId, matchConfidence, matchScore };
}

function selectCompatibleTurnBehaviors(pending, catalog) {
  if (pending.length < 2) return pending;
  const definitions = new Map(catalog.behaviors.map((item) => [item.id, item]));
  const selected = [pending[0]];
  for (const assignment of pending.slice(1)) {
    const compatible = selected.every((current) => {
      const currentDefinition = definitions.get(current.behaviorId);
      const candidateDefinition = definitions.get(assignment.behaviorId);
      return !currentDefinition?.incompatibleWith.includes(assignment.behaviorId)
        && !candidateDefinition?.incompatibleWith.includes(current.behaviorId);
    });
    if (compatible && selected.some((current) => current.combinedBehaviorIds.includes(assignment.behaviorId)
      || assignment.combinedBehaviorIds.includes(current.behaviorId))) selected.push(assignment);
  }
  return selected;
}

function retainPlannedSourceFacts(controller, actor, primaryQuestionId, response) {
  const assignments = controller.plan.behaviors.filter((assignment) => assignment.actor === actor
    && assignment.sourcePrimaryQuestionId === primaryQuestionId);
  for (const assignment of assignments) {
    if (controller.getRetainedFact(actor, assignment.scheduleItemId)) continue;
    controller.retainFact({
      actor,
      factId: assignment.scheduleItemId,
      primaryQuestionId,
      criterionId: assignment.sourceCriterionId,
      value: response,
      context: `retained for ${assignment.behaviorId}`
    });
  }
}

function updateScenarioCorrectionState(controller, assignment, response) {
  if (assignment.behaviorId === 'correction_previous_response' && assignment.stage === 'provide_corrected_fact') {
    if (!controller.getRetainedFact(assignment.actor, assignment.scheduleItemId)) return;
    controller.beginCorrection({ actor: assignment.actor, factId: assignment.scheduleItemId, correctedValue: response });
  }
  if (assignment.behaviorId === 'correction_previous_response' && assignment.stage === 'confirm_or_revise') {
    if (!controller.getRetainedFact(assignment.actor, assignment.scheduleItemId)) return;
    controller.resolveCorrection({ actor: assignment.actor, factId: assignment.scheduleItemId, confirmed: true });
  }
  if (assignment.behaviorId === 'add_to_previous_response' && assignment.stage === 'provide_additional_fact') {
    if (!controller.getRetainedFact(assignment.actor, assignment.scheduleItemId)) return;
    controller.addToRetainedFact({ actor: assignment.actor, factId: assignment.scheduleItemId, additionalValue: response });
  }
}

function evaluateExpectedPartnerBehavior(assignment, text) {
  const normalized = String(text ?? '').toLowerCase();
  const patterns = {
    clarification_request: /clarif|in other words|what.*mean|looking for|focus on/,
    definition_request: /means|refers to|definition|defined as/,
    example_request: /for example|example:|such as/,
    uncertainty_expression: /clarif|example|help|consider|you might/,
    skip_current_item: /move on|next question|come back|revisit|skip/,
    off_topic_response: /back to|return to|focus on|current question|topic/,
    embedded_questions: /\?[^?]*$/m,
    correction_previous_response: /correct|updated|is that right|confirm|previous/,
    add_to_previous_response: /which question|earlier|previous|add|confirm/,
    context_reuse: /you mentioned|earlier|previously|still relevant/,
    contradiction: /conflict|different|earlier|clarif|which is correct/,
    fatigue_expression: /move on|reframe|simpl|break|clarif|continue/
  };
  const passed = patterns[assignment.behaviorId]?.test(normalized) ?? true;
  return {
    passed,
    observed: compactVisibleText(text, 500)
  };
}

function extractLatestQfi(text) {
  const matches = [...String(text ?? '').matchAll(/QFI:\s*(?:Low|Moderate|High|Critical)?\s*\((-?\d+(?:\.\d+)?)\)/gi)];
  const value = Number(matches.at(-1)?.[1]);
  return Number.isFinite(value) ? value : null;
}

// Common Ground classifies each submitted response with an Intent (e.g.
// "AnswerAttempt (100%)") and a QoR / Quality-of-Response (e.g. "Moderate (75)").
// Capture the latest of each so artifacts show how CG actually handled the turn.
function extractLatestIntent(text) {
  const matches = [...String(text ?? '').matchAll(/Intent:\s*([A-Za-z]+)\s*(?:\((\d+)%\))?/gi)];
  const last = matches.at(-1);
  if (!last) return null;
  return last[2] ? `${last[1]} (${last[2]}%)` : last[1];
}

function extractLatestQor(text) {
  const matches = [...String(text ?? '').matchAll(/QoR:\s*([A-Za-z]+)?\s*\((-?\d+(?:\.\d+)?)?\)/gi)];
  const last = matches.at(-1);
  if (!last) return null;
  const level = last[1] ?? '';
  const score = last[2] ?? '';
  if (!level && !score) return null;
  return score ? `${level} (${score})`.trim() : level;
}

async function waitForPostProcessing(page, config) {
  const deadline = Date.now() + config.run.postCompletionWaitMs;
  while (Date.now() < deadline) {
    const text = await readVisibleBodyText(page);
    if (/fact statement|confident fact|label|submit/i.test(text)) return true;
    if (/post-processing/i.test(text)) return true;
    await page.waitForTimeout(1500);
  }

  return false;
}

async function labelFactStatements(page, config, labelText) {
  await waitForFactLabelingReady(page, config);
  const labelingUrl = page.url();
  await selectAllFactStatementLabels(page, config, labelText);
  await submitFactStatementRatings(page);
  await verifyFactStatementSubmission(page, labelingUrl);
}

async function completeActorPostProcessing(page, config, artifacts, actorLabel, labelText = config.run.scenarioFoundation.topic.workflow.factStatementLabel) {
  const firstState = await waitForWorkflowState(page, config, {
    name: `${actorLabel.toLowerCase()} excerpt review or fact statement labeling`,
    ready: (text, currentPage) => excerptReviewReady(text, currentPage.url()) || factLabelingReady(text, currentPage.url())
  });

  const currentText = await readVisibleBodyText(page);
  if (excerptReviewReady(currentText, page.url())) {
    recordStage(artifacts, `${actorLabel} Excerpt Review`, 'started', firstState.url);
    const approvalCount = extractExcerptApprovalCount(currentText);
    await submitExcerptReview(page, config);
    recordStage(
      artifacts,
      `${actorLabel} Excerpt Review`,
      'passed',
      approvalCount ? `${approvalCount.approved}/${approvalCount.total} excerpts approved and submitted.` : 'Excerpt review submitted.'
    );
  }

  recordStage(artifacts, `${actorLabel} Fact Statement Labels`, 'started');
  await waitForWorkflowState(page, config, {
    name: `${actorLabel.toLowerCase()} fact statement labeling`,
    ready: (text, currentPage) => factLabelingReady(text, currentPage.url())
  });
  await labelFactStatements(page, config, labelText);
  recordStage(artifacts, `${actorLabel} Fact Statement Labels`, 'passed', `All fact statements labeled ${labelText} and submitted.`);
}

function excerptReviewReady(text, url = '') {
  const value = String(text ?? '');
  const currentUrl = String(url ?? '');
  if (factReviewUrl(currentUrl)) return false;
  if (/\/excerpt-review(?:[/?#]|$)/i.test(currentUrl)) return true;
  return /\bExcerpt Review\b/i.test(value)
    && /(\d+)\s*\/\s*(\d+)\s+approved/i.test(value)
    && /\bSubmit\b/i.test(value);
}

function extractExcerptApprovalCount(text) {
  const match = String(text ?? '').match(/(\d+)\s*\/\s*(\d+)\s+approved/i);
  if (!match) return null;
  return { approved: Number(match[1]), total: Number(match[2]) };
}

async function submitExcerptReview(page, config) {
  const startedAt = Date.now();
  const deadline = startedAt + config.run.postCompletionWaitMs;
  let lastText = '';
  let lastApprovalCount = null;
  let lastSubmitState = 'not found';

  while (Date.now() < deadline) {
    lastText = await readVisibleBodyText(page);
    lastApprovalCount = extractExcerptApprovalCount(lastText);

    if (lastApprovalCount?.total > 0 && lastApprovalCount.approved < lastApprovalCount.total) {
      const approveAll = page.getByRole('button', { name: /^Approve All$/i }).first();
      const canApproveAll = await approveAll.isVisible({ timeout: 300 }).catch(() => false)
        && await approveAll.isEnabled({ timeout: 300 }).catch(() => false);
      if (canApproveAll) {
        await approveAll.click();
        await page.waitForTimeout(750);
        continue;
      }
    }

    const submitState = await findExcerptSubmitControl(page);
    lastSubmitState = submitState.description;
    if (submitState.control) {
      await submitState.control.scrollIntoViewIfNeeded().catch(() => {});
      await submitState.control.click();
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(1500);
      return;
    }

    await page.waitForTimeout(1000);
  }

  const approvalDescription = lastApprovalCount
    ? `${lastApprovalCount.approved}/${lastApprovalCount.total} approved`
    : 'approval counter not detected';
  throw new Error([
    `Excerpt Review Submit did not become enabled within ${Math.round(config.run.postCompletionWaitMs / 60000)} minutes.`,
    `Elapsed: ${Math.round((Date.now() - startedAt) / 1000)} seconds`,
    `Approval state: ${approvalDescription}`,
    `Submit state: ${lastSubmitState}`,
    `Current URL: ${page.url()}`,
    `Last visible page text: ${compactVisibleText(lastText, 1800)}`
  ].join('\n'));
}

async function findExcerptSubmitControl(page) {
  const candidates = page.locator('button, [role="button"], input[type="submit"], a');
  const count = await candidates.count().catch(() => 0);
  let matching = 0;
  let disabled = 0;

  for (let index = count - 1; index >= 0; index -= 1) {
    const candidate = candidates.nth(index);
    const descriptor = await candidate.evaluate((element) => (
      element.innerText
      || element.value
      || element.getAttribute('aria-label')
      || ''
    ).replace(/\s+/g, ' ').trim()).catch(() => '');
    if (!/^Submit$/i.test(descriptor)) continue;
    matching += 1;
    const visible = await candidate.isVisible({ timeout: 300 }).catch(() => false);
    const enabled = visible && await candidate.isEnabled({ timeout: 300 }).catch(() => false);
    const ariaDisabled = await candidate.getAttribute('aria-disabled').catch(() => null);
    if (enabled && ariaDisabled !== 'true') {
      return { control: candidate, description: `${matching} matching control(s); enabled` };
    }
    disabled += 1;
  }

  return {
    control: null,
    description: matching === 0
      ? 'no exact Submit control found'
      : `${matching} matching control(s); ${disabled} disabled or hidden`
  };
}

async function waitForWorkflowState(page, config, { name, ready }) {
  const startedAt = Date.now();
  const deadline = startedAt + config.run.postCompletionWaitMs;
  let lastText = '';
  let lastUrl = page.url();

  while (Date.now() < deadline) {
    lastText = await readVisibleBodyText(page);
    lastUrl = page.url();
    if (ready(lastText, page)) return {
      elapsedMs: Date.now() - startedAt,
      url: lastUrl
    };
    await page.waitForTimeout(3000);
  }

  throw new Error([
    `${name} did not become available within ${Math.round(config.run.postCompletionWaitMs / 60000)} minutes.`,
    `Elapsed: ${Math.round((Date.now() - startedAt) / 1000)} seconds`,
    `Current URL: ${lastUrl}`,
    `Last visible page text: ${compactVisibleText(lastText, 1800)}`
  ].join('\n'));
}

function factLabelingReady(text, url = '') {
  const value = String(text ?? '');
  const currentUrl = String(url ?? '');
  if (/\/get-started(?:[/?#]|$)/i.test(currentUrl)) return false;
  if (excerptReviewReady(value, url)) return false;
  const factPage = factReviewUrl(url)
    || (/\bRate your Confidence\b/i.test(value) && /\bStatement\s+\d+\b/i.test(value))
    || (!currentUrl && /\bFact Statements?\b/i.test(value));
  return factPage && /\bconfident fact\b|\bsubmit\b|\bcontinue\b|\bcomplete\b|\bdone\b|\bsave\b|\blabel\b|\brate\b/i.test(value);
}

function factReviewUrl(url = '') {
  const value = String(url ?? '');
  return /\/(?:fact-review|fact-statements?)(?:[/?#]|$)/i.test(value)
    || crossRateUrl(value);
}

function participantCrossRateUrl(url = '') {
  return crossRateUrl(url, 'participant_rates_requestor');
}

function crossRateUrl(url = '', mode = '') {
  const value = String(url ?? '');
  if (!/\/cross-rate(?:[/?#]|$)/i.test(value)) return false;
  if (!mode) return /[?&]mode=(?:participant_rates_requestor|requestor_rates_participant)(?:&|$)/i.test(value);
  return new RegExp(`[?&]mode=${escapeRegExp(mode)}(?:&|$)`, 'i').test(value);
}

function extractFactLabelCount(text) {
  const match = String(text ?? '').match(/(\d+)\s*\/\s*(\d+)\s+labeled/i);
  if (!match) return null;
  return { labeled: Number(match[1]), total: Number(match[2]) };
}

function gettingStartedAvailable(text) {
  return /getting started|begin discussion/i.test(text) && !/post-processing|post processing|still processing/i.test(text);
}

// Click the "Rate [party]'s Facts" / "Next Up: Rate ... Facts" control. DOM-based
// and tolerant of markup and of the Requester/Requestor spelling difference, which
// is why getByRole(name: /Rate Requestor's Facts/) was failing on the live UI.
async function clickRateFactsControl(page, options) {
  return page.evaluate(({ ratedParty }) => {
    const norm = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const isDisabled = (element) => element.disabled || element.getAttribute('aria-disabled') === 'true';
    // Live UI wording varies: "Rate Participant's Facts" (old) vs "Rate Employee's
    // Statements" / "Rate Manager's Statements" (current). The requestor is the
    // manager and the participant is the employee, so match either vocabulary, and
    // accept both "facts" and "statements".
    const partyToken = ratedParty === 'participant' ? '(?:participant|employee)' : '(?:request[eo]r|manager)';
    const partyRe = new RegExp(`rate\\b[\\s\\S]*\\b${partyToken}'?s?\\b[\\s\\S]*\\b(?:facts?|statements?)\\b`, 'i');
    const anyRe = /rate\b[\s\S]*\b(?:facts?|statements?)\b/i;
    const controls = [...document.querySelectorAll('a,button,[role="button"]')].filter((element) => !isDisabled(element));
    const pick = controls.find((element) => partyRe.test(norm(element.innerText)))
      ?? controls.find((element) => anyRe.test(norm(element.innerText)));
    if (pick) {
      pick.click();
      return true;
    }
    return false;
  }, { ratedParty: options.ratedParty });
}

async function openCrossPartyFactReviewIfRequired(page, createdCase, options) {
  const text = await readVisibleBodyText(page);
  if (factLabelingReady(text, page.url())) return true;

  // Direct cross-rate link, when the page exposes one.
  const crossRateLink = page.locator(`a[href*="/cross-rate"][href*="mode=${options.mode}"]`).first();
  if (await crossRateLink.isVisible({ timeout: 750 }).catch(() => false)) {
    await crossRateLink.click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1000);
    return true;
  }

  // The actual "Rate [party]'s Facts" / "Next Up" control.
  if (await clickRateFactsControl(page, options)) {
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1000);
    return true;
  }

  // On the dashboard with no control visible yet → open the case detail and retry.
  if (isDashboardPage(page.url(), text)) {
    const openedDetails = await openCaseDetailsFromDashboard(page, createdCase, '')
      .then(() => true)
      .catch(() => false);
    if (openedDetails) {
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(1000);
      return true;
    }
  }
  return false;
}

async function completeParticipantFactReview(page, config, createdCase, labelText) {
  return completeCrossPartyFactReview(page, config, createdCase, labelText, {
    raterRole: 'participant',
    ratedParty: 'requestor',
    linkText: /Rate Request[eo]r'?s Facts/i,
    mode: 'participant_rates_requestor',
    allowGettingStartedReady: true
  });
}

async function completeCrossPartyFactReview(page, config, createdCase, labelText, options) {
  const startedAt = Date.now();
  const deadline = startedAt + config.run.postCompletionWaitMs;
  let lastText = '';
  let lastUrl = page.url();
  let lastRefreshAt = 0;

  while (Date.now() < deadline) {
    lastText = await readVisibleBodyText(page);
    lastUrl = page.url();

    if (factLabelingReady(lastText, lastUrl)) {
      await labelFactStatements(page, config, labelText);
      return;
    }

    const opened = await openCrossPartyFactReviewIfRequired(page, createdCase, options);
    if (opened) {
      await page.waitForTimeout(1500);
      continue;
    }

    if (options.allowGettingStartedReady) {
      const responseInput = await findReadyResponseInput(page, config.selectors.partnerAi.responseInput, 500);
      if (responseInput && !participantFactRatingRequired(lastText)) return;
    }

    if (isDashboardPage(lastUrl, lastText)) {
      const entered = await openCaseDetailsFromDashboard(page, createdCase, config.run.caseType)
        .then(() => true)
        .catch(() => false);
      if (entered) {
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(2000);
        continue;
      }
    }

    if (Date.now() - lastRefreshAt >= 10000) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
      lastRefreshAt = Date.now();
    } else {
      await page.waitForTimeout(2000);
    }
  }

  throw new Error([
    `${capitalizeFirst(options.raterRole)} rating of ${options.ratedParty} facts did not become available within ${Math.round(config.run.postCompletionWaitMs / 60000)} minutes.`,
    `Elapsed: ${Math.round((Date.now() - startedAt) / 1000)} seconds`,
    `Current URL: ${lastUrl}`,
    `Last visible page text: ${compactVisibleText(lastText, 1800)}`
  ].join('\n'));
}

function isDashboardPage(url = '', text = '') {
  return /\/dashboard(?:[/?#]|$)/i.test(String(url ?? ''))
    || (/\bDashboard\b/i.test(String(text ?? '')) && /\bCreate New (?:Case|Discussion)\b/i.test(String(text ?? '')));
}

function capitalizeFirst(value = '') {
  const text = String(value ?? '');
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

async function ensureGettingStartedOpen(page, config, createdCase) {
  let text = await readVisibleBodyText(page);
  if (await findReadyResponseInput(page, config.selectors.partnerAi.responseInput, 1000)) return;
  if (!gettingStartedAvailable(text)) {
    await page.goto(new URL('/dashboard', config.productionUrl).toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await openCaseFromDashboard(page, createdCase, config.run.caseType);
    text = await readVisibleBodyText(page);
  }
  if (await findReadyResponseInput(page, config.selectors.partnerAi.responseInput, 1000)) return;
  await startGettingStarted(page, config, createdCase);
}

// True only if the report text belongs to the case under test. Guards against
// opening a different completed case's report (which is how 87 from CG-0311 was
// captured instead of 76 from CG-0316).
function reportMatchesCase(text, createdCase) {
  const ids = [createdCase?.commonGroundId, createdCase?.id].filter(Boolean).map((id) => id.toUpperCase());
  if (!ids.length) return true;
  const found = findCaseIdsInText(text);
  if (!found.length) return true; // no case id visible; cannot disprove
  return found.some((id) => ids.includes(id.toUpperCase()));
}

// Open THIS case's alignment report from its own detail page, where the report
// link is unambiguous (the dashboard lists a report button per completed case).
async function openCaseAlignmentReport(page, config, createdCase) {
  if (isDashboardPage(page.url(), await readVisibleBodyText(page))) {
    await openCaseFromDashboard(page, createdCase, config.run.caseType).catch(() => {});
    await waitForIdle(page);
  }
  const namePattern = /Alignment Report|Alignment Brief|View Alignment Brief|View Report|Open Report/i;
  for (const role of ['link', 'button']) {
    const control = page.getByRole(role, { name: namePattern }).first();
    if (await control.isVisible({ timeout: 750 }).catch(() => false)) {
      await control.click().catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
      return;
    }
  }
  // Last resort: case-card scoped click (still verified by reportMatchesCase).
  await clickCaseCardButton(page, createdCase, namePattern).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
}

async function waitForAndReadAlignmentReport(page, config, createdCase) {
  const startedAt = Date.now();
  const deadline = startedAt + config.run.postCompletionWaitMs;
  let lastText = '';
  let lastUrl = page.url();
  let lastReloadAt = 0;

  while (Date.now() < deadline) {
    lastText = await readVisibleBodyText(page);
    lastUrl = page.url();

    if (onAlignmentReportPage(lastUrl, lastText)) {
      // Landed on a different case's report — reopen the correct case and retry.
      if (!reportMatchesCase(lastText, createdCase)) {
        console.warn(`[alignment] Report page is for a different case than ${createdCase?.commonGroundId}; reopening the correct case.`);
        await openCaseAsRequestor(page, config, createdCase, { caseType: config.run.caseType }).catch(() => {});
        await waitForIdle(page);
        await page.waitForTimeout(2000);
        continue;
      }
      const score = extractAlignmentScore(lastText);
      if (score !== null) {
        return {
          score,
          url: lastUrl,
          elapsedMs: Date.now() - startedAt,
          visibleText: compactVisibleText(lastText, 4000)
        };
      }
      // Correct report page, but the score has not rendered yet (e.g.
      // "Loading alignment report..."). Wait and reload until it appears.
      if (Date.now() - lastReloadAt >= 8000) {
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await waitForIdle(page);
        lastReloadAt = Date.now();
      } else {
        await page.waitForTimeout(2000);
      }
      continue;
    }

    if (/alignment report/i.test(lastText)) {
      await openCaseAlignmentReport(page, config, createdCase);
      await page.waitForTimeout(1000);
      continue;
    }

    // Not on a report and no report link visible yet: reopen this case / refresh.
    if (isDashboardPage(lastUrl, lastText)) {
      await openCaseAsRequestor(page, config, createdCase, { caseType: config.run.caseType }).catch(() => {});
      await waitForIdle(page);
    } else {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitForIdle(page);
    }
    await page.waitForTimeout(3000);
  }

  throw new Error([
    `Alignment Report for ${createdCase?.commonGroundId ?? 'the case'} did not become available within ${Math.round(config.run.postCompletionWaitMs / 60000)} minutes.`,
    `Elapsed: ${Math.round((Date.now() - startedAt) / 1000)} seconds`,
    `Current URL: ${lastUrl}`,
    `Last visible page text: ${compactVisibleText(lastText, 1800)}`
  ].join('\n'));
}

function extractAlignmentScore(text) {
  const haystack = String(text ?? '');
  // The report shows the score as "NN/100". An "Alignment Threshold" value can
  // also appear as "NN/100", so collect every /100 value with its preceding label,
  // drop the threshold, and prefer the one whose context names the alignment score.
  const candidates = [];
  const outOf100 = /(\d{1,3}(?:\.\d+)?)\s*\/\s*100\b/g;
  let match;
  while ((match = outOf100.exec(haystack)) !== null) {
    const value = Number(match[1]);
    if (!isValidAlignmentScore(value)) continue;
    const context = haystack.slice(Math.max(0, match.index - 40), match.index).toLowerCase();
    candidates.push({ value, isThreshold: /threshold/.test(context), mentionsAlignment: /alignment|score/.test(context) });
  }
  const usable = candidates.filter((item) => !item.isThreshold);
  if (usable.length) return (usable.find((item) => item.mentionsAlignment) ?? usable[0]).value;

  // Fallback: a percentage explicitly tied to "alignment"/"score" and not a threshold.
  const percent = /(\d{1,3}(?:\.\d+)?)\s*%/g;
  while ((match = percent.exec(haystack)) !== null) {
    const value = Number(match[1]);
    if (!isValidAlignmentScore(value)) continue;
    const context = haystack.slice(Math.max(0, match.index - 40), match.index).toLowerCase();
    if (/threshold/.test(context)) continue;
    if (/alignment|score/.test(context)) return value;
  }
  return null;
}

function isValidAlignmentScore(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function onAlignmentReportPage(url = '', text = '') {
  if (/alignment-report/i.test(String(url ?? ''))) return true;
  if (isDashboardPage(url, text)) return false;
  // Positive markers of the single-case report (vs. the dashboard's case list).
  return /\b\d{1,3}(?:\.\d+)?\s*\/\s*100\b/.test(String(text ?? '')) || /alignment\s+threshold/i.test(String(text ?? ''));
}

function alignmentScoreWithinExpectedRange(score, range) {
  if (!Number.isFinite(score)) return undefined;
  const minimumPasses = range.minInclusive ? score >= range.min : score > range.min;
  const maximumPasses = range.maxInclusive ? score <= range.max : score < range.max;
  return minimumPasses && maximumPasses;
}

function compactVisibleText(text, maxLength = 1200) {
  const compact = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  const half = Math.floor(maxLength / 2);
  return `${compact.slice(0, half)} ... ${compact.slice(-half)}`;
}

async function waitForFactLabelingReady(page, config) {
  const deadline = Date.now() + config.run.postCompletionWaitMs;
  while (Date.now() < deadline) {
    const text = await readVisibleBodyText(page);
    if (factLabelingReady(text, page.url())) return;
    await page.waitForTimeout(1500);
  }

  throw new Error('Fact statement labeling did not become available before timeout.');
}

async function selectAllFactStatementLabels(page, config, labelText) {
  const timeoutMs = Math.min(config.run.postCompletionWaitMs, 120000);
  const deadline = Date.now() + timeoutMs;
  let lastProgress = null;
  let lastControlCount = 0;
  let nextControlIndex = null;

  while (Date.now() < deadline) {
    const beforeText = await readVisibleBodyText(page);
    const beforeProgress = extractFactRatingProgress(beforeText);
    lastProgress = beforeProgress;
    if (beforeProgress?.remaining === 0) return beforeProgress;
    if (!beforeProgress && await findEnabledFactSubmitControl(page)) {
      return { completed: 0, remaining: 0, total: 0, source: 'submit-enabled' };
    }

    const controls = await exactLabelControls(page, labelText);
    const controlCount = await controls.count().catch(() => 0);
    lastControlCount = controlCount;
    if (controlCount === 0) {
      await page.waitForTimeout(500);
      continue;
    }

    if (nextControlIndex === null) {
      nextControlIndex = nextFactLabelControlIndex(beforeProgress, controlCount);
    } else if (beforeProgress?.source === 'labeled-counter') {
      nextControlIndex = Math.max(nextControlIndex, beforeProgress.completed);
    }

    if (nextControlIndex >= controlCount) {
      const submit = await findEnabledFactSubmitControl(page);
      if (submit) {
        return beforeProgress ?? {
          completed: controlCount,
          remaining: 0,
          total: controlCount,
          source: 'all-controls-clicked'
        };
      }
      await page.waitForTimeout(500);
      continue;
    }

    const targetIndex = nextControlIndex;
    const control = controls.nth(targetIndex);
    const visible = await control.isVisible({ timeout: 1000 }).catch(() => false);
    const enabled = visible && await control.isEnabled({ timeout: 1000 }).catch(() => false);
    if (!enabled) {
      await page.waitForTimeout(500);
      continue;
    }
    await control.scrollIntoViewIfNeeded().catch(() => {});
    const clicked = await control.click({ timeout: 3000 }).then(() => true).catch(() => false);
    if (!clicked) {
      await page.waitForTimeout(500);
      continue;
    }

    nextControlIndex += 1;
    const changed = await waitForFactRatingProgress(page, beforeProgress, 1200);
    if (changed) lastProgress = changed;
  }

  const progressDescription = lastProgress
    ? `${lastProgress.completed}/${lastProgress.total} completed; ${lastProgress.remaining} remaining`
    : 'fact-rating progress not detected';
  throw new Error([
    `Could not register ${labelText} for every fact statement (${progressDescription}).`,
    `Next control index: ${nextControlIndex ?? 0}`,
    `Matching controls detected on the last pass: ${lastControlCount}`,
    `Current URL: ${page.url()}`,
    `Last visible page text: ${compactVisibleText(await readVisibleBodyText(page), 1800)}`
  ].join('\n'));
}

function nextFactLabelControlIndex(progress, controlCount) {
  if (controlCount <= 0) return 0;
  const completed = Number.isFinite(progress?.completed) ? progress.completed : 0;
  return Math.min(Math.max(completed, 0), controlCount - 1);
}

function extractCrossRateRemainingCount(text) {
  const match = String(text ?? '').match(/(\d+)\s+of\s+(\d+)\s+facts?\s+still need to be rated/i);
  if (!match) return null;
  return { remaining: Number(match[1]), total: Number(match[2]) };
}

function extractFactRatingProgress(text) {
  const labeled = extractFactLabelCount(text);
  if (labeled) {
    return {
      completed: labeled.labeled,
      remaining: Math.max(labeled.total - labeled.labeled, 0),
      total: labeled.total,
      source: 'labeled-counter'
    };
  }
  const remaining = extractCrossRateRemainingCount(text);
  if (remaining) {
    return {
      completed: Math.max(remaining.total - remaining.remaining, 0),
      remaining: remaining.remaining,
      total: remaining.total,
      source: 'remaining-counter'
    };
  }
  return null;
}

async function exactLabelControls(page, labelText) {
  const pattern = new RegExp(`^${escapeRegExp(labelText)}$`, 'i');
  const buttons = page.getByRole('button', { name: pattern });
  if (await buttons.count().catch(() => 0)) return buttons;
  const roleButtons = page.locator('[role="button"]').filter({ hasText: pattern });
  if (await roleButtons.count().catch(() => 0)) return roleButtons;
  return page.getByText(pattern);
}

async function waitForFactRatingProgress(page, beforeProgress, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = extractFactRatingProgress(await readVisibleBodyText(page));
    if (current && beforeProgress && (
      current.completed > beforeProgress.completed
      || current.remaining < beforeProgress.remaining
    )) return current;
    if (!beforeProgress && current) return current;
    if (beforeProgress?.remaining === 1 && !current && await findEnabledFactSubmitControl(page)) {
      return {
        completed: beforeProgress.total,
        remaining: 0,
        total: beforeProgress.total,
        source: 'submit-enabled'
      };
    }
    await page.waitForTimeout(150);
  }
  return null;
}

async function findEnabledFactSubmitControl(page) {
  const pattern = /^(?:Submit|Submit Ratings)$/i;
  for (const locator of [
    page.getByRole('button', { name: pattern }),
    page.getByRole('link', { name: pattern }),
    page.locator('input[type="submit"]')
  ]) {
    const count = await locator.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const control = locator.nth(index);
      const visible = await control.isVisible({ timeout: 300 }).catch(() => false);
      const enabled = visible && await control.isEnabled({ timeout: 300 }).catch(() => false);
      const ariaDisabled = await control.getAttribute('aria-disabled').catch(() => null);
      if (enabled && ariaDisabled !== 'true') return control;
    }
  }
  return null;
}

async function submitFactStatementRatings(page) {
  const submit = await findEnabledFactSubmitControl(page);
  if (!submit) {
    throw new Error(`Could not find an enabled fact-statement Submit control. Current URL: ${page.url()}`);
  }
  await submit.scrollIntoViewIfNeeded().catch(() => {});
  await submit.click();
}

async function verifyFactStatementSubmission(page, labelingUrl) {
  const deadline = Date.now() + 60000;
  let lastText = '';
  let sawSubmitting = false;
  let settledIncompleteReads = 0;
  while (Date.now() < deadline) {
    lastText = await readVisibleBodyText(page);
    const currentUrl = page.url();
    if (currentUrl !== labelingUrl && !factLabelingReady(lastText, currentUrl)) return;

    const submitting = /\bSubmitting(?:\.{3}|…)?\b/i.test(lastText);
    if (submitting) {
      sawSubmitting = true;
      settledIncompleteReads = 0;
      await page.waitForTimeout(500);
      continue;
    }

    const progress = extractFactRatingProgress(lastText);
    const explicitWarning = /(?:please|must|need to)\s+(?:rate|label|select)[^.!]*(?:all|each)[^.!]*fact/i.test(lastText)
      || /all fact statements?[^.!]*(?:must|need to be)[^.!]*(?:rated|labeled)/i.test(lastText);
    if (explicitWarning) {
      throw new Error([
        'Common Ground rejected the fact-statement submission.',
        `Current URL: ${currentUrl}`,
        `Visible warning: ${compactVisibleText(lastText, 1200)}`
      ].join('\n'));
    }

    if (sawSubmitting && progress?.remaining > 0) {
      const submitReadyAgain = Boolean(await findEnabledFactSubmitControl(page));
      settledIncompleteReads = submitReadyAgain ? settledIncompleteReads + 1 : 0;
      if (settledIncompleteReads >= 3) {
        throw new Error([
          `Common Ground rejected the fact-statement submission (${progress.remaining} of ${progress.total} still need a label).`,
          `Current URL: ${currentUrl}`,
          `Visible page text: ${compactVisibleText(lastText, 1200)}`
        ].join('\n'));
      }
    }
    await page.waitForTimeout(750);
  }

  throw new Error([
    'Fact-statement submission did not advance after Submit.',
    `Current URL: ${page.url()}`,
    `Last visible page text: ${compactVisibleText(lastText, 1800)}`
  ].join('\n'));
}

async function readLatestPrompt(page, config) {
  const locator = page.locator(config.selectors.partnerAi.latestPrompt).first();
  await locator.waitFor({ state: 'visible', timeout: 30000 });
  return waitForStableLocatorText(locator, page);
}

async function waitForInterviewReady(page, config) {
  const inputSelector = config.selectors.partnerAi.responseInput;
  let deadline = Date.now() + 600000;
  let lastVisibleText = '';
  let lastInputState = '';

  while (Date.now() < deadline) {
    const visibleText = await readVisibleBodyText(page);
    lastVisibleText = visibleText;
    if (participantFactRatingRequired(visibleText)) {
      throw new Error('Participant Getting Started is not available yet. Common Ground is requiring the participant to rate the requestor fact statements first. Complete the participant fact-statement rating for this case, then rerun Participant Getting Started mode.');
    }
    if (isCompletionPrompt(visibleText, config.completionPhrases)) return;
    if (isPostInterviewState(visibleText)) return;
    const readyInput = await findReadyResponseInput(page, inputSelector, 1000);
    lastInputState = await describeResponseInputs(page, inputSelector);
    if (interviewReadySignal({ readyInput: Boolean(readyInput), visibleText })) {
      await waitForStableLocatorText(page.locator(config.selectors.partnerAi.latestPrompt).first(), page);
      return;
    }
    // While Common Ground is visibly still processing the previous answer, keep
    // waiting instead of giving up: roll the deadline forward so an active
    // processing screen never trips the timeout, while a true hang still ends.
    if (isProcessingState(visibleText)) {
      deadline = Math.max(deadline, Date.now() + 180000);
    }
    await page.waitForTimeout(1500);
  }

  const compactText = lastVisibleText.replace(/\s+/g, ' ').trim();
  throw new Error([
    'Getting Started interview did not become ready before timeout.',
    `Response input state: ${lastInputState}`,
    `Last visible page text (start): ${compactText.slice(0, 900)}`,
    `Last visible page text (end): ${compactText.slice(-1400)}`
  ].join('\n'));
}

function interviewReadySignal({ readyInput }) {
  return Boolean(readyInput);
}

async function findReadyResponseInput(page, selector, timeout = 1000) {
  const inputs = page.locator(selector);
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const count = await inputs.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const input = inputs.nth(index);
      const visible = await input.isVisible({ timeout: 100 }).catch(() => false);
      if (!visible) continue;
      const enabled = await input.isEnabled({ timeout: 100 }).catch(() => false);
      if (enabled) return input;
    }
    await page.waitForTimeout(250);
  }

  return null;
}

async function describeResponseInputs(page, selector) {
  const inputs = page.locator(selector);
  const count = await inputs.count().catch(() => 0);
  const states = [];
  for (let index = 0; index < Math.min(count, 6); index += 1) {
    const input = inputs.nth(index);
    const visible = await input.isVisible({ timeout: 100 }).catch(() => false);
    const enabled = await input.isEnabled({ timeout: 100 }).catch(() => false);
    states.push(`#${index + 1}:visible=${visible},enabled=${enabled}`);
  }
  return `count=${count}${states.length ? `; ${states.join('; ')}` : ''}`;
}

function participantFactRatingRequired(text) {
  return /Rate the Requestor'?s Facts First|Before you can start the Getting Started conversation,\s*you need to review and rate the fact statements submitted by the requestor|Rate Requestor'?s Facts/i.test(text);
}

function isPostInterviewState(text) {
  // "Excerpt Review" is the first screen after the interview ends (before fact
  // labeling); recognizing it lets the interview loop exit cleanly and hand off to
  // completeActorPostProcessing instead of waiting for a response input that will
  // never reappear.
  return /post-processing|post processing|fact statement|confident fact|statement labels?|submit labels?|label.*fact|excerpt review/i.test(text);
}

function isProcessingState(text) {
  return /checking engagement|engagement levels?|still processing|processing your|analy[sz]ing|please wait|one moment/i.test(String(text ?? ''));
}

function otherPartyGate(text) {
  return /waiting on the other party|other (?:participant|party) is still finishing|almost there/i.test(String(text ?? ''));
}

// After the requestor submits ratings of the participant's facts, the "Getting
// Started" button does not appear immediately and the requestor may still be
// behind a "waiting on the other party" gate. Re-open the case from the dashboard
// and poll until an actionable Getting Started control is available.
async function waitForRequestorGettingStarted(page, config, createdCase, syntheticCase) {
  // Keep the full post-rating wait budget (Common Ground genuinely delays the
  // Getting Started button), but poll responsively and proceed the moment the
  // control is ready. The heavy dashboard re-open only runs periodically, since
  // re-entry is what surfaces the button — most checks stay fast.
  const deadline = Date.now() + config.run.postCompletionWaitMs;
  let lastReopenAt = 0;
  while (Date.now() < deadline) {
    // Already in the interview (input ready) → nothing to wait for.
    if (await findReadyResponseInput(page, config.selectors.partnerAi.responseInput, 300)) return;

    const text = await readVisibleBodyText(page);
    if (!otherPartyGate(text)) {
      const gettingStartedControl = page.locator('a[href*="/get-started"]').first();
      const gettingStartedLink = page.getByRole('link', { name: /^(Getting Started|Begin Discussion)$/i }).first();
      const gettingStartedButton = page.getByRole('button', { name: /^(Getting Started|Begin Discussion)$/i }).first();
      if (await gettingStartedControl.isVisible({ timeout: 300 }).catch(() => false)
        || await gettingStartedLink.isVisible({ timeout: 300 }).catch(() => false)
        || await gettingStartedButton.isVisible({ timeout: 300 }).catch(() => false)
        || gettingStartedAvailable(text)) {
        return;
      }
    }

    // Re-open the case roughly every 10s (re-entry surfaces the button); between
    // re-opens, poll the current page every ~1.5s so we proceed as soon as ready.
    if (Date.now() - lastReopenAt >= 10000) {
      await ensureOnDashboard(page, config);
      await openCaseFromDashboard(page, createdCase, syntheticCase.caseType).catch(() => {});
      await waitForIdle(page);
      lastReopenAt = Date.now();
    } else {
      await page.waitForTimeout(1500);
    }
  }
  throw new Error('Requestor "Getting Started" did not become available after rating the participant\'s facts within the timeout. The participant Getting Started or fact rating may not have completed.');
}

async function waitForStableLocatorText(locator, page) {
  let prior = '';
  let stableReads = 0;
  const deadline = Date.now() + 25000;

  while (Date.now() < deadline) {
    const current = (await locator.innerText().catch(() => '')).trim();
    if (current && current === prior) {
      stableReads += 1;
      if (stableReads >= 3 && !looksLikeStreamingPrompt(current)) return current;
    } else {
      stableReads = 0;
      prior = current;
    }
    await page.waitForTimeout(1000);
  }

  return prior;
}

function looksLikeStreamingPrompt(text) {
  const tail = String(text ?? '').trim().slice(-700);
  if (/Now,\s*back to where we were:\s*(?:Can|Could|Please|What|Why|How|If)\b[\s\S]*[^?.!]$/i.test(tail)) {
    return true;
  }
  if (/\b(?:Can|Could|Please|What|Why|How|If)\b[\s\S]{20,500}[^?.!]$/i.test(tail)) {
    return true;
  }
  return false;
}

function isCompletionPrompt(text, phrases) {
  const normalized = text.toLowerCase();
  if (/you(?:'|’)?ve\s+(?:completed|wrapped up)\s+the\s+getting started\s+conversation/i.test(text)) return true;
  if (/\bgetting started\s+(?:is\s+)?complete\b/i.test(text)) return true;
  if (/\bwe have enough information\b/i.test(text)) return true;

  return phrases
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase && !/^(?:getting started conversation|next step)$/i.test(phrase))
    .some((phrase) => normalized.includes(phrase.toLowerCase()));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fill(page, selector, value, label) {
  const locator = await waitForVisible(page, selector, label);
  await locator.fill(value);
}

// Today's date as YYYY-MM-DD (native date inputs accept this format). Built from
// local components so it does not shift a day near midnight like toISOString (UTC).
function todayIso() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

// Fill every present, editable date input with the given value. Re-scans after each
// pass so a field that becomes editable once another date is set (e.g. "Review
// Period To") gets filled; disabled/readOnly dates are skipped.
async function fillPresentDates(page, value) {
  const dateSelector = 'input[type="date"]';
  for (let pass = 0; pass < 4; pass += 1) {
    const inputs = page.locator(dateSelector);
    const count = await inputs.count().catch(() => 0);
    let filledAny = false;
    for (let index = 0; index < count; index += 1) {
      const input = inputs.nth(index);
      if (!await input.isVisible().catch(() => false)) continue;
      if (!await input.isEditable().catch(() => false)) continue; // skips disabled/readOnly
      if (await input.inputValue().catch(() => '')) continue;
      await input.fill(value).catch(() => {});
      filledAny = true;
    }
    if (!filledAny) break;
    await page.waitForTimeout(300); // allow dependent date fields to enable/recompute
  }
}

// Fill the first visible, editable, currently-empty input matching the selector.
// Used to populate the empty party's fields without assuming a fixed party number.
async function fillFirstEmpty(page, selector, value, label) {
  const inputs = page.locator(selector);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const count = await inputs.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const input = inputs.nth(index);
      if (!await input.isVisible().catch(() => false)) continue;
      if (!await input.isEditable().catch(() => false)) continue;
      if (await input.inputValue().catch(() => '')) continue;
      await input.fill(value);
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Could not find an empty, editable field for ${label} (selector: ${selector}). The New Case Request form may have changed.`);
}

async function click(page, selector, label) {
  const locator = await waitForVisible(page, selector, label);
  await locator.click();
}

async function waitForVisible(page, selector, label) {
  const locator = page.locator(selector).first();
  try {
    await locator.waitFor({ state: 'visible', timeout: 30000 });
    return locator;
  } catch (error) {
    throw new Error(`Could not find ${label}. Update selector: ${selector}`);
  }
}

async function pageContainsText(page, pattern) {
  const text = await readVisibleBodyText(page);
  return pattern.test(text);
}

async function readVisibleBodyText(page) {
  return page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
}

// Bounded settle: wait for the SPA to go network-idle, but never block longer
// than `ms` (the default Playwright wait is 30s, which stalls chatty dashboards).
async function waitForIdle(page, ms = 6000) {
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
}

// Navigate to the dashboard only when we are not already on it, avoiding the
// extra reload that the requestor/participant flows otherwise incur each step.
async function ensureOnDashboard(page, config) {
  if (isDashboardPage(page.url(), await readVisibleBodyText(page))) return;
  await page.goto(new URL('/dashboard', config.productionUrl).toString(), { waitUntil: 'domcontentloaded' });
  await waitForIdle(page);
}

async function assertLoggedIn(page, config, role) {
  const deadline = Date.now() + 60000;
  let lastText = '';
  await waitForIdle(page);

  while (Date.now() < deadline) {
    const text = await readVisibleBodyText(page);
    lastText = text;
    if (/dashboard|account|notifications|create new case/i.test(text)) return;
    if (/\?message=login_required|login_required/i.test(page.url())) break;
    await page.waitForTimeout(1000);
  }

  const compactText = lastText.replace(/\s+/g, ' ').trim();
  throw new Error([
    `${role} login did not complete before timeout.`,
    `Current URL: ${page.url()}`,
    `Visible page text: ${compactText.slice(0, 1200)}`
  ].join('\n'));
}

async function verifyAuthenticatedRoute(page, config, role) {
  // Avoid a redundant second dashboard load: login() usually lands here already.
  if (!isDashboardPage(page.url(), await readVisibleBodyText(page))) {
    await page.goto(new URL('/dashboard', config.productionUrl).toString(), { waitUntil: 'domcontentloaded' });
    await waitForIdle(page);
  }

  const deadline = Date.now() + 30000;
  let lastText = '';
  while (Date.now() < deadline) {
    const text = await readVisibleBodyText(page);
    lastText = text;
    if (/\?message=login_required|login_required/i.test(page.url())) break;
    if (/dashboard|account|notifications|create new case/i.test(text)) return;
    await page.waitForTimeout(1000);
  }

  const compactText = lastText.replace(/\s+/g, ' ').trim();
  throw new Error([
    `${role} login did not create a usable Common Ground session.`,
    `Current URL: ${page.url()}`,
    `Visible page text: ${compactText.slice(0, 1200)}`
  ].join('\n'));
}

async function assertNotLoginRequired(page, actionLabel) {
  const text = await readVisibleBodyText(page);
  if (/\?message=login_required|login_required/i.test(page.url()) || /Log-In|Insert Email Address|Insert Password/i.test(text)) {
    const compactText = text.replace(/\s+/g, ' ').trim();
    throw new Error([
      `Cannot ${actionLabel} because Common Ground redirected to login.`,
      `Current URL: ${page.url()}`,
      `Visible page text: ${compactText.slice(0, 1200)}`
    ].join('\n'));
  }
}

async function selectCaseType(page, requestedType) {
  const plan = caseCreationPlan(requestedType);

  // The "Create a Request" page groups requests under tabs ("Discussion Request",
  // "Performance Review"), each containing cards (e.g. "Raise Request",
  // "Performance Review") with their own "Begin Request" button. Select the tab,
  // then begin the request from the matching card.
  await selectRequestTab(page, plan.tab);
  await page.getByRole('button', { name: /Begin Request/i }).first()
    .waitFor({ state: 'visible', timeout: 30000 })
    .catch(() => {});
  await clickRequestCardButton(page, plan.card);
}

function caseCreationPlan(requestedType) {
  const value = String(requestedType ?? '').toLowerCase();
  // Performance Review tab — select the specific variant card by its full title.
  if (/performance|review/.test(value)) {
    if (/90.?day/.test(value)) return { tab: /Performance Review/i, card: 'Performance Review - 90-Day' };
    if (/evaluation/.test(value)) return { tab: /Performance Review/i, card: 'Performance Review - Evaluation' };
    if (/coaching/.test(value)) return { tab: /Performance Review/i, card: 'Performance Review - Coaching' };
    throw new Error(`Ambiguous case type "${requestedType}" — specify Coaching, Evaluation, or 90-Day.`);
  }
  // Discussion Request tab cards.
  if (/remote/.test(value)) return { tab: /Discussion Request/i, card: 'Remote Work' };
  if (/career/.test(value)) return { tab: /Discussion Request/i, card: 'Career Development' };
  return { tab: /Discussion Request/i, card: 'Raise Request' };
}

async function selectRequestTab(page, tabPattern) {
  for (const role of ['tab', 'button', 'link']) {
    const locator = page.getByRole(role, { name: tabPattern }).first();
    if (await locator.isVisible({ timeout: 1500 }).catch(() => false)) {
      await locator.click().catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
      return;
    }
  }
  // Fall back to a plain text click for custom tab markup. Harmless when the tab
  // is already active (e.g. "Discussion Request" is selected by default).
  const textTab = page.getByText(tabPattern, { exact: false }).first();
  if (await textTab.isVisible({ timeout: 1500 }).catch(() => false)) {
    await textTab.click().catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
  }
}

async function clickRequestCardButton(page, cardTitle, buttonPattern = /Begin Request/i) {
  const clicked = await page.evaluate(({ target, btnSource, btnFlags }) => {
    const beginPattern = new RegExp(btnSource, btnFlags);
    const isDisabled = (element) => element.disabled || element.getAttribute('aria-disabled') === 'true';
    // Normalize dash variants (en/em dash, minus) and whitespace so the config
    // title ("- Coaching") matches the UI title ("– Coaching").
    const norm = (value) => String(value || '')
      .toLowerCase()
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
    const wanted = norm(target);

    // Match the card whose title is the requested variant exactly, else the most
    // specific containment (least extra text). No "shortest overall" heuristic,
    // so sibling cards (e.g. 90-Day) and the tab cannot win.
    const candidates = [...document.querySelectorAll('h1,h2,h3,h4,strong,span,p,a,div')]
      .map((element) => ({ element, text: norm(element.innerText) }))
      .filter((candidate) => candidate.text === wanted || candidate.text.includes(wanted))
      .map((candidate) => ({ ...candidate, score: candidate.text === wanted ? -1 : candidate.text.length - wanted.length }))
      .sort((a, b) => a.score - b.score);

    for (const candidate of candidates) {
      let node = candidate.element;
      for (let depth = 0; node && depth < 6; depth += 1) {
        const button = [...node.querySelectorAll('button,a,[role="button"]')]
          .find((element) => beginPattern.test((element.innerText || '').trim()) && !isDisabled(element));
        if (button) {
          button.click();
          return true;
        }
        node = node.parentElement;
      }
    }
    return false;
  }, {
    target: cardTitle,
    btnSource: buttonPattern.source,
    btnFlags: buttonPattern.flags
  });

  if (!clicked) {
    throw new Error(`Could not begin the request: no enabled "Begin Request" button found for the card "${cardTitle}". The Create a Request UI may have changed.`);
  }

  await page.waitForLoadState('networkidle').catch(() => {});
}

async function findCaseId(page) {
  const text = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  const candidates = `${page.url()}\n${text}`;
  return findCaseIdInText(candidates);
}

function findCaseIdInText(value) {
  return findCaseIdsInText(value)[0] ?? null;
}

function findCaseIdsInText(value) {
  const matches = [...String(value ?? '').matchAll(/\bCG-[A-Z0-9-]+\b/gi)]
    .map((match) => match[0].toUpperCase())
    .filter((id) => !id.startsWith('CG-AI-TEST-'));

  const numeric = matches.filter((id) => /^CG-\d+$/i.test(id));
  return uniqueValues([...numeric, ...matches]);
}

function updateArtifactCaseId(artifacts, commonGroundId) {
  if (!commonGroundId || artifacts.case?.commonGroundId) return;
  artifacts.case = {
    ...(artifacts.case ?? {}),
    id: commonGroundId,
    commonGroundId
  };
}

async function openCaseFromDashboard(page, createdCase, caseType) {
  const headings = page.locator('h1, h2, h3');
  const headingCount = await headings.count();
  const targets = caseSearchTargets(createdCase, caseType);
  const fallbackPattern = caseTypeDashboardPattern(caseType);
  const requireExactCaseMatch = Boolean(createdCase?.requireExactCaseMatch);

  for (let index = 0; index < headingCount; index += 1) {
    const heading = headings.nth(index);
    const text = (await heading.innerText().catch(() => '')).trim();
    if (targets.some((target) => text.includes(target))) {
      await heading.click();
      return;
    }
  }

  for (const target of targets) {
    const candidate = page.getByText(target, { exact: false }).first();
    if (await candidate.isVisible({ timeout: 1000 }).catch(() => false)) {
      await candidate.click();
      return;
    }
  }

  if (requireExactCaseMatch) {
    throw new Error(`Could not open existing case ${createdCase.commonGroundId} from dashboard. Refusing to fall back to another case.`);
  }

  const firstCaseHeading = page.locator('h1, h2, h3').filter({ hasText: fallbackPattern }).first();
  if (await firstCaseHeading.isVisible({ timeout: 1000 }).catch(() => false)) {
    await firstCaseHeading.click();
    return;
  }

  throw new Error(`Could not open case from dashboard. Tried: ${targets.join(', ')}`);
}

async function openCaseDetailsFromDashboard(page, createdCase, caseType) {
  if (!isDashboardPage(page.url(), await readVisibleBodyText(page))) return;
  const opened = await clickCaseCardButton(page, createdCase, /^(Case Details|Discussion Details)$/i)
    .then(() => true)
    .catch(() => false);
  if (opened) return;
  await openCaseFromDashboard(page, createdCase, caseType);
}

async function clickCaseCardButton(page, createdCase, buttonPattern) {
  await page.evaluate(({ targets, patternSource, patternFlags, requireExactCaseMatch }) => {
    const pattern = new RegExp(patternSource, patternFlags);
    const headings = [...document.querySelectorAll('h1,h2,h3')];
    const targetHeading = headings.find((element) => targets.some((target) => element.innerText.includes(target)));
    const heading = targetHeading
      ?? (requireExactCaseMatch ? null : headings.find((element) => /raise|performance review|case/i.test(element.innerText)));
    const globalButton = [...document.querySelectorAll('button,a,[role="button"]')]
      .find((element) => pattern.test(element.innerText));

    let node = heading?.parentElement ?? null;
    while (node) {
      const button = [...node.querySelectorAll('button,a,[role="button"]')]
        .find((element) => pattern.test(element.innerText));
      if (button) {
        button.click();
        return;
      }
      node = node.parentElement;
    }

    if (!requireExactCaseMatch && globalButton) {
      globalButton.click();
      return;
    }

    throw new Error(`Could not find matching case-card button. Tried case targets: ${targets.join(', ')}`);
  }, {
    targets: caseSearchTargets(createdCase),
    patternSource: buttonPattern.source,
    patternFlags: buttonPattern.flags,
    requireExactCaseMatch: Boolean(createdCase?.requireExactCaseMatch)
  });
}

function caseSearchTargets(createdCase, caseType = '') {
  const targets = [createdCase?.commonGroundId, createdCase?.id];
  if (createdCase?.requireExactCaseMatch) return targets.filter(Boolean);

  targets.push(createdCase?.syntheticReference, createdCase?.title);
  targets.push(...caseTypeDashboardAliases(caseType));
  return uniqueValues(targets.filter(Boolean));
}

function caseTypeDashboardAliases(caseType = '') {
  const value = String(caseType ?? '').trim();
  const aliases = [value];
  if (/performance/i.test(value)) aliases.push('Performance Review');
  if (/raise/i.test(value)) aliases.push('Raise');
  return uniqueValues(aliases.filter(Boolean));
}

function caseTypeDashboardPattern(caseType = '') {
  const aliases = caseTypeDashboardAliases(caseType);
  const source = aliases.length
    ? aliases.map((alias) => escapeRegExp(alias)).join('|')
    : 'raise|performance review|case';
  return new RegExp(source, 'i');
}

function uniqueValues(values) {
  return [...new Set(values)];
}

// Verification helper: open an existing case's alignment report and read the
// score using the same production path (no case creation, no interview). Mirrors
// the 180s capture cap used in runFullWorkflow.
export async function readAlignmentReportForExistingCase(config, { caseId, caseType }) {
  const alignmentConfig = {
    ...config,
    run: { ...config.run, postCompletionWaitMs: Math.min(config.run.postCompletionWaitMs, 180000) }
  };
  const browser = await chromium.launch(alignmentConfig.browser);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, alignmentConfig, 'requestor');

    const createdCase = { id: caseId, commonGroundId: caseId, requireExactCaseMatch: true };
    const syntheticCase = { caseType: caseType ?? alignmentConfig.run.caseType };
    await openCaseAsRequestor(page, alignmentConfig, createdCase, syntheticCase);

    const report = await waitForAndReadAlignmentReport(page, alignmentConfig, createdCase);
    const expectedRange = alignmentConfig.run.scenarioFoundation?.alignmentScenarios.scenarios
      .find((scenario) => scenario.id === alignmentConfig.run.alignmentScenarioId)?.expectedAlignmentRange ?? null;

    return {
      ...report,
      expectedRange,
      withinExpectedRange: expectedRange ? alignmentScoreWithinExpectedRange(report.score, expectedRange) : undefined
    };
  } finally {
    await browser.close();
  }
}

export const workflowTestSupport = {
  extractAlignmentScore,
  onAlignmentReportPage,
  alignmentScoreWithinExpectedRange,
  extractLatestQfi,
  factLabelingReady,
  gettingStartedAvailable,
  matchScenarioQuestion,
  matchScenarioCriterion,
  selectScriptedAnswer,
  evaluateExpectedPartnerBehavior,
  interviewReadySignal,
  excerptReviewReady,
  extractExcerptApprovalCount,
  extractFactLabelCount,
  extractCrossRateRemainingCount,
  extractFactRatingProgress,
  nextFactLabelControlIndex,
  findCaseIdsInText,
  crossRateUrl,
  labelFactStatements,
  fullWorkflowResultStatus,
  factLabelingReady
};

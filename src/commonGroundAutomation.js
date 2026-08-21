import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { buildSyntheticCase } from './syntheticData.js';
import { generatePartnerAiResponse, generateScenarioDossiers, verifyOpenAiConnectivity } from './llmResponder.js';
import { extractPromptContext } from './promptContext.js';
import { WORKFLOW_PHASES } from './workflowPhases.js';
import { evaluateManeuverSuccess, evaluatePolicyAdvanceStop, findActiveManeuver } from './testManeuvers.js';
import { createScenarioController } from './scenarioController.js';
import { matchScenarioQuestion, matchScenarioQuestionScored, matchScenarioCriterion, textSimilarity } from './questionMatching.js';
import { pickScriptedAnswer } from './scriptedAnswers.js';

export async function runAutomation(config, store) {
  if (config.run.runMode !== 'fact_labeling_smoke' && !config.llm.connectivityVerified) {
    await verifyOpenAiConnectivity(config.llm);
    config.llm.connectivityVerified = true;
  }
  const browser = await chromium.launch(config.browser);
  const persona = options.persona ?? null;
  const caseNumber = options.caseNumber ?? 1;
  const requestorTranscript = [];
  const participantTranscript = [];
  const artifacts = {
    runId: store.runId,
    productionUrl: config.productionUrl,
    topic: config.run.topic,
    caseType: config.run.caseType,
    runMode: config.run.runMode,
    workflowScope: config.run.workflowScope,
    interviewStartActor: config.run.interviewStartActor,
    dossierMode: config.run.dossierMode,
    dossierVariationPrompt: config.run.dossierVariationPrompt,
    screenshotMode: config.run.screenshotMode,
    reuseAuthState: config.run.reuseAuthState,
    existingCaseId: config.run.existingCaseId,
    testObjective: config.run.testObjective,
    testBehaviorPolicy: config.run.testBehaviorPolicy,
    qualityCriteriaPath: config.run.qualityCriteriaPath,
    status: 'started',
    startedAt: new Date().toISOString(),
    case: null,
    persona,
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

    // resume_case is full_workflow against an existing case: same phases, but everything
    // before config.run.resumePhase is skipped instead of re-run (and no case is created).
    if (config.run.runMode === 'full_workflow' || config.run.runMode === 'resume_case') {
      return await runFullWorkflow({ browser, config, store, artifacts, syntheticCase, requestorTranscript, participantTranscript, persona, caseNumber });
    }

    if (config.run.runMode === 'fact_labeling_smoke') {
      artifacts.case = existingCaseFromConfig(config, syntheticCase);
      return await runFactLabelingSmoke({ browser, config, store, artifacts, syntheticCase });
    }

    if (config.run.runMode === 'participant_getting_started') {
      artifacts.case = existingCaseFromConfig(config, syntheticCase);
      recordStage(artifacts, 'Open existing case', 'started', artifacts.case.commonGroundId);
      const { context: participantInterviewContext, page: participantInterviewPage } = await newAuthenticatedPage(browser, config, 'participant');
      await openCaseAsParticipant(participantInterviewPage, config, artifacts.case, syntheticCase);
      recordStage(artifacts, 'Open existing case', 'passed', artifacts.case.commonGroundId);

      recordStage(artifacts, 'Participant Getting Started', 'started');
      await startGettingStarted(participantInterviewPage, config, artifacts.case);
      const participantResult = await runPartnerAiInterview(participantInterviewPage, config, participantTranscript, {
        seed: `${artifacts.case.commonGroundId ?? store.runId}:participant`,
        actorRole: 'participant',
        runDir: store.runDir,
        scriptedAnswers: config.run.scriptedAnswers,
        persona
      });
      artifacts.participantGettingStarted = participantResult;
      artifacts.completedGettingStarted = participantResult.completed;
      artifacts.stopReason = participantResult.stopReason;
      artifacts.policyStopTriggered = participantResult.policyStopTriggered;
      artifacts.status = participantResult.passed ? 'passed' : 'failed';
      artifacts.finalUrl = participantInterviewPage.url();
      artifacts.finalVisibleText = await readVisibleBodyText(participantInterviewPage);
      recordStage(artifacts, 'Participant Getting Started', participantResult.passed ? 'passed' : 'failed', participantResult.stopReason);
      await captureCheckpointScreenshot(participantInterviewPage, config, store, 'participant-final.png');
      await participantInterviewContext.close();
      artifacts.finishedAt = new Date().toISOString();
      return artifacts;
    }

    recordStage(artifacts, 'Create case', 'started');
    const { context: requestorContext, page: requestorPage } = await newAuthenticatedPage(browser, config, 'requestor');
    artifacts.case = await createCase(requestorPage, config, syntheticCase);
    await requestorContext.close();
    recordStage(artifacts, 'Create case', 'passed', artifacts.case?.commonGroundId ?? artifacts.case?.syntheticReference ?? '');

    recordStage(artifacts, 'Accept participant invitation', 'started');
    const { context: participantContext, page: participantPage } = await newAuthenticatedPage(browser, config, 'participant');
    await acceptCaseRequest(participantPage, config, syntheticCase, artifacts.case);
    await participantContext.close();
    recordStage(artifacts, 'Accept participant invitation', 'passed');

    recordStage(artifacts, 'Requestor Getting Started', 'started');
    const { context: interviewContext, page: interviewPage } = await newAuthenticatedPage(browser, config, 'requestor');
    await openCaseAsRequestor(interviewPage, config, artifacts.case, syntheticCase);
    await startGettingStarted(interviewPage, config, artifacts.case);
    updateArtifactCaseId(artifacts, await findCaseId(interviewPage));

    const requestorResult = await runPartnerAiInterview(interviewPage, config, requestorTranscript, {
      seed: artifacts.case?.commonGroundId ?? artifacts.case?.syntheticReference ?? store.runId,
      actorRole: 'requestor',
      runDir: store.runDir,
      scriptedAnswers: config.run.scriptedAnswers,
      persona
    });
    updateArtifactCaseId(artifacts, findCaseIdInText(JSON.stringify(requestorTranscript)));
    artifacts.requestorGettingStarted = requestorResult;
    artifacts.completedGettingStarted = requestorResult.completed;
    artifacts.stopReason = requestorResult.stopReason;
    artifacts.policyStopTriggered = requestorResult.policyStopTriggered;
    recordStage(artifacts, 'Requestor Getting Started', requestorResult.passed ? 'passed' : 'failed', requestorResult.stopReason, { blocking: false });

    artifacts.finalUrl = interviewPage.url();
    artifacts.finalVisibleText = await readVisibleBodyText(interviewPage);
    updateArtifactCaseId(artifacts, findCaseIdInText(artifacts.finalVisibleText));
    artifacts.manualNextStep = requestorResult.passed
      ? 'Complete Common Ground post-processing and fact statement labeling manually, then run Participant Getting Started mode with this Common Ground Case ID.'
      : '';
    artifacts.status = requestorResult.passed ? 'passed' : 'failed';
    artifacts.finishedAt = new Date().toISOString();
    await captureCheckpointScreenshot(interviewPage, config, store, 'final.png');
    await interviewContext.close();
    return artifacts;
  } catch (error) {
    artifacts.status = 'failed';
    artifacts.error = {
      message: error.message,
      stack: error.stack
    };
    await captureFailureScreenshot(browser, config, store);
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
  const { context, page } = await newAuthenticatedPage(browser, config, stage.actorRole);
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
      mode: stage.mode,
      artifacts
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
  await captureCheckpointScreenshot(page, config, store, 'fact-labeling-smoke-final.png');
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

async function runFullWorkflow({ browser, config, store, artifacts, syntheticCase, requestorTranscript, participantTranscript, persona, caseNumber }) {
  if (!config.run.scenarioFoundation) throw new Error('Full workflow mode requires a schemaVersion 2 topic definition.');
  const scenarioController = createScenarioController({
    foundation: config.run.scenarioFoundation,
    alignmentScenarioId: config.run.alignmentScenarioId,
    behaviorSchedule: config.run.behaviorSchedule,
    seed: config.run.scenarioSeed || store.runId,
    actorPersonaByRole: actorPersonaByRole(config)
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
  // Start dossier preparation concurrently with browser setup. In fresh mode
  // this generates a new dossier; in auto/cached modes it may return a matching
  // saved dossier immediately.
  recordStage(artifacts, 'Prepare Scenario Dossiers', 'started', `mode ${config.run.dossierMode ?? 'fresh'}`);
  const dossiersPromise = loadOrGenerateScenarioDossiers({
    config,
    store,
    topic: config.run.scenarioFoundation.topic,
    scenario: selectedScenario,
    syntheticCase,
    artifacts
  });
  // Avoid an unhandled rejection if browser setup throws before we await it.
  dossiersPromise.catch(() => {});

  recordStage(artifacts, 'Create case', 'started');
  const { context: requestorSetupContext, page: requestorSetupPage } = await newAuthenticatedPage(browser, config, 'requestor');
  artifacts.case = await createCase(requestorSetupPage, config, syntheticCase);
  await requestorSetupContext.close();
  recordStage(artifacts, 'Create case', 'passed', artifacts.case?.commonGroundId ?? artifacts.case?.syntheticReference ?? '');

  recordStage(artifacts, 'Accept participant invitation', 'started');
  const { context: participantSetupContext, page: participantSetupPage } = await newAuthenticatedPage(browser, config, 'participant');
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

  // Steps 3-4: Requestor interview, then Requestor fact section.
  // Open the requestor's case page BEFORE awaiting the dossier, so a real
  // window stays visible during the dossier wait instead of a blank one.
  const { context: participantContext, page: participantPage } = await newAuthenticatedPage(browser, config, 'participant');
  await openCaseAsParticipant(participantPage, config, artifacts.case, syntheticCase);

  // D8: click into Getting Started as soon as its link is available on the Case
  // Details page — do NOT wait on the dossier first. ensureGettingStartedOpen
  // clicks the link the moment it is visible; the dossier then finishes while
  // Common Ground loads the interview page (it is only needed once we read the
  // first prompt and generate a response, just below).
  const runRequestorInterview = !skipPhase('requestor_interview', 'Requestor Getting Started');
  if (runRequestorInterview) {
  recordStage(artifacts, 'Requestor Getting Started', 'started');
  await ensureGettingStartedOpen(requestorPage, config, artifacts.case);
  updateArtifactCaseId(artifacts, await findCaseId(requestorPage));

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
    'Prepare Scenario Dossiers',
    'passed',
    `${dossiers.employee.canonicalProfile.employeeRole}; ${dossiers.scenarioExpressionPlan.questionExpressions.length} question relationships; ${dossiers.cacheSource ?? 'fresh'} dossier seed ${dossiers.caseSeed}; pair audit warnings ${dossiers.pairValidation?.warnings?.length ?? 0}.`
  );
  artifacts.scenarioPlan = scenarioController.getPlan();
  artifacts.alignmentScenarioId = config.run.alignmentScenarioId;
  artifacts.behaviorScheduleId = config.run.behaviorSchedule.id;

  const requestorResult = await runPartnerAiInterview(requestorPage, config, requestorTranscript, {
    seed: `${artifacts.case?.commonGroundId ?? store.runId}:requestor`,
    actorRole: 'requestor',
    scenarioController,
    runDir: store.runDir,
    scriptedAnswers: config.run.scriptedAnswers,
    persona,
    artifacts
  });
  artifacts.requestorGettingStarted = requestorResult;
  recordStage(artifacts, 'Requestor Getting Started', requestorResult.passed ? 'passed' : 'failed', requestorResult.stopReason, { blocking: false });
  if (!requestorResult.passed) throw new Error(requestorResult.stopReason);
  }

  if (!skipPhase('requestor_facts', 'Requestor Fact Section')) {
  recordStage(artifacts, 'Requestor Fact Section', 'started');
  await withOtherPartyGateRecovery(
    {
      page: requestorPage, config, store, createdCase: artifacts.case,
      actorLabel: 'Requestor', waitName: 'Requestor Fact Section', artifacts,
      expectedStep: (t, u) => clarifyContextReady(t, u) || excerptReviewReady(t, u) || factLabelingReady(t, u)
    },
    () => completeActorPostProcessing(requestorPage, config, artifacts, 'Requestor', ownFactLabel)
  );
  recordStage(artifacts, 'Participant Fact Section', 'passed', `All fact statements labeled ${ownFactLabel}.`);
  await captureCheckpointScreenshot(participantPage, config, store, 'participant-post-processing.png');
  await participantContext.close();

  // Steps 5-8: Participant rates the requestor's facts, waits for Getting Started
  // to become available, then does their own interview and fact section. One
  // requestor session covers all four steps.
  const { context: requestorContext, page: requestorPage } = await newAuthenticatedPage(browser, config, 'requestor');
  await openCaseAsRequestor(requestorPage, config, artifacts.case, syntheticCase);

  if (!skipPhase('participant_rates_requestor', 'Participant Rates Requestor Facts')) {
  recordStage(artifacts, 'Participant Rates Requestor Facts', 'started');
  await withOtherPartyGateRecovery(
    {
      page: participantPage, config, store, createdCase: artifacts.case,
      actorLabel: 'Participant', waitName: 'Participant Rates Requestor Facts', artifacts,
      expectedStep: (t, u) => factLabelingReady(t, u) || /Rate (?:Participant|Request[eo]r)'?s Facts/i.test(t)
    },
    () => completeParticipantFactReview(participantPage, config, artifacts.case, crossPartyFactLabel, artifacts)
  );
  recordStage(artifacts, 'Requestor Rates Participant Facts', 'passed', `Participant facts labeled ${crossPartyFactLabel}.`);
  await captureCheckpointScreenshot(requestorPage, config, store, 'requestor-rates-participant-facts.png');

  // Step 6: the Getting Started button does not appear immediately after rating;
  // re-open the case from the dashboard and poll until it is available. No-op when
  // completeParticipantFactReview already returned on a ready input (its
  // allowGettingStartedReady path).
  await waitForGettingStartedAfterRating(participantPage, config, artifacts.case, syntheticCase, 'Participant');

  // Excerpt review is a post-INTERVIEW screen, so the participant cannot legitimately
  // be on it here — their interview has not run yet. If it appears, Common Ground is in
  // a state this sequence does not model; stop rather than let ensureGettingStartedOpen
  // click a Getting Started link out of an unfinished review (gettingStartedAvailable
  // is a whole-page text test and would not catch this on its own).
  const participantPreInterviewText = await readVisibleBodyText(participantPage);
  if (excerptReviewReady(participantPreInterviewText, participantPage.url())) {
    const guardShot = `${store.runDir}/participant-unexpected-excerpt-review.png`;
    await participantPage.screenshot({ path: guardShot, fullPage: true }).catch(() => {});
    throw new Error(
      'Participant is on the Excerpt Review screen before their Getting Started interview has run. '
      + 'Excerpt review is a post-interview step, so Common Ground is in a state this workflow does not model; '
      + 'stopping instead of clicking further. '
      + `URL: ${participantPage.url()}. Screenshot: ${guardShot}.`
    );
  }
  await ensureGettingStartedOpen(participantPage, config, artifacts.case);
  }

  if (!skipPhase('participant_interview', 'Participant Getting Started')) {
  recordStage(artifacts, 'Participant Getting Started', 'started');
  const participantResult = await runPartnerAiInterview(participantPage, config, participantTranscript, {
    seed: `${artifacts.case?.commonGroundId ?? store.runId}:participant`,
    actorRole: 'participant',
    scenarioController,
    runDir: store.runDir,
    scriptedAnswers: config.run.scriptedAnswers,
    persona,
    artifacts
  });
  artifacts.participantGettingStarted = participantResult;
  recordStage(artifacts, 'Participant Getting Started', participantResult.passed ? 'passed' : 'failed', participantResult.stopReason, { blocking: false });
  if (!participantResult.passed) throw new Error(participantResult.stopReason);
  }

  if (!skipPhase('participant_facts', 'Participant Fact Section')) {
  recordStage(artifacts, 'Participant Fact Section', 'started');
  await withOtherPartyGateRecovery(
    {
      page: participantPage, config, store, createdCase: artifacts.case,
      actorLabel: 'Participant', waitName: 'Participant Fact Section', artifacts,
      expectedStep: (t, u) => clarifyContextReady(t, u) || excerptReviewReady(t, u) || factLabelingReady(t, u)
    },
    () => completeActorPostProcessing(participantPage, config, artifacts, 'Participant', ownFactLabel)
  );
  recordStage(artifacts, 'Requestor Fact Section', 'passed', `All fact statements labeled ${ownFactLabel}.`);
  await captureCheckpointScreenshot(requestorPage, config, store, 'requestor-post-processing.png');
  await requestorContext.close();

  // Step 9: Participant rates the requestor's facts.
  recordStage(artifacts, 'Participant Rates Requestor Facts', 'started');
  const { context: participantReviewContext, page: participantReviewPage } = await newAuthenticatedPage(browser, config, 'participant');
  await openCaseAsParticipant(participantReviewPage, config, artifacts.case, syntheticCase);
  await withOtherPartyGateRecovery(
    {
      page: requestorReviewPage, config, store, createdCase: artifacts.case,
      actorLabel: 'Requestor', waitName: 'Requestor Rates Participant Facts', artifacts,
      expectedStep: (t, u) => factLabelingReady(t, u) || /Rate (?:Participant|Request[eo]r)'?s Facts/i.test(t)
    },
    () => completeCrossPartyFactReview(requestorReviewPage, config, artifacts.case, crossPartyFactLabel, {
      raterRole: 'requestor',
      ratedParty: 'participant',
      linkText: /Rate Participant'?s Facts/i,
      mode: 'requestor_rates_participant',
      artifacts
    })
  );
  recordStage(artifacts, 'Participant Rates Requestor Facts', 'passed', `Requestor facts labeled ${crossPartyFactLabel}.`);
  await captureCheckpointScreenshot(participantReviewPage, config, store, 'participant-rates-requestor-facts.png');
  await participantReviewContext.close();

  artifacts.workflowCompleted = true;
  artifacts.workflowCompletionStage = 'Requestor Rates Participant Facts';

  recordStage(artifacts, 'Alignment Report', 'started');
  const { context: reportContext, page: reportPage } = await newAuthenticatedPage(browser, config, 'requestor');
  let alignmentReportIssue = null;
  try {
    await openCaseAsRequestor(reportPage, config, artifacts.case, syntheticCase);
    // Poll for the full configured post-processing window (e.g. 10 minutes) rather
    // than a hard 3-minute cap. The report can take several minutes to render, and
    // the dashboard "Latest Alignment: NN%" is read as a fallback below, so there is
    // no benefit to giving up early.
    const alignmentReport = await waitForAndReadAlignmentReport(reportPage, config, artifacts.case, artifacts);
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
    await captureCheckpointScreenshot(reportPage, config, store, 'alignment-report.png');
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
    await reportPage.close();
  }

  // Close the shared workflow context (browser.close() in runAutomation also covers
  // this on error paths).
  await sessionContext.close();

  const coverage = scenarioController.getCoverageSummary();
  // Behaviors are cleared per turn in scripted mode (see the scenarioTurn.behaviors
  // reset), so the materialized schedule's counts are not a real target. Flag it so
  // the report/UI/CSV show "N/A (scripted)" instead of a misleading 0/N.
  coverage.behaviorsInjected = !config.run.scriptedAnswers;
  artifacts.behaviorCoverage = coverage;
  artifacts.behaviorExecutions = scenarioController.executionResults;
  artifacts.softAssertions = [
    ...artifacts.softAssertions,
    ...scenarioController.executionResults.flatMap((result) => result.softAssertions)
  ];
  if (alignmentReportIssue) artifacts.softAssertions.push(alignmentReportIssue);
  // Read from artifacts, not from the phase-local consts: requestorResult/participantResult are
  // block-scoped to their `if (!skipPhase(...))` blocks, so touching them here threw
  // "requestorResult is not defined" on every run that reached the end of the workflow.
  // null (rather than false) when a phase was skipped by a resume — that run did not observe it.
  const requestorCompleted = artifacts.requestorGettingStarted?.completed ?? null;
  const participantCompleted = artifacts.participantGettingStarted?.completed ?? null;
  artifacts.completedGettingStarted = requestorCompleted === null || participantCompleted === null
    ? null
    : Boolean(requestorCompleted && participantCompleted);
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

function recordStage(artifacts, name, status, detail = '', options = {}) {
  artifacts.stages.push({
    name,
    status,
    detail,
    // Only meaningful on a failure: false marks a step the run is designed to continue past.
    ...(status === 'failed' ? { blocking: options.blocking !== false } : {}),
    at: new Date().toISOString()
  });
}

async function captureCheckpointScreenshot(page, config, store, fileName) {
  if ((config.run.screenshotMode ?? 'failures_only') !== 'all') return;
  await page.screenshot({ path: `${store.runDir}/${fileName}`, fullPage: true });
}

async function captureFailureScreenshot(browser, config, store) {
  const mode = config.run.screenshotMode ?? 'failures_only';
  if (mode === 'none') return;
  const contexts = browser.contexts().slice().reverse();
  for (const context of contexts) {
    const pages = context.pages().slice().reverse();
    for (const page of pages) {
      if (page.isClosed()) continue;
      await page.screenshot({ path: `${store.runDir}/failure.png`, fullPage: true }).catch(() => {});
      return;
    }
  }
}

async function loadOrGenerateScenarioDossiers({ config, store, topic, scenario, syntheticCase, artifacts }) {
  const mode = config.run.dossierMode ?? 'fresh';
  const variationPrompt = String(config.run.dossierVariationPrompt ?? '').trim();
  const cacheKey = scenarioDossierCacheKey({ config, topic, scenario, variationPrompt });
  const cachePath = path.join(config.rootDir, '.cache', 'scenario-dossiers', `${cacheKey}.json`);
  artifacts.scenarioDossierCache = {
    mode,
    key: cacheKey,
    path: cachePath,
    variationPrompt
  };

  if (mode !== 'fresh' && fsSync.existsSync(cachePath)) {
    console.log(`Scenario dossier cache hit: ${cacheKey}`);
    const cached = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    return {
      ...cached,
      cacheSource: 'cache_hit',
      cacheKey
    };
  }

  if (mode === 'cached') {
    throw new Error(`Scenario dossier cache miss for key ${cacheKey}. Select "Create fresh dossier" or "Reuse matching dossier when available" to generate one.`);
  }

  const seed = mode === 'auto'
    ? `cached:${cacheKey}`
    : `${store.runId}:${syntheticCase.reference}`;
  console.log(`Generating ${mode === 'auto' ? 'cacheable' : 'fresh'} scenario dossier with seed ${seed}.`);
  const dossiers = await generateScenarioDossiers({
    llm: config.llm,
    topic,
    scenario,
    seed,
    variationPrompt
  });
  const payload = {
    ...dossiers,
    cacheSource: mode === 'auto' ? 'cache_miss_generated' : 'fresh_generated',
    cacheKey
  };
  if (mode === 'auto') {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`Scenario dossier cached: ${cacheKey}`);
  }
  return payload;
}

function scenarioDossierCacheKey({ config, topic, scenario, variationPrompt }) {
  const stable = {
    schemaVersion: topic?.schemaVersion ?? 2,
    caseType: config.run.caseType,
    topicId: topic?.topicId,
    alignmentScenarioId: scenario?.id,
    scenarioRatings: scenario?.ratings,
    interviewStartActor: config.run.interviewStartActor ?? 'employee',
    scriptedAnswersPath: config.run.scriptedAnswersPath ?? '',
    variationPrompt
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 24);
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

// Navigate with retry + a longer timeout: a single slow prod page load should not
// kill a whole case. Retries up to `attempts` times with linear backoff.
async function gotoWithRetry(page, url, options = {}) {
  const attempts = options.attempts ?? 3;
  const timeout = options.timeout ?? 60000;
  const waitUntil = options.waitUntil ?? 'domcontentloaded';
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(url, { waitUntil, timeout });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const backoffMs = 2000 * attempt; // 2s, then 4s
        console.warn(`[navigation] ${url} failed (attempt ${attempt}/${attempts}): ${error.message}. Retrying in ${backoffMs}ms.`);
        await page.waitForTimeout(backoffMs);
      }
    }
  }
  throw new Error(`Navigation to ${url} failed after ${attempts} attempts: ${lastError?.message}`);
}

// The login form renders behind a "Loading…" spinner, and staging may redirect
// /dashboard → /login?message=login_required&redirect=… (with a "Please log in to continue."
// banner) when logged out. On a cold/fresh context the spinner can persist for a while, so
// wait patiently for the ACTUAL #email field — through the spinner and regardless of the
// /login URL variant — then confirm it is interactable (editable), not just present, before
// the caller types into it. Returns false if the field never becomes usable in time.
async function waitForLoginForm(page, emailSelector, timeoutMs = 60000) {
  const field = page.locator(emailSelector).first();
  const appeared = await field.waitFor({ state: 'visible', timeout: timeoutMs }).then(() => true).catch(() => false);
  if (!appeared) return false;
  return field.isEditable({ timeout: 5000 }).catch(() => false);
}

// COMMON_GROUND_URL may land on the marketing landing page or the corporate signup page
// instead of the login form. Reach the real /login form robustly: go straight to /login
// first (the landing and signup pages both link there, and /login renders the form
// directly even when unauthenticated); if that does not produce the form, fall back to
// clicking the "Log-In" link on whatever entry page loaded; then one more direct /login.
// Screenshot + fail if none works. Credentials are only entered once the form is present.
async function ensureLoginForm(page, config, selectors, role, store) {
  const loginUrl = new URL('/login', config.productionUrl).toString();

  // Primary: navigate straight to /login (staging may redirect to
  // /login?message=login_required&redirect=… when logged out) and wait patiently for the
  // form to render past the "Loading…" spinner — do NOT bail on the spinner.
  await gotoWithRetry(page, loginUrl, { timeout: 60000 });
  if (await waitForLoginForm(page, selectors.emailInput)) return;

  // Fallback: load the app root (landing page) and click its "Log-In" link.
  await gotoWithRetry(page, config.productionUrl, { timeout: 60000 });
  const loginLink = page
    .getByRole('link', { name: /^(?:already have an account\?\s*)?log\s*-?\s*in$/i })
    .first();
  if (await loginLink.isVisible({ timeout: 5000 }).catch(() => false)) {
    await loginLink.click().catch(() => {});
    if (await waitForLoginForm(page, selectors.emailInput, 20000)) return;
  }

  // Last resort: one more direct /login attempt (covers a slow first hydration).
  await gotoWithRetry(page, loginUrl, { timeout: 60000 });
  if (await waitForLoginForm(page, selectors.emailInput, 20000)) return;

  const shot = `${store?.runDir ?? '.'}/login-page-not-reachable-${role}.png`;
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  throw new Error(
    `Could not reach the ${role} login form. Tried direct ${loginUrl} and the "Log-In" `
    + `link on the entry page (landing / corporate signup). Current URL: ${page.url()}. `
    + `The staging entry flow may have changed. Screenshot: ${shot}`
  );
}

async function login(page, config, role, store) {
  const selectors = config.selectors.auth;

  await ensureLoginForm(page, config, selectors, role, store);
  await submitLoginForm(page, config, selectors, role);
  await assertLoggedIn(page, config, role);
  await verifyAuthenticatedRoute(page, config, role);
}

async function newAuthenticatedPage(browser, config, role) {
  if (config.run.reuseAuthState !== false) {
    const storageStatePath = authStorageStatePath(config, role);
    if (fsSync.existsSync(storageStatePath)) {
      const context = await browser.newContext({ storageState: storageStatePath });
      const page = await context.newPage();
      try {
        await verifyAuthenticatedRoute(page, config, role);
        return { context, page, reusedAuthState: true };
      } catch {
        await context.close().catch(() => {});
      }
    }
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, config, role);
  if (config.run.reuseAuthState !== false) {
    const storageStatePath = authStorageStatePath(config, role);
    await fs.mkdir(path.dirname(storageStatePath), { recursive: true });
    await context.storageState({ path: storageStatePath }).catch(() => {});
  }
  return { context, page, reusedAuthState: false };
}

function authStorageStatePath(config, role) {
  const urlKey = crypto.createHash('sha1').update(config.productionUrl).digest('hex').slice(0, 10);
  return path.join(config.rootDir, '.tmp', 'auth-state', `${urlKey}-${role}.json`);
}

async function logout(page, config) {
  await click(page, config.selectors.auth.logoutButton, 'logout');
  await waitForIdle(page);
}

async function createCase(page, config, syntheticCase, store) {
  const selectors = config.selectors.requestor;

  await page.goto(new URL('/dashboard', config.productionUrl).toString(), { waitUntil: 'domcontentloaded' });
  await waitForDiscussionsLoaded(page);
  const existingCaseIds = findCaseIdsInText(await readVisibleBodyText(page));

  await page.goto(new URL('/request/new', config.productionUrl).toString(), { waitUntil: 'domcontentloaded' });
  await waitForIdle(page);
  await assertNotLoginRequired(page, 'open new case page');
  await selectCaseType(page, syntheticCase.caseType);
  // Fill every present date with today, then settle the two parties. The New Discussion
  // form has been through three shapes (legacy free-text -> "Select a manager" dropdown ->
  // both parties auto-resolved and read-only); fillCaseParties detects which one is on
  // screen and fails loudly if it is none of them.
  await fillPresentDates(page, todayIso());
  await fillCaseParties(page, selectors, config, syntheticCase, store);
  await click(page, selectors.createCaseButton, 'create case submit');
  await waitForDiscussionsLoaded(page);
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
  const deadline = Date.now() + 300000;
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

async function acceptCaseRequest(page, config, syntheticCase, createdCase, store) {
  await ensureOnDashboard(page, config);
  await waitForDiscussionsLoaded(page);
  await openInvitationReview(page, config, createdCase, store);
  await acceptInvitationAndConfirm(page, config, createdCase, store);
}

// The redesigned dashboard card no longer has a "Review Invitation" button. Reach the
// invitation Accept/Decline screen through the new path: open the target case's Discussion
// Details from its dashboard card (matched by case ID), switch to the Notifications tab on
// the case page, then click the "Review Invitation" link in the "New Case Invitation"
// notification. Each step waits for its target control to render (a DOM signal), never
// networkidle.
async function openInvitationReview(page, config, createdCase, store) {
  // 1. Open the case's Discussion Details from its dashboard card (matched by CG-id text).
  //    clickCaseCardButton already waits on the dashboard via waitForDiscussionsLoaded.
  await clickCaseCardButton(page, createdCase, /^(Discussion Details|Case Details)$/i);
  // 2. Switch to the Notifications tab on the case page. It is a <button>; we exclude the
  //    'link' role so we don't accidentally hit the sidebar's Notifications nav item.
  await clickInvitationStep(page, store, createdCase, ['tab', 'button'], /^Notifications\b/i,
    'the Notifications tab on the case page');
  // 3. Click "Review Invitation" in the New Case Invitation notification.
  await clickInvitationStep(page, store, createdCase, ['link', 'button'], /Review Invitation/i,
    'the "Review Invitation" link in the New Case Invitation notification');
}

// Click the first visible control matching one of the given roles + accessible-name
// pattern, polling until it renders (the case page and its notifications hydrate after
// navigation). Screenshots and fails cleanly if the control never appears.
async function clickInvitationStep(page, store, createdCase, roles, namePattern, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const role of roles) {
      const control = page.getByRole(role, { name: namePattern }).first();
      if (await control.isVisible({ timeout: 500 }).catch(() => false)) {
        await control.click().catch(() => {});
        return;
      }
    }
    await page.waitForTimeout(400);
  }
  const shot = `${store?.runDir ?? '.'}/accept-invitation-step-not-found.png`;
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  throw new Error(`Could not find ${label} for ${createdCase?.commonGroundId ?? 'the case'} while accepting the invitation. The invitation flow may have changed again. Screenshot: ${shot}`);
}

// The invitation review page (/request-review) hydrates after network-idle, so an Accept
// click fired too early is silently dropped and the case stays Pending — which is what made
// the old step "pass" while leaving the requestor unable to start. Click Accept once it is
// actionable, then confirm the case actually flips to Active, retrying once and failing
// loudly (with a screenshot) rather than trusting an unverified click.
async function acceptInvitationAndConfirm(page, config, createdCase, store) {
  const acceptSelector = config.selectors.participant.acceptRequestButton;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const accept = page.locator(acceptSelector).first();
    // The /request-review page renders its Decline/Accept buttons a few seconds after
    // navigation, so WAIT for the button to appear — locator.isVisible() is an immediate
    // check that does not wait, and would skip the click during the hydration window.
    const appeared = await accept.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
    if (appeared) {
      await page.waitForTimeout(750); // let the SPA attach the click handler
      await accept.click({ timeout: 10000 }).catch(() => {});
      await waitForIdle(page);
    }
    if (await caseIsActive(page, config, createdCase)) return;
    if (attempt < 2) {
      await ensureOnDashboard(page, config);
      await waitForDiscussionsLoaded(page);
      if (await caseIsActive(page, config, createdCase)) return;
      await openInvitationReview(page, config, createdCase, store).catch(() => {});
    }
  }
  const shot = `${store.runDir}/accept-invitation-failed.png`;
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  throw new Error(`Accepted the invitation for ${createdCase.commonGroundId}, but the case never became Active (still Pending). The invitation-review UI may have changed. Screenshot: ${shot}`);
}

// Report whether the case shows as accepted (Active) on the dashboard — its card no longer
// offers "Review Invitation" and now offers "Getting Started".
//
// Anchored to the case's own CG-id, never to a case-type alias: with several
// same-type cases on the dashboard, an alias-matched heading finds whichever
// card renders first (observed on CG-0062: four older Active "Project Review"
// cards made a still-pending case verify as accepted, masking a missed click).
async function caseIsActive(page, config, createdCase) {
  await ensureOnDashboard(page, config);
  await waitForDiscussionsLoaded(page);
  const caseId = createdCase?.commonGroundId ?? createdCase?.id ?? '';
  if (!caseId) return false;
  return page.evaluate((id) => {
    const marker = [...document.querySelectorAll('*')]
      .find((el) => !el.children.length && (el.textContent || '').toUpperCase().includes(id.toUpperCase()));
    let node = marker;
    for (let i = 0; i < 8 && node; i += 1) {
      const text = node.innerText || '';
      // The first ancestor carrying the party labels is the case's own card.
      if (/(Manager:|Employee:)/.test(text)) {
        // Acceptance is proved by the card having moved PAST the invitation —
        // not by the word "Active" (the redesign labels a case Active from
        // creation) and not by this actor owning the next step: after
        // accepting, the participant card reads "Next Up: Rabia shares their
        // perspective", because the requestor goes first (CG-0095).
        if (/Review Invitation/i.test(text)) return false;
        const nextUp = (text.match(/Next(?: Up)?:\s*([^\n]*)/i) || ['', ''])[1];
        if (/invitation/i.test(nextUp)) return false;
        return /Next(?: Up)?:/i.test(text) || /Getting Started|Begin Discussion/i.test(text);
      }
      node = node.parentElement;
    }
    return false;
  }, caseId);
}

// The dashboard fetches its discussions after network-idle, showing "Loading discussions…"
// meanwhile, so a case-card lookup can race the fetch. Wait for that state to clear.
// Cap defaults to 90s: on a cold context the dashboard's Next.js bundle can take
// ~30s to download and mount (measured), so the old 20s cap expired mid-load and
// the caller proceeded against a still-spinning page. This returns as soon as the
// cards render, so the higher cap only adds headroom for the first cold load and
// never slows warm loads. With the shared session context, only phase 1 is cold.
async function waitForDiscussionsLoaded(page, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readVisibleBodyText(page);
    if (!isDashboardPage(page.url(), text)) return;
    if (!/Loading discussions/i.test(text) && /(CG-\d+|Waiting for a Discussion)/i.test(text)) return;
    await page.waitForTimeout(500);
  }
}

// Case-detail twin of waitForDiscussionsLoaded: the detail page shows "Loading
// discussion details..." while it fetches, so action lookups can race the fetch.
// Returns as soon as the loading state clears; the cap only bounds a hung load.
async function waitForCaseDetailLoaded(page, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readVisibleBodyText(page);
    if (!/Loading discussion details|Loading discussions/i.test(text)) return;
    await page.waitForTimeout(500);
  }
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
  // Try the Getting Started action on the current page first (case detail page / interview).
  if (await clickGettingStartedAction(page)) return;

  // Not here — open the case's Discussion Details (always present) to reach its detail page,
  // then look for the action there, rather than matching the card's state-specific "Getting
  // Started" button on the dashboard.
  await ensureOnDashboard(page, config);
  await openCaseFromDashboard(page, createdCase, config.run.caseType);
  await waitForIdle(page);
  // The case detail page hydrates after navigation ("Loading discussion
  // details..." meanwhile), and the action can render a beat after the loading
  // state clears — a single fast probe races both (observed on CG-0060: the
  // action was reported missing while the page still said it was loading).
  await waitForCaseDetailLoaded(page);
  const actionDeadline = Date.now() + 30000;
  while (Date.now() < actionDeadline) {
    if (await clickGettingStartedAction(page)) return;
    await page.waitForTimeout(1000);
  }

  const dump = await dumpOpenCaseFailure(page, createdCase);
  throw new Error(
    `Could not start Getting Started for ${createdCase?.commonGroundId ?? 'the case'}: no Getting Started action on the case detail page. `
    + `URL: ${page.url()}. Screenshot: ${dump.shot}. Visible text: ${dump.bodyText}`
  );
}

// Click the Getting Started / Begin Discussion action on the current page (the case detail
// page after opening the case, or the interview entry). Returns true if it clicked.
async function clickGettingStartedAction(page) {
  const directLink = page.locator('a[href*="/get-started"]').first();
  if (await directLink.isVisible({ timeout: 750 }).catch(() => false)) {
    await directLink.click().catch(() => {});
    await waitForIdle(page);
    await page.waitForTimeout(2000);
    return true;
  }
  for (const role of ['link', 'button']) {
    const control = page.getByRole(role, { name: /Getting Started|Begin Discussion/i }).first();
    const visible = await control.isVisible({ timeout: 500 }).catch(() => false);
    const enabled = visible && await control.isEnabled({ timeout: 500 }).catch(() => false);
    if (enabled) {
      await control.click().catch(() => {});
      await waitForIdle(page);
      await page.waitForTimeout(2000);
      return true;
    }
  }
  return false;
}

class PromptLoopError extends Error {
  constructor(prompt, count) {
    super(`Partner AI repeated the same primary question ${count} times without advancing — aborting to avoid an infinite interview loop.`);
    this.name = 'PromptLoopError';
    this.repeatedPrompt = String(prompt ?? '');
    this.repeatCount = count;
  }
}

// Distinct from PromptLoopError: the page never posted a NEW Partner AI message, so
// there is no repeated question to speak of — we kept re-reading the same DOM. Naming
// this separately keeps the artifact honest about which failure actually occurred.
class PromptStallError extends Error {
  constructor(count) {
    super(`Partner AI did not post a new prompt across ${count} consecutive reads — the interview transcript stopped advancing.`);
    this.name = 'PromptStallError';
    this.stallCount = count;
  }
}

// Ceiling on consecutive turns within a single primary question before the interview is
// treated as stuck. Real runs use 3-4 follow-ups per primary, so this leaves headroom.
const MAX_TURNS_PER_PRIMARY_QUESTION = 8;

// Two prompts count as "the same" for the loop guard when their normalized
// primary-question text is identical or >=95% similar (small QFI-nudge edits
// still count as a repeat). Cheap early-outs keep the happy path near-zero cost.
function isSameRepeatedPrompt(a, b) {
  const x = normalizeLoopPrompt(a);
  const y = normalizeLoopPrompt(b);
  if (x === y) return true;
  const longest = Math.max(x.length, y.length);
  if (longest === 0) return true;
  // A length gap over 5% already caps similarity below 95% — skip the O(n*m) work.
  if (Math.abs(x.length - y.length) / longest > 0.05) return false;
  return 1 - levenshteinDistance(x, y) / longest >= 0.95;
}

function normalizeLoopPrompt(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  const n = b.length;
  if (a.length === 0) return n;
  if (n === 0) return a.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

// Fast, clean failure when Getting Started is gated on the other party. Detection
// lives in waitForInterviewReady (which throws OtherPartyGateError); this wrapper
// turns that into a screenshot, a recorded soft assertion, and an error naming the
// actor — instead of the 10-minute "did not become ready before timeout" that hides
// the cause. Deliberately does NOT recover: this is the only stage that submits
// interview turns, so re-running it could duplicate submissions. A gate here means
// Common Ground wants the OTHER actor to act, which no retry in this session fixes.
async function runPartnerAiInterview(page, config, transcript, options = {}) {
  try {
    return await runPartnerAiInterviewTurns(page, config, transcript, options);
  } catch (error) {
    if (!(error instanceof OtherPartyGateError)) throw error;

    const actorLabel = capitalizeFirst(options.actorRole ?? 'actor');
    const slug = String(options.actorRole ?? 'actor').toLowerCase().replace(/\s+/g, '-');
    const screenshotPath = options.runDir ? `${options.runDir}/${slug}-interview-gate.png` : '(no runDir)';
    if (options.runDir) {
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    }

    const submittedTurns = transcript.filter((entry) => entry.role === 'syntheticUser').length;
    const position = submittedTurns === 0
      ? 'before submitting any turn (Common Ground never let this actor start)'
      : `after ${submittedTurns} submitted turn(s)`;

    console.log(`[gate] ${actorLabel} Getting Started gated on the other party ${position}.`);
    options.artifacts?.softAssertions.push({
      type: 'workflow_interview_gate',
      passed: false,
      expected: `${actorLabel} can start and complete the Getting Started interview.`,
      observed: `Gated at "waiting on the other party" during ${error.waitName} ${position}. Screenshot: ${screenshotPath}. URL: ${error.url}.`
    });

    const gateError = new Error(
      `${actorLabel} Getting Started is blocked at the "waiting on the other party" gate ${position}. `
      + 'Common Ground is sequencing this step behind the other actor, so the response input will never appear in this session. '
      + `Screenshot: ${screenshotPath}.`
    );
    gateError.otherPartyGate = { actorLabel, waitName: error.waitName, screenshotPath, url: error.url };
    throw gateError;
  }
}

async function runPartnerAiInterviewTurns(page, config, transcript, options = {}) {
  // A first-run onboarding tour modal can overlay the Groundwork page and block
  // the response input; dismiss it before we wait for the interview to be ready.
  const interviewStageName = `${capitalizeFirst(options.actorRole ?? 'actor')} Getting Started interview`;
  await dismissOnboardingTourModal(page);
  await waitForInterviewReady(page, config, { stageName: interviewStageName });

  // Scripted-answers mode: which primary questions this actor has already
  // answered from the supplied script (so only the FIRST turn of each primary
  // question uses the scripted answer; follow-ups fall back to the responder).
  const scriptedAnswers = options.scriptedAnswers ?? null;
  const answeredScriptedQuestions = new Set();

  // Loop-guard state: detect Partner AI re-asking the same question verbatim.
  let lastLoopGuardQuestion = null;
  let repeatedPromptCount = 0;
  // Windowed twin of the consecutive guard: an app loop can ALTERNATE between two
  // prompts (observed on staging: "I noticed you skipped 1 question(s)..." ↔ the
  // re-asked primary question, with the skipped flag never clearing despite
  // QoR-High answers), so no prompt ever repeats consecutively. Track the recent
  // prompts and abort when any one question recurs 3 times within the window. A
  // healthy interview re-asks a question at most twice inside 8 turns (original
  // ask + one skipped-item revisit).
  const recentLoopGuardQuestions = [];
  const LOOP_GUARD_WINDOW = 8;
  // Secondary bound: consecutive turns spent on one primary question.
  let lastPrimaryQuestion = null;
  let samePrimaryCount = 0;
  // Stall state: the answer we last submitted, so a read taken before Partner AI has
  // replied is never mistaken for a repeated question.
  let lastSubmittedResponse = null;
  let stalledPromptCount = 0;

  for (let turn = 1; turn <= config.run.maxTurns; turn += 1) {
    await dismissTourOverlay(page, `${options.actorRole ?? 'actor'} interview turn ${turn}`);
    const latestPrompt = await readLatestPrompt(page, config, { afterResponse: lastSubmittedResponse });
    const promptContext = extractPromptContext(latestPrompt);
    if (participantFactRatingRequired(latestPrompt)) {
      throw new Error('Participant Getting Started is not available yet. Common Ground is requiring the participant to rate the requestor fact statements first. Complete the participant fact-statement rating for this case, then rerun Participant Getting Started mode.');
    }

    // Separate "no new prompt" from "same question asked again". A genuine re-ask puts a
    // new Partner AI message after our last answer; nothing after it means Partner AI has
    // not replied yet and the extracted question is stale header text.
    const promptAdvanced = lastSubmittedResponse === null
      || partnerRepliedAfter(latestPrompt, lastSubmittedResponse);
    const interviewEnded = isCompletionPrompt(latestPrompt, config.completionPhrases)
      || isPostInterviewState(latestPrompt);
    if (!promptAdvanced && !interviewEnded) {
      stalledPromptCount += 1;
      console.log(`[prompt-stall] No new Partner AI prompt on read ${stalledPromptCount}; re-reading instead of counting a repeat.`);
      if (stalledPromptCount >= 3) {
        const slug = String(options.actorRole ?? 'actor').toLowerCase().replace(/\s+/g, '-');
        if (options.runDir) {
          await page.screenshot({ path: `${options.runDir}/prompt-stall-${slug}.png`, fullPage: true }).catch(() => {});
        }
        throw new PromptStallError(stalledPromptCount);
      }
      continue;
    }
    stalledPromptCount = 0;

    // Abort if Partner AI asks the SAME question for 3 consecutive turns (e.g. every
    // answer flagged QFI: Low) — otherwise we would generate new answers indefinitely.
    //
    // Key on the question actually being asked (activeQuestion already prefers the
    // latest follow-up), NOT on primaryQuestion. A primary question legitimately spans
    // several follow-up turns while Partner AI drills into it: keying on the primary
    // counted normal drill-down as a repeat and aborted healthy interviews on the third
    // follow-up of any question.
    const loopGuardQuestion = promptContext.activeQuestion || promptContext.primaryQuestion || latestPrompt;
    repeatedPromptCount = (lastLoopGuardQuestion !== null && isSameRepeatedPrompt(lastLoopGuardQuestion, loopGuardQuestion))
      ? repeatedPromptCount + 1
      : 1;
    lastLoopGuardQuestion = loopGuardQuestion;
    if (repeatedPromptCount >= 3) {
      console.log(`[loop-guard] Same prompt repeated ${repeatedPromptCount} times — aborting to avoid infinite loop.`);
      const slug = String(options.actorRole ?? 'actor').toLowerCase().replace(/\s+/g, '-');
      if (options.runDir) {
        await page.screenshot({ path: `${options.runDir}/prompt-loop-${slug}.png`, fullPage: true }).catch(() => {});
      }
      throw new PromptLoopError(loopGuardQuestion, repeatedPromptCount);
    }
    recentLoopGuardQuestions.push(loopGuardQuestion);
    if (recentLoopGuardQuestions.length > LOOP_GUARD_WINDOW) recentLoopGuardQuestions.shift();
    const windowRepeats = recentLoopGuardQuestions
      .filter((question) => isSameRepeatedPrompt(question, loopGuardQuestion)).length;
    if (windowRepeats >= 3) {
      console.log(`[loop-guard] Same prompt recurred ${windowRepeats} times within ${LOOP_GUARD_WINDOW} turns (alternating loop) — aborting to avoid infinite loop.`);
      const slug = String(options.actorRole ?? 'actor').toLowerCase().replace(/\s+/g, '-');
      if (options.runDir) {
        await page.screenshot({ path: `${options.runDir}/prompt-loop-${slug}.png`, fullPage: true }).catch(() => {});
      }
      throw new PromptLoopError(loopGuardQuestion, windowRepeats);
    }

    // Secondary bound, preserving the original intent now that the primary question no
    // longer drives the guard above: if Partner AI never leaves one primary question, the
    // interview is stuck even though each follow-up is worded differently. Observed runs
    // use 3-4 follow-ups per primary, so this only trips on a genuine stall.
    const currentPrimary = promptContext.primaryQuestion || '';
    samePrimaryCount = (currentPrimary && lastPrimaryQuestion && isSameRepeatedPrompt(lastPrimaryQuestion, currentPrimary))
      ? samePrimaryCount + 1
      : 1;
    lastPrimaryQuestion = currentPrimary;
    if (currentPrimary && samePrimaryCount >= MAX_TURNS_PER_PRIMARY_QUESTION) {
      console.log(`[loop-guard] Primary question unchanged for ${samePrimaryCount} turns — aborting.`);
      const slug = String(options.actorRole ?? 'actor').toLowerCase().replace(/\s+/g, '-');
      if (options.runDir) {
        await page.screenshot({ path: `${options.runDir}/prompt-loop-${slug}.png`, fullPage: true }).catch(() => {});
      }
      throw new PromptLoopError(currentPrimary, samePrimaryCount);
    }

    transcript.push({
      role: 'partnerAi',
      turn,
      text: latestPrompt,
      promptContext,
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

    let responseInput = await findReadyResponseInput(page, config.selectors.partnerAi.responseInput, 5000);
    if (!responseInput) {
      // The composer is removed/disabled while Partner AI works between turns (e.g.
      // "Making sure there's enough here to go on…"), which a flat 5s probe reports as a
      // stale selector. Re-wait through the shared readiness loop, which rolls its
      // deadline forward while the page is visibly processing.
      await waitForInterviewReady(page, config, { stageName: interviewStageName });
      const afterWait = await readVisibleBodyText(page);
      if (isCompletionPrompt(afterWait, config.completionPhrases) || isPostInterviewState(afterWait)) {
        return {
          completed: true,
          passed: true,
          stopReason: 'Partner AI indicated Getting Started is complete.',
          policyStopTriggered: false
        };
      }
      responseInput = await findReadyResponseInput(page, config.selectors.partnerAi.responseInput, 15000);
    }
    if (!responseInput) {
      throw new Error([
        'Could not find a ready Partner AI response input.',
        `Selector: ${config.selectors.partnerAi.responseInput} (${await describeResponseInputs(page, config.selectors.partnerAi.responseInput)})`,
        'If count>0 the selector is fine and the composer was disabled — the page state below says why.',
        `Current URL: ${page.url()}`,
        `Last visible page text: ${compactVisibleText(await readVisibleBodyText(page), 1200)}`
      ].join('\n'));
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
      ? selectScriptedAnswer({ config, scriptedAnswers, scenarioTurn, latestPrompt, actorRole: options.actorRole, actorPersona: actorPersonaForRole(config, options.actorRole), answeredScriptedQuestions })
      : null;

    const responseContext = {
      actorRole: options.actorRole ?? 'requestor',
      actorPersona: actorPersonaForRole(config, options.actorRole),
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
      persona: options.persona ?? null,
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

    // Enforcement companion to the token clamp: if a sparse persona leaked
    // specifics on a non-follow-up turn, record it as a soft failure so the
    // "coax before detail" contract is observable, not just prompted.
    if (responseContext.persona?.detail === 'sparse'
      && responseContext.turnClassification
      && !responseContext.turnClassification.isFollowUpTurn
      && /\d|for example|for instance|such as|percent|%|\bmetric|benchmark/i.test(response)) {
      options.artifacts?.softAssertions.push({
        type: 'persona_sparse_leak',
        passed: false,
        expected: `Sparse persona "${responseContext.persona.id}" withholds specifics until Partner AI asks a follow-up.`,
        observed: `${options.actorRole ?? 'requestor'} turn ${turn}: initial answer already volunteered concrete detail.`
      });
    }

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
    // Verify the send actually happened: the app clears the input on success.
    // A click landing during a re-render can silently miss (observed on
    // CG-0082: the full response sat in the textarea, Partner AI never
    // replied, and the stall guard aborted the interview). Retry while the
    // text remains in the box.
    for (let sendAttempt = 1; sendAttempt <= 3; sendAttempt += 1) {
      await page.waitForTimeout(1500);
      const residual = await responseInput.inputValue().catch(async () =>
        responseInput.evaluate((el) => el.value ?? el.textContent ?? '').catch(() => ''));
      if (!String(residual ?? '').trim()) break;
      console.warn(`[interview] Send attempt ${sendAttempt} left the response in the input; clicking send again.`);
      await click(page, config.selectors.partnerAi.sendButton, 'Partner AI send (retry)');
    }
    // Anchor the next prompt read to this answer: the following turn must not read the
    // page until Partner AI has posted something after it.
    lastSubmittedResponse = response;
    await waitForInterviewReady(page, config, { stageName: interviewStageName });

    const visibleAfterResponse = await readVisibleBodyText(page);
    if (scenarioTurn?.behaviors?.length) {
      if (!behaviorVerification.length) {
        // Guardrail: behaviors were scheduled on this turn but no verification came
        // back, so none can be marked complete (silent 0/N coverage). Scripted-answers
        // runs clear scenarioTurn.behaviors earlier, so this only fires on a genuine
        // verification-wiring regression in generateScenarioComposedResponse.
        console.warn(`[behavior-coverage] ${options.actorRole ?? 'requestor'} turn ${turn}: ${scenarioTurn.behaviors.length} behavior(s) scheduled but behaviorVerification is empty; none can be completed.`);
      }
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

function actorPersonaByRole(config) {
  const firstPersona = config.run.interviewStartActor === 'manager' ? 'manager' : 'employee';
  const secondPersona = firstPersona === 'employee' ? 'manager' : 'employee';
  if (config.run.workflowScope === 'requestor') {
    return {
      requestor: firstPersona,
      participant: secondPersona
    };
  }
  return {
    participant: firstPersona,
    requestor: secondPersona
  };
}

function actorPersonaForRole(config, actorRole = 'requestor') {
  return actorPersonaByRole(config)[actorRole] ?? 'employee';
}

// A live prompt is a "primary question" turn when the newest Partner AI chat
// message carries the primary-question format: a "Please cover:" guidance list.
// Follow-up probes never include one. The prompt text contains the whole chat
// history (older primary questions included), so only the text after the last
// message timestamp is examined; the first prompt of an interview has no
// timestamps yet, so the whole text is checked instead.
function isPrimaryQuestionPrompt(latestPrompt) {
  const text = String(latestPrompt ?? '');
  const timestamps = [...text.matchAll(/\b\d{1,2}:\d{2}\s?[AP]M\b/g)];
  const newestMessage = timestamps.length ? text.slice(timestamps[timestamps.length - 1].index) : text;
  return /Please cover:/i.test(newestMessage);
}

// Resolves the scripted answer (if any) for the current turn. Returns null when
// the turn should be answered by the normal responder (follow-up, unmatched
// prompt with no fallback left, or no scripted answer for this actor/question).
function selectScriptedAnswer({ config, scriptedAnswers, scenarioTurn, latestPrompt, actorRole, actorPersona, answeredScriptedQuestions }) {
  // Scripted answers are reserved for primary questions. Without this gate,
  // follow-up probes can consume them — via the sequential fallback or a loose
  // fuzzy match — leaving the real primary question to the terse LLM fallback,
  // which Partner AI may reject and re-ask indefinitely (case CG-0347).
  if (!isPrimaryQuestionPrompt(latestPrompt)) return null;

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
  //
  // NEVER on a follow-up turn. A fuzzy match is evidence the prompt really is that
  // primary question; the fallback has no evidence at all, so on a follow-up it just
  // injects the next script regardless of what was asked. That produced answers that
  // did not address the question — e.g. a manager follow-up about team morale answered
  // with the compensation-alternatives script — which then made Partner AI re-probe the
  // same point for turn after turn. A follow-up must fall through to the LLM responder,
  // which is grounded in the transcript.
  if (!primaryQuestionId) {
    const next = scriptedAnswers.answers.find((entry) => !answeredScriptedQuestions.has(entry.primaryQuestionId));
    if (next) {
      primaryQuestionId = next.primaryQuestionId;
      matchConfidence = 'sequential-fallback';
    }
  }

  if (!primaryQuestionId || answeredScriptedQuestions.has(primaryQuestionId)) return null;

  const text = pickScriptedAnswer(scriptedAnswers, primaryQuestionId, actorRole ?? 'requestor', actorPersona);
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
  // Instrumented so the cost of this step can be attributed rather than guessed:
  // waiting for Common Ground to extract and render the statements is its time,
  // clicking through them is ours. Reported per actor in the run log.
  const startedAt = Date.now();
  await waitForFactLabelingReady(page, config, labelText);
  const readyAt = Date.now();
  if (await factStatementsAlreadySubmitted(page)) {
    console.log('[fact-labels] Statements are already labelled and submitted; moving on without re-rating.');
    return;
  }
  const labelingUrl = page.url();
  const statementCount = await countFactStatements(page);
  await selectAllFactStatementLabels(page, config, labelText);
  const labelledAt = Date.now();
  await submitFactStatementRatings(page);
  await verifyFactStatementSubmission(page, labelingUrl);
  const doneAt = Date.now();
  const secs = (from, to) => ((to - from) / 1000).toFixed(1);
  console.log(
    `[fact-labels] ${statementCount || 'unknown'} statement(s) | waiting for the app to render them ${secs(startedAt, readyAt)}s`
    + ` | labelling ${secs(readyAt, labelledAt)}s | submit+verify ${secs(labelledAt, doneAt)}s`
    + ` | total ${secs(startedAt, doneAt)}s`
  );
}

// Number of statements the labelling screen is showing, from its own counter.
async function countFactStatements(page) {
  return page.evaluate(() => {
    const text = String(document.body?.innerText ?? '').replace(/\s+/g, ' ');
    const counter = text.match(/(\d+)\s*\/\s*(\d+)\s+labell?ed/i);
    if (counter) return Number(counter[2]);
    return (text.match(/Statement\s+\d+/gi) ?? []).length || null;
  }).catch(() => null);
}

// How long an "already finished" reading must hold before a wait accepts it and moves on.
const STEP_ALREADY_DONE_CONFIRM_MS = 15000;

// True when every statement is labelled and the submit control is spent — the live page shows
// "9/9 labeled" beside a disabled "Submitted" button. Re-rating here would either no-op or
// overwrite a completed step, and waiting would burn the full timeout.
async function factStatementsAlreadySubmitted(page) {
  return page.evaluate(() => {
    const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const text = norm(document.body?.innerText);
    const counter = text.match(/(\d+)\s*\/\s*(\d+)\s+labell?ed/i);
    if (!counter || Number(counter[1]) < Number(counter[2]) || Number(counter[2]) === 0) return false;
    return [...document.querySelectorAll('button,[role="button"],input[type="submit"]')].some((node) => {
      const label = norm(node.innerText || node.value || '');
      const disabled = Boolean(node.disabled) || node.getAttribute('aria-disabled') === 'true';
      return /^Submitted$/i.test(label) && disabled;
    });
  }).catch(() => false);
}

async function completeActorPostProcessing(page, config, artifacts, actorLabel, labelText = config.run.scenarioFoundation.topic.workflow.factStatementLabel) {
  await assertNoBlockingStageFailure(page, artifacts, `${actorLabel} post-processing`);
  // Discussion Details does not auto-advance: it parks on a status list with a
  // "Next: <step>" link, and the step page only opens when that link is clicked. Without this
  // the wait below polls for a step screen that will never appear on its own (CG-0004).
  // The page can arrive here still on the dashboard — a resumed run logs in
  // fresh, and a hand-off can land there too. The dashboard carries no step
  // links, so openPendingWorkflowStep would find nothing and the wait below
  // would poll it forever (CG-0098, resumed at participant_facts). Open the
  // case first so the pending step is reachable.
  if (isDashboardPage(page.url(), await readVisibleBodyText(page))) {
    const opened = await openCaseDetailsFromDashboard(page, artifacts.case, config.run.caseType)
      .then(() => true).catch(() => false);
    if (opened) {
      await waitForIdle(page);
      console.log(`[workflow] ${actorLabel}: opened ${artifacts.case?.commonGroundId ?? 'the case'} from the dashboard before resolving the pending step.`);
    }
  }
  await openPendingWorkflowStep(page);

  // Nothing left for this actor: every one of their steps in the status list is already
  // complete and the case is waiting on the other party. The wait below would poll the full
  // postCompletionWaitMs for a step screen that will never appear — which is exactly what
  // CG-0004 did once its clarify step finished and "Next:" moved to "Esha rates your
  // supporting statements".
  const ownStatus = (await readWorkflowStatusList(page).catch(() => []))
    .filter((row) => row.person === 'you');
  if (ownStatus.length >= WORKFLOW_STATUS_STEPS.length && ownStatus.every((row) => row.status === 'complete')) {
    const summary = ownStatus.map((row) => row.label).join(', ');
    console.log(`[workflow] ${actorLabel}: every own post-processing step is already complete (${summary}); moving on.`);
    recordStage(artifacts, `${actorLabel} Post-Processing`, 'passed', `Already complete on the live case: ${summary}.`);
    return;
  }

  const firstState = await waitForWorkflowState(page, config, {
    name: `${actorLabel.toLowerCase()} clarify context, missing perspective, excerpt review or fact statement labeling`,
    ready: (text, currentPage) => clarifyContextReady(text, currentPage.url())
      || missingPerspectiveReady(text, currentPage.url())
      || excerptReviewReady(text, currentPage.url())
      || factLabelingReady(text, currentPage.url())
  });

  // "Add Helpful Details" / "Clarify & Improve" (route /clarify-context) sits between the
  // interview and Excerpt Review, on BOTH actors' sides. It must be COMPLETED, not merely
  // navigated away from: the case Status list keeps it "in progress" until it is submitted,
  // and the Alignment Brief never unlocks. We complete it by skipping each prompt.
  if (clarifyContextReady(await readVisibleBodyText(page), page.url())) {
    recordStage(artifacts, `${actorLabel} Clarify Context`, 'started', firstState.url);
    const outcome = await skipClarifyContext(page, config, actorLabel);
    if (outcome.completed) {
      console.log(`[clarify-context] ${actorLabel}: step submitted and confirmed complete (${outcome.work || 'nothing to resolve'}).`);
      recordStage(
        artifacts,
        `${actorLabel} Clarify Context`,
        'passed',
        `Submit & Continue clicked and the step completed (${outcome.work || 'nothing to resolve'}).`
      );
    } else {
      // Stop here. Previously this fell back to the Excerpt Review tab, which moved the browser
      // on without completing the step; the case then stalled downstream with an unrelated-
      // looking symptom (CG-0004). The dump names every card still unresolved.
      const unresolvedSummary = outcome.unresolved.length
        ? outcome.unresolved.map((card) => `${card.heading} [controls: ${card.controls.map((c) => c.label + (c.disabled ? '(disabled)' : '')).join(', ') || 'none'}]`).join('; ')
        : 'none detected';
      await failStage(
        page,
        artifacts,
        `${actorLabel} Clarify Context`,
        `"Submit & Continue" did not complete the step (button ${outcome.submission.lastState} after `
          + `${outcome.submission.clicks} click(s), ${Math.round(outcome.submission.elapsedMs / 1000)}s). `
          + `${outcome.unresolved.length} of ${outcome.cardCount} card(s) unresolved: ${unresolvedSummary}.`,
        { extra: { work: outcome.work, submission: outcome.submission, unresolved: outcome.unresolved, contextItems: outcome.contextItems } }
      );
    }
    await waitForWorkflowState(page, config, {
      name: `${actorLabel.toLowerCase()} missing perspective, excerpt review or fact statement labeling`,
      ready: (text, currentPage) => missingPerspectiveReady(text, currentPage.url())
        || excerptReviewReady(text, currentPage.url())
        || factLabelingReady(text, currentPage.url())
    });
  }

  // "Add Missing Perspective" follows Clarify & Improve when the mediator found
  // details the other party raised that this actor never covered.
  if (missingPerspectiveReady(await readVisibleBodyText(page), page.url())) {
    await completeMissingPerspectiveStep(page, artifacts, actorLabel);
    await waitForWorkflowState(page, config, {
      name: `${actorLabel.toLowerCase()} excerpt review or fact statement labeling`,
      ready: (text, currentPage) => excerptReviewReady(text, currentPage.url()) || factLabelingReady(text, currentPage.url())
    });
  }

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

function clarifyContextReady(text, url = '') {
  const value = String(text ?? '');
  const currentUrl = String(url ?? '');
  // Never mistake it for the neighbouring steps: Excerpt Review uses an "approved"
  // counter + bare "Submit"; Clarify Context uses a "reviewed" counter + "Submit & Continue".
  if (excerptReviewReady(value, url) || factLabelingReady(value, url)) return false;
  if (/\/clarify-context(?:[/?#]|$)/i.test(currentUrl)) return true;
  // Staging renamed this step: "Clarify Context" -> "Clarify & Improve" in the tab strip
  // and "Add Helpful Details" in the case Status list, and replaced the "N/M reviewed"
  // counter with numbered "Helpful Detail N" cards. Match old and new wording.
  const stepHeading = /\bClarify Context\b|\bClarify\s*&\s*Improve\b|\bAdd Helpful Details?\b|\bHelpful Detail\s*\d+\b/i.test(value);
  return stepHeading
    && /\bSubmit\s*&?\s*Continue\b/i.test(value)
    && (/(\d+)\s*\/\s*(\d+)\s+reviewed/i.test(value) || /\bHelpful Detail\s*\d+\b/i.test(value));
}

function extractExcerptApprovalCount(text) {
  const match = String(text ?? '').match(/(\d+)\s*\/\s*(\d+)\s+approved/i);
  if (!match) return null;
  return { approved: Number(match[1]), total: Number(match[2]) };
}

// Complete the "Add Helpful Details" / "Clarify & Improve" step WITHOUT answering any of
// its prompts (answering would invent content and alter the synthetic test data).
//
// The redesigned screen lists numbered "Helpful Detail N" cards, each with a textarea, a
// Skip button, and a Save Detail button that stays disabled until text is typed.
// "Submit & Continue" does not complete the step until every card has been skipped or
// saved — so the old "click Submit & Continue, else jump to the Excerpt Review tab"
// approach left the step permanently in progress ("Rabia adds helpful details" never
// ticked), and the case could never reach the Alignment Brief. Skip every card first.
//
// Returns the path taken for logging.
async function skipClarifyContext(page, config, actorLabel = 'actor') {
  // Wait for the step to actually RENDER before touching it. clarifyContextReady() is true as
  // soon as the URL is /clarify-context, which happens long before the cards exist: the
  // CG-0004 dump caught this page still showing "Loading…", so the Skip sweep found nothing,
  // no Context Item was seen and Submit & Continue did not exist — the step was then reported
  // unsubmittable when it had simply never been read.
  const rendered = await waitForClarifyStepRendered(page);
  if (!rendered) console.warn('[clarify-context] Step did not render within the wait; continuing so the failure carries a dump of what is on screen.');

  const skipped = await skipAllHelpfulDetails(page);
  // Context Item cards are a SECOND card type on this step and are not covered by the Skip
  // sweep above; resolve them before testing Submit & Continue.
  const contextItems = await resolveContextItems(page);
  // Resolving a Context Item re-renders the list and can reveal Helpful Detail cards that
  // were not actionable on the first sweep.
  const skippedAgain = contextItems.accepted + contextItems.dismissed > 0
    ? await skipAllHelpfulDetails(page)
    : 0;
  const work = describeClarifyWork(skipped + skippedAgain, contextItems);

  // The step is only COMPLETE once "Submit & Continue" has been clicked and the page has
  // actually left the clarify step. Skipping/saving the cards alone leaves it in progress, and
  // everything downstream (excerpt review, fact rating, alignment brief) waits on it forever.
  const submission = await submitClarifyContext(page);
  const cards = await readClarifyCards(page).catch(() => []);
  const unresolved = cards.filter((card) => !card.resolved);

  return {
    completed: submission.completed,
    work,
    contextItems,
    unresolved,
    submission,
    cardCount: cards.length
  };
}

// Step pages reachable from the Discussion Details status list via its "Next: <step>" link.
const PENDING_STEP_LINKS = [
  { name: /Add Helpful Details/i, route: /\/clarify-context/i },
  { name: /Add Missing Perspective/i, route: /\/missing-perspective/i },
  { name: /Confirm Your Additions/i, route: /\/(?:confirm-additions|new-evidence)/i },
  { name: /Review Your Excerpts/i, route: /\/excerpt-review/i },
  { name: /Rate (?:Your|[\w'’-]+'?s) Supporting Statements/i, route: /\/(?:fact-review|cross-rate)/i }
];

function missingPerspectiveReady(text, url = '') {
  const value = String(text ?? '');
  if (/\/missing-perspective(?:[/?#]|$)/i.test(String(url ?? ''))) return true;
  return /Missing Perspective Item\s*\d+/i.test(value) || /Nothing to add here/i.test(value);
}

// Leave the Add Missing Perspective step by whichever affordance the current
// variant offers. The step has three presentations and only the first carries a
// Continue button, so a single hard-coded exit strands the run on the others.
// Returns a short label naming the exit used.
async function leaveMissingPerspectiveStep(page) {
  for (const [label, locator] of [
    ['Continue', page.getByRole('button', { name: /^Continue$/i }).first()],
    ['the Excerpt Review tab', page.getByRole('button', { name: /^Excerpt Review$/i }).first()],
    ['the Excerpt Review link', page.getByRole('link', { name: /^Excerpt Review$/i }).first()]
  ]) {
    if (!await locator.isVisible({ timeout: 1500 }).catch(() => false)) continue;
    if (!await locator.isEnabled({ timeout: 500 }).catch(() => false)) continue;
    if (!await locator.click({ timeout: 5000 }).then(() => true).catch(() => false)) continue;
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500);
    return label;
  }
  // Last resort: navigate directly, so a missing tab strip cannot strand the run.
  const direct = page.url().replace(/\/missing-perspective(?:[/?#].*)?$/i, '/excerpt-review');
  if (direct !== page.url()) {
    await page.goto(direct, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1500);
    return 'a direct URL';
  }
  return 'no available exit';
}

// "Add Missing Perspective" (route /missing-perspective) sits between Clarify &
// Improve and Excerpt Review for the participant, and opens the requestor's
// return visit before cross-rating. Cards are completed without inventing
// content: answer "I Don't Know" (recorded by the app as
// no_perspective_provided — per spec never treated as disagreement), then
// Submit. Three presentations exist: "Waiting for the other party" (not yet
// actionable), a zero-item state (either "Nothing to add here" with a Continue
// button, or the populated layout showing "0/0 reviewed" with no control at
// all), and real cards. Only the cards state has a Submit.
async function completeMissingPerspectiveStep(page, artifacts, actorLabel) {
  const deadline = Date.now() + 45000;
  let mode = null;
  while (Date.now() < deadline && !mode) {
    await dismissTourOverlay(page, `${actorLabel} missing perspective`);
    const text = await readVisibleBodyText(page);
    const reviewedCounter = text.match(/(\d+)\s*\/\s*(\d+)\s+reviewed/i);
    if (/Waiting for the other party/i.test(text)) mode = 'waiting';
    else if (/Nothing to add here/i.test(text)) mode = 'empty';
    // The prompt header can render with a 0/0 counter and no cards or Submit
    // control — a zero-item step wearing the populated layout (CG-0087). It is
    // the empty state in substance, so treat it as such instead of matching
    // 'cards' on the counter alone and then finding nothing to click.
    else if (reviewedCounter && reviewedCounter[2] === '0') mode = 'empty';
    else if (/Missing Perspective Item\s*\d+/i.test(text)
      || (/\/missing-perspective(?:[/?#]|$)/i.test(page.url()) && reviewedCounter)) mode = 'cards';
    else await page.waitForTimeout(1000);
  }

  if (mode === 'waiting') {
    // Not actionable for this actor yet: the comparison needs the other
    // party's submitted review first. Leave via the tab strip so the actor's
    // own remaining steps (Excerpt Review onward) can proceed; the
    // cross-rating wait retries this step once it becomes ready.
    console.log(`[missing-perspective] ${actorLabel}: waiting on the other party; leaving the step for later.`);
    await leaveMissingPerspectiveStep(page);
    return { handled: false, mode };
  }

  if (mode === 'empty') {
    // Leave the step by whichever affordance this variant offers: the empty
    // state has Continue, the 0/0 variant has neither Continue nor Submit and
    // must be left via the tab strip, or the run stalls here (CG-0087).
    const left = await leaveMissingPerspectiveStep(page);
    console.log(`[missing-perspective] ${actorLabel}: zero items; left the step via ${left}.`);
    artifacts?.softAssertions?.push({
      type: 'missing_perspective_empty_state_unsubmittable',
      passed: false,
      expected: 'A zero-item Add Missing Perspective step completes (or auto-completes) so the workflow can advance.',
      observed: `The zero-item step exposes no submit affordance (exited via ${left}); it relies on the backend auto-completing zero-item builds, otherwise the stage stays pending and gates cross-rating and the Alignment Brief.`
    });
    recordStage(artifacts, `${actorLabel} Missing Perspective`, 'passed', `Nothing to add (zero items); left via ${left}.`);
    return { handled: true, mode };
  }

  if (mode === 'cards') {
    recordStage(artifacts, `${actorLabel} Missing Perspective`, 'started');
    let declined = 0;
    // Spec caps items at 10; each "I Don't Know" disables after tapping.
    for (let round = 0; round < 15; round += 1) {
      const buttons = await page.getByRole('button', { name: /I Don'?t Know/i }).all();
      let clicked = false;
      for (const button of buttons) {
        if (!await button.isVisible().catch(() => false)) continue;
        if (!await button.isEnabled().catch(() => false)) continue;
        await button.scrollIntoViewIfNeeded().catch(() => {});
        if (await button.click({ timeout: 5000 }).then(() => true).catch(() => false)) {
          declined += 1;
          clicked = true;
          await page.waitForTimeout(600);
          break;
        }
      }
      if (!clicked) break;
    }
    const submit = page.getByRole('button', { name: /^Submit$/i }).first();
    let submitted = false;
    if (await submit.isVisible({ timeout: 2000 }).catch(() => false)
      && await submit.isEnabled({ timeout: 1000 }).catch(() => false)) {
      submitted = await submit.click({ timeout: 10000 }).then(() => true).catch(() => false);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(2000);
    }
    // Never claim a submit that did not happen, and never leave the run parked
    // on this step: if Submit was absent or the page stayed put, leave via the
    // tab strip so the following steps can proceed.
    const stillHere = /\/missing-perspective(?:[/?#]|$)/i.test(page.url());
    const exit = stillHere ? await leaveMissingPerspectiveStep(page) : 'submit';
    const detail = `${declined} item(s) answered "I Don't Know"; ${submitted ? 'submitted' : 'no Submit control was available'}`
      + `${stillHere ? `, left the step via ${exit}` : ''}.`;
    console.log(`[missing-perspective] ${actorLabel}: ${detail}`);
    if (!submitted) {
      artifacts?.softAssertions?.push({
        type: 'missing_perspective_not_submitted',
        passed: false,
        expected: 'The Add Missing Perspective step offers a Submit control once its items are answered.',
        observed: `${declined} item(s) answered but no enabled Submit control was present at ${page.url()}; the tool left via ${exit}.`
      });
    }
    recordStage(artifacts, `${actorLabel} Missing Perspective`, 'passed', detail);
    return { handled: true, mode, declined, submitted };
  }

  const slug = String(actorLabel ?? 'actor').toLowerCase().replace(/\s+/g, '-');
  if (activeRunDir) {
    await page.screenshot({ path: `${activeRunDir}/missing-perspective-unrecognized-${slug}.png`, fullPage: true }).catch(() => {});
  }
  artifacts?.softAssertions?.push({
    type: 'missing_perspective_unrecognized',
    passed: false,
    expected: 'The Add Missing Perspective step renders cards or its empty state.',
    observed: `Neither cards nor "Nothing to add here" appeared within 45s at ${page.url()}.`
  });
  return { handled: false, mode: 'unrecognized' };
}

// "Confirm Your Additions" sits between Missing Perspective and Rate the Other
// Party's Statements on the requestor's return visit: perspectives they saved
// become new evidence they must confirm, because unlike the participant they
// have already finished Excerpt Review and would otherwise never see it.
//
// It renders even when there is nothing to confirm (every item answered "I
// Don't Know" produces zero new evidence) and still requires an explicit
// Continue. Skipping it leaves the rating step 409-gated, so the cross-rating
// wait just refreshes until it times out — observed on CG-0088, where the step
// had to be cleared by hand.
async function completeConfirmAdditionsIfPresent(page, artifacts, actorLabel) {
  const text = await readVisibleBodyText(page);
  // "Confirm Your Additions" is ALSO a row label in the case detail page's
  // status list, so matching the phrase alone finds the tracker rather than the
  // step (CG-0089: it matched on the detail page, found no controls, and
  // recorded a failure that blocked the Alignment Report). Require the step's
  // own route, or a page that is not the detail page.
  const onStepRoute = /\/(?:confirm-additions|new-evidence)(?:[/?#]|$)/i.test(page.url());
  const onCaseDetail = /Discussion Details/i.test(text);
  if (!onStepRoute && (onCaseDetail || !/Confirm Your Additions/i.test(text))) {
    return { handled: false, mode: 'absent' };
  }

  // Confirm each pending addition first; the step will not advance while any
  // remain. Nothing is invented — these are the user's own saved words.
  let confirmed = 0;
  for (let round = 0; round < 15; round += 1) {
    const buttons = await page.getByRole('button', { name: /^(?:Confirm|Approve|Looks Good)$/i }).all();
    let clicked = false;
    for (const button of buttons) {
      if (!await clickWhenActionable(button)) continue;
      confirmed += 1;
      clicked = true;
      await page.waitForTimeout(700);
      break;
    }
    if (!clicked) break;
  }

  let advanced = false;
  for (const name of [/^Continue$/i, /^Submit(?:\s*&?\s*Continue)?$/i, /^Done$/i]) {
    const control = page.getByRole('button', { name }).first();
    if (!await clickWhenActionable(control)) continue;
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);
    advanced = true;
    break;
  }

  const detail = `${confirmed} addition(s) confirmed; ${advanced ? 'continued past the step' : 'no Continue control was available'}.`;
  console.log(`[confirm-additions] ${actorLabel}: ${detail}`);
  if (!advanced) {
    // Recorded as a soft assertion, never a failed stage: this step is
    // conditional (it only appears when saved perspectives became new
    // evidence), and a failed stage here blocks the Alignment Report through
    // assertNoBlockingStageFailure even when the rating step proceeds fine.
    artifacts?.softAssertions?.push({
      type: 'confirm_additions_not_advanced',
      passed: false,
      expected: 'The Confirm Your Additions step offers a Continue control so the workflow can reach the rating step.',
      observed: `No enabled Continue control was found at ${page.url()} after confirming ${confirmed} addition(s).`
    });
    return { handled: false, confirmed };
  }
  recordStage(artifacts, `${actorLabel} Confirm Additions`, 'passed', detail);
  return { handled: true, confirmed };
}

// Open and complete the Missing Perspective step when the current page offers
// it (its tab/link, or already on its route). Returns { handled: false } when
// the step is not reachable from here.
async function completeMissingPerspectiveIfPresent(page, artifacts, actorLabel) {
  if (!/\/missing-perspective(?:[/?#]|$)/i.test(page.url())) {
    let opened = false;
    for (const role of ['link', 'button']) {
      const control = page.getByRole(role, { name: /Add Missing Perspective/i }).first();
      if (!await control.isVisible({ timeout: 750 }).catch(() => false)) continue;
      if (!await control.isEnabled({ timeout: 500 }).catch(() => false)) continue;
      await control.scrollIntoViewIfNeeded().catch(() => {});
      if (!await control.click({ timeout: 5000 }).then(() => true).catch(() => false)) continue;
      opened = true;
      break;
    }
    if (!opened) return { handled: false, mode: 'absent' };
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);
  }
  return completeMissingPerspectiveStep(page, artifacts, actorLabel);
}

// On the case detail page, open the step the app says is next. No-op when already on a step
// route, so it is safe to call before any post-processing wait.
async function openPendingWorkflowStep(page) {
  const url = page.url();
  if (PENDING_STEP_LINKS.some((step) => step.route.test(url))) return false;

  for (const step of PENDING_STEP_LINKS) {
    for (const role of ['link', 'button']) {
      const control = page.getByRole(role, { name: step.name }).first();
      if (!await control.isVisible({ timeout: 750 }).catch(() => false)) continue;
      if (!await control.isEnabled({ timeout: 500 }).catch(() => false)) continue;
      await control.scrollIntoViewIfNeeded().catch(() => {});
      if (!await control.click({ timeout: 5000 }).then(() => true).catch(() => false)) continue;
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(2500);
      console.log(`[workflow] Opened the pending step via its "${step.name.source.replace(/\\/g, '')}" link → ${page.url()}`);
      return true;
    }
  }
  return false;
}

// Poll until the clarify step's own UI is on screen — a card, the "N/M reviewed" counter, or
// the Submit & Continue button — and the page is not still a bare "Loading…" shell.
// Returns what it found, or null if the step never rendered in time.
async function waitForClarifyStepRendered(page, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await dismissTourOverlay(page, 'clarify step render');
    last = await page.evaluate(() => {
      const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
      const text = norm(document.body?.innerText);
      const hasSubmit = [...document.querySelectorAll('button,[role="button"],input[type="submit"]')]
        .some((node) => /Submit\s*&?\s*Continue/i.test(norm(node.innerText || node.value || '')));
      return {
        hasCards: /(?:Context Item|Helpful Detail)\s*\d+/i.test(text),
        hasCounter: /\d+\s*\/\s*\d+\s+reviewed/i.test(text),
        hasSubmit,
        // A shell that is only chrome + "Loading…" is not the step.
        stillLoading: /\bLoading\b/i.test(text) && text.length < 400,
        textLength: text.length
      };
    }).catch(() => null);

    if (last && !last.stillLoading && (last.hasCards || last.hasCounter || last.hasSubmit)) {
      return last;
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

// Click "Submit & Continue" and confirm the step really completed.
//
// The button stays disabled until every card is skipped or saved, and it can take a moment to
// enable after the last save settles — so poll rather than testing once. Completion is checked
// against the page leaving the clarify step, not against the click appearing to succeed.
async function submitClarifyContext(page, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let clicks = 0;
  let lastState = 'not found';

  while (Date.now() < deadline) {
    const button = page.getByRole('button', { name: /Submit\s*&?\s*Continue/i }).first();
    const visible = await button.isVisible({ timeout: 1000 }).catch(() => false);
    if (!visible) {
      // Already off the step (e.g. a prior click landed) — confirm and finish.
      if (!clarifyContextReady(await readVisibleBodyText(page), page.url())) {
        return { completed: true, clicks, lastState: 'step already left', elapsedMs: Date.now() - startedAt };
      }
      lastState = 'not visible';
      await page.waitForTimeout(2000);
      continue;
    }

    const enabled = await button.isEnabled({ timeout: 500 }).catch(() => false)
      && (await button.getAttribute('aria-disabled').catch(() => null)) !== 'true';
    lastState = enabled ? 'enabled' : 'visible but disabled';

    if (enabled) {
      await button.scrollIntoViewIfNeeded().catch(() => {});
      if (await button.click({ timeout: 5000 }).then(() => true).catch(() => false)) clicks += 1;
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(2500);
      if (!clarifyContextReady(await readVisibleBodyText(page), page.url())) {
        return { completed: true, clicks, lastState: 'submitted', elapsedMs: Date.now() - startedAt };
      }
      lastState = 'clicked but still on the clarify step';
    }

    await page.waitForTimeout(2000);
  }

  return { completed: false, clicks, lastState, elapsedMs: Date.now() - startedAt };
}

// Every card on the step with its resolution state and the controls it exposes.
async function readClarifyCards(page) {
  return page.evaluate(() => {
    const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const ACTIONS = 'button, [role="button"], input[type="submit"], a';
    const describe = (node) => ({
      label: norm(node.innerText || node.value || node.getAttribute('aria-label') || ''),
      disabled: Boolean(node.disabled) || node.getAttribute('aria-disabled') === 'true'
    });
    return [...document.querySelectorAll('*')]
      .filter((node) => {
        const text = norm(node.textContent);
        if (!/^(Context Item|Helpful Detail)\b/i.test(text)) return false;
        return ![...node.children].some((child) => /^(Context Item|Helpful Detail)\b/i.test(norm(child.textContent)));
      })
      .map((node) => {
        let card = node;
        for (let depth = 0; depth < 8 && card?.parentElement; depth += 1) {
          if ([...card.querySelectorAll(ACTIONS)].some((action) => norm(action.innerText))) break;
          card = card.parentElement;
        }
        return {
          heading: norm(node.textContent).slice(0, 80),
          // "Change answer" is the marker the app leaves on a card that has been resolved.
          resolved: /Change answer/i.test(norm(card.innerText)),
          text: norm(card.innerText).slice(0, 400),
          controls: [...card.querySelectorAll(ACTIONS)].map(describe).filter((control) => control.label)
        };
      });
  });
}

function describeClarifyWork(skipped, contextItems) {
  const parts = [];
  if (skipped) parts.push(`skipping ${skipped} helpful detail(s)`);
  if (contextItems.accepted) parts.push(`accepting ${contextItems.accepted} verbatim context item(s)`);
  if (contextItems.dismissed) parts.push(`dismissing ${contextItems.dismissed} context item(s)`);
  if (contextItems.unresolved.length) parts.push(`${contextItems.unresolved.length} context item(s) left unresolved`);
  return parts.join(', ');
}

// Click Skip on every Helpful Detail card. Cards re-render as they resolve, so re-query
// and always act on the first actionable Skip rather than caching an index. Returns how
// many were skipped.
async function skipAllHelpfulDetails(page) {
  const deadline = Date.now() + 120000;
  let skipped = 0;
  while (Date.now() < deadline) {
    await dismissTourOverlay(page, 'add helpful details');
    const buttons = page.getByRole('button', { name: /^\s*Skip\s*$/i });
    const count = await buttons.count().catch(() => 0);
    let clicked = false;
    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index);
      if (!await button.isVisible().catch(() => false)) continue;
      if (!await button.isEnabled().catch(() => false)) continue;
      if ((await button.getAttribute('aria-disabled').catch(() => null)) === 'true') continue;
      await button.scrollIntoViewIfNeeded().catch(() => {});
      if (await button.click({ timeout: 3000 }).then(() => true).catch(() => false)) {
        skipped += 1;
        clicked = true;
        await page.waitForTimeout(250);
        break; // re-query: skipping a card re-renders the list and shifts indices
      }
    }
    if (!clicked) break;
  }
  if (skipped) console.log(`[clarify-context] Skipped ${skipped} helpful detail prompt(s) without inventing content.`);
  return skipped;
}

// Context Item controls, read off the live page: "Accept Suggested" writes the suggestion in,
// "I Don't Know" resolves the card without adding content (the app's own way of declining, and
// exactly what the invent-nothing rule wants). "Save Context" stays disabled until text is
// typed, so it is never used here. The apostrophe is a curly U+2019, hence Don.?t.
const CONTEXT_ITEM_ACCEPT = /^\s*Accept(?:\s+Suggested)?\s*$/i;
const CONTEXT_ITEM_DISMISS = /^\s*(I\s*Don.?t\s*Know|Skip|Dismiss|Reject|Ignore|Decline|No,? thanks|Not accurate|Leave as is)\s*$/i;

// Resolve the OTHER card type on "Clarify & Improve". Context Items are not Helpful Details:
// they flag an unclear reference and offer a pre-filled answer under a "POSSIBLE CONTEXT
// FOUND - ACCEPT ONLY IF ACCURATE" banner, with an Accept button and no plain "Skip". Because
// skipAllHelpfulDetails only clicks controls named exactly "Skip", these cards were never
// touched: the counter sat one short ("14/15 reviewed"), Submit & Continue never activated,
// and the run burned the full post-completion wait on an Excerpt Review that could not arrive
// (run 2026-08-12T10-58-27-194Z, CG-0054).
//
// Accepting a suggestion writes it into the case, so accept ONLY when the suggestion is
// identical to the excerpt already quoted on the card (after normalising quotes, dashes and
// whitespace). That resolves the card while adding no content, which keeps the "invent
// nothing" rule this step is built around. A suggestion that differs is real content we did
// not author, so it is dismissed instead; a card with neither control is left alone and
// reported rather than forced.
async function resolveContextItems(page) {
  const result = { accepted: 0, dismissed: 0, unresolved: [] };
  const attempted = [];
  const deadline = Date.now() + 120000;

  while (Date.now() < deadline) {
    await dismissTourOverlay(page, 'clarify context items');
    const card = await tagNextUnresolvedContextItem(page, attempted);
    if (!card) break;

    // Keyed on the excerpt, not on a DOM handle: the list re-renders after every click, so a
    // card we could not resolve must be remembered by content or the loop re-picks it forever.
    attempted.push(card.excerpt);

    const scope = page.locator('[data-cg-context-item="1"]').first();
    const wanted = card.identical ? CONTEXT_ITEM_ACCEPT : CONTEXT_ITEM_DISMISS;
    const control = scope.getByRole('button', { name: wanted }).first();

    if (await clickWhenActionable(control)) {
      if (card.identical) result.accepted += 1;
      else result.dismissed += 1;
      await page.waitForTimeout(400);
      continue;
    }

    result.unresolved.push({
      excerpt: card.excerpt.slice(0, 160),
      suggestionMatchedExcerpt: card.identical,
      reason: card.identical
        ? 'suggestion matched the excerpt but no actionable Accept control was found'
        : 'suggestion differed from the excerpt and the card offered no dismiss control',
      controls: card.actions
    });
  }

  if (result.accepted || result.dismissed) {
    console.log(`[clarify-context] Resolved ${result.accepted} context item(s) by accepting a verbatim suggestion and ${result.dismissed} by dismissing.`);
  }
  for (const item of result.unresolved) {
    console.log(`[clarify-context] Context item left unresolved - ${item.reason}. Controls: ${item.controls.map((action) => action.label).join(', ') || 'none'}`);
  }
  return result;
}

// Tags the next unresolved Context Item with data-cg-context-item="1" and returns what it
// says. Tagging (rather than returning a handle) keeps the locator valid across the re-render
// that each click triggers; the attribute is cleared on every pass.
async function tagNextUnresolvedContextItem(page, attempted) {
  return page.evaluate((attemptedExcerpts) => {
    const ATTR = 'data-cg-context-item';
    document.querySelectorAll(`[${ATTR}]`).forEach((node) => node.removeAttribute(ATTR));

    const norm = (value) => String(value ?? '')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
    const ACTIONS = 'button, [role="button"], input[type="submit"], a';
    const labelOf = (node) => norm(node.innerText || node.value || node.getAttribute('aria-label') || '');

    // Innermost element naming the card: the card root also starts with "Context Item N", so
    // exclude any element that has a child saying the same thing.
    const headings = Array.from(document.querySelectorAll('*')).filter((node) => {
      if (!/^Context Item\b/i.test(norm(node.textContent))) return false;
      return !Array.from(node.children).some((child) => /^Context Item\b/i.test(norm(child.textContent)));
    });

    for (const heading of headings) {
      let card = null;
      let node = heading;
      for (let depth = 0; depth < 8 && node; depth += 1) {
        const hasBanner = /POSSIBLE CONTEXT FOUND/i.test(node.innerText || '');
        const hasAction = Array.from(node.querySelectorAll(ACTIONS)).some((action) => labelOf(action));
        if (hasBanner && hasAction) { card = node; break; }
        node = node.parentElement;
      }
      if (!card) continue;
      // "Change answer" is the marker the app leaves on a card that has been resolved.
      if (/Change answer/i.test(norm(card.innerText))) continue;

      const actions = Array.from(card.querySelectorAll(ACTIONS))
        .map((action) => ({
          label: labelOf(action),
          disabled: Boolean(action.disabled) || action.getAttribute('aria-disabled') === 'true'
        }))
        .filter((action) => action.label);
      const actionLabels = new Set(actions.map((action) => action.label));

      const lines = String(card.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean);
      const bannerIndex = lines.findIndex((line) => /POSSIBLE CONTEXT FOUND/i.test(line));
      const quoted = lines.slice(0, bannerIndex < 0 ? undefined : bannerIndex).join(' ')
        .match(/[“"]([\s\S]+?)[”"]/);
      const excerpt = norm(quoted ? quoted[1] : '');

      // The suggestion may share a line with the banner or follow it; strip the banner text
      // and drop any line that is just a button label.
      const bannerTail = bannerIndex >= 0
        ? lines[bannerIndex].replace(/^.*ACCEPT ONLY IF ACCURATE/i, '').replace(/^.*POSSIBLE CONTEXT FOUND/i, '')
        : '';
      const suggestion = norm([bannerTail, ...(bannerIndex >= 0 ? lines.slice(bannerIndex + 1) : [])]
        .filter((line) => norm(line) && !actionLabels.has(norm(line)))
        .join(' '));

      if (attemptedExcerpts.includes(excerpt)) continue;

      card.setAttribute(ATTR, '1');
      return {
        excerpt,
        suggestion,
        // Empty excerpt or suggestion must never count as a match - that would accept blind.
        identical: Boolean(excerpt) && Boolean(suggestion) && excerpt === suggestion,
        actions
      };
    }
    return null;
  }, attempted);
}

async function clickWhenActionable(locator) {
  if (!await locator.isVisible({ timeout: 1000 }).catch(() => false)) return false;
  if (!await locator.isEnabled({ timeout: 500 }).catch(() => false)) return false;
  if ((await locator.getAttribute('aria-disabled').catch(() => null)) === 'true') return false;
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  return locator.click({ timeout: 3000 }).then(() => true).catch(() => false);
}

async function submitExcerptReview(page, config) {
  const startedAt = Date.now();
  let deadline = startedAt + config.run.postCompletionWaitMs;
  let lastText = '';
  let lastApprovalCount = null;
  let lastSubmitState = 'not found';
  let gateSince = 0;
  let allApprovedSince = 0;

  while (Date.now() < deadline) {
    lastText = await readVisibleBodyText(page);
    lastApprovalCount = extractExcerptApprovalCount(lastText);

    // Gated on the other actor: the Submit control will never enable in this
    // session, so hand off instead of polling to the full timeout.
    if (otherPartyGate(lastText) && !lastApprovalCount) {
      if (!gateSince) gateSince = Date.now();
      else if (Date.now() - gateSince >= OTHER_PARTY_GATE_CONFIRM_MS) throw new OtherPartyGateError('excerpt review', page.url(), lastText);
    } else {
      gateSince = 0;
    }

    // Still processing → roll the deadline forward so a live processing screen
    // never trips the fixed timeout (a true hang still ends at the original deadline).
    if (isProcessingState(lastText)) {
      deadline = Math.max(deadline, Date.now() + 180000);
    }

    // Approve whatever is still outstanding. The app auto-approves unchanged excerpts, but a
    // REVISED one keeps its own "Approve" button and Submit stays disabled until every one is
    // approved — CG-0007 sat at "30/57 approved" with 27 un-clicked Approve buttons because
    // the only bulk control looked for here was "Approve All", which this page does not have
    // (it offers "Approve Shown").
    if (lastApprovalCount?.total > 0 && lastApprovalCount.approved < lastApprovalCount.total) {
      const approval = await approveOutstandingExcerpts(page);
      console.log(
        `[excerpt-review] Approval pass: ${approval.bulkClicks} bulk click(s), ${approval.singleClicks} individual click(s) → `
        + `${approval.count ? `${approval.count.approved}/${approval.count.total}` : 'counter unreadable'} approved.`
      );
      lastApprovalCount = approval.count ?? lastApprovalCount;
      if (!approval.done) {
        // No further progress possible this pass; fall through so the Submit probe and the
        // loop's own deadline decide, rather than spinning on the same buttons.
        await page.waitForTimeout(1500);
      }
    }

    const submitState = await findExcerptSubmitControl(page);
    lastSubmitState = submitState.description;

    // Already submitted: every excerpt approved and the page exposes no Submit control at all
    // (CG-0004 sat at "75/75 approved" with only nav/tab/filter buttons). Polling for a
    // control that does not exist burned the full postCompletionWaitMs. Confirmed over a
    // short grace so a control that renders late is not missed.
    if (!submitState.control && lastApprovalCount?.total > 0 && lastApprovalCount.approved >= lastApprovalCount.total) {
      if (!allApprovedSince) allApprovedSince = Date.now();
      else if (Date.now() - allApprovedSince >= STEP_ALREADY_DONE_CONFIRM_MS) {
        console.log(`[excerpt-review] ${lastApprovalCount.approved}/${lastApprovalCount.total} approved and no Submit control on the page — the step is already submitted; moving on.`);
        return;
      }
    } else {
      allApprovedSince = 0;
    }

    if (submitState.control) {
      await submitState.control.scrollIntoViewIfNeeded().catch(() => {});
      await submitState.control.click();
      await page.waitForLoadState('networkidle').catch(() => {});
      // Verify the submit actually landed before returning. An approval can
      // silently revert server-side (observed on CG-0075: the bulk pass
      // reported 59/59, the server kept one revised excerpt Unapproved, and
      // the app blocked submission with "All excerpts must be approved before
      // you can submit") — returning on the click alone strands the run one
      // step later with an unrelated-looking timeout.
      const exitDeadline = Date.now() + 20000;
      let blocked = false;
      while (Date.now() < exitDeadline) {
        await page.waitForTimeout(1500);
        const afterText = await readVisibleBodyText(page);
        const afterCount = extractExcerptApprovalCount(afterText);
        if (/must be approved before you can submit/i.test(afterText)
          || (afterCount && afterCount.approved < afterCount.total)) {
          blocked = true;
          break;
        }
        if (!excerptReviewReady(afterText, page.url())) return;
      }
      if (!blocked) return;
      console.log('[excerpt-review] Submit was blocked by an unapproved excerpt; re-running the approval pass.');
      continue;
    }

    await page.waitForTimeout(1000);
  }

  const approvalDescription = lastApprovalCount
    ? `${lastApprovalCount.approved}/${lastApprovalCount.total} approved`
    : 'approval counter not detected';
  const unapproved = await readUnapprovedExcerpts(page);
  const dump = await writeDiagnosticDump(page, 'excerpt-review-not-submitted', {
    approvalState: approvalDescription,
    submitState: lastSubmitState,
    unapprovedCount: unapproved.length,
    unapproved
  });
  throw new Error([
    `Excerpt Review Submit did not become enabled within ${Math.round(config.run.postCompletionWaitMs / 60000)} minutes.`,
    `Elapsed: ${Math.round((Date.now() - startedAt) / 1000)} seconds`,
    `Approval state: ${approvalDescription}`,
    `Submit state: ${lastSubmitState}`,
    `Excerpts still showing an Approve button: ${unapproved.length}${unapproved.length ? ` — ${unapproved.slice(0, 8).map((item) => item.heading).join('; ')}` : ''}`,
    dump ? `Dump: ${dump}` : 'Dump: could not be written.',
    `Current URL: ${page.url()}`,
    `Last visible page text: ${compactVisibleText(lastText, 1800)}`
  ].join('\n'));
}

// Drive the approval counter to full: bulk control first, then per-excerpt "Approve" buttons.
//
// "Approve Shown" acts on whatever the active filter displays, so the pending filter is
// selected first. Progress is measured by the counter, not by clicks: the bulk button stays
// enabled whether or not it did anything, so a few clicks that move nothing means it is not
// applicable here and the per-excerpt path takes over.
async function approveOutstandingExcerpts(page, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  let bulkClicks = 0;
  let singleClicks = 0;
  let lastApproved = -1;
  let stagnant = 0;
  let bulkExhausted = false;

  // Show the outstanding ones so a "shown"-scoped bulk control covers them.
  const pendingFilter = page.getByRole('button', { name: /^(?:Pending Approval|Show What.?s Pending|Revised Only)$/i }).first();
  if (await clickWhenActionable(pendingFilter)) await page.waitForTimeout(2000);

  let count = extractExcerptApprovalCount(await readVisibleBodyText(page));
  while (Date.now() < deadline) {
    count = extractExcerptApprovalCount(await readVisibleBodyText(page));
    if (count?.total > 0 && count.approved >= count.total) {
      return { done: true, bulkClicks, singleClicks, count };
    }

    const approved = count?.approved ?? -1;
    stagnant = approved === lastApproved ? stagnant + 1 : 0;
    lastApproved = approved;
    if (stagnant >= 3) bulkExhausted = true;   // bulk is not moving the counter
    if (stagnant >= 10) break;                 // nothing is moving it

    if (!bulkExhausted) {
      const bulk = page.getByRole('button', { name: /^Approve (?:Shown|All)$/i }).first();
      if (await clickWhenActionable(bulk)) {
        bulkClicks += 1;
        await page.waitForTimeout(2500);
        continue;
      }
      bulkExhausted = true;
    }

    // Per-excerpt fallback. Re-query every pass: approving one re-renders the list.
    const approveButtons = page.getByRole('button', { name: /^Approve$/i });
    const total = await approveButtons.count().catch(() => 0);
    if (!total) { await page.waitForTimeout(1500); continue; }
    let clicked = false;
    for (let index = 0; index < total; index += 1) {
      if (await clickWhenActionable(approveButtons.nth(index))) {
        singleClicks += 1;
        clicked = true;
        await page.waitForTimeout(400);
        break;
      }
    }
    if (!clicked) await page.waitForTimeout(1500);
  }

  count = extractExcerptApprovalCount(await readVisibleBodyText(page));
  return { done: Boolean(count?.total > 0 && count.approved >= count.total), bulkClicks, singleClicks, count };
}

// Excerpt cards still showing an "Approve" button, for the failure dump.
async function readUnapprovedExcerpts(page) {
  return page.evaluate(() => {
    const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const ACTIONS = 'button,[role="button"]';
    return [...document.querySelectorAll(ACTIONS)]
      .filter((node) => /^Approve$/i.test(norm(node.innerText)))
      .map((node) => {
        let card = node;
        for (let depth = 0; depth < 6 && card.parentElement; depth += 1) {
          if (/Excerpt\s*\d+/i.test(norm(card.textContent))) break;
          card = card.parentElement;
        }
        const text = norm(card.textContent);
        return {
          heading: (text.match(/Excerpt\s*\d+[^.]{0,40}/i) || [text.slice(0, 60)])[0],
          approveDisabled: Boolean(node.disabled) || node.getAttribute('aria-disabled') === 'true',
          snippet: text.slice(0, 180)
        };
      })
      .slice(0, 40);
  }).catch(() => []);
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
  let deadline = startedAt + config.run.postCompletionWaitMs;
  let lastText = '';
  let lastUrl = page.url();
  let gateSince = 0;

  while (Date.now() < deadline) {
    await dismissTourOverlay(page, name);
    lastText = await readVisibleBodyText(page);
    lastUrl = page.url();
    if (ready(lastText, page)) return {
      elapsedMs: Date.now() - startedAt,
      url: lastUrl
    };
    // This step is gated on the other actor's progress and will never become ready
    // in this session; bail out (once the gate has persisted) so the caller can hand
    // off rather than polling to the full postCompletionWaitMs timeout.
    if (otherPartyGate(lastText)) {
      if (!gateSince) gateSince = Date.now();
      else if (Date.now() - gateSince >= OTHER_PARTY_GATE_CONFIRM_MS) throw new OtherPartyGateError(name, lastUrl, lastText);
    } else {
      gateSince = 0;
    }
    // While Common Ground is visibly still processing (e.g. "Processing your
    // responses... 70% complete"), roll the deadline forward so an active
    // processing screen never trips the fixed post-processing timeout — mirroring
    // waitForInterviewReady. A true hang (processing text gone, still not ready)
    // still ends at the original deadline.
    if (isProcessingState(lastText)) {
      deadline = Math.max(deadline, Date.now() + 180000);
    }
    await page.waitForTimeout(3000);
  }

  throw new Error([
    `${name} did not become available within ${Math.round(config.run.postCompletionWaitMs / 60000)} minutes.`,
    `Elapsed: ${Math.round((Date.now() - startedAt) / 1000)} seconds`,
    `Current URL: ${lastUrl}`,
    `Last visible page text: ${compactVisibleText(lastText, 1800)}`
  ].join('\n'));
}

// The /fact-review route renders before the statements themselves exist: Common Ground
// shows the "Rate your Confidence" chrome with a "Generating your statements… Hang
// tight." placeholder while it builds them from the submitted excerpts. The chrome alone
// satisfied the URL + keyword test below, so labeling started against a page with zero
// rating controls. Treat the placeholder as explicitly not-ready.
function factStatementsGenerating(text) {
  const value = String(text ?? '');
  return /generating your statements|statements? (?:are|is) (?:still )?being generated|this runs after you submit your excerpts/i.test(value)
    || (/\bhang tight\b/i.test(value) && /\bstatements?\b/i.test(value));
}

function factLabelingReady(text, url = '') {
  const value = String(text ?? '');
  const currentUrl = String(url ?? '');
  if (/\/get-started(?:[/?#]|$)/i.test(currentUrl)) return false;
  if (excerptReviewReady(value, url)) return false;
  if (factStatementsGenerating(value)) return false;
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

async function completeParticipantFactReview(page, config, createdCase, labelText, artifacts = null) {
  return completeCrossPartyFactReview(page, config, createdCase, labelText, {
    raterRole: 'participant',
    ratedParty: 'requestor',
    linkText: /Rate Request[eo]r'?s Facts/i,
    mode: 'participant_rates_requestor',
    allowGettingStartedReady: true,
    artifacts
  });
}

// The Discussion Details "status list" steps, in the order Common Ground runs them. Matching
// is by the phrase each row uses ("Atika adds helpful details"), so the person's name is
// whatever precedes it.
// Each step appears twice in the list: once for the signed-in user in imperative form
// ("Add Helpful Details") and once per other party in third person ("Esha adds helpful
// details"). Verified against the live CG-0004 Discussion Details markup — an earlier guess
// at these labels matched only the third-person form and missed every own-party row.
const WORKFLOW_STATUS_STEPS = [
  { key: 'share_perspective', own: /^share your perspective$/i, other: /\bshares? their perspective$/i },
  { key: 'helpful_details', own: /^add helpful details$/i, other: /\badds? helpful details$/i },
  { key: 'excerpt_review', own: /^review your excerpts$/i, other: /\breviews? their excerpts$/i },
  { key: 'fact_rating', own: /^rate your supporting statements$/i, other: /\brates? their supporting statements$/i }
];

// Read the status list as ordered rows with a best-effort status per row.
//
// NOTE: staging renders status as an icon, not text, so the signals below (aria-busy, spinner
// classes, check glyphs, "complete"/"in progress" wording) are deliberately broad and any row
// that matches none is reported 'unknown' — an unknown row never drives a decision. The
// failure dump written by captureStatusListDump records the real markup so these can be
// tightened against it.
async function readWorkflowStatusList(page) {
  const steps = WORKFLOW_STATUS_STEPS.map((step) => ({
    key: step.key,
    own: { source: step.own.source, flags: step.own.flags },
    other: { source: step.other.source, flags: step.other.flags }
  }));
  return page.evaluate((stepDefs) => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const patterns = stepDefs.flatMap((def) => [
      { key: def.key, scope: 'own', re: new RegExp(def.own.source, def.own.flags) },
      { key: def.key, scope: 'other', re: new RegExp(def.other.source, def.other.flags) }
    ]);

    // Status is conveyed purely by the row's icon; there is no status text anywhere. Read the
    // SVG path data, which is stable and semantic, with class hints as a secondary signal:
    //   complete    check    path "M5 13l4 4L19 7", icon chip bg-cg-blue + text-white
    //   in-progress spinner  class motion-safe:animate-spin on a dashed circle
    //   pending     clock    path "M12 8v4l3 2", row faded via text-cg-blue/50
    const statusOf = (html, text) => {
      if (/animate-spin|aria-busy="true"|role="status"/i.test(html)) return 'in-progress';
      if (/M5 13l4 4L19 7/.test(html)) return 'complete';
      if (/M12 8v4l3 2/.test(html) || /text-cg-blue\/50/.test(html)) return 'pending';
      if (/\bin[- ]progress\b/i.test(text)) return 'in-progress';
      if (/\bcomplete(?:d)?\b|\bdone\b/i.test(text) || /[\u2713\u2714]/.test(text)) return 'complete';
      return 'unknown';
    };

    const rows = [];
    const claimed = new Set();

    for (const pattern of patterns) {
      const labelNodes = [...document.querySelectorAll('li,div,span,p')]
        .filter((node) => pattern.re.test(norm(node.textContent)))
        .filter((node) => ![...node.children].some((child) => pattern.re.test(norm(child.textContent))));

      for (const labelNode of labelNodes) {
        if (claimed.has(labelNode)) continue;
        claimed.add(labelNode);

        // Widen to the row: the nearest ancestor that carries the icon, bounded by length so
        // it can never swallow a sibling row.
        let row = labelNode;
        for (let depth = 0; depth < 5 && row.parentElement; depth += 1) {
          if (/<svg/i.test(row.innerHTML || '') && norm(row.textContent).length <= 120) break;
          if (norm(row.parentElement.textContent).length > 120) break;
          row = row.parentElement;
        }

        const label = norm(labelNode.textContent).slice(0, 120);
        rows.push({
          key: pattern.key,
          label,
          status: statusOf(row.outerHTML || '', norm(row.textContent)),
          // Own rows are imperative and name nobody; third-person rows lead with the name.
          person: pattern.scope === 'own' ? 'you' : (label.match(/^([A-Z][\w'\u2019-]*)\b/) || [])[1] || 'other'
        });
      }
    }
    return rows;
  }, steps);
}

// The inconsistency this guards against: Common Ground can leave an earlier step spinning
// while later steps in the SAME person's list are already complete. The earlier step then
// never flips, so any wait gated on it polls until it times out. A later completed step is
// proof the earlier one has effectively been passed, whatever its spinner says.
function findOutOfOrderStatus(rows) {
  const order = WORKFLOW_STATUS_STEPS.map((step) => step.key);
  const byPerson = new Map();
  for (const row of rows) {
    const key = row.person || '(unnamed)';
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key).push(row);
  }

  for (const [person, personRows] of byPerson) {
    const sorted = [...personRows].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    for (let index = 0; index < sorted.length; index += 1) {
      const stalled = sorted[index];
      if (stalled.status !== 'in-progress') continue;
      const laterComplete = sorted.slice(index + 1).find((row) => row.status === 'complete');
      if (laterComplete) return { person, stalled, laterComplete };
    }
  }
  return null;
}

// Write the evidence needed to fix a stuck status list: screenshot, DOM, and the parsed rows
// (so a wrong parse is visible next to the markup that produced it).
async function captureStatusListDump(page, label, rows, extra = {}) {
  const slug = String(label ?? 'wait').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const base = `${activeRunDir ?? '.'}/status-list-stuck-${slug}`;
  const written = [];
  if (await page.screenshot({ path: `${base}.png`, fullPage: true }).then(() => true).catch(() => false)) written.push('png');
  const html = await page.content().catch(() => null);
  if (html !== null && await writeFile(`${base}.html`, html, 'utf8').then(() => true).catch(() => false)) written.push('html');
  const report = {
    label,
    capturedAt: new Date().toISOString(),
    url: page.url(),
    parsedRows: rows,
    ...extra
  };
  if (await writeFile(`${base}.json`, JSON.stringify(report, null, 2), 'utf8').then(() => true).catch(() => false)) written.push('json');
  return written.length ? `status-list-stuck-${slug}.{${written.join(',')}}` : '';
}

// Refresh budget for a wait that reloads the case page while polling. Bounded independently of
// the time deadline so a page that reloads cleanly but never advances fails with a dump
// instead of grinding out the full postCompletionWaitMs.
const MAX_STATUS_REFRESHES = 24;

async function completeCrossPartyFactReview(page, config, createdCase, labelText, options) {
  const startedAt = Date.now();
  const waitName = `${capitalizeFirst(options.raterRole)} rating of ${options.ratedParty} facts`;
  // A step this wait depends on may already have failed; polling would never resolve.
  await assertNoBlockingStageFailure(page, options.artifacts, waitName);
  let deadline = startedAt + config.run.postCompletionWaitMs;
  let lastText = '';
  let lastUrl = page.url();
  let lastRefreshAt = 0;
  let gateSince = 0;
  let refreshes = 0;
  let lastRows = [];
  // The requestor's return visit opens with their own Add Missing Perspective
  // step (+ Confirm Additions when they saved perspectives); the rating stays
  // 409-gated until it is done. Attempt it once from this wait.
  let missingPerspectiveAttempted = false;

  while (Date.now() < deadline) {
    lastText = await readVisibleBodyText(page);
    lastUrl = page.url();

    if (factLabelingReady(lastText, lastUrl)) {
      await labelFactStatements(page, config, labelText);
      return;
    }

    if (!missingPerspectiveAttempted) {
      const mpOutcome = await completeMissingPerspectiveIfPresent(page, options.artifacts, capitalizeFirst(options.raterRole ?? 'actor'));
      // Only a completed step ends the attempts. 'waiting' (other party not
      // done) and 'absent' must retry on later passes — the step becomes
      // ready mid-wait once the counterparty submits their review.
      if (mpOutcome.mode === 'empty' || mpOutcome.mode === 'cards') missingPerspectiveAttempted = true;
      if (mpOutcome.handled) {
        await page.waitForTimeout(1500);
        continue;
      }
    }

    // Interposed between Missing Perspective and the rating step; it can appear
    // on any pass (right after the MP submit), so it is checked every time
    // rather than latched like the MP attempt above.
    if ((await completeConfirmAdditionsIfPresent(page, options.artifacts, capitalizeFirst(options.raterRole ?? 'actor'))).handled) {
      await page.waitForTimeout(1500);
      continue;
    }

    // Do not gate on one step's spinner. Common Ground can leave an earlier step in progress
    // while later steps for the same person are already complete (CG-0004: "Atika adds helpful
    // details" spinning behind a completed "reviews their excerpts" and "rates their supporting
    // statements"). The step never flips, so polling for it just reloads until the timeout.
    // Treat a later completed step as proof the earlier one is done and stop waiting.
    lastRows = await readWorkflowStatusList(page).catch(() => []);
    const outOfOrder = findOutOfOrderStatus(lastRows);
    if (outOfOrder) {
      const detail = `"${outOfOrder.stalled.label}" is still in progress while the later step `
        + `"${outOfOrder.laterComplete.label}" is already complete`;
      console.warn(`[status-list] ${waitName}: ${detail}. Treating the earlier step as done and moving on.`);
      options.artifacts?.softAssertions?.push({
        type: 'status_list_out_of_order',
        passed: false,
        expected: 'Discussion Details steps complete in order.',
        observed: `${detail}. The tool stopped waiting on the earlier step and continued.`
      });
      return;
    }

    // Gated on the other actor: this rating will never become available in this
    // session; throw so the caller can hand off instead of polling to the full
    // timeout. Confirmed over OTHER_PARTY_GATE_CONFIRM_MS to ignore transient frames.
    if (otherPartyGate(lastText)) {
      if (!gateSince) gateSince = Date.now();
      else if (Date.now() - gateSince >= OTHER_PARTY_GATE_CONFIRM_MS) {
        throw new OtherPartyGateError(`${capitalizeFirst(options.raterRole)} rating of ${options.ratedParty} facts`, lastUrl, lastText);
      }
    } else {
      gateSince = 0;
    }

    // Still processing → roll the deadline forward so a live processing screen
    // never trips the fixed timeout (a true hang still ends at the original deadline).
    if (isProcessingState(lastText)) {
      deadline = Math.max(deadline, Date.now() + 180000);
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
      if (refreshes >= MAX_STATUS_REFRESHES) {
        const dump = await captureStatusListDump(page, waitName, lastRows, {
          refreshes,
          elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
          visibleText: compactVisibleText(lastText, 4000)
        });
        throw new Error([
          `${waitName} did not become available after ${refreshes} page refreshes.`,
          `Elapsed: ${Math.round((Date.now() - startedAt) / 1000)} seconds (refresh cap reached before the ${Math.round(config.run.postCompletionWaitMs / 60000)}-minute timeout).`,
          `Status list rows parsed: ${lastRows.length ? lastRows.map((row) => `${row.label} [${row.status}]`).join(' | ') : 'none recognised'}`,
          dump ? `Dump: ${dump}` : 'Dump: could not be written.',
          `Current URL: ${lastUrl}`,
          `Last visible page text: ${compactVisibleText(lastText, 1800)}`
        ].join('\n'));
      }
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
      lastRefreshAt = Date.now();
      refreshes += 1;
    } else {
      await page.waitForTimeout(2000);
    }
  }

  const dump = await captureStatusListDump(page, waitName, lastRows, {
    refreshes,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    reason: 'time deadline'
  });
  throw new Error([
    `${waitName} did not become available within ${Math.round(config.run.postCompletionWaitMs / 60000)} minutes.`,
    `Elapsed: ${Math.round((Date.now() - startedAt) / 1000)} seconds after ${refreshes} refresh(es)`,
    `Status list rows parsed: ${lastRows.length ? lastRows.map((row) => `${row.label} [${row.status}]`).join(' | ') : 'none recognised'}`,
    dump ? `Dump: ${dump}` : 'Dump: could not be written.',
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
    await waitForDiscussionsLoaded(page);
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
      await waitForIdle(page);
      return;
    }
  }
  // The report link lives on the case detail page (reached via openCaseFromDashboard above);
  // no dashboard-card fallback — matching a state-specific card button is fragile and can
  // open the wrong case's report.
}

async function waitForAndReadAlignmentReport(page, config, createdCase, artifacts = null) {
  await assertNoBlockingStageFailure(page, artifacts, 'Alignment report');
  const startedAt = Date.now();
  let deadline = startedAt + config.run.postCompletionWaitMs;
  let lastText = '';
  let lastUrl = page.url();
  let lastReloadAt = 0;

  while (Date.now() < deadline) {
    lastText = await readVisibleBodyText(page);
    lastUrl = page.url();

    // Still processing → roll the deadline forward so a live processing screen
    // never trips the fixed timeout (a true hang still ends at the original deadline).
    if (isProcessingState(lastText)) {
      deadline = Math.max(deadline, Date.now() + 180000);
    }

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
          source: 'report',
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

    // "Your Alignment Brief" is the link's live wording; matching only "alignment report" meant
    // the brief was never opened.
    if (/alignment report|alignment brief/i.test(lastText)) {
      await openCaseAlignmentReport(page, config, createdCase);
      await page.waitForTimeout(1000);
      continue;
    }

    // Not on a report and no report link visible yet: reopen this case / refresh.
    if (isDashboardPage(lastUrl, lastText)) {
      // Fallback: the dashboard lists each case with "Latest Alignment: NN%" once
      // its report has generated. Read it for the case under test rather than
      // insisting on landing the single-case report page.
      const dashboardScore = extractDashboardAlignmentScore(lastText, createdCase);
      if (dashboardScore !== null) {
        return {
          score: dashboardScore,
          source: 'dashboard',
          url: lastUrl,
          elapsedMs: Date.now() - startedAt,
          visibleText: compactVisibleText(lastText, 4000)
        };
      }
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

// Read "Latest Alignment: NN%" for the case under test from the dashboard's case
// list. Scopes to the card that starts with the case's own CG-#### id (up to the
// next case id) so a neighbouring case's score is never picked up. Returns null
// when the card shows "Latest Alignment: —" (report not generated yet).
function extractDashboardAlignmentScore(text, createdCase) {
  const caseId = createdCase?.commonGroundId ?? createdCase?.id;
  if (!caseId) return null;
  const haystack = String(text ?? '');
  const start = haystack.search(new RegExp(`\\b${escapeRegExp(caseId)}\\b`, 'i'));
  if (start === -1) return null;
  const rest = haystack.slice(start + caseId.length);
  const nextId = rest.search(/\bCG-\d/i);
  const block = nextId === -1 ? rest : rest.slice(0, nextId);
  const match = block.match(/Latest Alignment\s*:?\s*(\d{1,3}(?:\.\d+)?)\s*%/i);
  if (!match) return null;
  const value = Number(match[1]);
  return isValidAlignmentScore(value) ? value : null;
}

function onAlignmentReportPage(url = '', text = '') {
  if (/alignment-report/i.test(String(url ?? ''))) return true;
  if (isDashboardPage(url, text)) return false;
  const value = String(text ?? '');
  // Positive markers of the single-case report (vs. the dashboard's case list).
  // "Current Alignment:" is the completed case-detail page, which prints the score directly
  // ("Current Alignment: 78% / Above Threshold (75%)") — CG-0007 finished there and the score
  // was never read because this predicate only knew the "NN/100" report layout.
  return /\b\d{1,3}(?:\.\d+)?\s*\/\s*100\b/.test(value)
    || /alignment\s+threshold/i.test(value)
    || /current\s+alignment\s*:/i.test(value);
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

// True once the page actually exposes something to act on: label controls to click, a
// progress counter, or an already-enabled submit (everything rated). Text readiness is
// not enough — the /fact-review chrome renders while statements are still generating.
async function factRatingSurfaceReady(page, labelText) {
  const progress = extractFactRatingProgress(await readVisibleBodyText(page));
  if (progress) return true;
  const controls = await exactLabelControls(page, labelText);
  if (await controls.count().catch(() => 0) > 0) return true;
  return Boolean(await findEnabledFactSubmitControl(page));
}

async function waitForFactLabelingReady(page, config, labelText) {
  let deadline = Date.now() + config.run.postCompletionWaitMs;
  let sawGenerating = false;
  while (Date.now() < deadline) {
    await dismissTourOverlay(page, 'fact statement labeling');
    const text = await readVisibleBodyText(page);
    if (factStatementsGenerating(text)) sawGenerating = true;
    // Require both the labeling screen AND a usable rating surface, so we never start
    // clicking against a page whose statements have not been generated yet.
    if (factLabelingReady(text, page.url()) && await factRatingSurfaceReady(page, labelText)) return;
    // Still processing → roll the deadline forward so a live processing screen
    // never trips the fixed timeout (a true hang still ends at the original deadline).
    if (isProcessingState(text)) deadline = Math.max(deadline, Date.now() + 180000);
    await page.waitForTimeout(1500);
  }

  throw new Error([
    'Fact statement labeling did not become available before timeout.',
    sawGenerating
      ? 'The "Generating your statements…" placeholder was showing during the wait; statement generation never produced rating controls.'
      : 'No statement-generation placeholder was seen; the labeling screen never exposed rating controls.',
    `Current URL: ${page.url()}`,
    `Last visible page text: ${compactVisibleText(await readVisibleBodyText(page), 1800)}`
  ].join('\n'));
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

// True when Partner AI has posted something after the answer we just submitted.
//
// Comparing whole-transcript text does NOT work here: our own submitted answers are
// appended to the same transcript, so the raw text grows every turn whether or not
// Partner AI replied. The reliable signal is what sits AFTER our last answer — nothing
// but chat timestamps means Partner AI has not responded yet.
function partnerRepliedAfter(rawText, submittedResponse) {
  const text = collapseWhitespace(rawText);
  const answer = collapseWhitespace(submittedResponse);
  if (!answer) return true;
  const index = text.lastIndexOf(answer);
  if (index < 0) return true; // can't locate our answer — don't block the interview
  const tail = text.slice(index + answer.length)
    .replace(/\b\d{1,2}:\d{2}\s*(?:AM|PM)?\b/gi, ' ');
  return collapseWhitespace(tail).length > 0;
}

function collapseWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// Stability is not newness. waitForStableLocatorText settles as soon as the DOM stops
// changing — which is immediately true when Partner AI has not replied yet and the tail
// of the transcript is still the synthetic user's own answer. Reading there yields a
// prompt whose question extraction falls back to the header/sidebar block (the FIRST
// primary question), so the interview appears to jump back to question 1. Passing
// afterResponse makes the read wait for Partner AI to actually reply.
async function readLatestPrompt(page, config, options = {}) {
  const locator = page.locator(config.selectors.partnerAi.latestPrompt).first();
  await locator.waitFor({ state: 'visible', timeout: 30000 });
  const afterResponse = options.afterResponse ?? '';
  if (!afterResponse) return waitForStableLocatorText(locator, page);

  const deadline = Date.now() + (options.newPromptTimeoutMs ?? 60000);
  let latest = '';
  while (Date.now() < deadline) {
    latest = await waitForStableLocatorText(locator, page);
    if (!latest) break;
    if (partnerRepliedAfter(latest, afterResponse)) return latest;
    // The interview can legitimately end without another question.
    if (isCompletionPrompt(latest, config.completionPhrases) || isPostInterviewState(latest)) return latest;
    await page.waitForTimeout(2000);
  }
  // Deliberately return the unchanged text rather than throwing: the caller's stall
  // counter decides whether this is a transient lag or a genuine dead transcript.
  return latest;
}

// Common Ground shows a first-run onboarding tour modal ("Start Groundwork with
// confidence", "Step N of M") on the Groundwork / interview page. It overlays the
// page and blocks the response input. We dismiss it via "Don't show again" so it
// never returns for the account (falling back to the X icon, then Escape). If the
// modal is not present this returns instantly (timeout:0 checks) with no waits or
// clicks, so the happy path is never slowed.
// Product-tour / onboarding overlay dismissal.
//
// The tour can appear on EITHER actor's side, on ANY page, at ANY step of the workflow,
// and at any step number ("Step 1 of 13", "Step 7 of 13", ...), and it blocks whatever is
// underneath — most damagingly the interview response composer. It can also reappear later
// in the same run, so this is checked repeatedly rather than once.
//
// Matching is deliberately structural (control labels + step counter) rather than keyed to
// a heading, because the heading and step count differ per screen. Dismissal prefers
// "Exit tour" (the current control); older builds exposed "Don't show again".
const TOUR_CONTROL_PATTERN = /Exit tour|Start Tour|Take a tour|Don'?t show again/i;
const TOUR_SIGNAL_PATTERN = /Exit tour|Start Tour|Take a tour|Step \d+ of \d+|Groundwork with confidence/i;

async function dismissTourOverlay(page, where = '') {
  // Cheap presence check first: timeout 0 resolves synchronously, so a page with no tour
  // costs one near-free query and never waits or clicks.
  const exitTour = page.getByRole('button', { name: /Exit tour/i })
    .or(page.getByRole('link', { name: /Exit tour/i }))
    .first();
  let present = await exitTour.isVisible({ timeout: 0 }).catch(() => false);

  const dialogModal = page.getByRole('dialog').filter({ hasText: TOUR_SIGNAL_PATTERN }).first();
  if (!present) present = await dialogModal.isVisible({ timeout: 0 }).catch(() => false);
  if (!present) {
    // Some builds render the tour without a dialog role; fall back to the step counter,
    // which is the one element every tour step has regardless of wording.
    const stepCounter = page.getByText(/Step \d+ of \d+/i).first();
    present = await stepCounter.isVisible({ timeout: 0 }).catch(() => false);
  }
  if (!present) return false;

  const location = where ? `${where} — ${page.url()}` : page.url();
  const attempts = [
    ['Exit tour', exitTour],
    ["Don't show again", page.getByRole('link', { name: /Don'?t show again/i })
      .or(page.getByRole('button', { name: /Don'?t show again/i })).first()],
    ['close icon', dialogModal.getByRole('button', { name: /close|dismiss|^x$/i }).first()
      .or(page.getByRole('button', { name: /close|dismiss|^x$/i }).first())]
  ];

  for (const [label, control] of attempts) {
    if (!await control.isVisible({ timeout: 0 }).catch(() => false)) continue;
    await control.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(400);
    if (!await tourStillVisible(page)) {
      console.log(`[tour] Dismissed product tour overlay via "${label}" on ${location}.`);
      return true;
    }
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
  const gone = !await tourStillVisible(page);
  console.log(`[tour] ${gone ? 'Dismissed' : 'FAILED to dismiss'} product tour overlay via Escape on ${location}.`);
  return gone;
}

async function tourStillVisible(page) {
  for (const locator of [
    page.getByRole('button', { name: TOUR_CONTROL_PATTERN }).first(),
    page.getByText(/Step \d+ of \d+/i).first()
  ]) {
    if (await locator.isVisible({ timeout: 0 }).catch(() => false)) return true;
  }
  return false;
}

// Back-compat alias for the previous name.
async function dismissOnboardingTourModal(page) {
  return dismissTourOverlay(page, 'interview');
}

// How long a turn waits for the composer to come back after an answer is submitted.
//
// Base cap, then a rolling grace period renewed for as long as the page shows any sign of
// work, bounded by an absolute ceiling so a genuine hang still ends the run. Raised from
// 10min/3min after a Performance Review - Evaluation run (2026-08-12T16-03-39-058Z, CG-0002)
// died 903s after its last submit with the composer still on screen and "Saving your answer…"
// visible: the save was slow, not broken.
const INTERVIEW_READY_TIMEOUT_MS = 900000;      // 15 min before any sign of work is needed
const INTERVIEW_PROGRESS_GRACE_MS = 300000;     // keep waiting 5 min past the last sign of work
const INTERVIEW_READY_MAX_MS = 2700000;         // 45 min absolute ceiling; a true hang still ends

async function waitForInterviewReady(page, config, options = {}) {
  const inputSelector = config.selectors.partnerAi.responseInput;
  const stageName = options.stageName ?? 'Getting Started interview';
  const startedAt = Date.now();
  const hardDeadline = startedAt + INTERVIEW_READY_MAX_MS;
  let deadline = startedAt + INTERVIEW_READY_TIMEOUT_MS;
  let lastVisibleText = '';
  let lastInputState = '';
  let gateSince = null;
  let extensions = 0;
  let lastProgressAt = null;
  let lastProgressSignal = '';

  while (Date.now() < deadline) {
    // Cheap per-pass check: close the onboarding tour modal if it appears
    // mid-flow so it never blocks the response input (no-op when absent).
    await dismissOnboardingTourModal(page);
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
    // Cross-party gate: Common Ground shows "waiting on the other party" when this
    // actor's interview is sequenced behind the other side. The response input never
    // appears, so polling to the full deadline burns 10 minutes and reports a generic
    // timeout instead of the real cause. Confirmed over OTHER_PARTY_GATE_CONFIRM_MS to
    // ignore transient frames, and checked only after the ready-input test above so a
    // live interview always wins over the broad "almost there" match. Free on the happy
    // path: visibleText is already read at the top of this loop.
    if (otherPartyGate(visibleText)) {
      if (!gateSince) gateSince = Date.now();
      else if (Date.now() - gateSince >= OTHER_PARTY_GATE_CONFIRM_MS) {
        throw new OtherPartyGateError(stageName, page.url(), visibleText);
      }
    } else {
      gateSince = null;
    }
    // While Common Ground is visibly still processing the previous answer, keep
    // waiting instead of giving up: roll the deadline forward so an active
    // processing screen never trips the timeout, while a true hang still ends.
    //
    // Two signals, because the banner is not reliable on its own: "Saving your answer…"
    // renders intermittently while a slow save runs, so a wait that only watched the text
    // could stop renewing mid-save. A composer that is on screen but DISABLED is the durable
    // form of the same state — the app has taken the answer and has not handed the turn back.
    const composerBusy = !readyInput && await hasDisabledResponseInput(page, inputSelector);
    const processingText = isProcessingState(visibleText);
    if (processingText || composerBusy) {
      const renewed = Math.min(hardDeadline, Math.max(deadline, Date.now() + INTERVIEW_PROGRESS_GRACE_MS));
      if (renewed > deadline) extensions += 1;
      deadline = renewed;
      lastProgressAt = Date.now();
      lastProgressSignal = processingText ? 'processing text on screen' : 'composer present but disabled';
    }
    await page.waitForTimeout(1500);
  }

  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  const sinceProgress = lastProgressAt ? `${Math.round((Date.now() - lastProgressAt) / 1000)}s ago (${lastProgressSignal})` : 'never observed';
  const compactText = lastVisibleText.replace(/\s+/g, ' ').trim();
  throw new Error([
    'Getting Started interview did not become ready before timeout.',
    `Waited ${elapsedSeconds}s (base ${Math.round(INTERVIEW_READY_TIMEOUT_MS / 1000)}s, `
      + `${extensions} grace extension(s) of ${Math.round(INTERVIEW_PROGRESS_GRACE_MS / 1000)}s, `
      + `ceiling ${Math.round(INTERVIEW_READY_MAX_MS / 1000)}s).`,
    `Last sign of progress: ${sinceProgress}.`,
    `Response input state: ${lastInputState}`,
    `Current URL: ${page.url()}`,
    `Last visible page text (start): ${compactText.slice(0, 900)}`,
    `Last visible page text (end): ${compactText.slice(-1400)}`
  ].join('\n'));
}

// True when the composer is rendered but not accepting input: Common Ground has the previous
// answer and has not returned the turn yet. Distinct from findReadyResponseInput, which looks
// for the opposite (a usable input) and returns null both for "disabled" and "not there".
async function hasDisabledResponseInput(page, selector) {
  const inputs = page.locator(selector);
  const count = await inputs.count().catch(() => 0);
  for (let index = count - 1; index >= 0; index -= 1) {
    const input = inputs.nth(index);
    if (!await input.isVisible({ timeout: 100 }).catch(() => false)) continue;
    if (!await input.isEnabled({ timeout: 100 }).catch(() => false)) return true;
  }
  return false;
}

function interviewReadySignal({ readyInput }) {
  return Boolean(readyInput);
}

async function findReadyResponseInput(page, selector, timeout = 1000) {
  const inputs = page.locator(selector);
  const deadline = Date.now() + timeout;
  await dismissTourOverlay(page, 'response input');

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
  const value = String(text ?? '');
  // Statement generation is an active processing screen, so it must roll the wait
  // deadline forward like any other — otherwise a slow generation trips the fixed
  // post-processing timeout while the app is visibly still working.
  if (factStatementsGenerating(value)) return true;
  // Partner AI's between-turn states. While any of these show, the composer is removed or
  // disabled, so every wait loop must keep waiting rather than treat it as a dead page.
  if (/making sure there'?s enough|enough here to go on|reviewing your (?:response|answer)|checking your (?:response|answer)/i.test(value)) return true;
  return /checking engagement|engagement levels?|still processing|processing your|analy[sz]ing|please wait|one moment|understanding your intent|understanding your response|saving your response|saving your answer|\d+\s*%\s*complete|thinking…|thinking\.\.\.|\bloading\b/i.test(value);
}

function otherPartyGate(text) {
  return /waiting on the other party|other (?:participant|party) is still finishing|almost there/i.test(String(text ?? ''));
}

// How long the "waiting on the other party" gate must persist before a wait loop
// treats it as a real cross-party handoff (vs. a transient frame that flips to the
// excerpt-review/fact-labeling screen a moment later).
const OTHER_PARTY_GATE_CONFIRM_MS = 15000;

// Thrown by post-processing wait loops when the current step is gated on the OTHER
// actor's progress ("Almost there, just waiting on the other party") and therefore
// will never become ready in this session. Carries diagnostics so the orchestrator
// can log/screenshot the exact handoff point instead of polling to the full timeout.
class OtherPartyGateError extends Error {
  constructor(waitName, url, visibleText) {
    super(`Blocked at the "waiting on the other party" gate during ${waitName}.`);
    this.name = 'OtherPartyGateError';
    this.waitName = waitName;
    this.url = url;
    this.visibleText = String(visibleText ?? '');
  }
}

// Always write the gate screenshot to a stable per-actor path — even when the gate is
// thrown outside a wait loop (a stage transition or post-navigation check).
async function captureGateScreenshot(page, store, actorLabel) {
  const slug = actorLabel.toLowerCase().replace(/\s+/g, '-');
  const screenshotPath = `${store.runDir}/${slug}-other-party-gate.png`;
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  return screenshotPath;
}

// Phase 2 handoff: recover from the cross-party gate in the SAME browser session (no
// account switch). Screenshot (always) → Back to Dashboard → the case row for
// createdCase.commonGroundId → Begin Discussion. Each click waits up to
// OTHER_PARTY_GATE_CONFIRM_MS; a miss/wrong page returns { recovered: false } so the
// caller can fall back to the Phase 1 stop.
async function recoverViaDashboard(page, config, createdCase, store, actorLabel, waitName) {
  const screenshotPath = await captureGateScreenshot(page, store, actorLabel);
  const caseId = createdCase?.commonGroundId ?? '';

  const clickWithin = async (locator) => {
    if (!await locator.isVisible({ timeout: OTHER_PARTY_GATE_CONFIRM_MS }).catch(() => false)) return false;
    await locator.click().catch(() => {});
    await waitForIdle(page);
    return true;
  };

  const backToDashboard = page.getByRole('link', { name: /Back to Dashboard/i })
    .or(page.getByRole('button', { name: /Back to Dashboard/i }))
    .first();
  if (!await clickWithin(backToDashboard)) {
    return { recovered: false, screenshotPath, failureReason: 'Back to Dashboard not found' };
  }
  if (!isDashboardPage(page.url(), await readVisibleBodyText(page))) {
    await ensureOnDashboard(page, config).catch(() => {});
  }

  const caseRow = page.getByText(caseId, { exact: false }).first();
  if (!caseId || !await clickWithin(caseRow)) {
    return { recovered: false, screenshotPath, failureReason: `case row ${caseId || '(no id)'} not found on dashboard` };
  }

  const beginDiscussion = page.getByRole('link', { name: /Begin Discussion|Getting Started/i })
    .or(page.getByRole('button', { name: /Begin Discussion|Getting Started/i }))
    .first();
  if (!await clickWithin(beginDiscussion)) {
    return { recovered: false, screenshotPath, failureReason: 'Begin Discussion not found on case page' };
  }

  console.log(`[gate] Phase 2 handoff: returned via dashboard for ${actorLabel} at ${waitName}`);
  return { recovered: true, screenshotPath };
}

// Runs ONLY after a dashboard handoff, before re-running the stage. Refuses to resume
// on anything but the expected pending step, so a handoff that lands on the interview
// (or anywhere ambiguous) stops cleanly instead of re-submitting. Rolls its bounded
// window forward only while CG is genuinely processing (reads isProcessingState — does
// not modify it), so legitimate post-handoff processing doesn't trigger a false stop;
// a persistent gate deliberately expires the window and stops.
async function confirmOnExpectedStep(page, config, expectedStep) {
  let deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const text = await readVisibleBodyText(page);
    const url = page.url();
    // A ready interview input means the handoff dropped us into the conversation, not
    // the pending post-processing/rating step → refuse to resume (never re-run turns).
    if (await findReadyResponseInput(page, config.selectors.partnerAi.responseInput, 300)) return false;
    if (expectedStep(text, url)) return true;
    if (isProcessingState(text)) deadline = Math.max(deadline, Date.now() + 30000); // still working → keep confirming
    await page.waitForTimeout(1500);
  }
  return false;
}

function recordGateOutcome(artifacts, actorLabel, waitName, screenshotPath, url, outcome, passed) {
  artifacts.softAssertions.push({
    type: 'workflow_other_party_gate',
    passed,
    expected: `${actorLabel} proceeds past "waiting on the other party" during ${waitName}.`,
    observed: `${outcome} at ${waitName} (${actorLabel}). Screenshot: ${screenshotPath}. URL: ${url}.`
  });
}

function makeGateStop(actorLabel, waitName, screenshotPath, url, reason) {
  const gateError = new Error(
    `Workflow gated at "waiting on the other party" during ${waitName} (${actorLabel}); ${reason}. Screenshot: ${screenshotPath}.`
  );
  gateError.otherPartyGate = { actorLabel, waitName, screenshotPath, url };
  return gateError;
}

// Runs a gate-prone stage with Phase 1 detection + Phase 2 recovery. When no gate
// fires, this is byte-for-byte a direct `await stageFn()` — no added reads, waits, or
// clicks. Detection happens inside each stage's own wait loop (which throws
// OtherPartyGateError). On the gate it performs ONE dashboard handoff, confirms CG is
// back on the expected step, then retries the stage — resuming from the next expected
// wait. If the handoff fails, we are not on the expected step, or it is still gated
// after one handoff, it stops with a clear error + screenshot (Phase 1 fallback).
// Re-running a stage can never re-run interview turns: the interview-submission code
// lives only in runPartnerAiInterview, which these stages never call.
async function withOtherPartyGateRecovery(ctx, stageFn) {
  const { page, config, store, createdCase, actorLabel, waitName, artifacts, expectedStep } = ctx;
  let recoveriesUsed = 0;
  while (true) {
    try {
      return await stageFn();
    } catch (error) {
      if (!(error instanceof OtherPartyGateError)) throw error;
      const stage = error.waitName ?? waitName;

      if (recoveriesUsed >= 1) {
        const shot = await captureGateScreenshot(page, store, actorLabel);
        recordGateOutcome(artifacts, actorLabel, stage, shot, error.url, 'still gated after one dashboard handoff', false);
        throw makeGateStop(actorLabel, stage, shot, error.url, 'still gated after one dashboard handoff');
      }

      recoveriesUsed += 1;
      const recovery = await recoverViaDashboard(page, config, createdCase, store, actorLabel, stage);
      if (!recovery.recovered) {
        recordGateOutcome(artifacts, actorLabel, stage, recovery.screenshotPath, error.url, `handoff failed: ${recovery.failureReason}`, false);
        throw makeGateStop(actorLabel, stage, recovery.screenshotPath, error.url, `dashboard handoff failed (${recovery.failureReason})`);
      }
      if (!await confirmOnExpectedStep(page, config, expectedStep)) {
        recordGateOutcome(artifacts, actorLabel, stage, recovery.screenshotPath, error.url, 'handed off but not on the expected step', false);
        throw makeGateStop(actorLabel, stage, recovery.screenshotPath, error.url, 'after handoff, not on the expected step; not re-running to avoid duplicate submission');
      }
      recordGateOutcome(artifacts, actorLabel, stage, recovery.screenshotPath, error.url, 'recovered via dashboard handoff', true);
      // confirmed → loop retries stageFn once; resumes the wait, acts once, cannot re-run turns.
    }
  }
}

// After an actor submits ratings of the other party's facts, the "Getting Started"
// button does not appear immediately and the actor may still be behind a "waiting on
// the other party" gate. Re-open the case from the dashboard and poll until an
// actionable Getting Started control is available.
async function waitForGettingStartedAfterRating(page, config, createdCase, syntheticCase, actorLabel = 'Requestor') {
  // Keep the full post-rating wait budget (Common Ground genuinely delays the
  // Getting Started button), but poll responsively and proceed the moment the
  // control is ready. The heavy dashboard re-open only runs periodically, since
  // re-entry is what surfaces the button — most checks stay fast.
  let deadline = Date.now() + config.run.postCompletionWaitMs;
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

    // Still processing → roll the deadline forward so a live processing screen
    // never trips the fixed timeout (a true hang still ends at the original deadline).
    if (isProcessingState(text)) deadline = Math.max(deadline, Date.now() + 180000);

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
  throw new Error(
    `${actorLabel} "Getting Started" did not become available after rating the other party's facts within the timeout. `
    + "The other party's Getting Started or fact rating may not have completed."
  );
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

// Populate Party 1 and Party 2 on the New Discussion form. The redesigned Raise Request
// form makes Party 2 (the Manager) a "Select a manager" dropdown that auto-fills the
// manager's Email, and it no longer auto-fills Party 1 (the Employee = the logged-in
// requestor). When that dropdown is present we fill the employee's text fields and pick
// the manager whose auto-filled Email matches the participant the tool later logs in as.
// When it is absent (older/other forms where both parties are free text and the app
// auto-fills the logged-in party) we fall back to the previous "fill the empty party"
// behavior, so this change is backward-compatible.
async function fillCaseParties(page, selectors, config, syntheticCase, store) {
  const managerSelect = page.locator(selectors.managerSelect).first();
  const hasManagerDropdown = await managerSelect.isVisible({ timeout: 5000 }).catch(() => false);

  if (hasManagerDropdown) {
    await fillIfEmpty(page, selectors.employeeNameInput, syntheticCase.requestorName, 'employee (Party 1) name');
    await fillIfEmpty(page, selectors.employeeEmailInput, config.credentials.requestor.email, 'employee (Party 1) email');
    await selectManagerParty(page, managerSelect, config.credentials.participant.email, store);
    return;
  }

  // Current staging design: the form resolves BOTH parties itself and renders them as
  // read-only text ("That's you — taken from your account", "Your manager, from your
  // organization's records"). There is nothing to fill, but we must still confirm the
  // pairing matches the two accounts this run drives, or the participant login later
  // lands on a case it was never invited to.
  const autoParties = await readAutoResolvedParties(page);
  if (autoParties) {
    await verifyAutoResolvedParties(page, autoParties, config, store);
    return;
  }

  // Legacy form: both parties are free text and the app auto-fills the logged-in one.
  if (await hasEmptyEditableInput(page, 'input[type="text"]')) {
    await fillFirstEmpty(page, 'input[type="text"]', syntheticCase.participantName, 'empty party name');
    await fillFirstEmpty(page, 'input[type="email"]', syntheticCase.participantEmail, 'empty party email');
    return;
  }

  // None of the known shapes matched. Previously we fell through to the legacy branch
  // regardless, which failed with "Could not find an empty, editable field ..." — an
  // error about the wrong thing. Fail explicitly, with the form state attached.
  await failCaseForm(page, store, [
    'The New Discussion Request form matched none of the known shapes.',
    `Expected one of: the "${selectors.managerSelect}" manager dropdown, read-only auto-resolved`,
    'Party 1/Party 2 blocks, or legacy free-text party fields — none were present.',
    'The form has probably changed again; re-run `node scripts/launch.js scripts/inspectCaseForm.js` to see its current fields.'
  ].join(' '));
}

// Parse the read-only party blocks the redesigned form renders. Returns null when the
// page does not use that shape, so the caller can try the other known layouts.
async function readAutoResolvedParties(page) {
  const text = (await readVisibleBodyText(page)).replace(/\s+/g, ' ');
  const parties = {};
  for (const number of [1, 2]) {
    const match = text.match(new RegExp(
      `Party\\s*${number}:\\s*Name:\\s*(.+?)\\s*Role:\\s*(.+?)\\s*Email:\\s*([\\w.+-]+@[\\w-]+\\.[\\w.-]+)`, 'i'));
    if (!match) return null;
    parties[`party${number}`] = { name: match[1].trim(), role: match[2].trim(), email: match[3].trim() };
  }
  return parties;
}

// The app decides the pairing, so our only job is to confirm it is the pairing this run
// can actually drive: both configured accounts must appear. Party order varies by topic
// (Raise puts the employee first, Performance Review the manager), so match on email.
async function verifyAutoResolvedParties(page, parties, config, store) {
  const requestorEmail = String(config.credentials.requestor.email ?? '').trim().toLowerCase();
  const participantEmail = String(config.credentials.participant.email ?? '').trim().toLowerCase();
  const present = [parties.party1, parties.party2].map((party) => party.email.toLowerCase());
  const describe = [parties.party1, parties.party2]
    .map((party, index) => `Party ${index + 1}: ${party.name} (${party.role}) <${party.email}>`).join('; ');

  const missing = [
    present.includes(requestorEmail) ? null : `requestor ${config.credentials.requestor.email}`,
    present.includes(participantEmail) ? null : `participant ${config.credentials.participant.email}`
  ].filter(Boolean);

  if (missing.length) {
    await failCaseForm(page, store,
      `The form auto-resolved parties that do not match this run's accounts — missing ${missing.join(' and ')}. `
      + `Form shows: ${describe}. Refusing to submit a case the configured participant cannot accept.`);
  }

  console.log(`[case] Parties auto-resolved by the form — ${describe}.`);
}

async function hasEmptyEditableInput(page, selector) {
  const inputs = page.locator(selector);
  const count = await inputs.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    if (!await input.isVisible().catch(() => false)) continue;
    if (!await input.isEditable().catch(() => false)) continue;
    if (await input.inputValue().catch(() => '')) continue;
    return true;
  }
  return false;
}

// Screenshot and throw, so an unrecognised case form stops the run with an accurate
// message instead of a misleading downstream selector error.
async function failCaseForm(page, store, message) {
  const shot = `${store.runDir}/case-form-unrecognised.png`;
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  const visible = (await readVisibleBodyText(page)).replace(/\s+/g, ' ').trim().slice(0, 1200);
  throw new Error([message, `URL: ${page.url()}`, `Screenshot: ${shot}`, `Visible form text: ${visible}`].join('\n'));
}

// Fill a field only if it is currently empty, so an environment that still auto-fills the
// requestor's party keeps the app's own (real) values instead of being overwritten.
async function fillIfEmpty(page, selector, value, label) {
  const locator = await waitForVisible(page, selector, label);
  if (await locator.inputValue().catch(() => '')) return;
  await locator.fill(value);
}

// Choose Party 2 (the Manager) from the "Select a manager" dropdown. Managers listed are
// real accounts and the option text carries no email, so we select each candidate, read
// the Email the form auto-fills, and keep the one matching the participant account the
// tool logs in as to accept the case. If none matches (or the list is empty) we screenshot
// and fail rather than submit an empty/incorrect Party 2.
async function selectManagerParty(page, managerSelect, participantEmail, store) {
  const options = await managerSelect.locator('option').evaluateAll((opts) =>
    opts.map((o) => ({ value: o.value, label: (o.textContent || '').trim(), disabled: o.disabled })));
  const candidates = options.filter((o) => o.value && !o.disabled);
  const wanted = participantEmail.trim().toLowerCase();

  if (candidates.length === 0) {
    await failManagerSelection(page, store,
      'The "Select a manager" dropdown has no selectable managers, so Party 2 cannot be assigned.');
  }

  let matched = null;
  let shownEmail = null;
  for (const option of candidates) {
    await managerSelect.selectOption(option.value);
    shownEmail = await waitForManagerEmail(page);
    if (shownEmail && shownEmail.toLowerCase() === wanted) {
      matched = option;
      break;
    }
  }

  if (!matched) {
    await failManagerSelection(page, store,
      `No manager in the "Select a manager" dropdown has the participant email ${participantEmail}. ` +
      `Available managers: ${candidates.map((c) => c.label).join(', ') || '(none)'}. ` +
      'Refusing to submit with an empty or incorrect Party 2.');
  }

  console.log(`[case] Party 2 manager selected: "${matched.label}" — auto-filled email ${shownEmail}.`);
}

// After a manager is picked the form renders the manager's Email as visible text (a
// <span>, not an input). Poll briefly for it, restricted to visible nodes so Next.js RSC
// <script> payloads (which contain email-like strings) are ignored. Returns the shown
// email, or null if none appears.
async function waitForManagerEmail(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const email = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('span, p, div, td')];
      const hit = nodes.find((el) =>
        el.children.length === 0 &&
        el.offsetParent !== null &&
        /^[\w.+-]+@[\w-]+\.[\w.-]+$/.test((el.textContent || '').trim()));
      return hit ? hit.textContent.trim() : null;
    });
    if (email) return email;
    await page.waitForTimeout(300);
  }
  return null;
}

// Screenshot and throw, so a failed manager selection stops the run cleanly instead of
// submitting an empty Party 2.
async function failManagerSelection(page, store, message) {
  const shot = `${store.runDir}/party2-manager-selection-failed.png`;
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  throw new Error(`${message} Screenshot: ${shot}`);
}

async function click(page, selector, label) {
  // The product tour can overlay any page and intercept the click.
  await dismissTourOverlay(page, `before clicking ${label}`);
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
  await waitForDiscussionsLoaded(page);
}

async function assertLoggedIn(page, config, role) {
  const dashUrl = new URL('/dashboard', config.productionUrl).toString();

  // (4) Log whether the auth token is present before we head to the dashboard.
  console.log(`[login] ${role} post-submit: accessTokenStored=${await hasAuthToken(page)}, url=${page.url()}`);

  // Now that the token is stored (submitLoginForm confirmed it), drive to /dashboard
  // ourselves — sessionStorage survives the navigation, so the dashboard's auth guard finds
  // the token. The SPA's own routing can race the token write and bounce to
  // /login?message=login_required; if the token is still stored, that is the race, so
  // re-navigate rather than failing. Bounded so a genuine auth failure still errors out.
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (!isDashboardPage(page.url())) {
      await page.goto(dashUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    // Wait for the dashboard to render past its "Loading…" spinner (raised cap for a slow
    // cold dashboard). Returns early if we bounced off /dashboard.
    await waitForDiscussionsLoaded(page, 120000);

    const url = page.url();
    const tokenStored = await hasAuthToken(page);
    const bounced = /\?message=login_required|login_required/i.test(url)
      || (!isDashboardPage(url) && /\/login(?:[/?#]|$)/i.test(url));
    console.log(`[login] ${role} dashboard settle attempt ${attempt}: url=${url}, accessTokenStored=${tokenStored}, bounced=${bounced}`);

    if (isDashboardPage(url) && !bounced) return;
    if (!tokenStored) break; // token gone → genuine auth failure; report below
    await page.waitForTimeout(500); // re-navigate on the next loop
  }

  const compactText = (await readVisibleBodyText(page)).replace(/\s+/g, ' ').trim();
  throw new Error([
    `${role} login did not complete before timeout.`,
    `Current URL: ${page.url()}`,
    `Auth token stored: ${await hasAuthToken(page)}`,
    `Visible page text: ${compactText.slice(0, 1200)}`
  ].join('\n'));
}

async function verifyAuthenticatedRoute(page, config, role) {
  // Avoid a redundant second dashboard load: login() usually lands here already.
  if (!isDashboardPage(page.url(), await readVisibleBodyText(page))) {
    await page.goto(new URL('/dashboard', config.productionUrl).toString(), { waitUntil: 'domcontentloaded' });
  }

  const hardDeadline = Date.now() + 120000;
  let deadline = Date.now() + 30000;
  let lastText = '';
  while (Date.now() < deadline && Date.now() < hardDeadline) {
    // Already on /dashboard → the session is valid; wait for it to finish rendering (cards /
    // empty-state) via waitForDiscussionsLoaded with a raised cap, rather than failing on the
    // "Loading…" spinner.
    if (isDashboardPage(page.url())) {
      await waitForDiscussionsLoaded(page, 120000);
      return;
    }
    const text = await readVisibleBodyText(page);
    lastText = text;
    if (/\?message=login_required|login_required/i.test(page.url())) break;
    if (/dashboard|account|notifications|create new case/i.test(text)) return;
    if (isProcessingState(text)) deadline = Math.min(Date.now() + 30000, hardDeadline);
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
  // then begin the request from the matching card. Newer topics' card placement is
  // frontend-owned (the backend's available-topics endpoint carries no display
  // metadata), so a plan may list fallback tabs to search when the card is not on
  // the preferred one. Only a card-not-found error moves to the next tab; a
  // disabled or ambiguous card on the right tab must keep failing loudly.
  const tabs = [plan.tab, ...(plan.fallbackTabs ?? [])];
  let lastError;
  for (const tab of tabs) {
    await selectRequestTab(page, tab);
    await page.getByRole('button', { name: /Begin Request/i }).first()
      .waitFor({ state: 'visible', timeout: 30000 })
      .catch(() => {});
    try {
      await clickRequestCardButton(page, plan.card);
      return;
    } catch (error) {
      if (error?.code !== 'REQUEST_CARD_NOT_FOUND') throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function caseCreationPlan(requestedType) {
  const value = String(requestedType ?? '').toLowerCase();
  // Project Review contains "review", so it must be resolved before the
  // Performance Review family. Its card mirrors the performance topics but the
  // tab is not documented anywhere backend-side, hence the fallback.
  if (/project/.test(value)) {
    return { tab: /Performance Review/i, card: 'Project Review', fallbackTabs: [/Discussion Request/i] };
  }
  // Performance Review tab — select the specific variant card by its full title.
  if (/performance|review/.test(value)) {
    if (/90.?day/.test(value)) return { tab: /Performance Review/i, card: 'Performance Review - 90-Day' };
    if (/focused|improvement/.test(value)) return { tab: /Performance Review/i, card: 'Performance Review - Focused Improvement' };
    if (/evaluation/.test(value)) return { tab: /Performance Review/i, card: 'Performance Review - Evaluation' };
    if (/coaching/.test(value)) return { tab: /Performance Review/i, card: 'Performance Review - Coaching' };
    throw new Error(`Ambiguous case type "${requestedType}" — specify Coaching, Evaluation, 90-Day, or Focused Improvement.`);
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

// Begin the request for exactly ONE card. The climb below stops at the card's OWN button and
// never borrows a neighbour's.
//
// The previous version searched each ancestor for the first *enabled* Begin Request, so a
// disabled button on the matched card was skipped and the climb continued to the container
// holding every variant, where it clicked whichever card came first in the DOM. On staging the
// "Performance Review - Evaluation" button is disabled for accounts without the role
// (title="Your role can't start this type of discussion. Contact your administrator."), so
// three runs silently created *Coaching* cases carrying Evaluation-labelled synthetic titles
// and Evaluation quality criteria - the interview served Coaching questions and no scripted
// answer could match.
//
// Now the climb stops at the first ancestor containing ANY Begin Request button: that is the
// card's own scope. A disabled button there is a hard error naming the UI's own explanation,
// not a reason to look elsewhere.
async function clickRequestCardButton(page, cardTitle, buttonPattern = /Begin Request/i) {
  const outcome = await page.evaluate(({ target, btnSource, btnFlags }) => {
    const beginPattern = new RegExp(btnSource, btnFlags);
    const isDisabled = (element) => element.disabled || element.getAttribute('aria-disabled') === 'true';
    // Normalize separator variants and whitespace so the config title
    // ("- Coaching") matches the UI title across redesigns: en/em dash
    // ("– Coaching"), minus, and colon ("Performance Review: Focused
    // Improvement" on the staging redesign) are all treated as " - ".
    const norm = (value) => String(value || '')
      .toLowerCase()
      .replace(/[\u2010-\u2015\u2212:]/g, '-')
      .replace(/\s*-\s*/g, ' - ')
      .replace(/\s+/g, ' ')
      .trim();
    const raw = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const wanted = norm(target);
    const ACTIONS = 'button,a,[role="button"]';
    const beginButtonsIn = (node) => [...node.querySelectorAll(ACTIONS)]
      .filter((element) => beginPattern.test((element.innerText || '').trim()));

    // Whatever the UI offers as the reason a control is unavailable.
    const reasonFor = (element) => {
      const described = element.getAttribute('aria-describedby');
      const describedText = described ? raw(document.getElementById(described)?.innerText) : '';
      return raw(element.getAttribute('title') || element.getAttribute('aria-label') || describedText);
    };

    // The card title owning a button: the nearest ancestor whose subtree holds exactly one
    // heading. At card level that is the card's own title; at container level several headings
    // appear, so the container is skipped.
    const ownerTitleOf = (element) => {
      let node = element.parentElement;
      for (let depth = 0; node && depth < 6; depth += 1) {
        const headings = [...node.querySelectorAll('h1,h2,h3,h4,strong')]
          .map((heading) => raw(heading.innerText))
          .filter(Boolean);
        if (headings.length === 1) return headings[0];
        node = node.parentElement;
      }
      return '';
    };

    // Match the card whose title is the requested variant exactly, else the most
    // specific containment (least extra text). No "shortest overall" heuristic,
    // so sibling cards (e.g. 90-Day) and the tab cannot win.
    const candidates = [...document.querySelectorAll('h1,h2,h3,h4,strong,span,p,a,div')]
      .map((element) => ({ element, text: norm(element.innerText) }))
      .filter((candidate) => candidate.text === wanted || candidate.text.includes(wanted))
      .map((candidate) => ({ ...candidate, score: candidate.text === wanted ? -1 : candidate.text.length - wanted.length }))
      .sort((a, b) => a.score - b.score);

    if (!candidates.length) return { status: 'no-card' };

    for (const candidate of candidates) {
      let node = candidate.element;
      for (let depth = 0; node && depth < 6; depth += 1) {
        // Stop at the first ancestor holding any Begin Request button, enabled or not.
        const buttons = beginButtonsIn(node);
        if (!buttons.length) { node = node.parentElement; continue; }

        // One button here means we are inside a single card. Several means the climb reached a
        // container spanning sibling cards, so attribute by owning title rather than guess.
        const own = buttons.length === 1
          ? buttons[0]
          : buttons.find((button) => norm(ownerTitleOf(button)) === wanted);

        if (!own) {
          return {
            status: 'ambiguous',
            cardTitle: raw(candidate.element.innerText).slice(0, 90),
            buttonCount: buttons.length,
            owners: buttons.map((button) => ownerTitleOf(button)).filter(Boolean)
          };
        }
        if (isDisabled(own)) {
          return {
            status: 'disabled',
            cardTitle: ownerTitleOf(own) || raw(candidate.element.innerText).slice(0, 90),
            reason: reasonFor(own)
          };
        }

        own.click();
        return { status: 'clicked', cardTitle: ownerTitleOf(own) || raw(candidate.element.innerText).slice(0, 90) };
      }
    }
    return { status: 'no-button' };
  }, {
    target: cardTitle,
    btnSource: buttonPattern.source,
    btnFlags: buttonPattern.flags
  });

  if (outcome.status === 'disabled') {
    throw new Error([
      `Could not begin the request: the "${outcome.cardTitle}" card's "Begin Request" button is disabled,`,
      'so this request type cannot be started by the signed-in account.',
      outcome.reason ? `The UI gives the reason: "${outcome.reason}".` : 'The UI gives no reason.',
      'Use an account permitted to start this request type, or run a different case type -',
      'the tool will NOT start a neighbouring request type in its place.'
    ].join(' '));
  }

  if (outcome.status === 'ambiguous') {
    throw new Error(
      `Could not begin the request: found ${outcome.buttonCount} "Begin Request" buttons around the card "${cardTitle}" `
      + `and none could be attributed to it (owning titles: ${outcome.owners.join(', ') || 'none detected'}). `
      + 'The Create a Request UI may have changed.'
    );
  }

  if (outcome.status !== 'clicked') {
    const notFound = new Error(`Could not begin the request: no "Begin Request" button found for the card "${cardTitle}". The Create a Request UI may have changed.`);
    notFound.code = 'REQUEST_CARD_NOT_FOUND';
    throw notFound;
  }

  console.log(`[create-case] Began request from the "${outcome.cardTitle}" card.`);
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
  // Open the case via its "Discussion Details" button — always present on the card
  // regardless of case state — rather than clicking the (often non-navigating) heading or
  // matching a state-specific action. clickCaseCardButton finds the card by its CG-id
  // (waitForCaseCard) and clicks the button within it, landing on the case detail page.
  try {
    await clickCaseCardButton(page, createdCase, /^(Discussion Details|Case Details)$/i);
  } catch (error) {
    const dump = await dumpOpenCaseFailure(page, createdCase);
    throw new Error(
      `Could not open case ${createdCase?.commonGroundId ?? ''} from dashboard: its "Discussion Details" button was not found. `
      + `URL: ${page.url()}. CG cards on dashboard: ${dump.cgIdsOnDashboard.join(', ') || '(none)'}. `
      + `Screenshot: ${dump.shot}. Visible text: ${dump.bodyText} (${error.message})`
    );
  }
}

async function openCaseDetailsFromDashboard(page, createdCase, caseType) {
  if (!isDashboardPage(page.url(), await readVisibleBodyText(page))) return;
  // Wait for the specific case card before either open path (clickCaseCardButton already
  // does, and openCaseFromDashboard now does — this makes the gate explicit for both).
  await waitForCaseCard(page, createdCase);
  const opened = await clickCaseCardButton(page, createdCase, /^(Case Details|Discussion Details)$/i)
    .then(() => true)
    .catch(() => false);
  if (opened) return;
  await openCaseFromDashboard(page, createdCase, caseType);
}

// Wait for a SPECIFIC case's card to render on the dashboard — identified by its exact
// CG-id heading, not just any card. With many accumulated cases the dashboard is slow and a
// just-created case can appear late (rendered below the fold, or not yet in the cached
// /cases response). Poll for the exact heading with a raised cap, scroll it into view so the
// click can reach it, and re-fetch the list periodically in case it hasn't propagated yet.
// Returns true once the heading is present.
async function waitForCaseCard(page, createdCase, timeoutMs = 60000) {
  const targets = caseSearchTargets(createdCase).filter(Boolean);
  if (targets.length === 0) return false;
  const deadline = Date.now() + timeoutMs;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    const found = await page.evaluate((targetList) => {
      const heading = [...document.querySelectorAll('h1,h2,h3')]
        .find((el) => targetList.some((t) => (el.innerText || '').includes(t)));
      if (!heading) return false;
      heading.scrollIntoView({ block: 'center' });
      return true;
    }, targets).catch(() => false);
    if (found) return true;
    // Re-fetch the discussion list in case the just-created case has not propagated to the
    // dashboard yet (its /cases fetch may have run before the case was indexed).
    if (Date.now() - lastReload >= 20000 && isDashboardPage(page.url())) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitForDiscussionsLoaded(page);
      lastReload = Date.now();
    }
    await page.waitForTimeout(500);
  }
  return false;
}

// Diagnostic dump for a "could not open case from dashboard" failure: full-page screenshot
// plus the visible body text and the CG-ids currently on the dashboard, so we can see
// whether it was stuck on "Loading…", rendered other cards but not the target, etc.
async function dumpOpenCaseFailure(page, createdCase) {
  const body = (await readVisibleBodyText(page)).replace(/\s+/g, ' ').trim();
  const cgIdsOnDashboard = [...new Set(body.match(/CG-\d{3,4}/g) || [])];
  const shot = `${activeRunDir ?? '.'}/open-case-failed-${createdCase?.commonGroundId ?? 'case'}.png`;
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  return { shot, cgIdsOnDashboard, bodyText: body.slice(0, 1200) };
}

async function clickCaseCardButton(page, createdCase, buttonPattern) {
  // Wait for THIS case's card specifically (by its CG-id heading) and scroll it into view
  // before clicking — not just any card — so a slow/crowded dashboard or a late-rendering
  // just-created case doesn't cause a "could not find matching case-card button" miss.
  await waitForCaseCard(page, createdCase);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await clickCaseCardButtonOnce(page, createdCase, buttonPattern);
      return;
    } catch (error) {
      if (attempt >= 2) throw error;
      // Card/button not ready yet; wait for the specific card again and retry once.
      await waitForCaseCard(page, createdCase, 20000);
      await page.waitForTimeout(500);
    }
  }
}

async function clickCaseCardButtonOnce(page, createdCase, buttonPattern) {
  await page.evaluate(({ targets, patternSource, patternFlags, requireExactCaseMatch }) => {
    const pattern = new RegExp(patternSource, patternFlags);
    const headings = [...document.querySelectorAll('h1,h2,h3')];
    // Match by the case's own CG-id before falling back to case-type aliases:
    // with several same-type cards on the dashboard, an alias matches whichever
    // card renders first, which needn't be this case's.
    const idTargets = targets.filter((target) => /^CG-\d+/i.test(target));
    const aliasTargets = targets.filter((target) => !/^CG-\d+/i.test(target));
    const findHeading = (list) => headings.find((element) => list.some((target) => target && element.innerText.includes(target)));
    const targetHeading = findHeading(idTargets) ?? findHeading(aliasTargets);
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
    const { context, page } = await newAuthenticatedPage(browser, alignmentConfig, 'requestor');

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
  isPrimaryQuestionPrompt,
  evaluateExpectedPartnerBehavior,
  interviewReadySignal,
  excerptReviewReady,
  clarifyContextReady,
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

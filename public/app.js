const fields = {
  caseType: document.querySelector('#caseType'),
  runMode: document.querySelector('#runMode'),
  existingCaseId: document.querySelector('#existingCaseId'),
  existingCaseIdField: document.querySelector('#existingCaseIdField'),
  factRatingStage: document.querySelector('#factRatingStage'),
  factRatingStageField: document.querySelector('#factRatingStageField'),
  alignmentScenario: document.querySelector('#alignmentScenario'),
  numberOfCases: document.querySelector('#numberOfCases'),
  personaMode: document.querySelector('#personaMode'),
  maxTurns: document.querySelector('#maxTurns'),
  scenarioSeed: document.querySelector('#scenarioSeed'),
  stopOnFailure: document.querySelector('#stopOnFailure'),
  testObjective: document.querySelector('#testObjective'),
  headed: document.querySelector('#headed'),
  scriptedEnabled: document.querySelector('#scriptedEnabled'),
  scriptedAnswersPath: document.querySelector('#scriptedAnswersPath'),
  scriptedAnswersField: document.querySelector('#scriptedAnswersField'),
  behaviorCount: document.querySelector('#behaviorCount'),
  draftCaseType: document.querySelector('#draftCaseType'),
  draftSourceFile: document.querySelector('#draftSourceFile'),
  draftDescription: document.querySelector('#draftDescription'),
  draftRequestor: document.querySelector('#draftRequestor'),
  draftParticipant: document.querySelector('#draftParticipant'),
  draftTerms: document.querySelector('#draftTerms'),
  draftRatingScale: document.querySelector('#draftRatingScale')
};

const elements = {
  envSummary: document.querySelector('#envSummary'),
  startRun: document.querySelector('#startRun'),
  stopRun: document.querySelector('#stopRun'),
  topicUnsupported: document.querySelector('#topicUnsupported'),
  scriptedScenarioNotice: document.querySelector('#scriptedScenarioNotice'),
  scenarioDescription: document.querySelector('#scenarioDescription'),
  alignmentRange: document.querySelector('#alignmentRange'),
  scenarioRatings: document.querySelector('#scenarioRatings'),
  resetSchedule: document.querySelector('#resetSchedule'),
  eligiblePoolSummary: document.querySelector('#eligiblePoolSummary'),
  compatibilityWarnings: document.querySelector('#compatibilityWarnings'),
  behaviorEditor: document.querySelector('#behaviorEditor'),
  topicDefinitionSummary: document.querySelector('#topicDefinitionSummary'),
  topicTerms: document.querySelector('#topicTerms'),
  statusPill: document.querySelector('#statusPill'),
  runSummary: document.querySelector('#runSummary'),
  artifactDir: document.querySelector('#artifactDir'),
  caseId: document.querySelector('#caseId'),
  coverageTotal: document.querySelector('#coverageTotal'),
  softFailureTotal: document.querySelector('#softFailureTotal'),
  alignmentScore: document.querySelector('#alignmentScore'),
  personaStatus: document.querySelector('#personaStatus'),
  behaviorTimeline: document.querySelector('#behaviorTimeline'),
  scenarioExpressions: document.querySelector('#scenarioExpressions'),
  softAssertions: document.querySelector('#softAssertions'),
  logs: document.querySelector('#logs'),
  runHistory: document.querySelector('#runHistory'),
  refreshHistory: document.querySelector('#refreshHistory'),
  runnerWorkspace: document.querySelector('#runnerWorkspace'),
  topicSetupWorkspace: document.querySelector('#topicSetupWorkspace'),
  showRunner: document.querySelector('#showRunner'),
  showTopicSetup: document.querySelector('#showTopicSetup'),
  draftStatus: document.querySelector('#draftStatus'),
  generationStatus: document.querySelector('#generationStatus'),
  generateTopicDraft: document.querySelector('#generateTopicDraft'),
  newTopicDraft: document.querySelector('#newTopicDraft'),
  refreshDrafts: document.querySelector('#refreshDrafts'),
  draftLibrary: document.querySelector('#draftLibrary'),
  draftReviewPanel: document.querySelector('#draftReviewPanel'),
  draftTermEditor: document.querySelector('#draftTermEditor'),
  draftQuestionEditor: document.querySelector('#draftQuestionEditor'),
  draftValidation: document.querySelector('#draftValidation'),
  saveTopicDraft: document.querySelector('#saveTopicDraft'),
  publishTopicDraft: document.querySelector('#publishTopicDraft'),
  addDraftQuestion: document.querySelector('#addDraftQuestion')
};

let polling = null;
let viewingHistory = false;
let caseTypes = [];
let qualityCriteria = null;
let scenarioData = null;
let scriptedAnswerFiles = [];
let stopOnFailureTouched = false;

// Mirror the CLI batch default: a single case stops on failure, a multi-case
// batch continues, unless the user has explicitly picked a value themselves.
function syncStopOnFailureDefault() {
  if (stopOnFailureTouched) return;
  fields.stopOnFailure.value = Number(fields.numberOfCases.value) > 1 ? 'false' : 'true';
}
let behaviorSchedule = null;
let topicDrafts = [];
let activeTopicDraft = null;

boot();

fields.runMode.addEventListener('change', updateModeFields);
fields.caseType.addEventListener('change', () => loadTopic(fields.caseType.value));
fields.alignmentScenario.addEventListener('change', renderScenarioPreview);
fields.behaviorCount.addEventListener('input', updateScheduleSummary);
fields.numberOfCases.addEventListener('input', syncStopOnFailureDefault);
fields.stopOnFailure.addEventListener('change', () => { stopOnFailureTouched = true; });
elements.resetSchedule.addEventListener('click', () => {
  if (!scenarioData?.defaultBehaviorSchedule) return;
  behaviorSchedule = structuredClone(scenarioData.defaultBehaviorSchedule);
  fields.behaviorCount.value = behaviorSchedule.behaviorCountPerActor;
  renderBehaviorEditor();
});

elements.startRun.addEventListener('click', async () => {
  try {
    const payload = collectPayload();
    elements.startRun.disabled = true;
    await api('/api/run', { method: 'POST', body: JSON.stringify(payload) });
    returnToLiveView();
    startPolling();
  } catch (error) {
    elements.startRun.disabled = false;
    alert(error.message);
  }
});

elements.runHistory.addEventListener('change', () => {
  const id = elements.runHistory.value;
  if (id) viewHistoricalRun(id);
  else returnToLiveView();
});
elements.refreshHistory.addEventListener('click', loadRunHistory);

elements.stopRun.addEventListener('click', async () => {
  await api('/api/stop', { method: 'POST', body: '{}' });
  startPolling();
});

fields.scriptedEnabled.addEventListener('change', updateScriptedAnswersField);
fields.scriptedAnswersPath.addEventListener('change', applyScriptedScenario);

elements.showRunner.addEventListener('click', () => showWorkspace('runner'));
elements.showTopicSetup.addEventListener('click', () => showWorkspace('topic'));
elements.refreshDrafts.addEventListener('click', loadTopicDrafts);
elements.newTopicDraft.addEventListener('click', clearTopicDraft);
elements.generateTopicDraft.addEventListener('click', generateDraftFromSource);
elements.saveTopicDraft.addEventListener('click', () => persistTopicDraft(false));
elements.publishTopicDraft.addEventListener('click', () => persistTopicDraft(true));
elements.addDraftQuestion.addEventListener('click', () => {
  if (!activeTopicDraft) return;
  activeTopicDraft.primaryQuestions.push(emptyDraftQuestion(activeTopicDraft));
  renderTopicDraftEditor();
});
elements.draftTermEditor.addEventListener('click', handleDraftEditorClick);
elements.draftQuestionEditor.addEventListener('click', handleDraftEditorClick);

async function boot() {
  const defaults = await api('/api/defaults');
  caseTypes = defaults.caseTypes ?? [];
  populateCaseTypes(caseTypes, defaults.runConfig.caseType);
  fields.runMode.value = defaults.runConfig.runMode ?? 'full_workflow';
  fields.numberOfCases.value = defaults.runConfig.numberOfCases ?? 1;
  fields.maxTurns.value = defaults.runConfig.maxTurns ?? 50;
  fields.testObjective.value = defaults.runConfig.testObjective ?? '';
  fields.stopOnFailure.value = String(defaults.runConfig.stopOnFailure ?? true);
  syncStopOnFailureDefault();
  fields.personaMode.value = personaModeLabel(defaults.personas);
  fields.personaMode.title = (defaults.personas?.personas ?? []).map((p) => p.id).join(', ') || 'No personas configured';
  fields.scenarioSeed.value = defaults.runConfig.scenarioSeed ?? '';
  elements.envSummary.textContent = [
    defaults.productionUrl ? `Target: ${defaults.productionUrl}` : 'Target URL missing',
    defaults.hasOpenAiKey ? 'OpenAI configured' : 'OpenAI key missing',
    `UI build: ${defaults.uiBuild ?? 'unknown'}`
  ].join(' | ');
  updateModeFields();
  await loadScriptedAnswerFiles();
  await applyScenarioData(defaults.scenarioData, defaults.qualityCriteria, defaults.runConfig.alignmentScenarioId);
  await loadTopicDrafts();
  await loadRunHistory();
  await updateStatus();
}

async function loadScriptedAnswerFiles() {
  let files = [];
  try {
    files = (await api('/api/scripted-answers')).files ?? [];
  } catch {
    files = [];
  }
  scriptedAnswerFiles = files;
  fields.scriptedAnswersPath.innerHTML = files.length
    ? files.map((file) => `<option value="${file.path}">${file.name}</option>`).join('')
    : '<option value="">No files in config/scripted-answers</option>';
  const hasFiles = files.length > 0;
  fields.scriptedEnabled.disabled = !hasFiles;
  if (!hasFiles) fields.scriptedEnabled.checked = false;
  updateScriptedAnswersField();
}

function updateScriptedAnswersField() {
  const enabled = fields.scriptedEnabled.checked;
  fields.scriptedAnswersField.hidden = !enabled;
  if (enabled) {
    applyScriptedScenario();
  } else {
    elements.scriptedScenarioNotice.hidden = true;
  }
}

// Keep the Named Scenario field in sync with the selected scripted-answer file.
// The file's embedded alignmentScenarioId already wins at runtime (src/config.js),
// so mirroring it here prevents a misleading/stale scenario in the UI. Files with
// no embedded id, or an id not valid for the current case type, leave the field
// untouched and surface a visible warning instead of guessing.
function applyScriptedScenario() {
  const notice = elements.scriptedScenarioNotice;
  const hideNotice = () => { notice.hidden = true; notice.textContent = ''; };
  if (!fields.scriptedEnabled.checked) { hideNotice(); return; }
  const file = scriptedAnswerFiles.find((item) => item.path === fields.scriptedAnswersPath.value);
  if (!file) { hideNotice(); return; }
  const scenarioId = file.alignmentScenarioId;
  if (!scenarioId) {
    notice.textContent = `"${file.name}" has no embedded scenario (alignmentScenarioId). Named Scenario left unchanged — set it manually to match this file.`;
    notice.hidden = false;
    return;
  }
  const known = [...fields.alignmentScenario.options].some((option) => option.value === scenarioId);
  if (!known) {
    notice.textContent = `"${file.name}" targets scenario "${scenarioId}", which is not available for the current case type. Named Scenario left unchanged.`;
    notice.hidden = false;
    return;
  }
  if (fields.alignmentScenario.value !== scenarioId) {
    fields.alignmentScenario.value = scenarioId;
    renderScenarioPreview();
  }
  hideNotice();
}

async function loadTopic(caseType) {
  const [criteriaResult, scenarioResult] = await Promise.all([
    api(`/api/criteria?caseType=${encodeURIComponent(caseType)}`),
    api(`/api/scenario-data?caseType=${encodeURIComponent(caseType)}`)
  ]);
  await applyScenarioData(scenarioResult, criteriaResult.qualityCriteria);
  // Repopulating scenarios for the new case type resets the Named Scenario
  // field; re-sync it to the active scripted file so a case-type change cannot
  // drift the two out of alignment.
  applyScriptedScenario();
}

async function applyScenarioData(data, criteria, selectedScenarioId = '') {
  scenarioData = data;
  qualityCriteria = criteria;
  elements.topicUnsupported.hidden = Boolean(data?.supported);
  elements.startRun.disabled = !data?.supported;

  if (!data?.supported) {
    elements.topicUnsupported.textContent = data?.message ?? 'Structured scenarios are unavailable for this topic.';
    fields.alignmentScenario.innerHTML = '';
    elements.scenarioRatings.innerHTML = '';
    elements.behaviorEditor.innerHTML = '';
    elements.topicTerms.innerHTML = '';
    return;
  }

  behaviorSchedule = structuredClone(data.defaultBehaviorSchedule);
  fields.behaviorCount.value = behaviorSchedule.behaviorCountPerActor;
  populateScenarios(data.alignmentScenarios, selectedScenarioId || data.alignmentScenarios[0]?.id);
  renderScenarioPreview();
  renderTopicDefinition();
  renderBehaviorEditor();
}

function populateCaseTypes(items, selectedValue) {
  fields.caseType.innerHTML = '';
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.caseType;
    option.textContent = item.caseType;
    fields.caseType.append(option);
  }
  fields.caseType.value = selectedValue;
  if (!fields.caseType.value && items.length) fields.caseType.value = items[0].caseType;
}

function populateScenarios(scenarios, selectedId) {
  fields.alignmentScenario.innerHTML = '';
  for (const scenario of scenarios) {
    const option = document.createElement('option');
    option.value = scenario.id;
    option.textContent = scenario.name;
    fields.alignmentScenario.append(option);
  }
  fields.alignmentScenario.value = selectedId;
  if (!fields.alignmentScenario.value && scenarios.length) fields.alignmentScenario.value = scenarios[0].id;
}

function renderScenarioPreview() {
  const scenario = selectedScenario();
  if (!scenario || !scenarioData?.topic) return;
  elements.scenarioDescription.textContent = scenario.description;
  elements.alignmentRange.textContent = formatRange(scenario.expectedAlignmentRange);
  elements.scenarioRatings.innerHTML = scenarioData.topic.terms.map((term) => `
    <tr>
      <th>${escapeHtml(term.label)}</th>
      <td>${ratingLabel(scenario.ratings.requestor[term.id])}</td>
      <td>${ratingLabel(scenario.ratings.participant[term.id])}</td>
    </tr>
  `).join('');
}

function renderTopicDefinition() {
  const topic = scenarioData.topic;
  const criteriaCount = topic.primaryQuestions.reduce((total, question) => total + question.highQualityCriteria.length, 0);
  elements.topicDefinitionSummary.textContent = `${topic.primaryQuestions.length} primary questions, ${criteriaCount} criteria, ${topic.terms.length} performance terms, ${Math.round(topic.workflow.postProcessingTimeoutMs / 60000)} minute post-processing timeout.`;
  elements.topicTerms.innerHTML = topic.terms.map((term) => `
    <div class="term-item">
      <strong>${escapeHtml(term.label)}</strong>
      <span>${escapeHtml(term.description)}</span>
    </div>
  `).join('');
}

function renderBehaviorEditor() {
  if (!behaviorSchedule || !scenarioData) return;
  const definitions = new Map(scenarioData.behaviorCatalog.behaviors.map((item) => [item.id, item]));
  elements.behaviorEditor.innerHTML = behaviorSchedule.behaviors.map((item, index) => {
    const definition = definitions.get(item.behaviorId);
    return `
      <article class="behavior-row" data-index="${index}">
        <label class="behavior-enable">
          <input type="checkbox" data-field="enabled" ${item.enabled ? 'checked' : ''}>
          <span></span>
        </label>
        <div class="behavior-copy">
          <strong>${escapeHtml(definition?.name ?? item.behaviorId)}</strong>
          <p>${escapeHtml(definition?.description ?? '')}</p>
          <span class="stage-note">${definition?.stages.length ?? 1} stage${definition?.stages.length === 1 ? '' : 's'}</span>
        </div>
        <label>
          <span>Target</span>
          <select data-field="targetMode">
            ${targetModeOptions(item.target.mode)}
          </select>
        </label>
        <label class="target-value-field">
          <span>Question / criterion</span>
          <select data-field="targetValue">${targetValueOptions(item.target)}</select>
        </label>
        ${item.behaviorId === 'fatigue_expression' ? `
          <label>
            <span>Fatigue</span>
            <select data-field="fatigueLevel">
              ${['low', 'moderate', 'high', 'critical'].map((level) => `<option value="${level}" ${item.fatigueLevel === level ? 'selected' : ''}>${titleCase(level)}</option>`).join('')}
            </select>
          </label>` : '<div></div>'}
        <label>
          <span>Combine with</span>
          <select data-field="combineWith">
            <option value="">None</option>
            ${scenarioData.behaviorCatalog.behaviors.filter((candidate) => candidate.id !== item.behaviorId).map((candidate) => `<option value="${candidate.id}" ${(item.combineWith ?? []).includes(candidate.id) ? 'selected' : ''}>${escapeHtml(candidate.name)}</option>`).join('')}
          </select>
        </label>
      </article>
    `;
  }).join('');

  elements.behaviorEditor.querySelectorAll('.behavior-row').forEach((row) => {
    const index = Number(row.dataset.index);
    row.querySelectorAll('[data-field]').forEach((control) => {
      control.addEventListener('change', () => updateBehaviorItem(index, control.dataset.field, control));
    });
    updateTargetFieldVisibility(row);
  });
  updateScheduleSummary();
}

function updateBehaviorItem(index, field, control) {
  const item = behaviorSchedule.behaviors[index];
  if (field === 'enabled') item.enabled = control.checked;
  if (field === 'fatigueLevel') item.fatigueLevel = control.value;
  if (field === 'combineWith') item.combineWith = control.value ? [control.value] : [];
  if (field === 'targetMode') {
    item.target = makeTarget(control.value);
    const row = control.closest('.behavior-row');
    row.querySelector('[data-field="targetValue"]').innerHTML = targetValueOptions(item.target);
    updateTargetFieldVisibility(row);
  }
  if (field === 'targetValue') applyTargetValue(item.target, control.value);
  updateScheduleSummary();
}

function updateScheduleSummary() {
  if (!behaviorSchedule || !scenarioData) return;
  behaviorSchedule.behaviorCountPerActor = Math.max(1, Number(fields.behaviorCount.value) || 1);
  const enabled = behaviorSchedule.behaviors.filter((item) => item.enabled);
  const stageCount = enabled.reduce((count, item) => {
    const definition = scenarioData.behaviorCatalog.behaviors.find((candidate) => candidate.id === item.behaviorId);
    return count + (definition?.stages.length ?? 1);
  }, 0);
  elements.eligiblePoolSummary.textContent =
    `${enabled.length} behavior${enabled.length === 1 ? '' : 's'} / ${stageCount} stage${stageCount === 1 ? '' : 's'}`;

  const warnings = compatibilityWarnings();
  if (enabled.length < behaviorSchedule.behaviorCountPerActor) warnings.unshift(`Enable at least ${behaviorSchedule.behaviorCountPerActor} behaviors; only ${enabled.length} are currently eligible.`);
  elements.compatibilityWarnings.hidden = warnings.length === 0;
  elements.compatibilityWarnings.innerHTML = warnings.map((warning) => `<div>${escapeHtml(warning)}</div>`).join('');
}

function compatibilityWarnings() {
  const definitions = new Map(scenarioData.behaviorCatalog.behaviors.map((item) => [item.id, item]));
  const warnings = [];
  for (const item of behaviorSchedule.behaviors.filter((candidate) => candidate.enabled)) {
    const definition = definitions.get(item.behaviorId);
    for (const combinedId of item.combineWith ?? []) {
      const combined = definitions.get(combinedId);
      if (!combined) continue;
      if (definition.incompatibleWith.includes(combinedId) || combined.incompatibleWith.includes(item.behaviorId)) {
        warnings.push(`${definition.name} cannot be combined with ${combined.name}.`);
      }
    }
  }
  return warnings;
}

function targetModeOptions(selected) {
  const options = [
    ['random_primary_question', 'Random primary question'],
    ['random_criterion', 'Random criterion'],
    ['primary_question', 'Specific primary question'],
    ['criterion', 'Specific criterion']
  ];
  return options.map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('');
}

function targetValueOptions(target) {
  if (!scenarioData?.topic) return '';
  if (target.mode === 'primary_question') {
    return scenarioData.topic.primaryQuestions.map((question) => `<option value="${question.id}" ${target.primaryQuestionId === question.id ? 'selected' : ''}>${escapeHtml(question.discussionArea)}</option>`).join('');
  }
  if (target.mode === 'criterion') {
    return scenarioData.topic.primaryQuestions.flatMap((question) => question.highQualityCriteria.map((criterion) => `<option value="${question.id}|${criterion.id}" ${target.criterionId === criterion.id ? 'selected' : ''}>${escapeHtml(question.discussionArea)}: ${escapeHtml(shorten(criterion.requirement, 72))}</option>`)).join('');
  }
  return '<option value="">Resolved from the recorded seed</option>';
}

function updateTargetFieldVisibility(row) {
  const mode = row.querySelector('[data-field="targetMode"]').value;
  row.querySelector('.target-value-field').classList.toggle('muted-control', mode.startsWith('random_'));
  row.querySelector('[data-field="targetValue"]').disabled = mode.startsWith('random_');
}

function makeTarget(mode) {
  if (mode === 'random_primary_question') return { mode, excludePrimaryQuestionIds: [] };
  if (mode === 'random_criterion') return { mode, excludeCriterionIds: [] };
  if (mode === 'primary_question') return { mode, primaryQuestionId: scenarioData.topic.primaryQuestions[0].id };
  const question = scenarioData.topic.primaryQuestions[0];
  return { mode: 'criterion', primaryQuestionId: question.id, criterionId: question.highQualityCriteria[0].id };
}

function applyTargetValue(target, value) {
  if (target.mode === 'primary_question') target.primaryQuestionId = value;
  if (target.mode === 'criterion') {
    const [primaryQuestionId, criterionId] = value.split('|');
    target.primaryQuestionId = primaryQuestionId;
    target.criterionId = criterionId;
  }
}

function collectPayload() {
  if (!scenarioData?.supported) throw new Error('Select a topic with an approved structured scenario definition.');
  updateScheduleSummary();
  const warnings = compatibilityWarnings();
  if (warnings.length) throw new Error(warnings.join(' '));
  const enabled = behaviorSchedule.behaviors.filter((item) => item.enabled).length;
  if (enabled < behaviorSchedule.behaviorCountPerActor) throw new Error(`Enable at least ${behaviorSchedule.behaviorCountPerActor} behaviors.`);

  const runMode = fields.runMode.value;
  const existingCaseId = ['participant_getting_started', 'fact_labeling_smoke'].includes(runMode)
    ? normalizeCaseId(fields.existingCaseId.value)
    : '';
  if (['participant_getting_started', 'fact_labeling_smoke'].includes(runMode) && !existingCaseId) {
    throw new Error('This mode requires a Common Ground Case ID.');
  }

  const scheduleBaseName = behaviorSchedule.name.replace(/(?:\s+- Run Copy)+$/i, '');
  behaviorSchedule = {
    ...behaviorSchedule,
    id: `${behaviorSchedule.id}_edited`,
    name: `${scheduleBaseName} - Run Copy`,
    builtIn: false,
    editableCopy: true,
    behaviorCountPerActor: Number(fields.behaviorCount.value)
  };

  return {
    headed: fields.headed.checked,
    runConfig: {
      topic: scenarioData.topic.caseType,
      caseType: fields.caseType.value,
      runMode,
      existingCaseId,
      factRatingStage: fields.factRatingStage.value,
      workflowScope: runMode === 'full_workflow' ? 'requestor_participant' : runMode === 'participant_getting_started' ? 'participant' : 'requestor',
      testObjective: fields.testObjective.value.trim(),
      alignmentScenarioId: fields.alignmentScenario.value,
      scenarioSeed: fields.scenarioSeed.value.trim(),
      numberOfCases: Number(fields.numberOfCases.value),
      maxTurns: Number(fields.maxTurns.value),
      stopOnFailure: fields.stopOnFailure.value === 'true',
      qualityCriteriaPath: scenarioData.criteriaPath,
      scriptedAnswersPath: fields.scriptedEnabled.checked ? fields.scriptedAnswersPath.value : ''
    },
    qualityCriteria,
    behaviorSchedule
  };
}

function updateModeFields() {
  const participantOnly = fields.runMode.value === 'participant_getting_started';
  const smokeTest = fields.runMode.value === 'fact_labeling_smoke';
  const existingCaseMode = participantOnly || smokeTest;
  fields.existingCaseIdField.hidden = !existingCaseMode;
  fields.factRatingStageField.hidden = !smokeTest;
  fields.numberOfCases.disabled = existingCaseMode;
  if (existingCaseMode) fields.numberOfCases.value = 1;
  else fields.existingCaseId.value = '';
}

function startPolling() {
  if (polling) clearInterval(polling);
  updateStatus();
  polling = setInterval(updateStatus, 1500);
}

async function updateStatus() {
  // While viewing a saved run, do not let the live poller overwrite the panels.
  if (viewingHistory) return;
  const run = await api('/api/run');
  const status = run.status ?? 'idle';
  elements.statusPill.textContent = status;
  elements.statusPill.className = `pill ${status}`;
  elements.artifactDir.textContent = run.artifactDir ?? '-';
  elements.logs.textContent = (run.logs ?? []).join('\n');
  elements.logs.scrollTop = elements.logs.scrollHeight;

  const summaryCase = run.summary?.cases?.[0];
  const artifactCase = run.artifactView?.cases?.[0];
  elements.caseId.textContent = artifactCase?.caseId ?? summaryCase?.caseId ?? '-';
  elements.runSummary.textContent = summaryCase
    ? `Case 1: ${summaryCase.status}${summaryCase.stopReason ? ` - ${summaryCase.stopReason}` : ''}`
    : status === 'running' ? 'Run in progress.' : 'No completed run summary.';
  renderArtifactView(artifactCase);
  renderPersonaStatus(run.currentPersona, run.artifactView?.cases);

  const running = status === 'running' || status === 'stopping';
  elements.startRun.disabled = running || !scenarioData?.supported;
  elements.stopRun.disabled = !running;
  if (!running && polling) {
    clearInterval(polling);
    polling = null;
    loadRunHistory();
  }
}

async function loadRunHistory() {
  let runs = [];
  try {
    runs = (await api('/api/runs')).runs ?? [];
  } catch (error) {
    console.warn('Failed to load run history:', error.message);
    return;
  }
  const selected = elements.runHistory.value;
  elements.runHistory.innerHTML = '<option value="">Live (current run)</option>';
  for (const run of runs) {
    const option = document.createElement('option');
    option.value = run.id; // internal key stays the run-id/timestamp
    const label = run.caseId || run.id; // show Case ID, fall back to timestamp
    option.textContent = `${label}${run.status ? ` — ${run.status}` : ''}`;
    elements.runHistory.append(option);
  }
  if (selected && runs.some((run) => run.id === selected)) elements.runHistory.value = selected;
}

async function viewHistoricalRun(id) {
  if (polling) {
    clearInterval(polling);
    polling = null;
  }
  viewingHistory = true;
  let detail;
  try {
    detail = await api(`/api/run-detail?id=${encodeURIComponent(id)}`);
  } catch (error) {
    viewingHistory = false;
    alert(error.message);
    return;
  }
  const status = detail.status ?? 'unknown';
  elements.statusPill.textContent = status;
  elements.statusPill.className = `pill ${status}`;
  elements.artifactDir.textContent = detail.artifactDir ?? '-';
  elements.logs.textContent = detail.report || '(No saved run-report.txt for this run.)';
  elements.logs.scrollTop = 0;

  const summaryCase = detail.summary?.cases?.[0];
  const artifactCase = detail.artifactView?.cases?.[0];
  elements.caseId.textContent = artifactCase?.caseId ?? summaryCase?.caseId ?? '-';
  elements.runSummary.textContent = `Viewing saved run ${detail.id}${summaryCase ? ` — Case 1: ${summaryCase.status}` : ''}`;
  renderArtifactView(artifactCase);
  renderPersonaStatus(null, detail.artifactView?.cases);

  // Live controls stay inert while viewing history.
  elements.stopRun.disabled = true;
  elements.startRun.disabled = !scenarioData?.supported;
}

function returnToLiveView() {
  viewingHistory = false;
  elements.runHistory.value = '';
  startPolling();
}

// Read-only persona mode label for Run Setup. Count comes from the server catalog,
// so adding a persona to config/personas/catalog.json needs no UI change.
function personaModeLabel(personas) {
  if (!personas || personas.mode === 'off' || !personas.personaCount) return 'Off';
  if (personas.mode === 'pinned') return `Pinned — ${personas.pinnedId ?? '?'}`;
  const n = personas.personaIds?.length || personas.personaCount;
  return `Rotation — ${n} persona${n === 1 ? '' : 's'}`;
}

// Show the persona of the current/last case (display-only). Prefer the live
// in-flight persona from /api/run; fall back to the last case's flushed run.json.
function renderPersonaStatus(currentPersona, cases) {
  const source = currentPersona?.id
    ? currentPersona
    : (cases ?? [])[(cases ?? []).length - 1]?.persona ?? null;
  const caseNumber = currentPersona?.id
    ? currentPersona.caseNumber
    : (cases ?? [])[(cases ?? []).length - 1]?.caseNumber;
  elements.personaStatus.textContent = source?.id
    ? `Case ${caseNumber ?? '?'} persona: ${source.id} (${source.polish}/${source.detail})`
    : '—';
}

function renderArtifactView(artifact) {
  if (!artifact) {
    elements.coverageTotal.textContent = '-';
    elements.softFailureTotal.textContent = '-';
    elements.alignmentScore.textContent = '-';
    elements.behaviorTimeline.className = 'empty-state';
    elements.behaviorTimeline.textContent = 'Behavior executions will appear after a run.';
    elements.scenarioExpressions.className = 'empty-state';
    elements.scenarioExpressions.textContent = 'Question relationships will appear after scenario generation.';
    elements.softAssertions.className = 'empty-state';
    elements.softAssertions.textContent = 'No soft assertions recorded.';
    return;
  }

  const coverage = artifact.behaviorCoverage?.byActor;
  elements.coverageTotal.textContent = coverage
    ? `Employee ${coverage.requestor.completedBehaviors}/${coverage.requestor.assignedBehaviors}; Manager ${coverage.participant.completedBehaviors}/${coverage.participant.assignedBehaviors}`
    : '-';
  const failedAssertions = (artifact.softAssertions ?? []).filter((item) => !item.passed);
  elements.softFailureTotal.textContent = String(failedAssertions.length);
  elements.alignmentScore.textContent = artifact.alignmentReport?.score == null
    ? 'Not detected'
    : `${artifact.alignmentReport.score}${artifact.alignmentReport.withinExpectedRange === false ? ' (outside recorded range)' : ''}`;

  renderTimeline(artifact.behaviorExecutions ?? []);
  renderScenarioExpressions(artifact.scenarioExpressionPlan?.questionExpressions ?? []);
  renderAssertions(artifact.softAssertions ?? []);
}

function renderScenarioExpressions(expressions) {
  if (!expressions.length) {
    elements.scenarioExpressions.className = 'empty-state';
    elements.scenarioExpressions.textContent = 'Question relationships will appear after scenario generation.';
    return;
  }
  elements.scenarioExpressions.className = 'table-wrap';
  elements.scenarioExpressions.innerHTML = `
    <table class="contrast-table">
      <thead><tr><th>Primary question</th><th>Expected relationship</th><th>Employee</th><th>Manager</th><th>Explanation</th></tr></thead>
      <tbody>${expressions.map((item) => `
        <tr>
          <th>${escapeHtml(questionLabel(item.primaryQuestionId))}</th>
          <td>${escapeHtml(String(item.expectedRelationship).replaceAll('_', ' '))}</td>
          <td>${escapeHtml(item.employeeOpeningStatement)}</td>
          <td>${escapeHtml(item.managerOpeningStatement)}</td>
          <td class="difference">${escapeHtml(item.relationshipExplanation)}</td>
        </tr>
      `).join('')}</tbody>
    </table>`;
}

function renderTimeline(executions) {
  if (!executions.length) {
    elements.behaviorTimeline.className = 'empty-state';
    elements.behaviorTimeline.textContent = 'Behavior executions will appear after a run.';
    return;
  }
  elements.behaviorTimeline.className = 'timeline';
  elements.behaviorTimeline.innerHTML = executions.map((item) => `
    <article class="timeline-item">
      <div class="timeline-meta">
        <span class="actor-badge">${item.actor === 'requestor' ? 'Employee' : 'Manager'}</span>
        <span>Turn ${item.turn}</span>
        ${item.observedQfi == null ? '' : `<span>QFI ${item.observedQfi}</span>`}
        ${item.observedIntent ? `<span>Intent ${escapeHtml(item.observedIntent)}</span>` : ''}
        ${item.observedQor ? `<span>QoR ${escapeHtml(item.observedQor)}</span>` : ''}
      </div>
      <strong>${item.behaviorIds.map(behaviorName).join(' + ')}</strong>
      <p>${escapeHtml(questionLabel(item.primaryQuestionId))}</p>
      <span class="result-mark ${item.syntheticUserCompliant ? 'pass' : 'fail'}">${item.syntheticUserCompliant ? 'Synthetic response compliant' : 'Synthetic response missed behavior'}</span>
    </article>
  `).join('');
}

function renderAssertions(assertions) {
  if (!assertions.length) {
    elements.softAssertions.className = 'empty-state';
    elements.softAssertions.textContent = 'No soft assertions recorded.';
    return;
  }
  elements.softAssertions.className = 'assertion-list';
  elements.softAssertions.innerHTML = assertions.map((item) => `
    <article class="assertion-item ${item.passed ? 'passed' : 'failed'}">
      <span class="result-mark ${item.passed ? 'pass' : 'fail'}">${item.passed ? 'Passed' : 'Missed'}</span>
      <div><strong>${escapeHtml(titleCase(item.type.replaceAll('_', ' ')))}</strong><p>Expected: ${escapeHtml(item.expected)}</p><p>Observed: ${escapeHtml(shorten(item.observed, 240))}</p></div>
    </article>
  `).join('');
}

function showWorkspace(name) {
  const topicVisible = name === 'topic';
  elements.runnerWorkspace.hidden = topicVisible;
  elements.topicSetupWorkspace.hidden = !topicVisible;
  elements.showRunner.classList.toggle('active', !topicVisible);
  elements.showTopicSetup.classList.toggle('active', topicVisible);
  document.querySelector('.header-actions').hidden = topicVisible;
}

async function loadTopicDrafts() {
  const result = await api('/api/topic-drafts');
  topicDrafts = result.drafts ?? [];
  renderDraftLibrary();
}

function renderDraftLibrary() {
  if (!topicDrafts.length) {
    elements.draftLibrary.className = 'draft-library empty-state';
    elements.draftLibrary.textContent = 'No drafts yet.';
    return;
  }
  elements.draftLibrary.className = 'draft-library';
  elements.draftLibrary.innerHTML = topicDrafts.map((draft) => `
    <button type="button" class="draft-list-item ${draft.id === activeTopicDraft?.id ? 'selected' : ''}" data-draft-id="${escapeHtml(draft.id)}">
      <strong>${escapeHtml(draft.caseType)}</strong>
      <span>${escapeHtml(titleCase(draft.status))} · ${escapeHtml(new Date(draft.updatedAt).toLocaleString())}</span>
      <span>${draft.primaryQuestions.length} questions · ${draft.terms.length} terms</span>
    </button>
  `).join('');
  elements.draftLibrary.querySelectorAll('[data-draft-id]').forEach((button) => {
    button.addEventListener('click', () => openTopicDraft(button.dataset.draftId));
  });
}

async function openTopicDraft(id) {
  const result = await api(`/api/topic-draft?id=${encodeURIComponent(id)}`);
  activeTopicDraft = result.draft;
  populateDraftMetadata(activeTopicDraft);
  renderTopicDraftEditor();
  renderDraftLibrary();
  setDraftStep(activeTopicDraft.status === 'published' ? 'publish' : 'review');
}

function clearTopicDraft() {
  activeTopicDraft = null;
  fields.draftCaseType.value = '';
  fields.draftSourceFile.value = '';
  fields.draftDescription.value = '';
  fields.draftRequestor.checked = true;
  fields.draftParticipant.checked = true;
  fields.draftTerms.value = '';
  fields.draftRatingScale.value = '';
  elements.draftReviewPanel.hidden = true;
  elements.draftStatus.textContent = 'No draft';
  elements.generationStatus.textContent = '';
  renderDraftLibrary();
  setDraftStep('source');
}

async function generateDraftFromSource() {
  try {
    const file = fields.draftSourceFile.files[0];
    const caseType = fields.draftCaseType.value.trim();
    if (!caseType) throw new Error('Enter a topic name.');
    if (!file) throw new Error('Choose a .docx source document.');
    if (!file.name.toLowerCase().endsWith('.docx')) throw new Error('The source must be a .docx Word document.');
    const actors = selectedDraftActors();
    if (!actors.length) throw new Error('Select at least one workflow actor.');
    const ratingScale = parseOptionalJson(fields.draftRatingScale.value, 'rating scale');
    elements.generateTopicDraft.disabled = true;
    elements.generationStatus.textContent = 'Extracting the document and generating a review draft...';
    const result = await api('/api/topic-draft/generate', {
      method: 'POST',
      body: JSON.stringify({
        fileName: file.name,
        fileBase64: await fileToBase64(file),
        caseType,
        description: fields.draftDescription.value.trim(),
        actors,
        terms: parseTermLines(fields.draftTerms.value),
        ratingScale
      })
    });
    activeTopicDraft = result.draft;
    populateDraftMetadata(activeTopicDraft);
    renderTopicDraftEditor();
    await loadTopicDrafts();
    elements.generationStatus.textContent = 'Draft generated. Review every question, criterion, and mapping before approval.';
    setDraftStep('review');
  } catch (error) {
    elements.generationStatus.textContent = error.message;
  } finally {
    elements.generateTopicDraft.disabled = false;
  }
}

function populateDraftMetadata(draft) {
  fields.draftCaseType.value = draft.caseType;
  fields.draftDescription.value = draft.description;
  fields.draftRequestor.checked = draft.workflow.actors.includes('requestor');
  fields.draftParticipant.checked = draft.workflow.actors.includes('participant');
  fields.draftTerms.value = draft.terms.map((term) => `${term.label} | ${term.description}`).join('\n');
  fields.draftRatingScale.value = '';
  elements.draftStatus.textContent = titleCase(draft.status);
  elements.draftReviewPanel.hidden = false;
  const published = draft.status === 'published';
  elements.saveTopicDraft.disabled = published;
  elements.publishTopicDraft.disabled = published;
}

function renderTopicDraftEditor() {
  if (!activeTopicDraft) return;
  const readOnly = activeTopicDraft.status === 'published' ? 'disabled' : '';
  elements.draftTermEditor.innerHTML = activeTopicDraft.terms.map((term, index) => `
    <div class="term-edit-row" data-term-index="${index}">
      <input data-draft-field="termLabel" value="${escapeAttribute(term.label)}" aria-label="Term name" ${readOnly}>
      <input data-draft-field="termDescription" value="${escapeAttribute(term.description)}" aria-label="Term description" ${readOnly}>
      <button type="button" class="icon-button" data-draft-action="remove-term" title="Remove term" ${readOnly}>Remove</button>
    </div>
  `).join('');
  elements.draftQuestionEditor.innerHTML = activeTopicDraft.primaryQuestions.map((question, questionIndex) => renderDraftQuestion(question, questionIndex, readOnly)).join('');
  elements.draftValidation.hidden = true;
}

function renderDraftQuestion(question, questionIndex, readOnly) {
  return `
    <article class="question-edit-card" data-question-index="${questionIndex}">
      <div class="question-card-header">
        <label><span>Discussion Area</span><input data-draft-field="discussionArea" value="${escapeAttribute(question.discussionArea)}" ${readOnly}></label>
        <label><span>Primary Term</span><select data-draft-field="primaryTermId" ${readOnly}>${termOptions(question.primaryTermId)}</select></label>
        <button type="button" class="icon-button" data-draft-action="remove-question" ${readOnly}>Remove</button>
      </div>
      <label class="question-field"><span>Primary Question</span><textarea data-draft-field="question" rows="2" ${readOnly}>${escapeHtml(question.question)}</textarea></label>
      <label class="question-field"><span>Voluntary Coverage Requirement</span><input data-draft-field="voluntaryCoverageRequirement" value="${escapeAttribute(question.voluntaryCoverageRequirement)}" ${readOnly}></label>
      <div class="subsection-heading"><strong>Answer Guidance</strong><button type="button" data-draft-action="add-guidance" ${readOnly}>Add Guidance</button></div>
      <div class="guidance-editor">
        ${question.answerGuidance.map((item, index) => `<div class="guidance-row" data-guidance-index="${index}"><input data-draft-field="guidance" value="${escapeAttribute(item)}" ${readOnly}><button type="button" data-draft-action="remove-guidance" ${readOnly}>Remove</button></div>`).join('')}
      </div>
      <div class="subsection-heading"><strong>High-Quality Criteria</strong><button type="button" data-draft-action="add-criterion" ${readOnly}>Add Criterion</button></div>
      <div class="criteria-editor">
        ${question.highQualityCriteria.map((criterion, index) => `
          <div class="criterion-row" data-criterion-index="${index}">
            <label class="required-toggle"><input type="checkbox" data-draft-field="criterionRequired" ${criterion.required ? 'checked' : ''} ${readOnly}> Mandatory</label>
            <input data-draft-field="criterionRequirement" value="${escapeAttribute(criterion.requirement)}" aria-label="Criterion requirement" ${readOnly}>
            <select data-draft-field="criterionTermIds" multiple aria-label="Criterion term mappings" ${readOnly}>${termOptions(criterion.termIds)}</select>
            <button type="button" data-draft-action="remove-criterion" ${readOnly}>Remove</button>
          </div>
        `).join('')}
      </div>
    </article>
  `;
}

function termOptions(selected) {
  const selectedIds = new Set(Array.isArray(selected) ? selected : [selected]);
  return activeTopicDraft.terms.map((term) => `<option value="${escapeAttribute(term.id)}" ${selectedIds.has(term.id) ? 'selected' : ''}>${escapeHtml(term.label)}</option>`).join('');
}

function handleDraftEditorClick(event) {
  const button = event.target.closest('[data-draft-action]');
  if (!button || !activeTopicDraft || activeTopicDraft.status === 'published') return;
  syncDraftFromEditor();
  const action = button.dataset.draftAction;
  const questionIndex = Number(button.closest('[data-question-index]')?.dataset.questionIndex);
  if (action === 'remove-term') activeTopicDraft.terms.splice(Number(button.closest('[data-term-index]').dataset.termIndex), 1);
  if (action === 'remove-question') activeTopicDraft.primaryQuestions.splice(questionIndex, 1);
  if (action === 'add-guidance') activeTopicDraft.primaryQuestions[questionIndex].answerGuidance.push('');
  if (action === 'remove-guidance') activeTopicDraft.primaryQuestions[questionIndex].answerGuidance.splice(Number(button.closest('[data-guidance-index]').dataset.guidanceIndex), 1);
  if (action === 'add-criterion') activeTopicDraft.primaryQuestions[questionIndex].highQualityCriteria.push({ requirement: '', required: true, termIds: [activeTopicDraft.primaryQuestions[questionIndex].primaryTermId] });
  if (action === 'remove-criterion') activeTopicDraft.primaryQuestions[questionIndex].highQualityCriteria.splice(Number(button.closest('[data-criterion-index]').dataset.criterionIndex), 1);
  renderTopicDraftEditor();
}

function syncDraftFromEditor() {
  if (!activeTopicDraft || elements.draftReviewPanel.hidden) return;
  activeTopicDraft.caseType = fields.draftCaseType.value.trim();
  activeTopicDraft.description = fields.draftDescription.value.trim();
  activeTopicDraft.workflow.actors = selectedDraftActors();
  activeTopicDraft.terms = [...elements.draftTermEditor.querySelectorAll('[data-term-index]')].map((row, index) => ({
    id: activeTopicDraft.terms[index].id,
    label: row.querySelector('[data-draft-field=termLabel]').value.trim(),
    description: row.querySelector('[data-draft-field=termDescription]').value.trim()
  }));
  activeTopicDraft.primaryQuestions = [...elements.draftQuestionEditor.querySelectorAll('[data-question-index]')].map((card) => ({
    discussionArea: card.querySelector('[data-draft-field=discussionArea]').value.trim(),
    question: card.querySelector('[data-draft-field=question]').value.trim(),
    primaryTermId: card.querySelector('[data-draft-field=primaryTermId]').value,
    voluntaryCoverageRequirement: card.querySelector('[data-draft-field=voluntaryCoverageRequirement]').value.trim(),
    answerGuidance: [...card.querySelectorAll('[data-draft-field=guidance]')].map((input) => input.value.trim()).filter(Boolean),
    highQualityCriteria: [...card.querySelectorAll('[data-criterion-index]')].map((row) => ({
      requirement: row.querySelector('[data-draft-field=criterionRequirement]').value.trim(),
      required: row.querySelector('[data-draft-field=criterionRequired]').checked,
      termIds: [...row.querySelector('[data-draft-field=criterionTermIds]').selectedOptions].map((option) => option.value)
    })).filter((criterion) => criterion.requirement)
  }));
}

async function persistTopicDraft(publish) {
  try {
    if (!activeTopicDraft) throw new Error('Generate or open a topic draft first.');
    syncDraftFromEditor();
    validateDraftClient(activeTopicDraft);
    elements.saveTopicDraft.disabled = true;
    elements.publishTopicDraft.disabled = true;
    const result = await api(publish ? '/api/topic-draft/publish' : '/api/topic-draft/save', {
      method: 'POST',
      body: JSON.stringify({ draft: activeTopicDraft })
    });
    activeTopicDraft = result.draft;
    populateDraftMetadata(activeTopicDraft);
    renderTopicDraftEditor();
    await loadTopicDrafts();
    if (publish) {
      const defaults = await api('/api/defaults');
      caseTypes = defaults.caseTypes ?? [];
      populateCaseTypes(caseTypes, activeTopicDraft.caseType);
      elements.generationStatus.textContent = `Published to ${result.publishedPath}. The topic is now available in the runner.`;
      setDraftStep('publish');
    } else {
      elements.generationStatus.textContent = 'Draft saved. It remains unavailable to the runner until approval.';
      setDraftStep('review');
    }
  } catch (error) {
    elements.draftValidation.hidden = false;
    elements.draftValidation.textContent = error.message;
  } finally {
    const published = activeTopicDraft?.status === 'published';
    elements.saveTopicDraft.disabled = published;
    elements.publishTopicDraft.disabled = published;
  }
}

function validateDraftClient(draft) {
  if (!draft.caseType) throw new Error('Topic name is required.');
  if (!draft.description) throw new Error('Topic description is required.');
  if (!draft.workflow.actors.length) throw new Error('Select at least one workflow actor.');
  if (!draft.terms.length) throw new Error('At least one topic term is required.');
  if (!draft.primaryQuestions.length) throw new Error('At least one primary question is required.');
  for (const question of draft.primaryQuestions) {
    if (!question.discussionArea || !question.question) throw new Error('Every primary question needs a discussion area and question text.');
    if (!question.answerGuidance.length) throw new Error(`${question.discussionArea} needs at least one answer-guidance item.`);
    if (!question.highQualityCriteria.length) throw new Error(`${question.discussionArea} needs at least one high-quality criterion.`);
    if (question.highQualityCriteria.some((criterion) => !criterion.termIds.length)) throw new Error(`Every criterion in ${question.discussionArea} needs at least one term mapping.`);
  }
}

function setDraftStep(step) {
  document.querySelectorAll('[data-draft-step]').forEach((item) => item.classList.toggle('active', item.dataset.draftStep === step));
}

function selectedDraftActors() {
  return [fields.draftRequestor.checked ? 'requestor' : null, fields.draftParticipant.checked ? 'participant' : null].filter(Boolean);
}

function parseTermLines(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [label, ...descriptionParts] = line.split('|');
    return { label: label.trim(), description: descriptionParts.join('|').trim() || `${label.trim()} considerations for this topic.` };
  });
}

function parseOptionalJson(value, label) {
  if (!String(value || '').trim()) return null;
  try { return JSON.parse(value); } catch (error) { throw new Error(`The ${label} override is not valid JSON: ${error.message}`); }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read the selected source document.'));
    reader.readAsDataURL(file);
  });
}

function emptyDraftQuestion(draft) {
  const termId = draft.terms[0]?.id ?? '';
  return {
    discussionArea: 'New Discussion Area',
    question: '',
    answerGuidance: [''],
    primaryTermId: termId,
    voluntaryCoverageRequirement: '50%',
    highQualityCriteria: [{ requirement: '', required: true, termIds: termId ? [termId] : [] }]
  };
}

function selectedScenario() {
  return scenarioData?.alignmentScenarios?.find((item) => item.id === fields.alignmentScenario.value);
}

function ratingLabel(id) {
  return escapeHtml(scenarioData.topic.ratingScale.find((item) => item.id === id)?.label ?? id);
}

function behaviorName(id) {
  return escapeHtml(scenarioData?.behaviorCatalog?.behaviors?.find((item) => item.id === id)?.name ?? id);
}

function questionLabel(id) {
  return scenarioData?.topic?.primaryQuestions?.find((item) => item.id === id)?.discussionArea ?? id;
}

function formatRange(range) {
  if (!range) return '-';
  if (range.min === 0 && range.max === 40 && !range.maxInclusive) return 'Expected below 40';
  if (range.min === 90 && !range.minInclusive) return 'Expected above 90';
  return `Expected ${range.min}-${range.max}`;
}

function normalizeCaseId(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw) return '';
  if (/^CG-\d+$/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `CG-${raw.padStart(4, '0')}`;
  return raw;
}

function titleCase(value) {
  return String(value).replace(/\b\w/g, (character) => character.toUpperCase());
}

function shorten(value, length) {
  const text = String(value ?? '');
  return text.length <= length ? text : `${text.slice(0, length - 1)}...`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}

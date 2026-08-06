# CLAUDE.md

Reference for the Common Ground Testing Application. Keep it factual and current.

## Purpose

Local Node + Playwright automation harness that drives the live "Common Ground"
product UI through a browser. It logs in as a Requestor and a Participant, creates
a synthetic case, runs an automated AI ("Partner AI") interview using synthetic
responses, injects scripted response *behaviors*, and produces alignment reports
and run artifacts. There is no Common Ground API — everything is driven through
the browser with mapped selectors.

ES modules (`"type": "module"`). Dependencies: `playwright`, `zod`, `dotenv`.

## Structure

Three layers:

- **CLI runner** (`src/`) — the automation engine. Entry point `src/index.js`.
- **Local web UI** (`scripts/uiServer.js` + `public/`) — control panel that spawns
  the CLI runner as a child process and polls its artifacts.
- **Config & data** (`config/`, `topic-drafts/`, `results/`, `.tmp/`).

## Main run flow

`src/index.js` `main()`:
1. `loadConfig(argv)` (`src/config.js`) merges `.env`, an optional `--config` JSON
   file, and CLI flags; loads selectors, quality criteria, scenario foundation,
   and behavior schedule.
2. `createRunStore()` (`src/resultStore.js`) creates `results/<ISO-timestamp>/`.
   Writes are atomic (temp file + `rename`).
3. Loops `numberOfCases` times calling `runAutomation(config, caseStore)`
   (`src/commonGroundAutomation.js` — the engine). Every case is recorded via
   `summarizeCase` — including errors thrown before the engine attaches artifacts
   (preflight, browser launch).
4. After **each** case, rewrites `summary.json`, `run-report.txt`, and `cases.csv`
   (flat one-row-per-case rollup for pattern analysis) so an interrupted batch
   keeps an up-to-date summary; sets the process exit code at the end.

### Batch runs (`numberOfCases > 1`)
- **Continue-on-failure is the default for batches.** `stopOnFailure` defaults to
  `numberOfCases <= 1` in `src/config.js` (single case fails fast; a batch runs to
  the end). Override with `--stop-on-failure` / `--continue-on-failure`, a
  runConfig `stopOnFailure`, or the UI dropdown (which auto-selects "Continue" when
  Number of Cases > 1 until you pick a value yourself).
- **Resume** an interrupted batch with `--resume <runId>` (the `results/<runId>`
  dir name). It reuses that dir, reads the existing `summary.json`, and skips any
  case number already recorded (passed *or* failed), running only the rest.
- `cases.csv` columns: case, caseId, status, alignmentScore,
  alignmentInExpectedRange, stopReason, behaviorCoverage, scenario,
  scriptedAnswersFile, error, artifactDir.
- Note: the scenario controller seed is shared across a batch, so behavior
  materialization is identical per case (dossier/LLM content still varies).

Run modes (`src/config.js`): `requestor_getting_started`,
`participant_getting_started`, `full_workflow`, `fact_labeling_smoke`. The main
path is `full_workflow` (`runFullWorkflow` in `src/commonGroundAutomation.js`):

1. Pre-browser prep: OpenAI preflight, build synthetic case, create
   `ScenarioController`, generate scenario dossiers via the LLM, persist them.
2. Launch Chromium, log in as Requestor, create a synthetic case.
3. Log in as Participant, accept the case.
4. Run the Getting Started interview turn-by-turn (read Partner AI prompt →
   generate synthetic reply with behaviors → submit) until a completion phrase or
   `maxTurns`.
5. Wait through post-processing, open the Alignment Report, scrape the score.
6. Assemble `artifacts` and write `run.json` (in a `finally`).

### Persona / habits layer

An orthogonal persona axis, configurable separately from scenario and scripted
answers. Two trait axes: `polish` (`professional`|`crude`) and `detail`
(`detailed`|`sparse`). Catalog `config/personas/catalog.json`; batch rotation
`config/personas/default-rotation.json` (`round_robin`). Selection lives in
`src/personas.js` (`selectPersona`) and is keyed **strictly to `caseNumber`** —
never `store.runId`/`scenarioSeed` — so a batch deterministically cycles personas
(the shared-seed caveat cannot pin one persona across a batch). Flags: `--persona
<id>` (pin one for all cases), `--persona-rotation <path>`, `--no-personas`.

- Injected at response time in `src/llmResponder.js`: `personaDirectives` pushes
  voice/register/detail directives into the generation system prompt; applies to
  every turn including **scripted-mode LLM follow-ups** (scripted first-answers
  bypass the LLM, follow-ups do not).
- **Sparse** is enforced through the follow-up machinery, not just a prompt:
  `responseTokenBudget` clamps non-follow-up turns (`classifyTurn`
  `isFollowUpTurn`), so detail can only flow once Partner AI coaxes; a
  `persona_sparse_leak` soft-assertion (`src/commonGroundAutomation.js`) records
  any specifics leaked on an initial turn.
- Recorded per case in `summary.json`/`run.json` (`persona`) and the `persona`
  column of `cases.csv`.
- Role diversity (varying the LLM-invented `canonicalProfile`) is a separate,
  not-yet-implemented dossier-time change; the persona layer varies voice/detail,
  not the invented role.

### Scripted-answers mode (alternative response source)

An opt-in layer (not a separate run mode) that supplies the **first response to
each primary question** for each actor instead of generating it. Enabled by
`scriptedAnswersPath` (run-config field or `--scripted-answers <path>`); composes
with any `workflowScope`. Mechanics:

- File format: `config/scripted-answers/*.json` — `{ schemaVersion, topicId,
  alignmentScenarioId?, answers: [{ primaryQuestionId, employee?, manager? }] }`.
  The optional `alignmentScenarioId` pins the run's alignment scenario (validated
  against `config/scenarios/alignment-scenarios.json`), which drives the
  cross-party fact labels and the record-only expected range — e.g. an aligned
  file sets `well_aligned_outstanding` so cross-facts label "Confident Fact"
  instead of "Opinion". Precedence: `--alignment-scenario` CLI flag > scripted
  file > runConfig > topic default; a runConfig override logs a warning.

  **Actor ↔ domain-role mapping is per-topic, not a fixed assumption.** Which actor
  is the Employee (first-person self-assessment) vs. the Manager (third-person
  evaluation) depends on `config.run.requestorRole`, resolved in `src/config.js`:
  Performance Review is manager-initiated (**requestor = manager**), while a Raise is
  employee-initiated (**requestor = employee**). Override per run with
  `--requestor-role <employee|manager>` or runConfig `requestorRole`, since a Raise can
  be created from either side (e.g. a manager-role account on staging created one where
  the requestor was assigned Manager). Scripted files stay keyed by `employee`/`manager`
  (invariant to who the requestor is); the actor→key routing is centralized in
  `src/roleMapping.js` (`domainRoleForActor`) and used identically by
  `resolveActorPerspective` (`src/llmResponder.js`), `pickScriptedAnswer`
  (`src/scriptedAnswers.js`), and the actor→dossier mapping in `src/scenarioController.js`.
  (This replaces the pre-2026-08 assumption that the requestor was always the Employee;
  Common Ground re-architected Performance Review to be created from the manager side.)
  Scripted follow-ups are grounded in the transcript rather than the scenario dossier so
  the interviewee's role stays consistent. The example file documents the shape.
- The live Common Ground prompt is matched to a `primaryQuestionId` with the same
  fuzzy matcher used for scenario turns (`src/questionMatching.js`,
  `matchScenarioQuestionScored`). Manager questions mirror the employee questions,
  so the employee-worded `primaryQuestions` match both actors. If matching fails,
  a sequential fallback assigns the next unanswered question in file order.
- Only the **first** turn of each primary question is scripted; follow-ups, and
  questions with no scripted answer, fall back to the normal LLM responder. Runs
  are **clean**: behaviors and test maneuvers are not injected.
- Per-turn diagnostics in `run.json` transcripts: `responseSource`
  (`scripted`/`llm`) and `scriptedAnswer` (`primaryQuestionId`, `matchConfidence`,
  `matchScore`); rolled up into `summary.json` `scriptedAnswerCoverage`. Selection
  logic: `selectScriptedAnswer` in `src/commonGroundAutomation.js`.
- Validate a file offline (schema + topic cross-check + matcher dry-run) with
  `npm run validate:scripted [answersPath] [topicPath]`.

## Install & run

```bash
npm install
npx playwright install chromium
cp .env.example .env          # fill in COMMON_GROUND_URL + Requestor/Participant creds
cp config/selectors.example.json config/selectors.local.json   # set SELECTORS_PATH in .env
```

Key env vars: `COMMON_GROUND_URL`, `REQUESTOR_EMAIL/PASSWORD`,
`PARTICIPANT_EMAIL/PASSWORD`, `SELECTORS_PATH`, `OPENAI_API_KEY`, `OPENAI_MODEL`
(default `gpt-4.1-mini`), `HEADLESS`, `MAX_TURNS`, `POST_COMPLETION_WAIT_MS`.

npm scripts:
- `npm run validate` — config check only (`--validate-config`).
- `npm run test:case` / `test:case:headed` — run the CLI (`-- --config <file>` to
  point at a run config; copy `config/test-run.example.json`).
- `npm run ui` — start the local web UI (default port 4317, override `UI_PORT`).
- `npm run validate:*` — assorted validation scripts in `scripts/`.

## Where results are saved

`src/resultStore.js` creates `results/<runId>/` (runId = sanitized ISO timestamp).
Single-case runs write directly there; multi-case runs nest `case-NNN/`. Files:

- `run.json` — full per-case result (`behaviorCoverage`, `behaviorExecutions`,
  `softAssertions`, `alignmentReport`, `transcripts`).
- `scenario-dossiers.json`, `scenario-expression-plan.json` — scenario inputs.
- `alignment-report.png` + other screenshots.
- Run-level: `summary.json`, `run-report.txt`.

## Key files by area

### Scenario prep (runs before the browser boots; the slow part)
`src/commonGroundAutomation.js` (`runFullWorkflow`, prep at ~lines 264-289),
`src/scenarioDossiers.js`, `src/llmResponder.js`, `src/scenarioController.js`,
`src/scenarioConfig.js`. The bottleneck is `generateScenarioDossiers`
(`src/scenarioDossiers.js`): a chain of large, **sequential**, retried OpenAI
calls (evidence packet → expression plan → employee dossier → manager dossier →
pair audit). Compounded by validation retries (up to 2x per call and per pair)
and transport retries (up to 4x with backoff in `src/llmResponder.js`). Only
`full_workflow` triggers it; `fact_labeling_smoke` skips the preflight.

### Behavior injection & logging
Behaviors (structured, scheduled) vs. testManeuvers (free-text policy directives)
are mutually exclusive per turn.
- Materialize/select: `src/scenarioController.js` (`materializeBehaviors`
  ~361-423; `getPendingBehaviors` ~178-187).
- Per-turn selection: `src/commonGroundAutomation.js:648-650` →
  `buildScenarioTurn` (~819-842).
- Response composition/injection: `src/llmResponder.js`
  (`generateScenarioComposedResponse` ~111-144; `scenarioBehaviorDirective`
  ~312-345).
- Logging is to artifacts, not console: lifecycle at
  `src/commonGroundAutomation.js:700-745`; recorded into `run.json` fields
  `behaviorCoverage`, `behaviorExecutions`, `softAssertions`, and per-turn
  `scenarioBehaviors`/`behaviorVerification` in `transcripts`. Rolled into
  `summary.json` at `src/index.js:57-58`.
- Config: `config/behaviors/catalog.json`,
  `config/behavior-schedules/default-six.json`.
- testManeuvers mechanism: `src/testManeuvers.js`.

### Alignment score capture
`src/commonGroundAutomation.js`: `waitForAndReadAlignmentReport` (~1296-1340)
polls/opens the report (role locator name `/Alignment Report|View Report|Open
Report/i`); `extractAlignmentScore` (~1342-1353) scrapes the number from visible
body text via regex (no CSS selector — none exists for it);
`alignmentScoreWithinExpectedRange` (~1355-1360) compares to the scenario's
`expectedAlignmentRange`. Assembled into `artifacts.alignmentReport` (~403-412),
screenshot `alignment-report.png`. **Record-only** — `affectsCaseResult: false`,
does not affect pass/fail. Schema in `src/scenarioSchemas.js`.

### Local UI
- Server `scripts/uiServer.js`: plain `http` server (port 4317). `POST /api/run`
  writes temp config into `.tmp/` and spawns `node src/index.js --config ...`,
  capturing stdout/stderr into logs and discovering the artifact dir by matching
  the `Artifacts:` log line. `GET /api/run` → `getRunStatus`/`loadArtifactView`
  reads `summary.json` and `run.json` (root + `case-*/`).
- Front-end `public/app.js`: polls `/api/run` every 1.5s; `renderArtifactView`
  (~461-488) renders coverage, soft failures, alignment score, behavior timeline,
  scenario expressions, soft assertions. Also has a Topic Setup workspace for
  authoring topic drafts (`src/topicOnboarding.js`, `topic-drafts/`).
  Markup `public/index.html`, styles `public/styles.css`.

## Notes / gotchas

- All generated case titles/fields include `SYNTHETIC TEST DATA`; credentials live
  in `.env`, not source control.
- Alignment-report `expectedRange` schema declares only `{min, max}` but runtime
  also writes `minInclusive`/`maxInclusive`, which are dropped if re-parsed
  (`src/scenarioSchemas.js`).
- Norton Antivirus intercepts TLS on this machine and re-signs `api.openai.com`,
  so Node `fetch` fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` unless
  `NODE_EXTRA_CA_CERTS` points at the Norton root CA
  (`config/certs/norton-root.pem`, gitignored). The `ui`, `test:case`, and
  `preflight` npm scripts route through `scripts/launch.js`, which resolves the
  cert via `scripts/localCaEnv.js` (override with `EXTRA_CA_CERTS_PATH`); the UI
  server also injects it into spawned runs. Quick check: `npm run preflight`.
  Details: `config/certs/README.md`.
</content>
</invoke>

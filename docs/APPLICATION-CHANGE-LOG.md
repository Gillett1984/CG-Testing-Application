# Application Change Log

This file records functional changes made to the Common Ground testing application. Add a dated entry for every code change, including the problem, root cause, implementation, affected files, and verification performed.

## 2026-08-22 - Skip Submit on an Already-Submitted Rating Page

**Problem:** After recognizing the final cross-rating success banner, the runner still called the submit helper and failed because the completed page intentionally had no enabled Submit control.

**Root cause:** Completion recognition existed in progress parsing but not in the earlier `factStatementsAlreadySubmitted` guard used by the full labeling operation.

**Change:** The full labeling operation now treats `All statements have been successfully rated!` as already submitted and exits without clicking or submitting again.

**Files:** `src/commonGroundAutomation.js`, `scripts/validateFullWorkflow.js`.

**Verification:** Workflow validation checks that the success banner is both parsed as complete and recognized by the already-submitted guard.

## 2026-08-22 - Recognize Cross-Rating Success Banner

**Problem:** CG-0123 visibly completed all nine final statement ratings, but the runner failed because the completed page no longer displayed a numeric progress counter.

**Root cause:** Fact-rating completion recognized only `N/N labeled`, `N of N still need to be rated`, or an enabled submit button. The current UI replaces those signals with `All statements have been successfully rated!`.

**Change:** Fact-rating progress now treats the success banner as zero remaining and derives the total from the rendered statement numbers.

**Files:** `src/commonGroundAutomation.js`, `scripts/validateFullWorkflow.js`.

**Verification:** Added an exact success-banner progress assertion to the full workflow validation suite.

## 2026-08-22 - Scope Final Cross-Rating to the Target Discussion

**Problem:** During monitored CG-0121, the final employee rating completed but a legacy global rating lookup subsequently opened completed discussion CG-0105 and refreshed it until timeout.

**Root cause:** The cross-party rating helper searched all visible dashboard controls before using the new case-scoped Next Up router.

**Change:** Dashboard cross-rating now resolves the exact CG card first and never runs the global control fallback on the dashboard. The rating loop also detects navigation to a different CG ID and returns to the target discussion card.

**Files:** `src/commonGroundAutomation.js`, `scripts/validateFullWorkflow.js`.

**Verification:** Syntax and full workflow validation include assertions for dashboard-scoped cross-rating and wrong-discussion recovery.

## 2026-08-22 - UTC Discussion Start Date

**Problem:** A monitored two-case run could not create either discussion because staging rejected `requested_case_start_date` as being in the past.

**Root cause:** After UTC midnight, the runner's Los Angeles calendar date lagged Common Ground's server-side UTC date by one day.

**Change:** Requested discussion start dates now use the current UTC calendar date, which is accepted by Common Ground and is immediately actionable.

**Files:** `src/commonGroundAutomation.js`, `scripts/validateFullWorkflow.js`.

**Verification:** The workflow validation now covers the UTC date rollover explicitly.

## 2026-08-22 - Case-Scoped Dashboard Next Up Navigation

**Problem:** A completed discussion could loop between Dashboard and Discussion Details while the dashboard already exposed `Your Alignment Brief`. More generally, the runner was opening Discussion Details instead of using the active `Next Up` link on the exact discussion card.

**Root cause:** Legacy navigation treated Discussion Details as the primary entry point for every workflow phase. The current Common Ground dashboard is itself the workflow router, and the actionable link can exist only on the card.

**Change:** Added a case-scoped dashboard router that finds the exact CG ID card and clicks its active `Next Up` action. Plain-text Next Up values remain handoff signals and are not clicked. General case entry, participant entry, post-processing, cross-party statement rating, and final Alignment Brief handling now prefer this router. Discussion Details remains a fallback when no actionable card link is available.

**Files:** `src/commonGroundAutomation.js`, `scripts/validateFullWorkflow.js`.

**Verification:** Syntax validation plus the full workflow validation suite, including static assertions that the dashboard router is present and used by general case navigation.

## 2026-08-22 - Transient Confirm Additions Compatibility

**Problem:** After Add Missing Perspective, Common Ground could navigate to `/confirm-additions` and display "Nothing to confirm" with a `Continue` button. The runner did not recognize this transition and waited indefinitely.

**Root cause:** Confirm Additions is not part of the approved canonical workflow, so no transition handler existed between Missing Perspective and the next canonical step.

**Change:** Added a generic Confirm Additions detector and Continue handler to post-processing, cross-party statement rating, and final employee completion. The handler can open the transition from its Discussion Details action and treats it as proof that the preceding Missing Perspective submission completed. Detection requires the rendered page heading rather than trusting the route alone, because Common Ground can retain `/confirm-additions` while displaying "Loading discussion details...". The handler allows up to 30 seconds for `Continue` to become actionable. The page is logged as a compatibility transition rather than a canonical workflow phase.

**Affected files:** `src/commonGroundAutomation.js`, `scripts/validateFullWorkflow.js`, and `docs/APPLICATION-CHANGE-LOG.md`.

**Verification:** Added positive and negative workflow regression assertions for Confirm Additions detection.

**Live follow-up:** A resumed CG-0116 run showed that Discussion Details can already advertise `Next: Rate [Manager] Supporting Statements` while the runner's in-memory Missing Perspective flag is unset. The staging link used legacy/inverted route-mode vocabulary, so the runner now treats the single active cross-rating link as authoritative proof that all preceding employee steps are complete without filtering it by the legacy mode value. This matches the approved Next Up contract.

**Live verification:** Targeted resume run `2026-08-22T18-33-33-359Z` recognized the active employee cross-rating action, labeled and submitted all 9 manager statements, and advanced CG-0116 to `Completed`. Common Ground then remained in `Your Alignment Brief — Preparing…` beyond the configured 10-minute wait, so the run correctly failed at the external brief-generation boundary rather than reporting a false pass.

**Two-case follow-up:** Batch `2026-08-22T19-13-05-474Z` completed CG-0117 and CG-0118 back to back. Monitoring showed that staging may expose a cross-rating link before employee Missing Perspective is ready, so an active rating link alone is not accepted as prerequisite completion. Resume/final routing now requires Discussion Details to show `Confirm Your Additions View`, or the runner must complete Missing Perspective and Confirm Additions itself before rating.

## 2026-08-21 - Live Employee/Manager Role Resolution

**Problem:** Employee interviews could receive the manager dossier, manager perspective, and manager scenario rating. This caused third-person answers during the employee interview and repeated Partner AI follow-ups.

**Root cause:** The scenario layer retained an older assumption that the requestor was the manager. The current Common Ground New Discussion form identifies the configured requestor account as the employee and the participant account as the manager.

**Change:** Read employee/manager roles from the live New Discussion form, update the run and scenario controller before dossier use, route employee actors to the employee dossier and requestor scenario ratings, route manager actors to the manager dossier and participant scenario ratings, and validate the complete role contract before the first interview response.

**Files:** `src/commonGroundAutomation.js`, `src/config.js`, `src/roleMapping.js`, `src/scenarioController.js`, `scripts/validatePerspectiveContract.js`, `scripts/validateScenarioController.js`

**Verification:** JavaScript syntax checks, perspective-contract validation, scenario-controller validation, and workflow validation.

## 2026-08-21 - Sparse Response Completion Budget

**Problem:** Sparse-persona replies could be cut off before completing a thought, contributing to repeated follow-up loops.

**Root cause:** Initial and retry token limits were too small for a concise but complete answer.

**Change:** Increased sparse initial and retry response budgets while retaining sparse-persona prompting and validation.

**Files:** `src/llmResponder.js`

**Verification:** JavaScript syntax and response validation suites.

## 2026-08-21 - Alignment Brief Completion Requirement

**Problem:** A full-workflow run could report passed after the final cross-rating even when the Alignment Brief was not available.

**Root cause:** The terminal condition treated final fact-rating completion as full workflow completion.

**Change:** Require the Alignment Brief availability state before a full workflow can pass, while preserving earlier completion behavior for narrower run modes.

**Files:** `src/commonGroundAutomation.js`, `src/index.js`, `scripts/validateFullWorkflow.js`

**Verification:** Full-workflow validation suite.

## 2026-08-21 - Interview Send Transition Recovery

**Problem:** Playwright could time out clicking Send even though Common Ground accepted the response and transitioned to Add Helpful Details.

**Root cause:** The send control was removed during navigation before Playwright observed the click completing.

**Change:** Treat a send timeout as recoverable when the page has demonstrably advanced to the next workflow stage.

**Files:** `src/commonGroundAutomation.js`

**Verification:** JavaScript syntax and workflow validation.

## 2026-08-21 - New Discussion Submission Confirmation

**Problem:** Multi-case runs could continue without confirming that a later New Discussion submission created a new discussion.

**Root cause:** The runner assumed a successful click meant the SPA had committed and navigated.

**Change:** Confirm route or dashboard state after submission, retry the hydrated form once, and fail with a screenshot and visible validation text if no discussion is created.

**Files:** `src/commonGroundAutomation.js`

**Verification:** Full-workflow validation suite.

## 2026-08-21 - Requested Start Date Rollover

**Problem:** A form left open across local midnight could submit a date that Common Ground considered in the past.

**Root cause:** The date was calculated before the final submission attempt.

**Change:** Refill date fields with the current local date immediately before each submission attempt.

**Files:** `src/commonGroundAutomation.js`

**Verification:** Full-workflow validation suite.

## 2026-08-22 - Canonical Manager-Created, Employee-First Workflow

**Problem:** Workflow navigation was distributed across requestor/participant assumptions that no longer matched the approved Common Ground sequence. The runner could start the manager interview before the employee, treat an invented `Confirm Additions` step as real, open later actions before required Missing Perspective work, or report completion without proving every required step had finished.

**Root cause:** The code conflated the account that creates a Discussion with the party that shares a perspective first. It also inferred workflow order from whichever link happened to be visible instead of enforcing one explicit, reviewable sequence.

**Change:** Added a canonical 16-step workflow and per-run ledger. The manager (`REQUESTOR`) creates the Discussion; the employee (`PARTICIPANT`) accepts and completes Share Your Perspective, Clarify & Improve, Excerpt Review, and Statements first. The manager then rates the employee's supporting statements, completes their own Share Your Perspective, Clarify & Improve, Add Missing Perspective, Excerpt Review, and Statements. The employee returns to Add Missing Perspective and rate the manager's supporting statements. The run passes only after Your Alignment Brief is available and every preceding ledger step is complete. Both Add Missing Perspective presentations are supported: populated cards must be resolved and successfully submitted; `Nothing to add here` must be continued. Removed all `Confirm Additions` navigation and status assumptions. Updated UI wording, synthetic actor names, role defaults, resume phases, and the local credential slots to match Manager/Employee semantics.

**Loop and false-pass protection:** The final-stage waiter only opens actions for the exact Discussion, detects repeated identical navigation, and does not treat inconsistent status-list spinners as proof that a required rating finished. A populated Missing Perspective step cannot advance the ledger unless its Submit succeeds.

**Files:** `src/canonicalWorkflow.js`, `src/workflowPhases.js`, `src/commonGroundAutomation.js`, `src/config.js`, `src/roleMapping.js`, `src/scenarioController.js`, `src/syntheticData.js`, `public/index.html`, `.env.example`, `.env`, `scripts/validateFullWorkflow.js`, `scripts/validatePerspectiveContract.js`, `scripts/validateScenarioController.js`

**Verification:** Canonical workflow sequence and ledger validation; JavaScript syntax checks; configuration, scenario-controller, perspective-contract, scripted-answer, topic-onboarding, and fact-labeling validation suites; Git whitespace validation. Live end-to-end verification is recorded separately when a Common Ground Discussion is run.

## 2026-08-22 - Manager-Side Employee Picker

**Problem:** The first monitored canonical run stopped before Discussion creation because staging replaced the prior party controls with an Employee dropdown.

**Root cause:** The runner recognized the legacy `#party2-participant` manager picker and fully read-only party blocks, but not the current manager-side `#counterpart-picker` control.

**Change:** Added an explicit Employee picker selector and form branch. The runner matches the configured employee by the email local-part when possible, accepts a sole direct-report candidate, and fails rather than guessing when multiple candidates are ambiguous.

**Files:** `config/selectors.example.json`, `src/commonGroundAutomation.js`

**Verification:** Live form inspection on staging, JavaScript syntax check, configuration validation, and full-workflow signal validation, followed by a new monitored end-to-end run.

## 2026-08-22 - Immediate Discussion Start Date

**Problem:** A monitored run created a Discussion scheduled for the following day, so Common Ground displayed `This discussion hasn't started yet` and the employee could not begin Share Your Perspective.

**Root cause:** A prior midnight rollover workaround always set Requested Discussion Start Date to tomorrow.

**Change:** Requested Discussion Start Date now uses today's local calendar date so the synthetic workflow can begin immediately. A server/local clock mismatch must surface as a date validation failure instead of silently creating a future Discussion.

**Files:** `src/commonGroundAutomation.js`, `scripts/validateFullWorkflow.js`

**Verification:** Date helper regression assertion, full-workflow signal validation, and a fresh monitored staging run.

## 2026-08-22 - Deferred Employee Missing Perspective Gate

**Problem:** After the employee completed Clarify & Improve, Common Ground opened Add Missing Perspective in a `Waiting for the other party` state. The runner waited there instead of continuing to Excerpt Review.

**Root cause:** The approved workflow correctly places the employee's actionable Add Missing Perspective step after the manager finishes, but Common Ground includes the same page earlier in its tab sequence as a non-actionable waiting gate.

**Change:** Detect the early waiting presentation, leave it for Excerpt Review, and do not mark the employee Add Missing Perspective ledger step complete. The later employee return still requires the actionable cards/Submit or Nothing-to-add/Continue path. An unexpectedly actionable early page now fails as an out-of-order workflow state.

**Files:** `src/commonGroundAutomation.js`

**Verification:** JavaScript syntax, workflow validation, and a fresh monitored staging run.

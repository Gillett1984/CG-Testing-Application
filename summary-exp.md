# Project Summary — Common Ground Testing Application

*A summary derived from `README.md`.*

## What it is

A local automation spike for testing how Common Ground's Partner AI responds during the **Getting Started** step. It's a Playwright proof-of-concept runner that drives the production UI through a browser, uses synthetic case data, and writes local run artifacts.

## Setup

1. Install dependencies:
   ```powershell
   npm install
   npx playwright install chromium
   ```
2. Copy the environment file: `Copy-Item .env.example .env`
3. Fill in `.env` with the production URL and the Requestor/Participant test credentials.
4. Copy `config/selectors.example.json` to `config/selectors.local.json`, then set `SELECTORS_PATH=config/selectors.local.json` in `.env`.
5. Run the config check: `npm run validate`
6. Run one headed automation spike:
   ```powershell
   npm run test:case:headed -- --topic "Parenting schedule conflict" --instructions "Respond vaguely but cooperate enough to complete Getting Started."
   ```

## Run configuration

Test parameters are best specified in a JSON run config. Copy the example for your own run:

```powershell
Copy-Item config/test-run.example.json config/test-run.local.json
```

Key fields include `topic`, `caseType`, `instructions`, `testObjective`, `testBehaviorPolicy`, `recoveryBehavior`, `successCondition`, `stopCondition`, `testManeuvers`, `numberOfCases`, `maxTurns`, `stopOnFailure`, and `qualityCriteriaPath`.

Run it:
```powershell
npm run test:case:headed -- --config config/test-run.local.json
```

Common values can be overridden from the command line:
```powershell
npm run test:case:headed -- --config config/test-run.local.json --count 3 --max-turns 30 --continue-on-failure
```

## Case-type quality criteria

Each case type can have its own high-quality answer criteria file under `config/case-types/` (e.g. `raise.json`, `performance-review.json`). Point your run config at it via `qualityCriteriaPath`. The criteria file supports: primary question ID, discussion area, primary question text, answer guidance, high-quality criteria, mandatory vs voluntary criteria, voluntary coverage requirement, and objective/subjective fact definitions.

## Run flow (current scope)

Supports one or more synthetic cases per batch, executing this flow for each case:

1. Login as Requestor
2. Create a synthetic case
3. Login as Participant
4. Accept the case request
5. Login as Requestor
6. Start Getting Started
7. Respond to Partner AI prompts until a completion phrase is detected
8. Wait for the app to move to post-processing
9. Save transcript, screenshots, and status in `results/`

## Selector mapping

The Common Ground production UI is only available through the browser (no API), so selectors must be mapped from the real app. Prefer stable selectors:

- `data-testid`
- accessible role/name combinations
- stable form labels

Avoid brittle selectors like deep CSS chains or generated class names.

## Production safety

Every generated case title and text field includes `SYNTHETIC TEST DATA`. Keep test account credentials in `.env`, not in source control.

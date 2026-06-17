# Common Ground Testing Application

Local automation spike for testing how Common Ground's Partner AI responds during the Getting Started step.

This first implementation is a Playwright proof-of-concept runner. It automates the production UI through a browser, uses synthetic case data, and writes local run artifacts.

## Setup

1. Install dependencies:

   ```powershell
   npm install
   npx playwright install chromium
   ```

2. Copy the environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Fill in `.env` with the production URL and the Requestor/Participant test credentials.

4. Copy `config/selectors.example.json` to `config/selectors.local.json`, then update `.env`:

   ```text
   SELECTORS_PATH=config/selectors.local.json
   ```

5. Run the config check:

   ```powershell
   npm run validate
   ```

6. Run one headed automation spike:

   ```powershell
   npm run test:case:headed -- --topic "Parenting schedule conflict" --instructions "Respond vaguely but cooperate enough to complete Getting Started."
   ```

## Run Configuration

The recommended place to specify test parameters is:

```text
config/test-run.example.json
```

Copy it for your own run:

```powershell
Copy-Item config/test-run.example.json config/test-run.local.json
```

Then edit:

```json
{
  "topic": "Raise",
  "caseType": "Raise",
  "instructions": "Use synthetic test data. Respond cooperatively and concisely so the Getting Started step can complete.",
  "testObjective": "Verify Partner AI can complete Getting Started with high-quality synthetic raise answers.",
  "testBehaviorPolicy": "Answer each primary question with a direct synthetic user response that follows the quality criteria.",
  "recoveryBehavior": "If Partner AI asks a follow-up, provide the missing details with a stronger answer.",
  "successCondition": "Getting Started Complete",
  "stopCondition": "Stop after Partner AI indicates Getting Started is complete, or stop if Partner AI responds contrary to the success condition.",
  "testManeuvers": [
    {
      "name": "Ask for clarification on Raise Justification",
      "when": {
        "discussionArea": "Raise Justification",
        "questionContains": "Why do you believe this raise request is justified?"
      },
      "userIntent": "Ask Partner AI to clarify what information it wants before answering.",
      "responseStyle": "question",
      "response": "Can you clarify what kinds of justification you want me to include?",
      "successExpectation": "Partner AI provides a clarification response.",
      "successSignals": ["clarify", "focus on", "include", "looking for"],
      "stopAfterSuccess": true
    }
  ],
  "numberOfCases": 1,
  "maxTurns": 25,
  "stopOnFailure": true,
  "qualityCriteriaPath": "config/case-types/raise.json"
}
```

Run it:

```powershell
npm run test:case:headed -- --config config/test-run.local.json
```

You can also override common values from the command line:

```powershell
npm run test:case:headed -- --config config/test-run.local.json --count 3 --max-turns 30 --continue-on-failure
```

## Case-Type Quality Criteria

Each case type can have its own high-quality answer criteria file. The Raise criteria live here:

```text
config/case-types/raise.json
```

Add new case types by creating another file, for example:

```text
config/case-types/performance-review.json
```

Then point your run config to it:

```json
{
  "caseType": "Performance Review",
  "qualityCriteriaPath": "config/case-types/performance-review.json"
}
```

The criteria file supports:

- primary question ID
- discussion area
- primary question text
- answer guidance
- high-quality criteria
- mandatory vs voluntary criteria
- voluntary coverage requirement
- objective/subjective fact definitions

## Current Scope

The runner supports one or more synthetic cases per batch and executes this flow for each case:

1. Login as Requestor
2. Create a synthetic case
3. Login as Participant
4. Accept the case request
5. Login as Requestor
6. Start Getting Started
7. Respond to Partner AI prompts until a completion phrase is detected
8. Wait for the app to move to post-processing
9. Save transcript, screenshots, and status in `results/`

## Selector Mapping

Because the Common Ground production UI is only available through the browser and no API exists, selectors need to be mapped from the real app. The example config intentionally uses placeholders such as `[data-testid="..."]`.

Good selectors are stable attributes such as:

- `data-testid`
- accessible role/name combinations
- stable form labels

Avoid brittle selectors like deep CSS chains or generated class names.

## Production Safety

Every generated case title and text field includes `SYNTHETIC TEST DATA`. Keep test account credentials in `.env`, not in source control.

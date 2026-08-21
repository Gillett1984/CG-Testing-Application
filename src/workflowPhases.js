// Ordered workflow phases for a full two-party run. Resume mode starts at one of these
// and skips everything before it, so an interrupted case can be driven to the Alignment
// Brief without re-walking (or re-creating) work that already succeeded on the live case.
//
// Kept in its own module so both the config loader and the automation engine can share it
// without config.js having to import the Playwright-heavy engine.
export const WORKFLOW_PHASES = [
  'create_case',
  'accept_invitation',
  'requestor_interview',
  'requestor_facts',
  'participant_rates_requestor',
  'participant_interview',
  'participant_facts',
  'requestor_rates_participant',
  'alignment'
];

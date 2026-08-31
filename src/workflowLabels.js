// Every user-visible workflow label this harness navigates by, in one place.
//
// Common Ground renames these. On 2026-08-25 five of six changed in a single
// release (shared/progress_labels.py: "Add Helpful Details" -> "Add Clarity",
// "Review Your Excerpts" -> "Review & Approve Excerpts", "Rate Your Supporting
// Statements" -> "Rate Foundational Statements", "Your Alignment Brief" ->
// "View Alignment Brief"), and the harness sat polling for wording that no
// longer existed. Keeping the vocabulary here means the next rename is a
// one-line addition rather than a hunt through the engine.
//
// Old wording is retained deliberately: the same harness has to drive
// environments that have not been promoted yet.
//
// `own`    - the row for the actor whose page this is ("Add Clarity")
// `other`  - the counterpart's row ("Esha adds clarity")
// `link`   - the clickable control, wherever it appears
// `route`  - the step's own URL, which is stabler than any label
export const WORKFLOW_STEP_LABELS = {
  share_perspective: {
    own: /^share your perspective$/i,
    other: /\bshares? their perspective$/i,
    link: /Share Your Perspective/i
  },
  clarify_context: {
    own: /^(?:add helpful details|add clarity)$/i,
    other: /\b(?:adds? helpful details|adds? clarity)$/i,
    link: /Add Helpful Details|Add Clarity/i,
    route: /\/clarify-context/i
  },
  missing_perspective: {
    own: /^add missing perspective$/i,
    other: /\badds? missing perspective$/i,
    link: /Add Missing Perspective/i,
    route: /\/missing-perspective/i
  },
  excerpt_review: {
    own: /^(?:review your excerpts|review\s*(?:&|and)\s*approve excerpts)$/i,
    other: /\b(?:reviews? their excerpts|reviews?\s*(?:&|and)\s*approves? excerpts)$/i,
    link: /Review Your Excerpts|Review\s*(?:&|and)\s*Approve Excerpts/i,
    route: /\/excerpt-review/i
  },
  fact_rating: {
    // Both spellings ship: steps 5/6/11 say "Foundational", step 14 says
    // "Foundation". The missing "-al" is upstream, so match either.
    own: /^rate (?:your supporting|foundational|foundation) statements$/i,
    other: /\brates? (?:their supporting|foundational|foundation) statements$/i,
    link: /Rate (?:Your|[\w'’-]+'?s) Supporting Statements|Rate Foundationa?l? Statements/i,
    route: /\/(?:fact-review|cross-rate)/i
  },
  // Step 13 lost its tracker row on 2026-08-25 (_RESERVED_STEPS = {13}), but
  // the screen and its API still exist and still gate cross-rating. It is
  // handled opportunistically when encountered, never waited for.
  confirm_additions: {
    link: /Confirm Your Additions/i,
    route: /\/(?:confirm-additions|new-evidence)/i
  },
  alignment_brief: {
    link: /Your Alignment Brief|View Alignment Brief|Alignment Report|View Report|Open Report/i
  }
};

// The status-list rows the harness treats as an actor's own workflow. Confirm
// Additions is absent by design: it no longer has a row to wait for.
export const WORKFLOW_STATUS_STEP_KEYS = [
  'share_perspective',
  'clarify_context',
  'excerpt_review',
  'fact_rating'
];

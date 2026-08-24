export const CANONICAL_WORKFLOW = [
  { id: 'manager_create_discussion', actor: 'manager', label: 'Create Discussion', phase: 'create_case' },
  { id: 'employee_review_invitation', actor: 'employee', label: 'Review Invitation', phase: 'accept_invitation' },
  { id: 'employee_share_perspective', actor: 'employee', label: 'Share Your Perspective', phase: 'employee_interview' },
  { id: 'employee_clarify_improve', actor: 'employee', label: 'Clarify & Improve', phase: 'employee_post_processing' },
  { id: 'employee_excerpt_review', actor: 'employee', label: 'Excerpt Review', phase: 'employee_post_processing' },
  { id: 'employee_statements', actor: 'employee', label: 'Statements', phase: 'employee_post_processing' },
  { id: 'manager_rates_employee', actor: 'manager', label: 'Rate (Employee Name) Supporting Statements', phase: 'manager_rates_employee' },
  { id: 'manager_share_perspective', actor: 'manager', label: 'Share Your Perspective', phase: 'manager_interview' },
  { id: 'manager_clarify_improve', actor: 'manager', label: 'Clarify & Improve', phase: 'manager_post_processing' },
  {
    id: 'manager_missing_perspective', actor: 'manager', label: 'Add Missing Perspective', phase: 'manager_post_processing',
    variants: ['cards_submit', 'nothing_to_add_continue']
  },
  { id: 'manager_excerpt_review', actor: 'manager', label: 'Excerpt Review', phase: 'manager_post_processing' },
  { id: 'manager_statements', actor: 'manager', label: 'Statements', phase: 'manager_post_processing' },
  {
    id: 'employee_missing_perspective', actor: 'employee', label: 'Add Missing Perspective', phase: 'employee_rates_manager',
    variants: ['cards_submit', 'nothing_to_add_continue']
  },
  { id: 'employee_rates_manager', actor: 'employee', label: 'Rate (Manager Name) Supporting Statements', phase: 'employee_rates_manager' },
  { id: 'alignment_brief', actor: 'system', label: 'Your Alignment Brief', phase: 'alignment' },
  { id: 'runner_complete', actor: 'runner', label: 'Mark Test Complete', phase: 'complete' }
];

export const WORKFLOW_PHASES = [...new Set(CANONICAL_WORKFLOW.map((step) => step.phase).filter((phase) => phase !== 'complete'))];

export function createWorkflowLedger() {
  return CANONICAL_WORKFLOW.map((step) => ({ ...structuredClone(step), status: 'pending', detail: '', updatedAt: null }));
}

export function updateWorkflowLedger(ledger, stepId, status, detail = '') {
  const step = ledger.find((item) => item.id === stepId);
  if (!step) throw new Error(`Unknown canonical workflow step: ${stepId}`);
  step.status = status;
  step.detail = detail;
  step.updatedAt = new Date().toISOString();
  return step;
}

export function assertWorkflowLedgerComplete(ledger) {
  const incomplete = ledger.filter((step) => step.id !== 'runner_complete' && step.status !== 'completed');
  if (incomplete.length) {
    throw new Error(`Canonical workflow is incomplete: ${incomplete.map((step) => `${step.id}=${step.status}`).join(', ')}.`);
  }
}

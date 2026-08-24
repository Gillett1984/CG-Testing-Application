// Maps an actor (requestor/participant) to the domain role (employee/manager) they hold.
// The manager always creates the discussion (requestor); the employee is always the
// invited participant. requestorRole remains explicit for artifact replay and validation.
export function domainRoleForActor(actorRole, requestorRole = 'manager') {
  const requestor = requestorRole === 'employee' ? 'employee' : 'manager';
  const participant = requestor === 'employee' ? 'manager' : 'employee';
  return actorRole === 'participant' ? participant : requestor;
}

export function perspectiveForDomainRole(domainRole) {
  return domainRole === 'manager' ? 'manager_evaluating_employee' : 'employee_self_assessment';
}

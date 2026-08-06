// Maps an actor (requestor/participant) to the domain role (employee/manager) they hold.
// The redesigned Common Ground creates cases from the manager's side, so the requestor is
// usually the manager — but this is configurable per run/topic (requestorRole), never a
// fixed assumption, because a Raise Request can be initiated from either side.
export function domainRoleForActor(actorRole, requestorRole = 'manager') {
  const requestor = requestorRole === 'employee' ? 'employee' : 'manager';
  const participant = requestor === 'employee' ? 'manager' : 'employee';
  return actorRole === 'participant' ? participant : requestor;
}

export function perspectiveForDomainRole(domainRole) {
  return domainRole === 'manager' ? 'manager_evaluating_employee' : 'employee_self_assessment';
}

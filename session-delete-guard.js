// Who may delete a session, and what a delete is refused for (harness review 2026-11-11, item 1).
// 14 sessions were closed through DELETE /api/sessions in 5 minutes and nobody could say who: the caller is now recorded
// (`by`), and a delete of a session that still has an open owner ask, a held lease or unmerged commits is refused unless the
// caller is the owner (the dashboard sends by=owner) or the agent that spawned the session. Pure: facts are injected.
export const callerOf = (by, header) => {
  const v = String(by || header || '').trim().slice(0, 60);
  return v || 'unknown';
};

// -> { allow, reasons[] }. facts: { openAsk, leases: [ids], unmerged }. startedBy: sessionMeta.startedBy(name).
export function deleteVerdict({ name, by, startedBy = null, facts = {} } = {}) {
  const trusted = by === 'owner' || (!!startedBy && by === startedBy && by !== 'unknown' && by !== 'cbsession' && by !== 'dashboard');
  const reasons = [];
  if (facts.openAsk) reasons.push('an owner ask is still open');
  if (facts.leases?.length) reasons.push(`it holds lease ${facts.leases.slice(0, 3).join(', ')}`);
  if (facts.unmerged) reasons.push('it has uncommitted or unmerged work');
  if (!reasons.length || trusted) return { allow: true, reasons: trusted ? [] : reasons, by };
  return { allow: false, reasons, by, name };
}

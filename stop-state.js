// Stop state from facts (owner, 2026-11-11 evening: "counting is good, but how do we fix it"). The harness decides what a stop IS from what it knows,
// not from the word the session wrote: a stop with a live background job, an open integration / deploy id, a queued or granted lease ticket, a worker
// session the session started that still runs, or a named time not yet passed is WAITING whatever the line says (blocked, failed, done, none).
// Only a stop with none of these facts and a blocked / failed line reaches the manager as a block. Pure; manager.js calls it at every stop,
// server.js builds the facts (stopFacts). Journal fields on the stall row: said, computed, stateReasons.
export const STATE_KINDS = ['background job', 'integration', 'lease ticket', 'worker session', 'time'];
// said: the STATUS kind the session wrote ('blocked' | 'done' | 'failed' | 'waiting' | 'needs-owner' | ... | '' for none).
// facts: { bgJobs: number, integrations: [id], tickets: [id], workers: [name], timeMs: number|null }.
export function computeStopState({ said = '', facts = {}, now = Date.now() } = {}) {
  const said0 = String(said || '').toLowerCase() || 'none';
  const reasons = [];
  if ((facts.bgJobs || 0) > 0) reasons.push({ kind: 'background job', id: String(facts.bgJobs) });
  for (const id of facts.integrations || []) reasons.push({ kind: 'integration', id });
  for (const id of facts.tickets || []) reasons.push({ kind: 'lease ticket', id });
  for (const id of facts.workers || []) reasons.push({ kind: 'worker session', id });
  if (Number.isFinite(facts.timeMs) && facts.timeMs > now) reasons.push({ kind: 'time', id: new Date(facts.timeMs).toISOString().slice(11, 16) + ' UTC' });
  // statuses the facts may overrule: a wait written as blocked / failed / done, or a stop with no status. needs-owner / needs-manager / waiting stay as written.
  const overrulable = ['blocked', 'failed', 'done', 'none'].includes(said0);
  const computed = reasons.length && overrulable ? 'waiting' : said0;
  return { said: said0, computed, reasons, mismatch: computed !== said0 };
}
// the dependency text a parked wake reads (own-jobs.js parkedDeps): integration ids, ticket ids, the time
export function waitingText(reasons) {
  return `waiting: ${reasons.map((r) => (r.kind === 'integration' ? `integration ${r.id}` : r.kind === 'lease ticket' ? `lease ticket ${r.id}` : r.kind === 'time' ? `until ${r.id}` : r.kind === 'worker session' ? `worker ${r.id}` : 'background job')).join(', ')}`;
}

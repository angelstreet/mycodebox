// Synthetic V2 task specs for orchestration tests. No real repos, hosts or people.
export const SHA_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
export const SHA_B = 'b2c3d4e5f60718293a4b5c6d7e8f9012345678a1';

export const spec = (over = {}) => ({
  project_id: 'fixture-project',
  goal: 'Update the synthetic README link and keep tests green',
  scope: 'README.md only',
  prohibited_actions: ['write_live_state'],
  definition_of_done: ['link present', 'npm test passes on the candidate SHA'],
  acceptance_checks: [
    { id: 'unit', command: ['npm', 'test'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true },
    { id: 'lint', command: ['node', '--check', 'x.js'], expect: { exit: 0 }, evidence_type: 'exit_code', required: false },
  ],
  risk_class: 'low',
  runtime_capabilities: ['edit', 'shell'],
  privacy_policy: 'synthetic',
  resources: [],
  dependencies: [],
  base_sha: SHA_A,
  created_by: { kind: 'api', id: 'test-client' },
  ...over,
});

// Deterministic clock and ids for stores and events.
// Each clock gets its own id prefix: two store instances over one dir must never mint the same id.
let clocks = 0;
export function clock(start = Date.parse('2026-01-01T00:00:00Z')) {
  let t = start, n = 0;
  const p = clocks++ ? `c${clocks}-` : '';
  return { now: () => (t += 1000), randomId: () => `${p}id${String(++n).padStart(4, '0')}` };
}

// Tasks view (public/tasks-view.js): badge honesty, escaping, and static rules (icons only from icons.js, sw precache).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { badgeOf, badgeHtml, listHtml, detailHtml, newFormHtml } from '../public/tasks-view.js';
import { ICONS } from '../public/icons.js';

const OUTCOME = { accepted: 'done', waiting: 'waiting', awaiting_approval: 'needs_owner', failed_unrecoverable: 'unrecoverable', cancelled: 'cancelled' };
const STATES = ['created', 'clarified', 'planned', 'ready', 'executing', 'evaluating', 'repair', 'replan', 'waiting', 'awaiting_approval',
  'integrating', 'release_verifying', 'accepted', 'failed_unrecoverable', 'cancelled', 'unknown_external_effect'];
const task = (state, over = {}) => ({ task_id: `t-${state}`, goal: 'g', state, outcome: OUTCOME[state] || 'not_yet_done', next_action: 'n', updated_at: 'now', store_error: null, ...over });

test('only an accepted task gets the done badge; others never say done', () => {
  for (const s of STATES) {
    const b = badgeOf(task(s));
    assert.equal(b.cls === 'done', s === 'accepted', s);
    if (s !== 'accepted') assert.doesNotMatch(badgeHtml(task(s)), /done/i, s);
  }
  assert.equal(badgeOf(task('accepted', { store_error: 'corrupt log' })).cls, 'unknown', 'unreadable log beats a stale accepted');
});

test('waiting, needs owner and unknown are three distinct badges', () => {
  const k = ['waiting', 'awaiting_approval', 'unknown_external_effect'].map((s) => badgeOf(task(s)).cls);
  assert.deepEqual(k, ['wait', 'owner', 'unknown']);
});

test('list escapes markup from goals; empty list says so', () => {
  assert.match(listHtml([]), /no V2 tasks/);
  const h = listHtml([task('created', { goal: '<img src=x onerror=alert(1)>' })]);
  assert.doesNotMatch(h, /<img/);
  assert.match(h, /data-tk-open="t-created"/);
});

const detail = (over = {}) => ({ ...task('awaiting_approval'), goal: 'g', definition_of_done: ['d'], base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), branch: null,
  acceptance_checks: [{ id: 'unit', command: ['npm', 'test'], required: true, status: 'stale_sha', latest_evidence: { sha: 'c'.repeat(40), exit: null, duration_ms: null, artifact: null } }],
  verdicts: [], decisions: [{ kind: 'k', chosen: 'c', question: 'q', rationale: 'because', evidence: ['e'], actor: { role: 'manager' }, alternatives: ['a'] }],
  usage: { input_tokens: null, output_tokens: 5, usd: null, unknown: ['usd', 'input_tokens'], records: [{ runtime: null, model: null, input_tokens: null, output_tokens: 5, usd: null }] },
  leases: { resources: [], effects: [] }, incidents: [], history: [], pending_approval: null, ...over });

test('detail: unknown usage reads "unknown" not 0; evidence shows SHA; decisions show rationale', () => {
  const h = detailHtml(detail());
  assert.match(h, /cost unknown/);
  assert.match(h, /input tokens unknown/);
  assert.doesNotMatch(h, /\$0\.0000/);
  assert.match(h, /sha c{12}/);
  assert.match(h, /exit unknown/);
  assert.match(h, /because/);
});

test('approve/deny buttons only for a pending request, and they carry its action id and sha', () => {
  assert.doesNotMatch(detailHtml(detail()), /data-tk-approve|data-tk-deny/);
  const h = detailHtml(detail({ pending_approval: { action_id: 'appr-t-1', question: 'Deploy?', classes: ['deploy'], sha: 'b'.repeat(40) } }));
  assert.match(h, /data-tk-approve data-aid="appr-t-1" data-sha="b{40}"/);
  assert.match(h, /data-tk-deny/);
  assert.doesNotMatch(detailHtml(detail({ state: 'accepted', outcome: 'done' })), /data-tk-cancel/, 'terminal tasks cannot be cancelled');
  assert.match(detailHtml(detail()), /data-tk-cancel/);
});

test('static: UI code uses only icons that exist in icons.js, no emoji or hand-pasted svg', () => {
  const files = { 'tasks-view.js': readFileSync(new URL('../public/tasks-view.js', import.meta.url), 'utf8'),
    'index.html': readFileSync(new URL('../public/index.html', import.meta.url), 'utf8') };
  const used = [...files['tasks-view.js'].matchAll(/icon\(\s*(?:'([\w-]+)'|b\.ico)/g)].map((m) => m[1]).filter(Boolean);
  used.push(...[...files['tasks-view.js'].matchAll(/ico: '([\w-]+)'/g)].map((m) => m[1]));
  used.push(...[...files['index.html'].matchAll(/data-icon="([\w-]+)"/g)].map((m) => m[1]));
  assert.ok(used.includes('tasks') && used.includes('help'));
  for (const n of used) assert.ok(ICONS[n], `icon ${n} missing from icons.js`);
  assert.doesNotMatch(files['tasks-view.js'], /<svg/);
  assert.doesNotMatch(files['tasks-view.js'], /\p{Extended_Pictographic}/u);
  assert.match(newFormHtml(), /Nothing runs until/);
});

test('service worker precaches the new module and the cache version moved on', () => {
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /'\/tasks-view\.js'/);
  assert.match(sw, /ghosty-shell-v151/);
});

test('approval queue on top of the list; accepted tasks show delivery; partial usage, runs, roles, graph render', () => {
  const q = [{ task_id: 't-q', goal: 'g', action_id: 'appr-t-q-0', question: 'Deploy?', classes: ['deploy'], sha: null }];
  const l = listHtml([task('accepted', { delivery: { requested: false, integrated: false, label: 'verified in worktree, not integrated' } })], q);
  assert.ok(l.indexOf('tk-queue') < l.indexOf('tk-row accepted') || l.indexOf('tk-queue') < l.indexOf('data-tk-open="t-accepted"'));
  assert.match(l, /Needs owner \(1\)/);
  assert.match(l, /not integrated/);
  assert.equal(listHtml([task('created')], []).includes('tk-queue'), false);
  const h = detailHtml(detail({ state: 'accepted', outcome: 'done', pending_approval: null, delivery: { requested: true, integrated: false, label: 'verified in worktree, not integrated' },
    usage: { input_tokens: 1, output_tokens: 1, usd: null, unknown: ['usd'], incomplete: true, records: [] },
    runs: [{ run_id: 'r', role: 'developer', runtime: 'claude', model: 'm', effort: 'high', outcome: 'finished', started_at: 's', ended_at: 'e', usage: null }],
    roles: { developers: ['claude:m'], reviewers: [] }, allowed_actions: { source: 'x', approval_required: ['deploy'], prohibited_actions: [], allowed_commands: null, allowed_paths: null },
    parent_task_id: 'p-1', children: [{ task_id: 'c-1', state: 'created', goal: 'x' }] }));
  for (const re of [/partial/, /not integrated/, /effort high/, /usage unknown/, /developer: claude:m/, /unknown until a run reads the policy/, /data-tk-open="p-1"/, /data-tk-open="c-1"/]) assert.match(h, re);
});

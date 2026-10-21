// Round 13 brief B: notify texts and targets, the own-job wake on an integration id, the deploy adapter argv, the view helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyStall } from '../stall.js';
import { jobRefs, waitsOnOwnJob, createOwnJobs } from '../own-jobs.js';
import { integrationText, integrationNotice, createIntegrationNotify, tailLines, normRequest } from '../integration-notify.js';
import { createIntegrationDeploys, requestArgv } from '../integration-deploys.js';
import * as iv from '../public/integration-view.js';
import { ICONS } from '../public/icons.js';

// Lane shape (integration-lane.js enqueue + transitions): deployScope, deployed { id, version, env, scope }, ISO timestamps,
// endedAt ISO on final, live { step, tail } while running, r.tail '' while running. `normRequest` maps these onto the
// names the session / own-jobs / view read.
const iso = (ms) => new Date(ms).toISOString();
const req = (o = {}) => ({
  id: 'int-7f3a', repo: 'demo-repo', branch: 'feat/x', target: 'main', session: 'alpha',
  state: 'merged', sha: 'a'.repeat(40), deployScope: null, deployed: null, tail: '',
  createdAt: iso(0), updatedAt: iso(0), startedAt: null, endedAt: null, ...o,
});

test('texts: merged, deployed, returned (+ tail), ci red, deploy failed', () => {
  assert.equal(integrationText(req()), 'Integration int-7f3a: merged feat/x into main at aaaaaaaaaaaa.');
  // deployed: the lane sets `deployed = { id, version, env, scope }` only on a successful deploy
  assert.equal(integrationText(req({ state: 'deployed', deployed: { id: 'd-1', version: '1.2.3', env: 'env-a', scope: 'full' } })),
    'Integration int-7f3a: merged feat/x into main at aaaaaaaaaaaa, deployed 1.2.3 to env-a.');
  const r = integrationText(req({ state: 'returned', reason: 'tests are red', tail: 'FAIL a\n\n  at b\nx\ny\nz\nw' }));
  assert.match(r, /^Integration int-7f3a returned: tests are red\. Fix it on your branch and run integrate request again\.\nFAIL a\n  at b\nx\ny\nz$/);
  assert.match(integrationText(req({ state: 'merged_ci_red', reason: 'unit failed' })), /CI is red.*manager decides/);
  assert.match(integrationText(req({ state: 'deploy_failed', reason: 'health check' })), /deploy failed/);
  assert.equal(integrationText(req({ state: 'running' })), null);
  assert.equal(tailLines('a\nb\nc', { lines: 2 }), 'a\nb');
  assert.equal(integrationNotice(req({ state: 'merged_ci_red' })).priority, 'high');
});

test('normRequest: maps lane fields onto session-side names (deployScope->deploy, deployed->{version,env}, endedAt ISO->finishedAt ms, ISO->ms for timestamps, live.tail->tail while running)', () => {
  const now = 1_700_000_000_000;
  const lane = {
    id: 'int-9', repo: 'demo', branch: 'feat/n', target: 'main', session: 'alpha',
    deployScope: 'server', deployed: { id: 'd-7', version: '3.0.0', env: 'env-a', scope: 'server' },
    state: 'running', step: 'test', tail: '', live: { step: 'test', tail: 'l1\nl2' },
    sha: 'b'.repeat(40), createdAt: iso(now - 60_000), updatedAt: iso(now - 1_000), startedAt: iso(now - 30_000), endedAt: null,
  };
  const n = normRequest(lane);
  assert.equal(n.deploy, 'server');
  assert.equal(n.version, '3.0.0'); assert.equal(n.env, 'env-a');
  assert.equal(n.tail, 'l1\nl2', 'live.tail fills tail while running');
  assert.equal(typeof n.createdAt, 'number'); assert.equal(typeof n.startedAt, 'number'); assert.equal(typeof n.updatedAt, 'number');
  assert.equal(n.finishedAt, null);

  // final state: endedAt ISO -> finishedAt ms; live ignored; tail kept as the lane set it
  const final = { ...lane, state: 'returned', tail: 'tests red', live: undefined, reason: 'tests red', endedAt: iso(now) };
  const f = normRequest(final);
  assert.equal(f.finishedAt, now);
  assert.equal(f.tail, 'tests red', 'final tail is not overwritten by stale live');
  assert.equal(f.version, '3.0.0'); assert.equal(f.env, 'env-a'); assert.equal(f.deploy, 'server');

  // already-normalised: no overwrite
  const already = { ...lane, deploy: 'frontend', version: '9.9.9', env: 'env-z', finishedAt: now - 1 };
  const a = normRequest(already);
  assert.equal(a.deploy, 'frontend'); assert.equal(a.version, '9.9.9'); assert.equal(a.env, 'env-z'); assert.equal(a.finishedAt, now - 1);
  assert.ok(!Number.isNaN(a.createdAt), 'timestamps still normalised to numbers');

  // queued: position preserved, deployScope null -> deploy null, live not set
  const queued = { ...lane, state: 'queued', deployScope: null, deployed: null, position: 2, tail: '', live: undefined };
  const q = normRequest(queued);
  assert.equal(q.deploy, null); assert.equal(q.position, 2); assert.equal(q.tail, '');
});

test('notify: log line records event.kind (the lane sets kind, not type)', async () => {
  const logs = [];
  const notify = createIntegrationNotify({ log: (r) => logs.push(r) });
  await notify(req({ state: 'merged' }), { kind: 'final', state: 'merged' });
  assert.ok(logs.some((l) => l.type === 'integration_notify' && l.event === 'final'));
  await notify(req({ id: 'int-2', state: 'returned', reason: 'x', tail: 'y' }), { kind: 'final', state: 'returned' });
  assert.ok(logs.some((l) => l.type === 'integration_notify' && l.event === 'final'));
});

function harness(over = {}) {
  const sent = [], feed = [], events = [], after = [];
  const status = { alpha: { state: 'done', stall: {} }, busy: { state: 'working' }, drafty: { state: 'done', stall: { draft: true } }, menu: { state: 'done', stall: { options: [1, 2] } } };
  const canSend = (st) => st.state === 'done' && !st.stall?.draft && !st.stall?.options?.length;
  const notify = createIntegrationNotify({ status: (s) => status[s], isRemote: (s) => s.startsWith('mac:'), canSend, send: async (s, t) => { sent.push([s, t]); },
    feed: (i) => feed.push(i), managerEvent: async (e) => { events.push(e); }, afterSend: (s, r) => after.push([s, r.id]), ...over });
  return { notify, sent, feed, events, after };
}

test('notify: a stopped codebox session gets one line; the feed and the manager always get an event', async () => {
  const h = harness();
  const r = await h.notify(req(), { type: 'state' });
  assert.deepEqual(h.sent, [['alpha', 'Integration int-7f3a: merged feat/x into main at aaaaaaaaaaaa.']]);
  assert.equal(r.sent, true);
  assert.equal(h.feed.length, 1); assert.equal(h.feed[0].kind, 'integration');
  assert.equal(h.events.length, 1); assert.equal(h.events[0].key, 'integration:int-7f3a:merged'); assert.equal(h.events[0].session, 'alpha');
  assert.deepEqual(h.after, [['alpha', 'int-7f3a']]);
  await h.notify(req());   // the same transition twice: told once
  assert.equal(h.sent.length, 1); assert.equal(h.feed.length, 1);
});

test('notify: working / draft / menu / unknown / remote / cancelled sessions get no typed line, but the feed and manager are told', async () => {
  for (const [session, state] of [['busy', 'merged'], ['drafty', 'merged'], ['menu', 'returned'], ['ghost', 'merged'], ['mac:laptop', 'merged'], ['alpha', 'cancelled'], [undefined, 'merged']]) {
    const h = harness();
    await h.notify(req({ session, state, reason: 'x' }));
    assert.equal(h.sent.length, 0, `${session}/${state}`);
    assert.equal(h.feed.length, 1, `${session}/${state} feed`);
    assert.equal(h.events.length, 1, `${session}/${state} event`);
  }
});

test('notify: non-final transitions are ignored; a failing send or feed never throws into the lane', async () => {
  const h = harness();
  assert.equal((await h.notify(req({ state: 'running' }), { type: 'step' })).told, false);
  assert.equal(h.feed.length + h.events.length, 0);
  const bad = harness({ send: async () => { throw new Error('pane is not an agent'); }, feed: () => { throw new Error('feed down'); } });
  const r = await bad.notify(req({ id: 'int-9' }));
  assert.equal(r.told, false);
  assert.equal(bad.events.length, 1, 'the manager event is written before the send is tried');
});

test('job refs: "integration <id>" in a STATUS line is the session\'s own job, never a needs-you', () => {
  assert.equal(jobRefs('waiting: integration int-7f3a').integration, 'int-7f3a');
  assert.equal(jobRefs('integration int-42 queued').integration, 'int-42');
  assert.equal(jobRefs('integration request id: int-r9x').integration, 'int-r9x');
  assert.equal(jobRefs('waiting for the integration tests').integration, null);
  assert.equal(jobRefs('the integration lane is slow').integration, null);
  assert.equal(waitsOnOwnJob('waiting: integration int-7f3a', 'waiting'), true);
  const s = classifyStall({ plain: ['Pushed my branch.', 'STATUS: waiting: integration int-7f3a'], state: 'done' });
  assert.equal(s.case, 'own_job_wait'); assert.equal(s.answer, null); assert.equal(s.ownJob.integration, 'int-7f3a');
});

test('own-jobs: an integration id wakes the session on a final state with the same text; not before', async () => {
  // the lane's request shape: deployScope, deployed { ... }, ISO timestamps, live { step, tail } while running, endedAt ISO on final
  let current = { id: 'int-7f3a', repo: 'demo', branch: 'feat/x', target: 'main', session: 'alpha', deployScope: null, deployed: null,
    state: 'running', step: 'test', steps: [{ name: 'test', startedAt: iso(1_000), endedAt: null, ok: null, tail: 'part of the run' }],
    tail: '', live: { step: 'test', tail: 'part of the run' },
    createdAt: iso(1_000), updatedAt: iso(1_000), startedAt: iso(1_000), endedAt: null, sha: 'a'.repeat(40), reason: null };
  const sent = [];
  const oj = createOwnJobs({ now: () => 2_000, integrationState: async (id) => (id === 'int-7f3a' ? current : null), send: async (s, t) => { sent.push([s, t]); } });
  const w = await oj.watch('alpha', { text: 'integration int-7f3a' });
  assert.equal(w.kind, 'integration'); assert.equal(w.label, 'integration int-7f3a'); assert.equal(w.unseen, false);
  assert.deepEqual(await oj.tick(), []);
  assert.match(await oj.progressOf('alpha'), /integration int-7f3a is running \(test\)/);
  // final: the lane sets endedAt ISO and clears live; own-jobs normalises via normRequest
  current = { ...current, state: 'returned', reason: 'tests are red', tail: 'FAIL x', endedAt: iso(2_000), updatedAt: iso(2_000), live: undefined };
  const woke = await oj.tick();
  assert.equal(woke.length, 1);
  assert.equal(sent[0][1], integrationText(current));
  assert.match(sent[0][1], /returned: tests are red/);
  assert.deepEqual(await oj.tick(), [], 'woken once');
});

test('own-jobs: an unknown id or an unreachable lane does not wake and does not throw', async () => {
  const oj = createOwnJobs({ integrationState: async () => { throw new Error('lane down'); }, send: async () => { throw new Error('must not send'); } });
  await oj.watch('alpha', { text: 'integration int-1' });
  assert.deepEqual(await oj.tick(), []);
});

test('deploy adapter: request argv, id from stdout, refusals, wait polls the list and reads the version', async () => {
  assert.deepEqual(requestArgv({ env: 'env-a', scope: 'server', ref: 'main', agent: 'integration:int-7f3a' }),
    ['deploy', 'request', 'env-a', '--scope', 'server', '--ref', 'main', '--agent', 'integration:int-7f3a', '--approved']);
  const calls = [];
  let polls = 0;
  const registry = async (argv) => {
    calls.push(argv);
    if (argv[1] === 'request') return { code: 0, stdout: 'd-42\n', stderr: '' };
    if (argv[1] === 'list') { polls++; return { code: 0, stdout: JSON.stringify({ deploys: [{ id: 'd-42', env: 'env-a', state: polls < 3 ? 'running' : 'done' }] }), stderr: '' }; }
    if (argv[1] === 'last') return { code: 0, stdout: JSON.stringify({ envs: { 'env-a': { version: '1.2.3' } } }), stderr: '' };
    return { code: 1, stdout: '', stderr: 'unsupported' };
  };
  const d = createIntegrationDeploys({ registry, sleep: async () => {} });
  const q = await d.request({ env: 'env-a', scope: 'server', ref: 'main', sha: 'a'.repeat(40), agent: 'integration:int-7f3a' });
  assert.deepEqual(q, { ok: true, id: 'd-42', sha: 'a'.repeat(40) });
  assert.deepEqual(calls[0], requestArgv({ env: 'env-a', scope: 'server', ref: 'main', agent: 'integration:int-7f3a' }));
  const w = await d.wait('d-42');
  assert.deepEqual([w.ok, w.state, w.version], [true, 'done', '1.2.3']);
  assert.equal(polls, 3);
  for (const bad of [{ env: 'e;rm', scope: 'server', ref: 'main', agent: 'integration:i1' }, { env: 'env-a', scope: 'all', ref: 'main', agent: 'integration:i1' },
    { env: 'env-a', scope: 'server', ref: '--evil', agent: 'integration:i1' }, { env: 'env-a', scope: 'server', ref: 'main', agent: 'someone' }]) assert.equal((await d.request(bad)).ok, false);
  const refuse = createIntegrationDeploys({ registry: async () => ({ code: 3, stdout: '', stderr: 'E_HELD' }) });
  assert.match((await refuse.request({ env: 'env-a', scope: 'server', ref: 'main', agent: 'integration:i1' })).error, /E_HELD/);
});

test('deploy adapter: the version is this deploy\'s own ledger entry, not the server\'s (real case 2026-10-20 23:44)', async () => {
  // `deploy last env-a --json` really returns one entry per target (server, frontend, each host name). A scope-host
  // deploy put main-2026.10.20-89466 on every host while the server stayed on the older main-2026.10.20-89445, and
  // `env.server || env.frontend || env.host` made the lane report 89445. Nothing here names a real env or host.
  const entry = (o) => ({ agent: 'manager:deploy', status: 'done', ...o });
  const hosts = (o = {}) => ({ 'host-a': entry({ at: 1200, version: 'main-2026.10.20-89466', ...o }), 'host-b': entry({ at: 1201, version: 'main-2026.10.20-89466', ...o }) });
  const server = entry({ at: 1000, version: 'main-2026.10.20-89445', commit: 'a1a1a1a', deployId: 'older-1' });
  const frontend = entry({ at: 900, version: 'main-2026.10.20-89400' });
  const mk = (map, deploy = {}) => createIntegrationDeploys({ registry: async (argv) => {
    if (argv[1] === 'list') return { code: 0, stdout: JSON.stringify({ deploys: [{ id: 'd9', env: 'env-a', state: 'done', scope: 'host', agent: 'integration:int-7f3a', ...deploy }] }), stderr: '' };
    if (argv[1] === 'last') return { code: 0, stdout: typeof map === 'string' ? map : JSON.stringify({ envs: { 'env-a': map } }), stderr: '' };
    return { code: 1, stdout: '', stderr: 'unsupported' };
  }, sleep: async () => {} }).wait('d9');

  assert.equal((await mk({ server, frontend, ...hosts({ deployId: 'd9' }) })).version, 'main-2026.10.20-89466', 'the entry carrying this deploy id wins');
  assert.equal((await mk({ server, frontend, 'host-a': entry({ at: 1100, version: 'main-2026.10.20-89450', lastAttempt: { deployId: 'd9', status: 'done', version: 'main-2026.10.20-89466' } }) })).version,
    'main-2026.10.20-89450', 'a done lastAttempt of this deploy marks its entry, whose own version is returned');
  assert.equal((await mk({ server, frontend, 'host-a': entry({ at: 1100, version: 'main-2026.10.20-89450', lastAttempt: { deployId: 'another', status: 'failed' } }), ...hosts() })).version,
    'main-2026.10.20-89466', 'a failed lastAttempt of another deploy marks nothing');
  // no deployId anywhere: this deploy's own agent wins, even against a newer entry written by someone else
  assert.equal((await mk({ server: entry({ at: 1300, version: 'main-2026.10.20-89470' }), 'host-a': entry({ at: 1200, version: 'main-2026.10.20-89466', agent: 'integration:int-7f3a' }) })).version, 'main-2026.10.20-89466');
  // neither: the newest entry inside the deploy's scope
  assert.equal((await mk({ server, frontend, ...hosts() })).version, 'main-2026.10.20-89466');
  assert.equal((await mk({ server, frontend, ...hosts({ deployId: 'another' }) }, { scope: 'server' })).version, 'main-2026.10.20-89445', 'scope server reads the server entry');
  assert.equal((await mk({ server, frontend, ...hosts({ deployId: 'another' }) }, { scope: 'full' })).version, 'main-2026.10.20-89466', 'scope full reads the newest of all targets');
  assert.equal((await mk({ server: entry({ at: 1000, version: 'main-2026.10.20-89445', deployId: 'd9' }), 'host-a': entry({ at: 1300, version: 'main-2026.10.20-89470' }) }, { scope: 'server' })).version,
    'main-2026.10.20-89445', 'a deployId match wins over a newer unrelated entry');
  assert.equal((await mk({ version: '1.2.3' })).version, '1.2.3', 'a flat entry keeps its own version');
  assert.equal((await mk('not json')).version, null, 'unparsable output is no version');
  assert.equal((await mk({})).version, null, 'an env without entries is no version');
});

test('deploy adapter: a failed deploy, a timeout and a vanished id', async () => {
  const mk = (state) => createIntegrationDeploys({ registry: async () => ({ code: 0, stdout: JSON.stringify({ deploys: state ? [{ id: 'd1', env: 'e', state, tail: 'boom' }] : [] }), stderr: '' }), sleep: async () => {} });
  const f = await mk('failed').wait('d1');
  assert.deepEqual([f.ok, f.state, f.tail], [false, 'failed', 'boom']);
  let t = 0;
  const slow = createIntegrationDeploys({ registry: async () => ({ code: 0, stdout: JSON.stringify({ deploys: [{ id: 'd1', state: 'running' }] }), stderr: '' }), sleep: async () => { t += 60000; }, now: () => t });
  assert.equal((await slow.wait('d1', { timeoutMs: 120000 })).state, 'timeout');
  assert.equal((await mk(null).wait('d1')).state, 'unknown');
});

test('deploy adapter: a deploy that finished between polls is read from the registry, not counted as a miss', async () => {
  // `deploy list` only holds queued/running deploys: a finished one is gone, so the registry is asked (`deploy wait <id>`)
  const mk = (waitResult) => {
    const calls = [];
    const d = createIntegrationDeploys({ registry: async (argv) => {
      calls.push(argv.join(' '));
      if (argv[1] === 'list') return { code: 0, stdout: JSON.stringify({ deploys: [] }), stderr: '' };
      if (argv[1] === 'wait') return waitResult();
      if (argv[1] === 'last') return { code: 0, stdout: JSON.stringify({ envs: { 'env-a': { version: '1.2.3' } } }), stderr: '' };
      return { code: 1, stdout: '', stderr: 'unsupported' };
    }, sleep: async () => {} });
    return { d, calls };
  };
  // done with a version on the line
  let a = mk(() => ({ code: 0, stdout: 'deploy d9 done (version 2.0.1)\n', stderr: '' }));
  assert.deepEqual(await a.d.wait('d9'), { ok: true, state: 'done', version: '2.0.1', tail: '' });
  assert.ok(a.calls.includes('deploy wait d9 --timeout 5'), 'asks the registry for that id');
  // done without a version: the version is read from `deploy last`, as for a listed entry
  const b = mk(() => ({ code: 0, stdout: 'deploy d9 done\n', stderr: '' }));
  const w = await b.d.wait('d9');
  assert.deepEqual([w.ok, w.state, w.version, w.tail], [true, 'done', '1.2.3', '']);
  assert.ok(b.calls.includes('deploy last --json'));
  // failed and cancelled carry their reason as the tail
  const f = await mk(() => ({ code: 1, stdout: 'deploy d9 failed (health check failed)\n', stderr: '' })).d.wait('d9');
  assert.deepEqual([f.ok, f.state, f.version, f.tail], [false, 'failed', null, 'health check failed']);
  const c = await mk(() => ({ code: 1, stdout: 'deploy d9 cancelled (the owner stopped it)\n', stderr: '' })).d.wait('d9');
  assert.deepEqual([c.ok, c.state, c.version, c.tail], [false, 'cancelled', null, 'the owner stopped it']);
  // a wait that only times out (still queued/running, or the registry is unavailable) counts the miss as before
  let polls = 0;
  const t = mk(() => { polls++; return { code: 75, stdout: '', stderr: 'timeout waiting for the deploy' }; });
  const u = await t.d.wait('d9');
  assert.equal(polls, 20); assert.equal(u.state, 'unknown'); assert.match(u.error, /not in the registry/);
});

const now = 10_000_000;
const rq = (o) => ({ id: 'int-1', repo: 'demo-repo', branch: 'feat/a', target: 'main', session: 'alpha', deployScope: null, deployed: null,
  state: 'queued', tail: '', createdAt: iso(now - 60_000), updatedAt: iso(now - 60_000), startedAt: null, endedAt: null, ...o });

test('view: per repo queue by position, running step with output tail, results with sha, version and reason', () => {
  // the lane shape: deployScope -> deploy in the view; deployed { id, version, env, scope } -> version, env; live.tail -> tail while running; endedAt ISO -> finishedAt ms
  const data = { requests: [
    rq({ id: 'q2', position: 2, branch: 'feat/b', deployScope: 'server' }), rq({ id: 'q1', position: 1 }),
    rq({ id: 'r1', state: 'running', step: 'test', tail: '', live: { step: 'test', tail: 'l1\nl2 <b>x</b>' } }),
    rq({ id: 'd1', state: 'deployed', sha: 'c'.repeat(40), deployed: { id: 'd-1', version: '2.0.1', env: 'env-a', scope: 'server' }, endedAt: iso(now - 120_000), updatedAt: iso(now - 120_000) }),
    rq({ id: 'x1', state: 'returned', reason: 'tests are red', tail: 'FAIL x', endedAt: iso(now - 1_000), updatedAt: iso(now - 1_000) }),
    rq({ id: 'o1', repo: 'other-repo', state: 'merged', sha: 'd'.repeat(40) }) ] };
  const h = iv.viewHtml(data, { now });
  assert.ok(h.indexOf('demo-repo') < h.indexOf('other-repo'));
  assert.ok(h.indexOf('data-iv-id="q1"') < h.indexOf('data-iv-id="q2"'));
  assert.match(h, /step<\/span> <b>test<\/b>/);
  assert.match(h, /<pre class="iv-tail">l1\nl2 &lt;b&gt;x&lt;\/b&gt;<\/pre>/);
  assert.match(h, /<code>cccccccccccc<\/code>/);
  assert.doesNotMatch(h, /href="[^"]*">\s*<code>cccccccccccc/, 'lane does not set commitUrl; sha is rendered as a label, not a link');
  assert.match(h, /2\.0\.1<\/a> to env-a/);
  assert.match(h, /tests are red/);
  assert.ok(h.indexOf('data-iv-id="x1"') < h.indexOf('data-iv-id="d1"'), 'newest result first');
  assert.match(h, /data-iv-cancel="q1"/); assert.doesNotMatch(h, /data-iv-cancel="r1"|data-iv-cancel="d1"/, 'only queued requests can be cancelled');
});

test('view: cancel is armed by a first tap; escaping; empty and error states; js commit urls are not linked', () => {
  assert.deepEqual(iv.tap(null, 'q1'), { arm: 'q1', fire: null });
  assert.deepEqual(iv.tap('q1', 'q1'), { arm: null, fire: 'q1' });
  assert.deepEqual(iv.tap('q1', 'q2'), { arm: 'q2', fire: null });
  assert.equal(iv.actionRequest('q1').url, '/api/integration/requests/q1/cancel');
  assert.equal(iv.actionRequest('../x'), null);
  assert.match(iv.viewHtml({ requests: [rq({ id: 'q1', position: 1 })] }, { armed: 'q1', now }), /tap again to cancel/);
  // escaping: even when commitUrl slips in (the lane never sets it), it must not be rendered as a link
  const evil = iv.viewHtml({ requests: [rq({ branch: '<img src=x onerror=1>', session: '"><script>', state: 'merged', sha: 'e'.repeat(40), commitUrl: 'javascript:alert(1)', reason: '<b>' })] }, { now });
  assert.doesNotMatch(evil, /<img|<script|href="javascript/);
  assert.match(iv.viewHtml({ requests: [] }, { now }), /No integration requests/);
  assert.match(iv.viewHtml([], { now }), /No integration requests/);
  assert.match(iv.viewHtml({ ok: false, error: 'lane down' }, { now }), /lane down/);
});

test('static: view icons exist, no emoji or pasted svg; service worker precaches the view at v150; the menu and app wire it', () => {
  const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const view = rd('../public/integration-view.js'), sw = rd('../public/sw.js'), html = rd('../public/index.html'), app = rd('../public/app.js');
  for (const m of view.matchAll(/icon\('([\w-]+)'/g)) assert.ok(ICONS[m[1]], `icon ${m[1]}`);
  assert.doesNotMatch(view, /<svg|\p{Extended_Pictographic}/u);
  assert.match(sw, /'\/integration-view\.js'/); assert.match(sw, /ghosty-shell-v154/);
  assert.ok(html.indexOf('id="integrationBtn"') > 0 && html.indexOf('id="integrationBtn"') < html.indexOf('id="legacyGroup"'), 'default menu, not Legacy');
  assert.match(app, /import\('\/integration-view\.js'\)/); assert.match(app, /get\('integration'\)\) openIntegrationView/);
});

test('docs: session rules say hand off, never merge / push the target / deploy', () => {
  const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  for (const f of ['../AGENTS.md', '../scripts/cbsession']) { const t = rd(f); assert.match(t, /integrate request/); assert.match(t, /STATUS: waiting:\s+integration <id>/); }
  assert.match(rd('../docs/LEASE-RULES.md'), /integrate request <branch> --deploy/);
  assert.match(rd('../docs/REFERENCE.md'), /## Integration lane/);
});

test('deploy adapter: a deploy still queued at the timeout is cancelled before failure is reported; a running one is waited out', async () => {
  let t = 0; const calls = []; let state = 'queued';
  const registry = async (argv) => {
    calls.push(argv.slice(0, 2).join(' '));
    if (argv[1] === 'cancel') { state = 'cancelled'; return { code: 0, stdout: '{}', stderr: '' }; }
    return { code: 0, stdout: JSON.stringify({ deploys: [{ id: 'd1', state }] }), stderr: '' };
  };
  const d = createIntegrationDeploys({ registry, sleep: async () => { t += 60000; }, now: () => t });
  const w = await d.wait('d1', { timeoutMs: 120000 });
  assert.equal(w.state, 'timeout'); assert.match(w.error, /cancelled/); assert.ok(calls.includes('deploy cancel')); assert.equal(state, 'cancelled');
  // started: never cancelled, waited to its result
  let t2 = 0, polls = 0; const calls2 = [];
  const reg2 = async (argv) => { calls2.push(argv[1]); polls++; return { code: 0, stdout: JSON.stringify({ deploys: [{ id: 'd2', version: 'v1', state: polls > 6 ? 'done' : 'running' }] }), stderr: '' }; };
  const r = await createIntegrationDeploys({ registry: reg2, sleep: async () => { t2 += 60000; }, now: () => t2 }).wait('d2', { timeoutMs: 120000 });
  assert.equal(r.state, 'done'); assert.ok(!calls2.includes('cancel'));
  // find: the deploy already requested for this agent, not a failed one
  const f = createIntegrationDeploys({ registry: async () => ({ code: 0, stdout: JSON.stringify({ deploys: [{ id: 'x1', agent: 'integration:i1', state: 'failed' }, { id: 'x2', agent: 'integration:i1', state: 'queued' }, { id: 'x3', agent: 'integration:i2', state: 'queued' }] }), stderr: '' }) });
  assert.equal(await f.find({ agent: 'integration:i1' }), 'x2'); assert.equal(await f.find({ agent: 'integration:none' }), null);
});

test('jobRefs: "integration test-2" is a sentence, not a request id; the deploy id in it is still found', () => {
  const t = 'waiting on deploy 3fa9c1, then the integration test-2 suite';
  assert.equal(jobRefs(t).integration, null); assert.equal(jobRefs(t).deploy, '3fa9c1');
  assert.equal(jobRefs('integration tests-9 done').integration, null);
  assert.equal(jobRefs('integration request id: int-lq3k9a0b1c2d').integration, 'int-lq3k9a0b1c2d');
});

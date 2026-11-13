// Cross-run dedupe for scripts/manager-event-filter.sh:
//   - asks / waiting / lease lines: deduped across runs within a 6-hour window (persisted in <state>/manager-reports/.seen-keys)
//   - deploy / hold / quota / disk / credits lines: per-run dedupe only (the awk array, as before)
//
// The filter reads JSONL lines on STDIN, runs them through jq selects, then dedupes via awk. We spawn the script with
// a temp GHOSTY_STATE_DIR and feed two separate runs of the same input to assert what is printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmp } from './helpers-tmp.js';

const SH = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'manager-event-filter.sh');

const ev = (overrides) => JSON.stringify({ at: new Date(1e12).toISOString(), title: 't', body: '', ...overrides }) + '\n';
const asksLine   = ev({ key: 'web:asks',    kind: 'asks',    session: 'web', body: 'Should I deploy now?' });
const waitingLine= ev({ key: 'web:waiting', kind: 'waiting', session: 'web', body: 'Need approval' });
const leaseLine  = ev({ key: 'lease:narrowed', kind: 'lease', state: 'narrowed', body: 'shrunk' });
const deployLine = ev({ key: 'deploy:a:failed', kind: 'deploy', state: 'failed', body: 'crashed' });
const holdLine   = ev({ key: 'web:hold',    kind: 'hold',    session: 'web', body: 'paused' });

const run = (env, input) => spawnSync('bash', [SH], { env, input, encoding: 'utf8', timeout: 20000 });
const kinds = (r) => r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l).l.kind);
const seenPath = (dir) => join(dir, 'manager-reports', '.seen-keys');

test('cross-run dedupe: asks / waiting / lease are suppressed in run 2; deploy / hold keep per-run dedupe only', () => {
  const dir = tmp('ghosty-filt-');
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const input = asksLine + waitingLine + leaseLine + deployLine + holdLine;

  const r1 = run(env, input);
  assert.equal(r1.status, 0, r1.stderr);
  assert.deepEqual(kinds(r1).sort(), ['asks', 'deploy', 'hold', 'lease', 'waiting'], 'run 1 prints everything (deploy:failed passes the selects)');

  const r2 = run(env, input);
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(kinds(r2).sort(), ['deploy', 'hold'], 'run 2 prints only deploy + hold; asks / waiting / lease are deduped across runs');
});

test('seen-keys file: only cross-run kinds (asks / waiting / lease) are appended; per-run kinds (deploy / hold) are not', () => {
  const dir = tmp('ghosty-filt-');
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  run(env, asksLine + waitingLine + leaseLine + deployLine + holdLine);
  const lines = readFileSync(seenPath(dir), 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 3, 'asks + waiting + lease are persisted');
  const keys = lines.map((l) => l.split(' ').slice(1).join(' ')).sort();
  assert.deepEqual(keys, [
    'stop|web|shouldideploynow?',
    'web|waiting|Needapproval',
    '|lease|shrunk',
  ]);
});

test('seen-keys: entries older than 6 h are pruned on startup, so the same asks line prints again', () => {
  const dir = tmp('ghosty-filt-');
  mkdirSync(join(dir, 'manager-reports'), { recursive: true });
  const seven_h_ago = Math.floor(Date.now() / 1000) - 7 * 3600;
  writeFileSync(seenPath(dir), `${seven_h_ago} stop|web|shouldideploynow?\n`);
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const r = run(env, asksLine);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(kinds(r), ['asks'], 'entry older than 6 h was pruned, so the asks line prints again');
});

test('seen-keys: an entry within the 6 h window is kept and suppresses the same asks line in a later run', () => {
  const dir = tmp('ghosty-filt-');
  mkdirSync(join(dir, 'manager-reports'), { recursive: true });
  const one_h_ago = Math.floor(Date.now() / 1000) - 3600;
  writeFileSync(seenPath(dir), `${one_h_ago} stop|web|shouldideploynow?\n`);
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const r = run(env, asksLine);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(kinds(r), [], 'recent entry suppresses the same asks line');
  // after the run, the entry is still there (within the window)
  const lines = readFileSync(seenPath(dir), 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
});
test('the deploy runner\'s own lease releases (agent manager:deploy, deploy-finished) are dropped; routine released/expired leases are dropped too; other lease events and failed deploys pass', () => {
  const dir = tmp('ghosty-filt-');
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const own = ev({ key: 'lease:released', kind: 'lease', state: 'released', title: 'lease released: e/host-a (agent manager:deploy)', body: 'lease 1 by manager:deploy (deploy-finished); purpose: deploy abc' });
  const other = ev({ key: 'lease:released', kind: 'lease', state: 'released', title: 'lease released: e/host-a (agent codebox:run)', body: 'lease 2 by codebox:run (released); purpose: run' });
  const expired = ev({ key: 'lease:expired', kind: 'lease', state: 'expired', title: 'lease expired: e/host-b', body: 'lease 3 expired' });
  const denied = ev({ key: 'lease:denied', kind: 'lease', state: 'denied', title: 'lease denied: e/host-c', body: 'lease 4 denied' });
  const stuck = ev({ key: 'lease:overdue', kind: 'lease', state: 'overdue', title: 'lease overdue: e/host-d', body: 'lease 5 overdue' });
  const r = run(env, own + other + expired + denied + stuck + deployLine);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(kinds(r).sort(), ['deploy', 'lease', 'lease']);
  assert.match(r.stdout, /lease denied/);
  assert.match(r.stdout, /lease overdue/);
  assert.doesNotMatch(r.stdout, /codebox:run|deploy-finished|lease expired/);
});

test('residual-risk pin: beside a dropped runner release, a blocked or orphan deploy event of the same deploy still wakes the manager', () => {
  const dir = tmp('ghosty-filt-');
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const own = ev({ key: 'lease:released', kind: 'lease', state: 'released', title: 'lease released: e/host-a (agent manager:deploy)', body: 'lease 1 by manager:deploy (deploy-finished); purpose: deploy abc' });
  const blocked = ev({ key: 'deploy:abc:start', kind: 'deploy', state: 'start', blockedBy: ['lease 9'], body: 'blocked' });
  const orphan = ev({ key: 'deploy:abc:orphan', kind: 'deploy', state: 'orphan', body: 'runner gone' });
  const r = run(env, own + blocked + orphan);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(kinds(r).sort(), ['deploy', 'deploy']);
});

test('a lease/deploy wait the system resolves (state system-wait: a live ticket, a running deploy) never wakes the manager (owner 2026-10-31)', () => {
  const dir = tmp('ghosty-filt-');
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const sw = ev({ key: 'lease:system-wait', kind: 'lease', state: 'system-wait', session: 'web', title: 'web: lease wait the system resolves', body: 'ticket t-1 queued' });
  const item = ev({ key: 'lease:manager-item', kind: 'lease', state: 'manager-item', session: 'web', title: 'web: lease stop for the manager', body: 'no ticket' });
  const r = run(env, sw + item);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /system resolves/);
  assert.match(r.stdout, /lease stop for the manager/);
});

test('routine integration merged / deployed events are dropped; returned / failed / non-default priority pass', () => {
  const dir = tmp('ghosty-filt-');
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const e = (id, st, extra = {}) => ev({ key: `integration:int-${id}:${st}`, kind: `int-${id}:${st}`, session: 'integration', priority: 'default', ...extra });
  const input = e('a1', 'merged') + e('a2', 'deployed') + e('a3', 'returned') + e('a4', 'deploy_failed') + e('a5', 'merged_ci_superseded') + e('a6', 'merged', { priority: 'high' });
  const r = run(env, input);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(kinds(r), ['int-a3:returned', 'int-a4:deploy_failed', 'int-a5:merged_ci_superseded', 'int-a6:merged']);
});

test('told / unseen:* are dropped; orphaned-task is deduped across runs', () => {
  const dir = tmp('ghosty-filt-');
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const input = ev({ key: 'rules-watch:told', kind: 'told', body: 'x' }) + ev({ key: 'job:unseen:s', kind: 'unseen:s', body: 'y' }) + ev({ key: 'TASK-1:orphaned-task', kind: 'orphaned-task', body: 'z' });
  assert.deepEqual(kinds(run(env, input)), ['orphaned-task']);
  assert.deepEqual(kinds(run(env, input)), []);
});

// Policy (owner, 2026-11-02): scripts/manager-event-policy.json + <state>/manager-event-policy.json; `u` marks urgent lines for manager-wait.sh.
const flags = (r) => r.stdout.split('\n').filter(Boolean).map((l) => { const o = JSON.parse(l); return [o.l.kind, o.u]; });

test('policy: ignore drops before the built-in rules, pass keeps a line a built-in rule would drop, urgent marks the line', () => {
  const dir = tmp('ghosty-filt-');
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manager-event-policy.json'), JSON.stringify({ 'lease:released': 'pass', leftovers: 'urgent', 'lease:nudge': 'ignore', bug: 'ignore' }));
  const released = ev({ key: 'lease:released', kind: 'lease', state: 'released', body: 'routine' });
  const nudge = ev({ key: 'lease:nudge', kind: 'lease', state: 'nudge', body: 'ask holder' });
  const left = ev({ key: 'w:leftovers', kind: 'leftovers', session: 'w', body: 'left' });
  const bug = ev({ key: 'w:bug', kind: 'bug', session: 'w', body: 'b', bug: { blocking: true } });
  const r = run(env, released + nudge + left + bug + asksLine + deployLine);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(flags(r), [['lease', false], ['leftovers', true], ['asks', true], ['deploy', true]]);
});

test('policy: without an owner file the defaults apply (asks urgent, leftovers not); a high-priority line is urgent by itself and a bug filing (blocking too: the bug drain gets it first) is only deferred; a malformed owner file is ignored', () => {
  const dir = tmp('ghosty-filt-');
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const left = ev({ key: 'w:leftovers', kind: 'leftovers', session: 'w', body: 'left' });
  const bug = ev({ key: 'w:bug', kind: 'bug', session: 'w', body: 'b', bug: { blocking: true } });
  const bug2 = ev({ key: 'x:bug', kind: 'bug', session: 'x', body: 'b2', bug: { blocking: false } });
  const high = ev({ key: 'integration:int-9:merged', kind: 'int-9:merged', session: 'integration', priority: 'high', body: 'm' });
  assert.deepEqual(flags(run(env, left + bug + bug2 + high + asksLine)), [['leftovers', false], ['bug', false], ['bug', false], ['int-9:merged', true], ['asks', true]]);
  const dir2 = tmp('ghosty-filt-');                       // a fresh state dir: the asks line above is in the first dir's cross-run dedupe
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir2, 'manager-event-policy.json'), '{ not json');
  assert.deepEqual(flags(run({ ...process.env, GHOSTY_STATE_DIR: dir2 }, left + asksLine)), [['leftovers', false], ['asks', true]]);
});

test('an event the lane already delivered to its session (handled: session) does not wake the manager; its undelivered follow-up does', () => {
  const dir = tmp('ghosty-filt-');
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const handled = ev({ key: 'integration:int-7:returned', kind: 'int-7:returned', session: 'integration', handled: 'session', body: 'fix it' });
  const undelivered = ev({ key: 'integration:int-7:returned:s1:undelivered', kind: 'int-7:returned:s1:undelivered', session: 'integration', body: 'never told' });
  const plain = ev({ key: 'integration:int-8:returned', kind: 'int-8:returned', session: 'integration', body: 'no session' });
  assert.deepEqual(kinds(run(env, handled + undelivered + plain)), ['int-7:returned:s1:undelivered', 'int-8:returned']);
});

test('external-result: a routine one is dropped (TASK-239), a failure (priority high) always wakes', () => {
  const dir = tmp('ghosty-filt-');
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const ok = ev({ key: 'int-1a:external-result', kind: 'external-result', session: 'int-1a', body: 'Integration int-1a: merged x into main (label mac-1).' });
  const bad = ev({ key: 'int-1b:external-result', kind: 'external-result', session: 'int-1b', priority: 'high', body: 'Integration int-1b: failed.' });
  assert.deepEqual(kinds(run(env, ok)), []);
  assert.deepEqual(kinds(run(env, bad)), ['external-result']);
  assert.deepEqual(kinds(run(env, bad)), ['external-result']);
});

test('TASK-239 wake economy: share notices, idea bugs, session notices and told/daily/overlap are dropped; real bugs and blocking ones pass', () => {
  const dir = tmp('ghosty-filt-');
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const drop = [
    ev({ key: 'a', kind: 'share:TASK66', body: 'plan is 3% used' }),
    ev({ key: 'b', kind: 'bug', priority: 'low', title: 's: bug found: idea: dup state', bug: { blocking: false } }),
    ev({ key: 'c', kind: 'kpi-stb', body: 'parked' }), ev({ key: 'd', kind: 'overlap', body: 'x' }), ev({ key: 'e', kind: 'told', body: 'x' }),
  ].join('');
  assert.deepEqual(kinds(run(env, drop)), []);
  const keep = ev({ key: 'f', kind: 'bug', body: 'f', priority: 'low', title: 's: bug found: Localize fails', bug: { blocking: false } }) + ev({ key: 'g', kind: 'bug', body: 'g', priority: 'high', title: 's: BLOCKING bug found: idea: x', bug: { blocking: true } });
  assert.deepEqual(kinds(run(env, keep)), ['bug', 'bug']);
});

test('the deploy runner\'s per-host narrowing is dropped; narrowed by another agent or without the done-on purpose still passes', () => {
  const dir = tmp('ghosty-filt-');
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const own = ev({ key: 'lease:narrowed', kind: 'lease', state: 'narrowed', title: 'lease narrowed to host: e/host-a,host-b (agent manager:deploy)', body: 'lease 1 by manager:deploy (deploy abc123: done on host-c); purpose: deploy abc123' });
  const other = ev({ key: 'lease:narrowed', kind: 'lease', state: 'narrowed', title: 'lease narrowed to host: e/host-a (agent web)', body: 'lease 2 by web (deploy abc123: done on host-c); purpose: x' });
  const odd = ev({ key: 'lease:narrowed', kind: 'lease', state: 'narrowed', title: 'lease narrowed to host: e/host-a (agent manager:deploy)', body: 'lease 3 by manager:deploy (stuck); purpose: deploy abc123' });
  assert.deepEqual(kinds(run(env, own)), []);
  assert.deepEqual(kinds(run(env, other)), ['lease']);
  assert.deepEqual(kinds(run(env, odd)), ['lease']);
});

// ---- rules before the manager (owner 2026-11-12, TASK-239 G6) ----
const keysOf = (r) => r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l).l.key);

test('a waiting stop routed as a lease / deploy item and the notices of checks the harness answered itself do not wake; an ask and a needs-manager do', () => {
  const dir = tmp('ghosty-filt-'); const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const input = ev({ key: 'lease:manager-item', kind: 'lease', state: 'manager-item', title: 'kpi: lease stop for the manager', body: 'kpi waits for a deploy: lease ticket t-1 on boxA' })
    + ev({ key: 'deploy:abc:manager-item', kind: 'deploy', state: 'manager-item', title: 'web: deploy stop for the manager', body: 'web asks: the box is dead, which host do I use?' })
    + ev({ key: 'done-check:kpi', kind: 'kpi', session: 'done-check', title: 'kpi said done, git disagrees' })
    + ev({ key: 'goal-check:mac:a', kind: 'mac:a', session: 'goal-check', title: 'mac:a: done not accepted by the goal check (Mac: reply with SendMessage to the session name)' })
    + ev({ key: 'health:session-closed:a', kind: 'session-closed:a', session: 'health', title: 'session closed: a' })
    + ev({ key: 'a:needs-manager', kind: 'needs-manager', session: 'a', title: 'a: needs the manager', body: 'a needs the manager: pick one' })
    + ev({ key: 'done-check:b', kind: 'b', session: 'done-check', title: 'b said done, git disagrees', body: 'third time', priority: 'high' });
  assert.deepEqual(keysOf(run(env, input)), ['deploy:abc:manager-item', 'a:needs-manager', 'done-check:b']);
});

test('disk / quota under 95%: once per 5-point bucket across runs; 95% and over always passes', () => {
  const dir = tmp('ghosty-filt-'); const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const d = (p) => ev({ key: 'disk:/', kind: 'disk', title: `codebox disk / ${p}% full`, priority: 'urgent', body: `at ${p}` });
  assert.equal(keysOf(run(env, d(90))).length, 1, 'first alert of the 90-94 bucket');
  assert.equal(keysOf(run(env, d(91))).length, 0, 'same bucket, later run: no wake');
  assert.equal(keysOf(run(env, d(85))).length, 1, 'another bucket');
  assert.equal(keysOf(run(env, d(96))).length, 1, '95% and over passes');
  assert.equal(keysOf(run(env, d(96))).length, 1, '95% and over passes again in a later run');
  const q = (p) => ev({ key: 'quota:claude:week', kind: 'quota', title: `Claude week quota at ${p}%`, priority: 'high', body: `q ${p}` });
  assert.equal(keysOf(run(env, q(80) + q(83))).length, 1, 'one quota wake per bucket');
  assert.equal(keysOf(run(env, q(84))).length, 0);
});

test('every bug filing is marked deferred (d), a blocking one too (bug-67c65223); the drain `bug-drain-cannot` line is urgent', () => {
  const dir = tmp('ghosty-filt-'); const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const r = run(env, ev({ key: 'a:bug', kind: 'bug', session: 'a', title: 'a: bug found: x', body: 'b1', priority: 'default', bug: { blocking: false } })
    + ev({ key: 'b:bug', kind: 'bug', session: 'b', title: 'b: BLOCKING bug found: y', body: 'b2', priority: 'default', bug: { blocking: true } })
    + ev({ key: 'c:bug', kind: 'bug', session: 'c', title: 'c: bug found: z', body: 'b3', priority: 'high', bug: { blocking: false } })
    + ev({ key: 'bug-drain-cannot:bug-1', kind: 'bug-drain-cannot', session: 'b', title: 'blocking bug-1 not started by the drain: x', body: 'b4', priority: 'high' })
    + ev({ key: 'web:asks', kind: 'asks', session: 'web', body: 'Which one?' }));
  const o = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(o.map((x) => [x.l.key, x.d, x.u]), [['a:bug', true, false], ['b:bug', true, false], ['c:bug', true, false], ['bug-drain-cannot:bug-1', false, true], ['web:asks', false, true]]);
});

// one stop = one event; a blocked stop that is a wait and the low-action notices are deferred (2026-11-12, TASK-239 G6)
test('one stop is one event: asks, lease stop and deploy stop of the same text share a key; a wait and a notice are deferred', () => {
  const dir = tmp('mef-stop-');
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const lines = (out) => out.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const a1 = ev({ key: 'content-androidtv:asks', kind: 'asks', session: 'content-androidtv', priority: 'high', title: 'content-androidtv asks you', body: 'STATUS: blocked · 2s · 88k tok · P1 CI claims on `vpt-mf1/device5` stopped my P3 sweep, no missed-slot run completed' });
  const a2 = ev({ key: 'content-androidtv:asks', kind: 'asks', session: 'content-androidtv', priority: 'high', title: 'content-androidtv asks you', body: 'STATUS: blocked · P1 CI claims on vpt-mf1/device5 stopped my P3 sweep, no missed-slot run completed · closing review: docs unchanged' });
  const a3 = ev({ key: 'lease:manager-item', kind: 'lease', session: 'content-androidtv', title: 'content-androidtv: lease stop for the manager', body: 'content-androidtv asks: P1 CI claims on `vpt-mf1/device5` stopped my P3 sweep, no missed-slot run completed' });
  const a4 = ev({ key: 'deploy:3716bf25:manager-item', kind: 'deploy', session: 'content-androidtv', title: 'content-androidtv: deploy stop for the manager', body: 'content-androidtv asks: P1 CI claims on vpt-mf1/device5 stopped my P3 sweep, no missed-slot run completed' });
  const other = ev({ key: 'kpi-stb:asks', kind: 'asks', session: 'kpi-stb', priority: 'high', title: 'kpi-stb asks you', body: 'STATUS: blocked · stb3 has no IR transmitter · tried: hub reset · need: the owner replugs the dongle' });
  const r = lines(run(env, a1 + a2 + a3 + a4 + other));
  assert.equal(r.length, 2, JSON.stringify(r.map((x) => x.k)));
  assert.match(r[0].k, /^stop\|content-androidtv\|p1ciclaimsonvpt-mf1\/device5/);
  assert.equal(r[0].d, false); assert.equal(r[1].d, false, 'a real block wakes the manager now');
  // the same stop does not wake again in a later run (cross-run, like asks before)
  assert.equal(lines(run(env, a3)).length, 0);
  const dir2 = tmp('mef-stop2-');
  const env2 = { ...process.env, GHOSTY_STATE_DIR: dir2 };
  const wait = ev({ key: 'kpi-androidtv:asks', kind: 'asks', session: 'kpi-androidtv', priority: 'high', title: 'kpi-androidtv asks you', body: 'STATUS: blocked · 22s · 1.1M tok · Mi device5 is kept free for content-androidtv until 04:50 UTC; after that I re-claim' });
  const owner = ev({ key: 'x:asks', kind: 'asks', session: 'x', priority: 'high', title: 'x asks you', body: 'STATUS: needs-owner · the box is held by the owner until 09:00, replug it? [1 yes / 2 no]' });
  const note = ev({ key: 'w:leftovers', kind: 'leftovers', session: 'w', title: 'w: leftovers', body: 'row 3 left' });
  const nudge = ev({ key: 'lease:nudge', kind: 'lease', state: 'nudge', title: 'ask a to release', body: 'Your lease blocks b' });
  const quota = ev({ key: 'quota:claude:week', kind: 'quota', title: 'claude default at 80% of the week', body: 'resets 2026-11-14' });
  const r2 = lines(run(env2, wait + owner + note + nudge + quota));
  assert.deepEqual(r2.map((x) => [x.l.kind, x.d]), [['asks', true], ['asks', false], ['leftovers', true], ['lease', true], ['quota', false]], 'quota is urgent in the default policy: not deferred');
});

// 2026-11-12, third set: the manager's field list of wakes it did nothing on
test('a needs-manager stop re-sent with other words after its first 40 characters wakes once per 6 h; a new question wakes; a low-priority bug-drain notice is deferred', () => {
  const dir = tmp('ghosty-filt-nm-'); const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const nm = (body) => ev({ key: 'mac:T208:needs-manager', kind: 'T208:needs-manager', title: 'mac:T208: needs the manager', body: 'mac:T208 needs the manager: ' + body });
  const out = (r) => r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const a = out(run(env, nm('goal not achieved: radio_play_station has no run that proves a station plays · tried: sound only')));
  assert.equal(a.length, 1); assert.equal(a[0].k, 'stop|mac:T208|nm|goalnotachieved:radio_play_stationhasnor'); assert.ok(!a[0].d);
  assert.equal(out(run(env, nm('goal not achieved: radio_play_station has no run proving a station plays · tried: silence check'))).length, 0, 'same question, second run');
  assert.equal(out(run(env, nm('which box do I use for the BLE run? [1 stb4 / 2 stbv1]'))).length, 1, 'a new question still wakes');
  const d = out(run(env, ev({ key: 'bug-drain:tick', kind: 'bug-drain', title: 'bug drain dry: 0 started', body: 'dry: disk 93% >= 90%.', priority: 'low' })));
  assert.equal(d.length, 1); assert.equal(d[0].d, true);
});

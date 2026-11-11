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
    'web|asks|ShouldIdeploynow?',
    'web|waiting|Needapproval',
    '|lease|shrunk',
  ]);
});

test('seen-keys: entries older than 6 h are pruned on startup, so the same asks line prints again', () => {
  const dir = tmp('ghosty-filt-');
  mkdirSync(join(dir, 'manager-reports'), { recursive: true });
  const seven_h_ago = Math.floor(Date.now() / 1000) - 7 * 3600;
  writeFileSync(seenPath(dir), `${seven_h_ago} web|asks|ShouldIdeploynow?\n`);
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const r = run(env, asksLine);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(kinds(r), ['asks'], 'entry older than 6 h was pruned, so the asks line prints again');
});

test('seen-keys: an entry within the 6 h window is kept and suppresses the same asks line in a later run', () => {
  const dir = tmp('ghosty-filt-');
  mkdirSync(join(dir, 'manager-reports'), { recursive: true });
  const one_h_ago = Math.floor(Date.now() / 1000) - 3600;
  writeFileSync(seenPath(dir), `${one_h_ago} web|asks|ShouldIdeploynow?\n`);
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

test('policy: without an owner file the defaults apply (asks urgent, leftovers not); a blocking bug and a high-priority line are urgent by themselves; a malformed owner file is ignored', () => {
  const dir = tmp('ghosty-filt-');
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const left = ev({ key: 'w:leftovers', kind: 'leftovers', session: 'w', body: 'left' });
  const bug = ev({ key: 'w:bug', kind: 'bug', session: 'w', body: 'b', bug: { blocking: true } });
  const bug2 = ev({ key: 'x:bug', kind: 'bug', session: 'x', body: 'b2', bug: { blocking: false } });
  const high = ev({ key: 'integration:int-9:merged', kind: 'int-9:merged', session: 'integration', priority: 'high', body: 'm' });
  assert.deepEqual(flags(run(env, left + bug + bug2 + high + asksLine)), [['leftovers', false], ['bug', true], ['bug', false], ['int-9:merged', true], ['asks', true]]);
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

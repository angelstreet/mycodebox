// scripts/bug-drain-tick.js (owner 2026-11-11: scheduled bug drain). A fake ledger / sessions / quota server and a fake cbsession:
// no live state, no real sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { plan, rank, stats, skipReason, isSmall, impactOf, isOwnerOnly, tick, brief, hostsOf, reachableFrom } from '../scripts/bug-drain-tick.js';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const ago = (h) => new Date(NOW - h * 3600e3).toISOString();
let n = 0;
const bug = (o = {}) => ({ id: `bug-${String(++n).padStart(8, '0')}`, at: ago(30), session: 'gone-session', title: 'endpoint returns 500', endpoint: 'GET /api/x', repro: 'curl the endpoint twice in a row', error: 'HTTP 500 internal', blocking: false, why: 'other-area', state: 'open', ...o });
const quota = (mm = 10, cl = 40) => ({ plans: [{ plan: 'minimax', windows: [{ name: '5h', usedPercent: mm }] }, { plan: 'claude', windows: [{ name: 'week', usedPercent: cl }] }] });
const P = (bugs, o = {}) => plan({ bugs, live: new Set(o.live || []), quota: o.quota || quota(), diskPct: o.disk ?? 50, now: NOW });

test('owner-only / hard floor bugs are dropped', () => {
  for (const b of [bug({ why: 'owner-floor' }), bug({ why: 'credentials' }), bug({ title: 'db repair needed for found-bugs table', why: 'large' }), bug({ title: 'phone needs a physical replug' }), bug({ title: 'b.tv login expired' }), bug({ title: 'refund money path wrong' })]) assert.ok(isOwnerOnly(b), b.title);
  assert.ok(!isOwnerOnly(bug({ title: 'tick wake text wrong' })));
  assert.equal(P([bug({ why: 'owner-floor' })]).start.length, 0);
});

test('claims, live filers (2 h) and live-session areas are dropped', () => {
  const live = new Set(['alice-session', 'kpi-first-paint-fix']);
  assert.match(skipReason(bug({ claim: { by: 'x', at: ago(1), until: new Date(NOW + 3600e3).toISOString() } }), { live, now: NOW }), /claimed/);
  assert.match(skipReason(bug({ session: 'alice-session', at: ago(1) }), { live, now: NOW }), /live session/);
  assert.equal(skipReason(bug({ session: 'alice-session', at: ago(5) }), { live, now: NOW }), '');     // old report of a live session: drainable
  assert.match(skipReason(bug({ session: 'alice-session', at: ago(5), why: 'live-session-task' }), { live, now: NOW }), /live session task/);
  assert.match(skipReason(bug({ title: 'kpi first paint is slow on card' }), { live, now: NOW }), /area owned by live session kpi-first-paint-fix/);
  assert.equal(skipReason(bug({ title: 'kpi table slow' }), { live, now: NOW }), '');                   // not all of the session's words
});

test('rank: blocking first, then age, then impact', () => {
  const a = bug({ at: ago(10), title: 'ui button off' }), b = bug({ at: ago(50), title: 'ui button off 2' }), c = bug({ at: ago(50), title: 'deploy lease wrong' }), d = bug({ at: ago(5), blocking: true, title: 'ui tab' });
  assert.deepEqual(rank([a, b, c, d]).map((x) => x.id), [d.id, c.id, b.id, a.id]);   // c and b are the same age: deploy beats UI
  assert.ok(impactOf(bug({ title: 'ci red' })) > impactOf(bug({ title: 'ui page' })) && impactOf(bug({ title: 'ui page' })) > impactOf(bug({ title: 'idea: nicer' })));
});

test('routing: small -> MiniMax, otherwise Sonnet; quota gates', () => {
  const small = bug(), big = bug({ why: 'large', title: 'rework the lane' }), idea = bug({ title: 'idea: x' });
  assert.ok(isSmall(small) && !isSmall(big) && !isSmall(idea) && !isSmall(bug({ blocking: true })));
  const r = P([small, big]);
  assert.deepEqual(r.start.map((s) => s.provider).sort(), ['claude', 'minimax']);
  const mm = P([small, big], { quota: quota(81, 40) });
  assert.deepEqual(mm.start.map((s) => s.provider), ['claude']); assert.match(mm.skipped[0].why, /MiniMax 5h at 81/);
  const cl = P([small, big], { quota: quota(10, 85) });
  assert.deepEqual(cl.start.map((s) => s.provider), ['minimax']); assert.match(cl.skipped[0].why, /Claude default week/);
  assert.equal(P([big], { quota: { plans: [] } }).start.length, 0);   // unknown quota: no Sonnet worker
});

test('limits: 3 per tick, max 2 alive, disk >= 90 % starts nothing', () => {
  const many = Array.from({ length: 6 }, () => bug());
  assert.equal(P(many).start.length, 2);                                   // room = min(3, 2 - 0)
  assert.equal(P(many, { live: ['bugdrain-aaaa'] }).start.length, 1);
  assert.match(P(many, { live: ['bugdrain-aaaa', 'bugdrain-bbbb'] }).halt, /alive/);
  assert.match(P(many, { disk: 90 }).halt, /disk 90/);
  assert.equal(P(many, { disk: 89 }).start.length, 2);
});

test('stats: open, 24 h opened / closed, median age, finder vs worker', () => {
  const rows = [bug({ at: ago(2) }), bug({ at: ago(10) }), bug({ at: ago(30) }),
    bug({ at: ago(40), resolved: true, state: 'fixed', resolvedBy: 'gone-session', resolvedAt: ago(1), session: 'gone-session' }),
    bug({ at: ago(3), resolved: true, state: 'fixed', resolvedBy: 'bug-drain-2', resolvedAt: ago(2) }),
    bug({ at: ago(60), resolved: true, state: 'wontfix', resolvedBy: 'someone', resolvedAt: ago(48) }), bug({ test: true })];
  const s = stats(rows, NOW);
  assert.deepEqual([s.open, s.opened24h, s.closed24h, s.medianAgeHours], [3, 3, 2, 10]);
  assert.deepEqual([s.fixed, s.fixedByFinder, s.fixedByWorker], [2, 1, 1]);
});

function fakeServer(bugs, { sessions = [], q = quota(), claimStatus = 200 } = {}) {
  const claims = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      const send = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url.startsWith('/api/bugs?')) return send({ ok: true, bugs: req.url.includes('state=open') ? bugs.filter((b) => !b.resolved) : bugs });
      if (req.url === '/api/sessions') return send({ sessions: sessions.map((name) => ({ name })) });
      if (req.url === '/api/quota') return send(q);
      if (/\/claim$/.test(req.url)) { claims.push({ url: req.url, ...JSON.parse(body) }); return send({ ok: claimStatus === 200 }, claimStatus); }
      send({}, 404);
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, claims, url: `http://127.0.0.1:${srv.address().port}` })));
}

test('tick: dry starts and claims nothing, writes journal, scorecard and one manager event; live claims, writes the brief and starts the worker', async () => {
  const bugs = [bug({ title: 'ui page small', blocking: false }), bug({ why: 'large', title: 'rework lane merge' }), bug({ why: 'owner-floor' })];
  const f = await fakeServer(bugs);
  const state = mkdtempSync(path.join(tmpdir(), 'bd-')), fake = path.join(state, 'cbsession'), log = path.join(state, 'cb.log');
  writeFileSync(fake, `#!/bin/sh\nprintf "%s\\n" "$*" >> ${log}\n`); chmodSync(fake, 0o755);
  try {
    const dry = await tick({ reachable: () => new Set(), url: f.url, stateDir: state, mode: 'dry', now: NOW, cbsession: fake, dir: '/x', diskPct: 50 });
    assert.equal(dry.line.started.length, 2); assert.equal(f.claims.length, 0); assert.ok(!existsSync(log));
    const ev = readFileSync(path.join(state, 'manager-events.jsonl'), 'utf8').trim().split('\n');
    assert.equal(ev.length, 1); assert.match(JSON.parse(ev[0]).body, /^dry: /);
    assert.equal(readFileSync(path.join(state, 'bug-drain', 'journal.jsonl'), 'utf8').trim().split('\n').length, 1);
    assert.equal(JSON.parse(readFileSync(path.join(state, 'bug-drain', 'scorecard.json'), 'utf8')).open, 3);

    const live = await tick({ reachable: () => new Set(), url: f.url, stateDir: state, mode: 'live', now: NOW, cbsession: fake, dir: '/x', diskPct: 50 });
    assert.equal(f.claims.length, 2); assert.match(f.claims[0].session, /^bugdrain-/);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.length, 2, JSON.stringify([calls, live.line.started]));
    assert.match(calls.find((c) => c.includes('-p minimax')), /-n bugdrain-\w+ -d \/x -p minimax -g fix bug-\d+ -f /);
    assert.match(calls.find((c) => c.includes('-p claude')), /-m sonnet/);
    assert.ok(live.line.started.every((s) => !s.error));
    const briefFile = calls[0].split('-f ')[1];
    assert.match(readFileSync(briefFile, 'utf8'), /found-bug --claim bug-\d+[\s\S]*STATUS vocabulary/);
  } finally { f.srv.close(); }
});

test('tick: a refused claim starts no worker; sessions API down starts nothing', async () => {
  const f = await fakeServer([bug()], { claimStatus: 409 });
  const state = mkdtempSync(path.join(tmpdir(), 'bd-')), fake = path.join(state, 'cbsession'), log = path.join(state, 'cb.log');
  writeFileSync(fake, `#!/bin/sh\nprintf "%s\\n" "$*" >> ${log}\n`); chmodSync(fake, 0o755);
  try {
    const r = await tick({ reachable: () => new Set(), url: f.url, stateDir: state, mode: 'live', now: NOW, cbsession: fake, dir: '/x', diskPct: 50 });
    assert.match(r.line.started[0].error, /claim refused/); assert.ok(!existsSync(log));
    await assert.rejects(tick({ reachable: () => new Set(), url: f.url, stateDir: state, mode: 'live', now: NOW, cbsession: fake, dir: '/x', diskPct: 50, fetchJson: async (u, p) => { if (p === '/api/sessions') throw new Error('down'); return { bugs: [] }; } }), /sessions/);
  } finally { f.srv.close(); }
});

test('brief carries the bug, the claim command and the STATUS vocabulary, no foreign data', () => {
  const t = brief(bug({ title: 'T' }), { provider: 'minimax' });
  assert.match(t, /Goal: fix bug-/); assert.match(t, /integrate request/); assert.match(t, /failed — goal not achieved/); assert.match(t, /--release/);
  assert.doesNotMatch(brief(bug(), { provider: 'claude' }), /MiniMax/);
});

// Manager, 2026-11-11: the real 1490e2fe (sudo on a hypervisor cron) was classed small; 79a8e46a (a renamed script row) stays small.
const B1490 = { id: 'bug-1490e2fe', title: 'proxmox: clawbox-watchdog cron restarts disabled nginx every 2 min', repro: 'ssh the hypervisor and read the crontab of root', error: 'nginx restarted every 2 min', why: 'other-area' };
const B79A8 = { id: 'bug-79a8e46a', title: "Virtual script row renamed to Play_ClashOfClan during the owner's script edit", repro: 'open the virtual scripts page and list the rows', error: 'row name changed unexpectedly', why: 'other-area' };

test('floor filter: sudo / cron / units / hypervisor / nginx / host config / secrets / DNS / firewall / data deletion / DB work are owner-only', () => {
  assert.ok(isOwnerOnly(bug(B1490)));
  assert.ok(!isOwnerOnly(bug(B79A8)) && isSmall(bug(B79A8)));
  for (const t of ['needs sudo to read the log', 'sudoers entry missing', 'crontab of the worker', 'systemd unit file wrong', 'systemctl restart fails', 'docker daemon down', 'host-config payload wrong', 'secret in .env leaks', 'DNS record wrong', 'firewall blocks port', 'deletion of data on the lane', 'DB migration fails', 'database repair needed']) assert.ok(isOwnerOnly(bug({ title: t })), t);
  for (const t of ['ui tab label cut off', 'ci status badge wrong', 'secretary view empty']) assert.ok(!isOwnerOnly(bug({ title: t })), t);
  // the floor words may sit in the repro or error only
  assert.ok(isOwnerOnly(bug({ title: 'watchdog flaps', repro: 'run it under sudo' })));
  const r = P([bug(B1490), bug(B79A8)]);
  assert.deepEqual(r.start.map((s) => s.bug.id), ['bug-79a8e46a']); assert.equal(r.skipped[0].id, 'bug-1490e2fe'); assert.match(r.skipped[0].why, /^owner-only/);
});

test('hosts: a bug about a host with no healthy lease-inventory entry is never started', () => {
  const inv = 'web: host-clone-1 (held by manager:deploy)  host-clone-2 (free)\nstb: vpt-pi1/device4 (held by x)  vpt-pi3/device4 (UNHEALTHY: host does not answer)\n';
  const reach = reachableFrom(inv);
  assert.deepEqual([...reach].sort(), ['host-clone-1', 'host-clone-2', 'vpt-pi1']);
  assert.deepEqual(hostsOf(bug({ title: 'vpt-pi3 stream stalls on host-clone-1' })), ['vpt-pi3', 'host-clone-1']);
  const ok = bug({ title: 'tile on host-clone-2 blank' }), down = bug({ title: 'vpt-pi3 grabber stalls' }), none = bug({ title: 'vpt-lenovo9 has no entry' });
  const r = P([ok, down, none].map((b) => b), { quota: quota() });   // no inventory known: host-bound bugs held back
  assert.equal(r.start.length, 0);
  const r2 = plan({ bugs: [ok, down, none], live: new Set(), quota: quota(), diskPct: 50, now: NOW, reachable: reach });
  assert.deepEqual(r2.start.map((s) => s.bug.id), [ok.id]);
  assert.match(r2.skipped.map((s) => s.why).join('|'), /not reachable.*vpt-pi3/);
  assert.equal(reachableFrom(''), null);
});

test('tick journal lists owner-only and unreachable ids', async () => {
  const f = await fakeServer([bug(B1490), bug(B79A8), bug({ id: 'bug-aaaaaaaa', title: 'vpt-lenovo9 tile blank' })]);
  const state = mkdtempSync(path.join(tmpdir(), 'bd-'));
  try {
    const r = await tick({ reachable: () => new Set(['host-clone-1']), url: f.url, stateDir: state, mode: 'dry', now: NOW, cbsession: 'x', dir: '/x', diskPct: 50 });
    assert.deepEqual(r.line.ownerOnly, ['bug-1490e2fe']); assert.deepEqual(r.line.unreachable, ['bug-aaaaaaaa']);
    assert.deepEqual(r.line.started.map((s) => s.id), ['bug-79a8e46a']);
    assert.deepEqual(JSON.parse(readFileSync(path.join(state, 'bug-drain', 'journal.jsonl'), 'utf8')).ownerOnly, ['bug-1490e2fe']);
  } finally { f.srv.close(); }
});

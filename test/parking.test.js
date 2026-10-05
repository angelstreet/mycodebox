import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeIndex, claudeOfPane, busyChildren, lastActivityOf, resumeCommand, leasesOfSession, capView, createParking, fmtIdle } from '../parking.js';

const table = (rows) => { // rows: [pid, ppid, args]
  const children = new Map(), args = new Map();
  for (const [pid, ppid, a] of rows) { args.set(pid, a); if (!children.has(ppid)) children.set(ppid, []); children.get(ppid).push(pid); }
  return { children, args, rss: new Map() };
};

test('claudeOfPane skips a bash -c wrapper and takes the claude that has a session file', () => {
  const t = table([[10, 1, 'tmux pane shell'], [11, 10, 'bash -c /home/u/.local/bin/claude --x; exec bash -l'], [12, 11, '/home/u/.local/bin/claude --dangerously-skip-permissions --remote-control A']]);
  const idx = new Map([[12, { pid: 12, sessionId: 's1', status: 'idle' }]]);
  assert.equal(claudeOfPane(10, t, idx).pid, 12);
  assert.equal(claudeOfPane(10, t, new Map()), null);
});

test('busyChildren ignores MCP servers, reports other children', () => {
  const t = table([[1, 0, 'claude'], [2, 1, 'node /x/mcp-server.js'], [3, 1, 'sleep 600']]);
  assert.deepEqual(busyChildren(1, t).map((c) => c.pid), [3]);
});

test('lastActivityOf takes the later of Claude stamp and reporter turn', () => {
  assert.deepEqual(lastActivityOf({ info: { statusUpdatedAt: 100 }, reporterAt: 50 }), { at: 100, source: 'claude' });
  assert.deepEqual(lastActivityOf({ info: { statusUpdatedAt: 100 }, reporterAt: 150 }), { at: 150, source: 'reporter' });
  assert.equal(lastActivityOf({ info: null, reporterAt: 0 }), null);
});

test('resumeCommand reuses the launch command, model and remote-control, then --resume id', () => {
  const base = 'claude --dangerously-skip-permissions';
  assert.equal(resumeCommand({ base, args: 'claude --dangerously-skip-permissions --model opus --remote-control X -n X', name: 'TASK 1', sessionId: 'abc' }),
    "claude --dangerously-skip-permissions --model opus --remote-control 'TASK 1' -n 'TASK 1' --resume abc");
  assert.equal(resumeCommand({ base, args: 'claude --dangerously-skip-permissions', name: 'n', sessionId: 'abc' }), 'claude --dangerously-skip-permissions --resume abc');
});

test('leasesOfSession matches by session or Claude name, ignores others', () => {
  const ls = [{ id: 'l1', agent: 'TASK-33-games', purpose: '' }, { id: 'l2', agent: 'someone-else', purpose: 'deploy' }];
  assert.deepEqual(leasesOfSession(ls, ['TASK33-games', 'x']).map((l) => l.id), ['l1']);
  assert.deepEqual(leasesOfSession(ls, ['TASK99']), []);
});

test('capView: under the cap no candidates; over it lists idle-longest first', () => {
  const mk = (name, la, state = 'idle') => ({ name, agent: 'claude', state, lastActivity: la });
  const under = capView({ sessions: [mk('a', 1)], cap: 10, now: 1e6 });
  assert.equal(under.over, 0); assert.deepEqual(under.candidates, []);
  const sessions = [...Array.from({ length: 12 }, (_, i) => mk('s' + i, 1000 + i * 100)), mk('busy', 1, 'working'), { name: 'sh', agent: 'bash', state: 'idle' }];
  const v = capView({ sessions, cap: 10, now: 1e6 });
  assert.equal(v.live, 13); assert.equal(v.over, 3);
  assert.equal(v.candidates[0].name, 's0');           // oldest idle first; the working one is never a candidate
  assert.ok(!v.candidates.some((c) => c.name === 'busy' || c.name === 'sh'));
  assert.equal(fmtIdle(90), '90m'); assert.equal(fmtIdle(600), '10h'); assert.equal(fmtIdle(4320), '3d');
});

test('claude index reads session files and ignores junk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-'));
  writeFileSync(join(dir, '5.json'), JSON.stringify({ pid: 5, sessionId: 'x', cwd: '/c' }));
  writeFileSync(join(dir, '6.json'), '{half');
  writeFileSync(join(dir, '7.key'), 'k');
  const m = await createClaudeIndex({ dir }).get();
  assert.deepEqual([...m.keys()], [5]);
});

function harness({ exits = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pk-'));
  const log = [];
  let alive = true, exists = true;
  const tmux = { exists: async () => exists, kill: async (n) => { log.push('kill ' + n); exists = false; }, sendText: async (n, t) => log.push('text ' + t), sendEnter: async () => { log.push('enter'); if (exits) alive = false; },
    create: async (n, cwd) => { log.push('create ' + cwd); exists = true; } };
  const p = createParking({ file: join(dir, 'parked.json'), tmux, exitWaitMs: 50, pollMs: 5, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
  const facts = { claude: { pid: 9, info: { status: 'idle', sessionId: 'sid', cwd: '/w', name: 'N', statusUpdatedAt: 7 }, args: 'claude --dangerously-skip-permissions --remote-control N' }, state: 'idle', attached: false, reporterWaiting: false, backgroundWork: 0, busy: [], leases: [], rssMb: 300, priority: 'P1' };
  return { p, log, facts, file: join(dir, 'parked.json'), isAlive: async () => alive };
}

test('checks refuse every unsafe case', () => {
  const { p, facts } = harness();
  assert.deepEqual(p.checks(facts), []);
  const bad = (patch) => p.checks({ ...facts, ...patch });
  assert.match(bad({ claude: { ...facts.claude, info: { ...facts.claude.info, status: 'busy' } } })[0], /not idle/);
  assert.match(bad({ state: 'working' })[0], /board state/);
  assert.match(bad({ attached: true })[0], /attached/);
  assert.match(bad({ reporterWaiting: true })[0], /pending/);
  assert.match(bad({ backgroundWork: 2 })[0], /background/);
  assert.match(bad({ busy: [{ pid: 1, args: 'sleep 9' }] })[0], /child process/);
  assert.match(bad({ leases: null })[0], /vpt-lease/);
  assert.match(bad({ leases: [{ id: 'L' }] })[0], /holds vpt-lease: L/);
  assert.match(bad({ claude: null })[0], /no Claude/);
});

test('park: record first, /exit, kill only after claude is gone; resume recreates and removes the record', async () => {
  const h = harness();
  const rec = await h.p.park('S', h.facts, { claudeAlive: h.isAlive });
  assert.equal(rec.sessionId, 'sid');
  assert.deepEqual(h.log, ['text /exit', 'enter', 'kill S']);
  assert.equal(JSON.parse(readFileSync(h.file, 'utf8')).parked.S.cwd, '/w');
  const started = [];
  const out = await h.p.resume('S', { base: 'claude --dangerously-skip-permissions', start: async (n, r, cmd) => started.push(cmd) });
  assert.equal(started[0], "claude --dangerously-skip-permissions --remote-control 'N' -n 'N' --resume sid");
  assert.equal(out.sessionId, 'sid');
  assert.deepEqual(JSON.parse(readFileSync(h.file, 'utf8')).parked, {});
  await assert.rejects(h.p.resume('S', { base: 'c', start: async () => {} }), /not parked/);
});

test('park: claude that does not exit leaves the session alive and no record', async () => {
  const h = harness({ exits: false });
  await assert.rejects(h.p.park('S', h.facts, { claudeAlive: h.isAlive }), /did not exit/);
  assert.ok(!h.log.some((l) => l.startsWith('kill')));
  assert.deepEqual(JSON.parse(readFileSync(h.file, 'utf8')).parked, {});
});

test('park refuses with reasons and does not touch tmux', async () => {
  const h = harness();
  await assert.rejects(h.p.park('S', { ...h.facts, leases: [{ id: 'L' }] }, { claudeAlive: h.isAlive }), (e) => e.status === 409 && e.reasons.length === 1);
  assert.deepEqual(h.log, []);
  assert.ok(!existsSync(h.file));
});

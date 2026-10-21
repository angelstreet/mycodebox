import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs';

import { join } from 'node:path';
import { createClaudeIndex, claudeOfPane, minimaxOfPane, minimaxPidsUnder, codexOfPane, codexPidsUnder, codexMetaOf, findCodexSessionId, codexResumeCommand, busyChildren, lastActivityOf, resumeCommand, leasesOfSession, capView, createParking, fmtIdle, readManualNotes, isWatcher, rcArchivedInTail, transcriptFile, autoParkArchived } from '../parking.js';
import { tmp } from './helpers-tmp.js';

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
  assert.equal(resumeCommand({ base, args: 'claude --dangerously-skip-permissions', name: 'n', sessionId: 'abc' }), "claude --dangerously-skip-permissions --remote-control 'n' -n 'n' --resume abc");
  // a name-less record (old entries) and a base that already sets Remote Control add nothing
  assert.equal(resumeCommand({ base, args: 'claude', sessionId: 'abc' }), 'claude --dangerously-skip-permissions --resume abc');
  assert.equal(resumeCommand({ base: 'claude --remote-control', args: 'claude', name: 'n', sessionId: 'abc' }), 'claude --remote-control --resume abc');
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
  const dir = tmp('cs-');
  writeFileSync(join(dir, '5.json'), JSON.stringify({ pid: 5, sessionId: 'x', cwd: '/c' }));
  writeFileSync(join(dir, '6.json'), '{half');
  writeFileSync(join(dir, '7.key'), 'k');
  const m = await createClaudeIndex({ dir }).get();
  assert.deepEqual([...m.keys()], [5]);
});

function harness({ exits = true } = {}) {
  const dir = tmp('pk-');
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

test('dead park: no agent in the pane -> records dead:true, skips /exit, kills tmux; resume runs claude --resume', async () => {
  const h = harness();
  const facts = { ...h.facts, claude: null, minimax: null, dead: true, cwd: '/w/dead', sessionId: 'dead-sid' };
  assert.deepEqual(h.p.checks(facts), []);                 // the only refusal that used to fire is gone
  const rec = await h.p.park('D', facts, { claudeAlive: h.isAlive });
  assert.equal(rec.dead, true);
  assert.equal(rec.sessionId, 'dead-sid');
  assert.equal(rec.cwd, '/w/dead');
  assert.equal(rec.claudeName, 'D');                       // same shape as a live Claude park, so resume is unchanged
  assert.deepEqual(h.log, ['kill D']);                     // no /exit, no wait: nothing was running
  assert.equal(JSON.parse(readFileSync(h.file, 'utf8')).parked.D.dead, true);
  const started = [];
  const out = await h.p.resume('D', { base: 'claude --dangerously-skip-permissions', start: async (n, r, cmd) => started.push(cmd) });
  assert.equal(started[0], "claude --dangerously-skip-permissions --remote-control 'D' -n 'D' --resume dead-sid");
  assert.equal(out.dead, true);
  assert.deepEqual(JSON.parse(readFileSync(h.file, 'utf8')).parked, {});
});

test('dead park without a conversation id still parks (sessionId null); resume refuses before creating tmux', async () => {
  const h = harness();
  const facts = { ...h.facts, claude: null, minimax: null, dead: true, cwd: '/w/dead', sessionId: null };
  const rec = await h.p.park('D', facts, { claudeAlive: h.isAlive });
  assert.equal(rec.sessionId, null);
  assert.equal(rec.dead, true);
  assert.deepEqual(h.log, ['kill D']);
  let started = false;
  await assert.rejects(h.p.resume('D', { base: 'claude', start: async () => { started = true; } }), (e) => e.status === 400 && /no conversation id/.test(e.message));
  assert.equal(started, false);                            // refused before anything was launched
  assert.ok(!h.log.includes('create /w/dead'));             // and before a tmux session was created
  assert.equal(JSON.parse(readFileSync(h.file, 'utf8')).parked.D.sessionId, null);   // still parked, nothing lost
});

test('dead park keeps the other refusals: lease held, busy children, no lease readable; an unknown pane is still refused', async () => {
  const h = harness();
  const dead = { ...h.facts, claude: null, minimax: null, dead: true, cwd: '/w', sessionId: 'x' };
  assert.match(h.p.checks({ ...dead, leases: [{ id: 'L' }] })[0], /holds vpt-lease: L/);
  assert.match(h.p.checks({ ...dead, busy: [{ pid: 1, args: 'sleep 9' }] })[0], /child process/);
  assert.match(h.p.checks({ ...dead, leases: null })[0], /vpt-lease/);
  assert.match(h.p.checks({ ...dead, attached: true })[0], /attached/);
  assert.match(h.p.checks({ claude: null, minimax: null })[0], /no Claude, Codex or MiniMax/);   // no dead flag -> unchanged refusal
  await assert.rejects(h.p.park('D', { ...dead, leases: [{ id: 'L' }] }, { claudeAlive: h.isAlive }), (e) => e.status === 409);
  assert.deepEqual(h.log, []);
});

test('readManualNotes parses valid entries (newest first), skips bad rows, tolerates missing/corrupt file', async () => {
  const dir = tmp('ghosty-mn-');
  const file = join(dir, 'parked.json');
  assert.deepEqual(await readManualNotes(file), []);                     // missing file -> []
  writeFileSync(file, '{not json');                                       // corrupt JSON -> []
  assert.deepEqual(await readManualNotes(file), []);
  writeFileSync(file, JSON.stringify({                                     // valid: newest first, non-object row skipped
    a: { resume: 'tmux new -A -s a', parkedAt: '2026-10-04T12:00:00Z', how: 'reason a' },
    b: 'not an object',
    c: { resume: 'tmux new -A -s c', parkedAt: '2026-10-06T08:00:00Z', how: 'reason c' },
  }));
  const out = await readManualNotes(file);
  assert.deepEqual(out.map((m) => m.session), ['c', 'a']);
  assert.equal(out[0].parkedAt, Date.parse('2026-10-06T08:00:00Z'));
  assert.equal(out[0].how, 'reason c');
  assert.equal(out[0].resume, 'tmux new -A -s c');
  assert.equal(out[1].how, 'reason a');
  writeFileSync(file, JSON.stringify({ x: { resume: 'r', parkedAt: 'not-a-date', how: 'h' } }));   // invalid ISO -> null
  const one = await readManualNotes(file);
  assert.equal(one.length, 1);
  assert.equal(one[0].session, 'x');
  assert.equal(one[0].parkedAt, null);
});

test('session-cap-check: no finding under the cap, one finding listing idle-longest over it', async () => {
  const { summarize } = await import('../scripts/session-cap-check.js');
  assert.deepEqual(summarize({ live: 9, cap: 10, over: 0, candidates: [], parked: [{}], ramSavedMb: 300 }).findings, []);
  assert.deepEqual(summarize({ live: 12, cap: 10, over: 2, candidates: [{ name: 'a', idleMin: 3000, rssMb: 300 }], parked: [] }, 6000).findings, []);   // RAM to spare: no finding
  const f = summarize({ live: 12, cap: 10, over: 2, candidates: [{ name: 'a', idleMin: 3000, rssMb: 300 }], parked: [] }, 2000).findings;
  assert.equal(f.length, 1); assert.match(f[0].body, /a \(2d\)/);
});
// MiniMax harness: same shape as harness() above, but the pane's agent is minimax-code / mcode; no claude session file.
function mmHarness({ exits = true, hasCtrlC = true } = {}) {
  const dir = tmp('pk-mm-');
  const log = [];
  let alive = true, exists = true;
  const tmux = {
    exists: async () => exists,
    kill: async (n) => { log.push('kill ' + n); exists = false; },
    sendText: async (n, t) => log.push('text ' + t),
    sendEnter: async () => { log.push('enter'); if (exits) alive = false; },
    ...(hasCtrlC ? { sendCtrlC: async () => log.push('ctrlc') } : {}),
    create: async (n, cwd) => { log.push('create ' + cwd); exists = true; },
  };
  const p = createParking({ file: join(dir, 'parked.json'), tmux, exitWaitMs: 50, pollMs: 5, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
  const facts = { minimax: { pid: 12, cwd: '/w', args: 'mcode' }, state: 'idle', attached: false, reporterWaiting: false, backgroundWork: 0, busy: [], leases: [], rssMb: 200, priority: 'P1' };
  return { p, log, facts, file: join(dir, 'parked.json'), isAlive: async () => alive };
}

test('minimaxOfPane finds the minimax-code pid in the tree', () => {
  const t = table([[10, 1, 'tmux pane shell'], [11, 10, 'bash -c mcode -c; exec bash -l'], [12, 11, '/home/u/.local/node-v24.21.0-linux-x64/bin/mcode']]);
  assert.equal(minimaxOfPane(10, t, '/w').pid, 12);
  assert.equal(minimaxOfPane(10, t, '/w').cwd, '/w');
  assert.equal(minimaxOfPane(10, t, '/w').args, '/home/u/.local/node-v24.21.0-linux-x64/bin/mcode');
  assert.equal(minimaxOfPane(99, t, '/w'), null);
  const t2 = table([[1, 0, 'tmux pane'], [2, 1, '/opt/minimax-code --something']]);
  assert.equal(minimaxOfPane(1, t2, '/w').pid, 2);
  assert.equal(minimaxOfPane(12, table([[12, 0, '/usr/bin/python3']]), '/w'), null);
});

test('minimaxPidsUnder returns empty when no minimax-code / mcode is in the tree', () => {
  const t = table([[1, 0, 'bash'], [2, 1, 'claude --dangerously-skip-permissions']]);
  assert.deepEqual(minimaxPidsUnder(1, t), []);
});

test('checks for a minimax session: busy / lease / attached / reporter refusals; no Claude-specific reasons', () => {
  const { p, facts } = mmHarness();
  assert.deepEqual(p.checks(facts), []);
  const bad = (patch) => p.checks({ ...facts, ...patch });
  assert.match(bad({ minimax: null })[0], /no Claude, Codex or MiniMax/);
  assert.match(bad({ state: 'working' })[0], /board state/);
  assert.match(bad({ attached: true })[0], /attached/);
  assert.match(bad({ reporterWaiting: true })[0], /pending/);
  assert.match(bad({ backgroundWork: 2 })[0], /background/);
  assert.match(bad({ busy: [{ pid: 1, args: 'sleep 9' }] })[0], /child process/);
  assert.match(bad({ leases: null })[0], /vpt-lease/);
  assert.match(bad({ leases: [{ id: 'L' }] })[0], /holds vpt-lease: L/);
});

test('minimax park: records agent + cwd, /exit + Enter, kills tmux; resume runs base -c', async () => {
  const h = mmHarness();
  const rec = await h.p.park('S', h.facts, { claudeAlive: h.isAlive });
  assert.equal(rec.agent, 'minimax');
  assert.equal(rec.cwd, '/w');
  assert.equal(rec.priority, 'P1');
  assert.equal(rec.rssMb, 200);
  assert.ok(!('sessionId' in rec));
  assert.ok(!('claudeName' in rec));
  assert.deepEqual(h.log, ['text /exit', 'enter', 'kill S']);
  const stored = JSON.parse(readFileSync(h.file, 'utf8')).parked.S;
  assert.equal(stored.agent, 'minimax');
  assert.equal(stored.cwd, '/w');
  const started = [];
  const out = await h.p.resume('S', { base: 'PATH=$HOME/.local/node-v24.21.0-linux-x64/bin:$PATH mcode', start: async (n, r, cmd) => started.push(cmd) });
  assert.equal(started[0], 'PATH=$HOME/.local/node-v24.21.0-linux-x64/bin:$PATH mcode -c');
  assert.equal(out.cwd, '/w');
  assert.equal(out.agent, 'minimax');
  assert.equal(out.cmd, 'PATH=$HOME/.local/node-v24.21.0-linux-x64/bin:$PATH mcode -c');
  assert.deepEqual(JSON.parse(readFileSync(h.file, 'utf8')).parked, {});
  await assert.rejects(h.p.resume('S', { base: 'mcode', start: async () => {} }), /not parked/);
});

test('minimax park: /exit did not take -> Ctrl-C twice then kill tmux anyway', async () => {
  const h = mmHarness({ exits: false });
  const rec = await h.p.park('S', h.facts, { claudeAlive: h.isAlive });
  assert.equal(rec.agent, 'minimax');
  assert.deepEqual(h.log, ['text /exit', 'enter', 'ctrlc', 'ctrlc', 'kill S']);
});

test('minimax park: missing sendCtrlC falls through to kill (still finishes)', async () => {
  const h = mmHarness({ exits: false, hasCtrlC: false });
  const rec = await h.p.park('S', h.facts, { claudeAlive: h.isAlive });
  assert.equal(rec.agent, 'minimax');
  assert.deepEqual(h.log, ['text /exit', 'enter', 'kill S']);
});

test('minimax park refuses with reasons and does not touch tmux', async () => {
  const h = mmHarness();
  await assert.rejects(h.p.park('S', { ...h.facts, leases: [{ id: 'L' }] }, { claudeAlive: h.isAlive }), (e) => e.status === 409 && e.reasons.length === 1);
  assert.deepEqual(h.log, []);
  assert.ok(!existsSync(h.file));
});
test('resume validates saved records before creating tmux or executing a command', async () => {
  const h = harness();
  await h.p.park('S', h.facts, { claudeAlive: h.isAlive });
  h.log.length = 0;
  await assert.rejects(h.p.resume('S', { base: 'claude', validate: async () => { throw new Error('invalid saved cwd'); }, start: async () => { throw new Error('must not start'); } }), /invalid saved cwd/);
  assert.deepEqual(h.log, []);
  const saved = JSON.parse(readFileSync(h.file, 'utf8'));
  saved.parked.S.sessionId = 'fake;echo nope';
  writeFileSync(h.file, JSON.stringify(saved));
  const fresh = createParking({ file: h.file, tmux: { exists: async () => false, create: async () => h.log.push('create') } });
  await assert.rejects(fresh.resume('S', { base: 'claude', start: async () => h.log.push('start') }), /invalid resume session id/);
  assert.deepEqual(h.log, []);
});

test('busyChildren ignores the mcode helper every MiniMax session runs, still reports real work under it', () => {
  const helper = 'node --input-type=module --eval\nimport { spawn } from "node:child_process";\nimport x from "y";';
  const t = { children: new Map([[1, [2, 3]]]), args: new Map([[2, helper], [3, 'npm test']]) };
  assert.deepEqual(busyChildren(1, t).map((c) => c.pid), [3]);
  assert.deepEqual(busyChildren(1, { children: new Map([[1, [2]]]), args: new Map([[2, helper.replace(/\n/g, '\\012')]]) }), []);
  assert.deepEqual(busyChildren(1, { children: new Map([[1, [2]]]), args: new Map([[2, 'node --input-type=module --eval "doWork()"']]) }).length, 1);
});

const WATCH = "/bin/bash -c source /h/.claude/shell-snapshots/snapshot-bash-1.sh 2>/dev/null || true && eval 'until ! pgrep -f gate >/dev/null; do sleep 3; done; tail -3 /x/log'";
const okFacts = { claude: { pid: 5, info: { status: 'idle', sessionId: 's' }, args: 'claude' }, state: 'done', busy: [], leases: [] };
const mkP = () => createParking({ file: join(tmp('park-'), 'p.json'), tmux: {} });

test('a finished session whose only leftovers are watcher loops parks (status shell, reporter job count ignored)', () => {
  assert.equal(isWatcher(WATCH), true);
  assert.equal(isWatcher('/bin/bash -c source /h/.claude/shell-snapshots/snapshot-1.sh && eval "npm test"'), false);
  const p = mkP();
  const f = { ...okFacts, claude: { ...okFacts.claude, info: { status: 'shell', sessionId: 's' } }, busy: [{ pid: 7, args: WATCH }, { pid: 8, args: WATCH }], backgroundWork: 2 };
  assert.deepEqual(p.checks(f), []);
});

test('real work still blocks: a build child, a busy turn, a held lease, shell status with a non-watcher child', () => {
  const p = mkP();
  const sh = { ...okFacts.claude, info: { status: 'shell', sessionId: 's' } };
  const r = p.checks({ ...okFacts, claude: sh, busy: [{ pid: 7, args: WATCH }, { pid: 9, args: 'npm test' }] });
  assert.ok(r.some((x) => /running child process: npm test/.test(x)) && r.some((x) => /not idle/.test(x)));
  assert.match(p.checks({ ...okFacts, claude: { ...okFacts.claude, info: { status: 'busy', sessionId: 's' } } })[0], /"busy", not idle/);
  assert.match(p.checks({ ...okFacts, leases: [{ id: 'L1' }] })[0], /holds vpt-lease: L1/);
  assert.match(p.checks({ ...okFacts, backgroundWork: 1 })[0], /1 background job/);
});

const TAKEOVER = '{"type":"system","subtype":"informational","content":"Remote Control disconnected \u2014 another connection took over this session (usually another device or Claude Code session) \u2014 this device is standing down (code 4090)"}';
const GONE = '{"type":"system","subtype":"informational","content":"Remote Control disconnected \u2014 this session was ended or archived from another device or app (code 4090)"}';
test('rcArchivedInTail: the 4090 line archives, a later bridge_status reconnects, other text does not', () => {
  const ACTIVE = '{"type":"system","subtype":"bridge_status","content":"/remote-control is active \u00b7 x"}';
  assert.equal(rcArchivedInTail(GONE), true);
  assert.equal(rcArchivedInTail(`${ACTIVE}\n${GONE}\n`), true);
  assert.equal(rcArchivedInTail(`${GONE}\n${ACTIVE}\n`), false);
  assert.equal(rcArchivedInTail('nothing about it'), false);
  // a take-over shares code 4090 but the owner keeps working elsewhere: never archived
  assert.equal(rcArchivedInTail(TAKEOVER), false);
  assert.equal(transcriptFile('/p', '/home/u/my.proj', 'sid'), '/p/-home-u-my-proj/sid.jsonl');
});

test('autoParkArchived parks only archived + parkable sessions, announces a refusal once, skips managers and live bridges', async () => {
  const claude = (bridge) => ({ pid: 5, info: { status: 'idle', sessionId: 's', cwd: '/w', bridgeSessionId: bridge } });
  const tails = { done: GONE, held: GONE, live: GONE, mgr: GONE, plain: 'no marker', taken: TAKEOVER };
  const panes = ['done', 'held', 'live', 'mgr', 'plain', 'taken'].map((name) => ({ name, claude: claude(name === 'live' ? 'session_x' : null) }));
  const parked = [], notices = [], seen = new Map();
  const p = mkP();
  const run = () => autoParkArchived({
    panes, tailOf: async (info) => tails[panes.find((x) => x.claude.info === info).name], seen, skip: (n) => n === 'mgr',
    factsOf: async (n) => ({ ...okFacts, leases: n === 'held' ? [{ id: 'L9' }] : [] }), checks: (f) => p.checks(f),
    park: async (n) => { parked.push(n); }, notice: async (x) => { notices.push(x); },
  });
  assert.deepEqual(await run(), ['done']);
  await run();
  assert.deepEqual(parked, ['done', 'done']);
  const held = notices.filter((n) => n.session === 'held');
  assert.equal(held.length, 1); assert.match(held[0].reasons[0], /holds vpt-lease: L9/);
  assert.ok(!notices.some((n) => ['live', 'mgr', 'plain', 'taken'].includes(n.session)));
});

const MENU = 'Background work is running\n 1. Exit and stop tasks\n 2. Move to background and exit\n 3. Stay';
function menuHarness(busy) {
  const sent = []; let alive = true;
  const tmux = { sendText: async (_n, t) => { sent.push(t); if (t === '1') alive = false; }, sendEnter: async () => {}, kill: async () => { sent.push('kill'); } };
  const p = createParking({ file: join(tmp('park-'), 'p.json'), tmux, exitWaitMs: 200, pollMs: 5, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
  const facts = { ...okFacts, busy: [], backgroundWork: 0 };
  return { p, sent, facts, opts: { claudeAlive: async () => alive, readPane: async () => MENU, busyNow: async () => busy } };
}

test('exit menu with watcher loops only: sends 1 and parks', async () => {
  const h = menuHarness([{ pid: 7, args: WATCH }]);
  const rec = await h.p.park('s', h.facts, h.opts);
  assert.equal(rec.session, 's');
  assert.deepEqual(h.sent.filter((x) => x !== '/exit'), ['1', 'kill']);
});

test('exit menu with a real child: sends 3 (Stay), reports the reason, does not park', async () => {
  const h = menuHarness([{ pid: 7, args: WATCH }, { pid: 9, args: 'npm test' }]);
  await assert.rejects(h.p.park('s', h.facts, h.opts), (e) => e.status === 409 && /npm test/.test(e.reasons[0]));
  assert.deepEqual(h.sent.filter((x) => x !== '/exit'), ['3']);
  assert.equal(await h.p.get('s'), null);
});

// ---------------------------------------------------------------------------------------------
// Codex: the pane is found through the process tree, the conversation through its rollout file.
// ---------------------------------------------------------------------------------------------
// A temp ~/.codex/sessions tree: `rollouts` writes rollout-<name>.jsonl under <dir>/YYYY/MM/DD with a first line
// holding the session meta, and an explicit mtime so "newest wins" is deterministic (no sleeping in tests).
function rollout(sessionsDir, { day = '2026/10/20', id, cwd, at = 1000, tail = '', flat = false } = {}) {
  const dir = join(sessionsDir, day);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-10-20T10-00-00-${id}.jsonl`);
  const meta = { id, cwd, originator: 'codex_cli_rs', cli_version: '0.0.0' };
  const line = flat ? JSON.stringify({ sessionId: id, cwd }) : JSON.stringify({ timestamp: '2026-10-20T10:00:00.000Z', type: 'session_meta', payload: meta });
  writeFileSync(file, line + '\n' + tail);
  utimesSync(file, at / 1000, at / 1000);
  return file;
}

test('codexMetaOf reads the session meta off the first line (payload or flat record), ignores junk', () => {
  assert.deepEqual(codexMetaOf('{"type":"session_meta","payload":{"id":"abc","cwd":"/w"}}'), { sessionId: 'abc', cwd: '/w' });
  assert.deepEqual(codexMetaOf('{"sessionId":"old","cwd":"/w"}'), { sessionId: 'old', cwd: '/w' });   // older layout
  assert.equal(codexMetaOf('{not json'), null);
  assert.equal(codexMetaOf('{"type":"session_meta","payload":{"cwd":"/w"}}'), null);                  // no id
});

test('codexPidsUnder finds the codex binary, skips a `bash -c codex` wrapper, and nothing else matches', () => {
  const t = table([[10, 1, 'tmux pane shell'], [11, 10, 'bash -c codex; exec bash -l'], [12, 11, '/home/u/.local/bin/codex --dangerously-bypass-approvals-and-sandbox']]);
  assert.deepEqual(codexPidsUnder(10, t), [12]);                       // pid 11 is the wrapper: parking waits on the real agent
  assert.deepEqual(codexPidsUnder(10, table([[10, 1, 'tmux pane'], [11, 10, 'codex --dangerously-bypass-approvals-and-sandbox']])), [11]);
  assert.deepEqual(codexPidsUnder(10, table([[10, 1, 'bash'], [11, 10, 'claude --dangerously-skip-permissions']])), []);
});

test('findCodexSessionId picks the newest rollout of the pane cwd; another cwd is ignored', async () => {
  const dir = tmp('cx-sessions-');
  rollout(dir, { id: 'other-newer', cwd: '/w/other', at: 9000 });
  rollout(dir, { id: 'ours-old', cwd: '/w', at: 1000 });
  rollout(dir, { id: 'ours-new', cwd: '/w', at: 5000 });
  assert.equal((await findCodexSessionId({ sessionsDir: dir, cwd: '/w' })).sessionId, 'ours-new');
  assert.equal((await findCodexSessionId({ sessionsDir: dir, cwd: '/w/other' })).sessionId, 'other-newer');
  assert.equal(await findCodexSessionId({ sessionsDir: dir, cwd: '/w/unknown' }), null);       // nothing for this pane
  assert.equal(await findCodexSessionId({ sessionsDir: join(dir, 'nope'), cwd: '/w' }), null);  // missing tree
  // Only the first line is read: a huge conversation body does not matter, and a cwd later in the file cannot win over the meta.
  rollout(dir, { id: 'ours-big', cwd: '/w', at: 7000, tail: ('{"type":"event_msg","payload":{"cwd":"/elsewhere"}}\n').repeat(5000) });
  assert.equal((await findCodexSessionId({ sessionsDir: dir, cwd: '/w' })).sessionId, 'ours-big');
  assert.equal(await findCodexSessionId({ sessionsDir: dir, cwd: '/elsewhere' }), null);        // the body cwd never counts
});

test('codexOfPane: a codex pid in the tree + the id from the sessions tree; no codex or no id', async () => {
  const dir = tmp('cx-pane-');
  rollout(dir, { id: 'sid-1', cwd: '/w' });
  const t = table([[10, 1, 'tmux pane shell'], [11, 10, 'bash -c codex; exec bash -l'], [12, 11, '/usr/local/bin/codex --dangerously-bypass-approvals-and-sandbox']]);
  const found = await codexOfPane(10, t, '/w', dir);
  assert.equal(found.pid, 12);
  assert.equal(found.sessionId, 'sid-1');
  assert.equal(found.cwd, '/w');
  assert.equal(found.args, '/usr/local/bin/codex --dangerously-bypass-approvals-and-sandbox');
  assert.equal(await codexOfPane(10, table([[10, 1, 'bash']]), '/w', dir), null);            // no codex process
  assert.equal((await codexOfPane(10, t, '/w/elsewhere', dir)).sessionId, null);            // codex, but no rollout for this cwd
  const missing = await codexOfPane(10, t, '/w', join(dir, 'missing'));                     // no sessions tree: process found, nothing to resume
  assert.equal(missing.pid, 12);
  assert.equal(missing.sessionId, null);
});

// Codex harness: same shape as mmHarness(), the pane's agent is `codex` and the conversation id is known.
function cxHarness({ exits = true, sessionId = 'cx-sid', hasCtrlC = true } = {}) {
  const dir = tmp('pk-cx-');
  const log = [];
  let alive = true, exists = true;
  const tmux = {
    exists: async () => exists,
    kill: async (n) => { log.push('kill ' + n); exists = false; },
    sendText: async (n, t) => log.push('text ' + t),
    sendEnter: async () => { log.push('enter'); if (exits) alive = false; },
    ...(hasCtrlC ? { sendCtrlC: async () => log.push('ctrlc') } : {}),
    create: async (n, cwd) => { log.push('create ' + cwd); exists = true; },
  };
  const p = createParking({ file: join(dir, 'parked.json'), tmux, exitWaitMs: 50, pollMs: 5, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
  const facts = { codex: { pid: 12, cwd: '/w', args: 'codex --dangerously-bypass-approvals-and-sandbox', sessionId }, state: 'idle', attached: false, reporterWaiting: false, backgroundWork: 0, busy: [], leases: [], rssMb: 180, priority: 'P1' };
  return { p, log, facts, file: join(dir, 'parked.json'), isAlive: async () => alive };
}

test('checks for a codex session: ok when it has an id; a busy child, a held lease, a missing id all refuse', () => {
  const { p, facts } = cxHarness();
  assert.deepEqual(p.checks(facts), []);
  const bad = (patch) => p.checks({ ...facts, ...patch });
  assert.match(bad({ codex: null })[0], /no Claude, Codex or MiniMax/);
  assert.match(bad({ codex: { ...facts.codex, sessionId: null } })[0], /no resumable codex session id/);
  assert.match(bad({ state: 'working' })[0], /board state/);
  assert.match(bad({ attached: true })[0], /attached/);
  assert.match(bad({ busy: [{ pid: 1, args: 'sleep 9' }] })[0], /child process/);
  assert.match(bad({ leases: null })[0], /vpt-lease/);
  assert.match(bad({ leases: [{ id: 'L' }] })[0], /holds vpt-lease: L/);
});

test('codex park refuses a busy pane and does not touch tmux', async () => {
  const h = cxHarness();
  await assert.rejects(h.p.park('S', { ...h.facts, busy: [{ pid: 30, args: 'npm run build' }] }, { claudeAlive: h.isAlive }),
    (e) => e.status === 409 && /running child process: npm run build/.test(e.reasons[0]));
  assert.deepEqual(h.log, []);
  assert.ok(!existsSync(h.file));
});

test('codex park: records agent + sessionId, /quit, kills tmux; resume runs `codex resume <id>` in the recorded cwd', async () => {
  const h = cxHarness();
  const rec = await h.p.park('S', h.facts, { claudeAlive: h.isAlive });
  assert.equal(rec.agent, 'codex');
  assert.equal(rec.sessionId, 'cx-sid');
  assert.equal(rec.cwd, '/w');
  assert.deepEqual(h.log, ['text /quit', 'enter', 'kill S']);            // Codex quits on /quit, not /exit
  const stored = JSON.parse(readFileSync(h.file, 'utf8')).parked.S;
  assert.equal(stored.agent, 'codex');
  assert.equal(stored.sessionId, 'cx-sid');
  const started = [];
  const out = await h.p.resume('S', { base: 'codex --dangerously-bypass-approvals-and-sandbox', start: async (n, r, cmd) => started.push([n, r.cwd, cmd]) });
  assert.deepEqual(started, [['S', '/w', 'codex --dangerously-bypass-approvals-and-sandbox resume cx-sid']]);
  assert.deepEqual(h.log, ['text /quit', 'enter', 'kill S', 'create /w']);
  assert.equal(out.cmd, 'codex --dangerously-bypass-approvals-and-sandbox resume cx-sid');
  assert.deepEqual(JSON.parse(readFileSync(h.file, 'utf8')).parked, {});
});

test('codex park: /quit did not take -> Ctrl-C twice then kill tmux anyway', async () => {
  const h = cxHarness({ exits: false });
  const rec = await h.p.park('S', h.facts, { claudeAlive: h.isAlive });
  assert.equal(rec.agent, 'codex');
  assert.deepEqual(h.log, ['text /quit', 'enter', 'ctrlc', 'ctrlc', 'kill S']);
});

test('codexResumeCommand keeps the launch flags and refuses a tampered id', () => {
  assert.equal(codexResumeCommand({ base: 'codex --dangerously-bypass-approvals-and-sandbox', sessionId: 'abc-123' }), 'codex --dangerously-bypass-approvals-and-sandbox resume abc-123');
  assert.equal(codexResumeCommand({ base: 'codex', sessionId: 's' }), 'codex resume s');
  assert.throws(() => codexResumeCommand({ base: 'codex', sessionId: 'x; rm -rf /' }), /invalid resume session id/);
  assert.throws(() => codexResumeCommand({ base: 'codex', sessionId: null }), /invalid resume session id/);
});

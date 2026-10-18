import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReporter, isLoopback } from '../reporter.js';

const dir = mkdtempSync(join(tmpdir(), 'ghosty-rep-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000' });
let clock = 1_000_000;
const rep = createReporter({ stateDir: dir, now: () => clock });
await rep.init();
const ev = (event, extra = {}) => ({ v: 1, event, session: 'sess', sessionId: 'sid-1', cwd: '/x', at: clock, ...extra });

test('token file is created 0600, kept on restart, and checked in constant time', async () => {
  const f = join(dir, 'reporter.token');
  assert.ok(existsSync(f));
  assert.equal(statSync(f).mode & 0o777, 0o600);
  const t = readFileSync(f, 'utf8').trim();
  assert.ok(rep.tokenOk(t));
  assert.ok(!rep.tokenOk('nope') && !rep.tokenOk(undefined) && !rep.tokenOk(t + 'x'));
  const again = createReporter({ stateDir: dir });
  await again.init();
  assert.ok(again.tokenOk(t), 'the same token after a restart');
});

test('only loopback peers', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.ok(isLoopback(a), a);
  for (const a of ['192.0.2.7', '198.51.100.5', '::ffff:198.51.100.5', '', undefined]) assert.ok(!isLoopback(a), String(a));
});

test('events keep the latest facts per session; texts are exact and capped', () => {
  assert.throws(() => rep.ingest({ event: 'x' }), /bad event/);
  assert.equal(rep.ingest({ v: 1, event: 'prompt', text: 'x' }).ignored, 'not in tmux');
  rep.ingest(ev('session.start'));
  rep.ingest(ev('prompt', { text: 'Reply with the single word: pong' }));
  clock += 3000;
  rep.ingest(ev('turn.end', { text: 'pong', reason: 'answer' }));
  rep.ingest(ev('turn.end', { text: 'subagent text', agentId: 'ag1' }));   // a subagent's turn is not the session's
  const d = rep.detail('sess');
  assert.equal(d.lastPrompt.text, 'Reply with the single word: pong');
  assert.equal(d.lastTurn.text, 'pong');
  assert.equal(d.sessionId, 'sid-1');
  rep.ingest(ev('turn.end', { text: 'é'.repeat(20000) }));
  assert.ok(rep.detail('sess').lastTurn.text.length <= 8192);
});

test('turn.end and stop of one turn merge, in either order', () => {
  rep.ingest(ev('turn.end', { text: 'waiting for the build', reason: 'answer' }));
  clock += 100;
  rep.ingest(ev('stop', { text: 'waiting for the build', backgroundWork: 1, background: [{ type: 'shell', status: 'running', description: 'npm test' }] }));
  assert.equal(rep.detail('sess').lastTurn.backgroundWork, 1);
  assert.equal(rep.detail('sess').lastTurn.reason, 'answer');
  clock += 60000;
  rep.ingest(ev('stop', { text: 'done now', backgroundWork: 0 }));
  clock += 100;
  rep.ingest(ev('turn.end', { text: 'done now', reason: 'answer' }));
  assert.equal(rep.detail('sess').lastTurn.backgroundWork, 0, 'stop first, then turn.end: the count survives');
  assert.equal(rep.detail('sess').lastTurn.text, 'done now');
});

test('a report belongs to a stop only when no newer prompt and not long before it', () => {
  const stopSince = clock;
  assert.equal(rep.turnForStop('sess', stopSince).text, 'done now');
  assert.equal(rep.turnForStop('sess', stopSince + 120000), null, 'ended long before the stop began');
  clock += 10;
  rep.ingest(ev('prompt', { text: 'next task' }));
  assert.equal(rep.turnForStop('sess', stopSince), null, 'a newer prompt without a turn end');
  assert.equal(rep.promptSince('sess', stopSince).text, 'next task');
});

test('a synthetic prompt (task notification) is not the owner prompt', () => {
  rep.ingest(ev('prompt', { text: 'owner words' }));
  rep.ingest(ev('prompt', { text: '<task-notification>x', synthetic: true }));
  assert.equal(rep.detail('sess').lastPrompt.text, 'owner words');
});

test('waiting stands until the pane moves on, a prompt arrives or the turn ends', () => {
  clock += 1000;
  rep.ingest(ev('waiting', { kind: 'permission', message: 'Permission requested: Bash', tool: 'Bash' }));
  const at = clock;
  assert.equal(rep.waitingNow('sess', at - 5000).message, 'Permission requested: Bash');
  assert.equal(rep.waitingNow('sess', at + 5000), null, 'the pane changed after the report: answered');
  rep.ingest(ev('prompt', { text: 'ok' }));
  assert.equal(rep.waitingNow('sess', 0), null);
});

test('summary exposes the scheduled wakeups (crons) of the last stop', () => {
  rep.ingest(ev('stop', { text: 'next check in 5 min', backgroundWork: 0, crons: 1 }));
  assert.equal(rep.summary('sess').crons, 1);
  assert.equal(rep.summary('sess').backgroundWork, 0);
  clock += 100;
  rep.ingest(ev('turn.end', { text: 'next check in 5 min', reason: 'answer' }));
  assert.equal(rep.summary('sess').crons, 1, 'turn.end after stop keeps the crons');
});

test('agents snapshot, summary for the status payload, session end', () => {
  rep.ingest(ev('agents', { agents: [{ id: 'a1', type: 'Explore', status: 'running', description: 'look' }, { id: 'a2', type: 'general-purpose', status: 'idle', description: 'wait' }] }));
  const s = rep.summary('sess');
  assert.deepEqual(s.agents, { count: 2, by: { running: 1, idle: 1 } });
  assert.equal(rep.summary('nobody'), null);
  rep.ingest(ev('session.end', { reason: 'other' }));
  assert.equal(rep.summary('sess'), null, 'ended: not live');
  clock += 11 * 60 * 1000;
  rep.ingest(ev('session.start'));
  clock += 11 * 60 * 1000;
  assert.equal(rep.summary('sess'), null, 'silent for too long: not live');
});

test('a new conversation (clear / resume) drops the old facts', () => {
  rep.ingest(ev('turn.end', { text: 'old' }));
  rep.ingest({ ...ev('session.start'), sessionId: 'sid-2' });
  assert.equal(rep.detail('sess').lastTurn, null);
});

test('peer.send returns a peer record with from=session, to=given, capped text and ISO at; session facts untouched', () => {
  const before = rep.detail('sess');
  const r = rep.ingest({ v: 1, event: 'peer.send', session: 'sess', sessionId: 'sid-1', cwd: '/x', at: clock, to: 'task58-b', text: 'please continue with phase 2 of the build' });
  assert.equal(r.ok, true);
  assert.ok(r.peer);
  assert.equal(r.peer.type, 'peer');
  assert.equal(r.peer.from, 'sess');
  assert.equal(r.peer.to, 'task58-b');
  assert.equal(r.peer.text, 'please continue with phase 2 of the build');
  assert.match(r.peer.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.equal(r.peer.agentId, undefined);
  assert.equal(r.peer.sessionId, undefined);
  assert.equal(r.peer.session, undefined);
  // per-session facts are untouched
  const after = rep.detail('sess');
  assert.equal(after.lastTurn, before.lastTurn);
  assert.equal(after.lastPrompt, before.lastPrompt);
  assert.equal(after.agents.length, before.agents.length);
  assert.equal(after.live, before.live);
});

test('peer.send text is capped to 2000 chars', () => {
  const big = 'x'.repeat(5000);
  const r = rep.ingest({ v: 1, event: 'peer.send', session: 'sess', sessionId: 'sid-1', cwd: '/x', at: clock, to: 'peer', text: big });
  assert.ok(r.peer);
  assert.equal(r.peer.text.length, 2000);
  assert.equal(r.peer.from, 'sess');
});

test('peer.send with empty text is ignored', () => {
  const r = rep.ingest({ v: 1, event: 'peer.send', session: 'sess', sessionId: 'sid-1', cwd: '/x', at: clock, to: 'peer', text: '' });
  assert.equal(r.peer, undefined);
  assert.equal(r.ignored, 'empty peer text');
});

test('peer.recv returns from=null,to=session and is logged; a recv that repeats a just-sent text is a duplicate', () => {
  clock += 1000;
  const sentText = 'unique signature for this peer message — ' + 'A'.repeat(220);
  rep.ingest({ v: 1, event: 'peer.send', session: 'sess', sessionId: 'sid-1', cwd: '/x', at: clock, to: 'task58-c', text: sentText });
  clock += 2000;
  // a recv of the same text from another session arrives: this is a duplicate of the send we just logged
  const dup = rep.ingest({ v: 1, event: 'peer.recv', session: 'task58-c', sessionId: 'sid-2', cwd: '/y', at: clock, text: sentText });
  assert.equal(dup.ok, true);
  assert.equal(dup.peer, undefined);
  assert.equal(dup.ignored, 'duplicate peer');
  const wrapped = rep.ingest({ v: 1, event: 'peer.recv', session: 'task58-c', sessionId: 'sid-2', cwd: '/y', at: clock, text: `<peer-message from="sess">\n${sentText}\n</peer-message>` });
  assert.equal(wrapped.ignored, 'duplicate peer');   // the receiver sees the text inside an envelope
  clock += 2000;
  // a recv of a different text from yet another session: not a duplicate, logged
  const fresh = rep.ingest({ v: 1, event: 'peer.recv', session: 'task58-d', sessionId: 'sid-3', cwd: '/z', at: clock, text: 'completely unrelated content for a peer message' });
  assert.ok(fresh.peer);
  assert.equal(fresh.peer.type, 'peer');
  assert.equal(fresh.peer.from, null);
  assert.equal(fresh.peer.to, 'task58-d');
  assert.equal(fresh.peer.text, 'completely unrelated content for a peer message');
  assert.match(fresh.peer.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('peer.recv with empty text is ignored', () => {
  const r = rep.ingest({ v: 1, event: 'peer.recv', session: 'peer', sessionId: 'sid-x', cwd: '/x', at: clock, text: '' });
  assert.equal(r.peer, undefined);
  assert.equal(r.ignored, 'empty peer text');
});

test('peer.recv shorter than 20 chars is never deduped (too short to match reliably)', () => {
  clock += 3000;
  rep.ingest({ v: 1, event: 'peer.send', session: 'sess', sessionId: 'sid-1', cwd: '/x', at: clock, to: 'short', text: 'tiny' });
  clock += 2000;
  const r = rep.ingest({ v: 1, event: 'peer.recv', session: 'short', sessionId: 'sid-9', cwd: '/y', at: clock, text: 'tiny' });
  assert.ok(r.peer, 'too short to dedupe — logged normally');
  assert.equal(r.peer.from, null);
  assert.equal(r.peer.to, 'short');
});

test('peer.recv text is capped to 2000 chars', () => {
  const big = 'q'.repeat(5000);
  const r = rep.ingest({ v: 1, event: 'peer.recv', session: 'peer', sessionId: 'sid-x', cwd: '/x', at: clock, text: big });
  assert.ok(r.peer);
  assert.equal(r.peer.text.length, 2000);
});

test('the peer ring only matches the first 200 chars and only within 120 s', () => {
  // a send: remember its head
  clock += 1000;
  const head = 'H'.repeat(180) + 'tail-of-message';
  rep.ingest({ v: 1, event: 'peer.send', session: 'sess', sessionId: 'sid-1', cwd: '/x', at: clock, to: 'old', text: head + ' and more after 200 chars ' + 'X'.repeat(50) });
  // 121 s later, a recv with the same first 200 chars must NOT be deduped (out of window)
  clock += 121_000;
  const r = rep.ingest({ v: 1, event: 'peer.recv', session: 'old', sessionId: 'sid-9', cwd: '/y', at: clock, text: head + ' and more after 200 chars ' + 'X'.repeat(50) });
  assert.ok(r.peer, 'past the 120 s window: not a duplicate');
});

test('a peer record appended via logEvent lands in stalls.jsonl and is ignored by stall consumers', async () => {
  // dynamic import so manager.js reads STATE_DIR after this test set GHOSTY_STATE_DIR
  const { logEvent, LOG_FILE: LOG } = await import('../manager.js');
  assert.equal(LOG, join(dir, 'stalls.jsonl'), 'manager.js loaded STATE_DIR from the env this test set');
  const record = { type: 'peer', from: 'sess', to: 'task58-b', text: 'ghosty-level peer log entry', at: new Date().toISOString() };
  await logEvent(record);
  const logFile = join(dir, 'stalls.jsonl');
  assert.ok(existsSync(logFile));
  const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  const peerLines = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && x.type === 'peer');
  assert.ok(peerLines.length >= 1);
  const last = peerLines[peerLines.length - 1];
  assert.equal(last.from, 'sess');
  assert.equal(last.to, 'task58-b');
  assert.equal(last.text, 'ghosty-level peer log entry');
  // the same consumers that iterate stalls.jsonl should not misread a peer record
  const stalls = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && x.type === 'stall' && Date.parse(x.at) >= clock - 86400000);
  assert.equal(stalls.length, 0, 'no stall records produced by these peer tests');
});

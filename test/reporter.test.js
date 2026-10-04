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
  for (const a of ['<tailscale-ip>', '10.0.0.5', '::ffff:10.0.0.5', '', undefined]) assert.ok(!isLoopback(a), String(a));
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

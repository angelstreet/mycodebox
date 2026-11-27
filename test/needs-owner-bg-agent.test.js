// Owner 2026-11-27: userinterface-audit ended its turn on "STATUS: needs-owner: approve the map recording mockup" while a background
// subagent ("Build virtual_stb device") still ran. The pane kept spinning ("✻ Waiting for 1 background agent to finish"), so the raw
// state stayed 'working': no stall, no push, a green dot. A hand-over turn with only subagents spinning is a stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { tmp } from './helpers-tmp.js';
import { createReporter } from '../reporter.js';
import { stoppedBehindAgents } from '../stall.js';
import { verdictOf } from '../turn-meter.js';
import { displayState } from '../public/state.js';
import { isOwnersTurn } from '../public/ask-model.js';
import { paneBackgroundOf } from '../api-extras.js';
import { liveState } from '../pane-state.js';

const dir = tmp('needsbg-');
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000', JEV_URL: '', JEV_API_KEY: '' });
const m = await import('../manager.js');
const pushes = [];
await m.initManager({ onOwnerNeeded: (s, st) => pushes.push([s, st.case, st.status]) });
await m.setManagerConfig({ aiTriage: 'off', routerShadow: false, autoSend: false });

const RULE = '─'.repeat(40);
const LINE = 'STATUS: needs-owner: approve the map recording mockup (one screen per step, the recorded path on the right) [approve | change it]';
const TEXT = `Mockup is at docs/mockups/map-recording.html.\n\n${LINE}`;
const AGENT = { id: 'a1', type: 'general-purpose', status: 'running', description: 'Build virtual_stb device' };
// the pane as it was: the closing text, the running subagent, Claude's background footer, the input box
const PANE = [...TEXT.split('\n'), '', '● Agent(Build virtual_stb device)', '  ⎿  ⠼ Running… (4m 12s · ↓ 9.1k tokens)',
  '✻ Waiting for 1 background agent to finish', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];
const records = () => (existsSync(m.LOG_FILE) ? readFileSync(m.LOG_FILE, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }) : []);
const until = async (pred, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const r = records().find(pred); if (r) return r; await new Promise((x) => setTimeout(x, 20)); } throw new Error('timed out'); };

function reporterAt(name, text) {
  let clock = 1000;
  const rep = createReporter({ stateDir: dir, now: () => clock });
  const ev = (event, extra) => { clock += 1000; return rep.ingest({ v: 1, session: name, sessionId: 'sid', event, ...extra }); };
  ev('prompt', { text: 'go on with item 17' });
  ev('agents', { agents: [AGENT] });
  ev('turn.end', { text });
  ev('stop', { text, backgroundWork: 1, background: [{ type: 'agent', status: 'running', description: AGENT.description }] });
  return { rep, ev };
}

test('the running-agent + needs-owner row is a stop: the pane state, the reporter and the dashboard row', async () => {
  const { rep } = reporterAt('uia', TEXT);
  assert.deepEqual(rep.summary('uia').agents, { count: 1, by: { running: 1 } });
  const turn = rep.handedOverTurn('uia');
  assert.ok(turn, 'the needs-owner turn is the hand-over turn');
  assert.equal(stoppedBehindAgents(PANE.slice(-15), turn.text), true);   // server.js: the spinner no longer makes it 'working'

  // the manager sees the stop: an owner_decision stall, logged and pushed
  const seam = { turnForStop: (since) => rep.turnForStop('uia', since), promptSince: () => null };
  const tick = (state, now) => m.observe({ name: 'uia', state, agent: 'claude', plain: PANE, raw: PANE, changed: true, realWork: state === 'working', project: 'p', now, rep: seam });
  tick('working', 0); tick('done', 1000); tick('done', 2100); tick('done', 3000);
  const log = await until((r) => r.type === 'stall' && r.session === 'uia');
  assert.equal(log.case, 'owner_decision');
  await new Promise((x) => setTimeout(x, 150));
  assert.deepEqual(pushes.filter(([s]) => s === 'uia'), [['uia', 'owner_decision', 'needs-owner']]);

  // the /ws/status row: the reporter counts the agent; server.js does not report the subagent spinner as pane background for this stop
  assert.equal(paneBackgroundOf(PANE, { shell: false }), true);
  const live = liveState({ agent: 'claude', tail: PANE.slice(-15), now: 5000, handedTurn: () => rep.handedOverTurn('uia'), runningAgents: () => rep.summary('uia').agents.by.running });
  assert.equal(live.state, 'done');
  assert.equal(live.behindAgents, true);   // server.js reports no paneBackground for such a stop
  const row = { name: 'uia', state: 'done', stall: m.stallOf('uia'), triage: m.triageOf('uia'), reporter: rep.summary('uia'), paneBackground: false,
    lastTurn: { ...verdictOf(TEXT.split('\n')), source: 'reporter' } };
  assert.notEqual(displayState(row), 'working');
  assert.equal(isOwnersTurn(row), true);
});

test('back to working: a new prompt, the subagent result starting a new turn, or the footer gone', () => {
  const a = reporterAt('p1', TEXT);
  a.ev('prompt', { text: 'mockup approved, build item 18' });
  assert.equal(a.rep.handedOverTurn('p1'), null);

  const b = reporterAt('p2', TEXT);
  b.ev('prompt', { synthetic: true, text: '<task-notification>agent done</task-notification>' });   // the subagent's result wakes it
  assert.equal(b.rep.handedOverTurn('p2'), null);

  const c = reporterAt('p3', TEXT);
  const turn = c.rep.handedOverTurn('p3');
  const resumed = [...TEXT.split('\n'), '● Reading the agent result', '✻ Thinking… (12s · esc to interrupt)', RULE, '❯ ', RULE];
  assert.equal(stoppedBehindAgents(resumed, turn.text), false);
});

test('a turn without a hand-over STATUS keeps the running agent green', () => {
  for (const text of ['Started the build agent, will report when it lands.', 'Agent running.\n\nSTATUS: running: build agent — then ship']) {
    const { rep } = reporterAt('g', text);
    assert.equal(rep.handedOverTurn('g'), null, text);
    assert.equal(stoppedBehindAgents(PANE, text), false, text);
  }
  // and the dashboard: a pane background with no stop line is still working
  assert.equal(displayState({ name: 'g', state: 'done', paneBackground: true, stall: null, lastTurn: null }), 'working');
});

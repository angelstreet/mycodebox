// Owner 2026-11-26 (whiteboard): a turn ended on "STATUS: needs-owner" stayed green. Claude listed six artifact live-update monitors as
// background work, so the stop was classed background_wait (no ask, no push); later a bare Enter left the row idle and empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { tmp } from './helpers-tmp.js';
import { createReporter } from '../reporter.js';
import { endsHandedOver } from '../stall.js';
import { verdictOf } from '../turn-meter.js';
import { displayState } from '../public/state.js';
import { isOwnersTurn, buildQueue } from '../public/ask-model.js';

const dir = tmp('needsred-');
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000', JEV_URL: '', JEV_API_KEY: '' });
const m = await import('../manager.js');
const pushes = [];
await m.initManager({ onOwnerNeeded: (s, st) => pushes.push([s, st.case, st.status]) });
await m.setManagerConfig({ aiTriage: 'off', routerShadow: false, autoSend: false });

const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Sautéed for 7s · done 6:18 AM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ⧉ 6'];
const records = () => (existsSync(m.LOG_FILE) ? readFileSync(m.LOG_FILE, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }) : []);
const until = async (pred, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const r = records().find(pred); if (r) return r; await new Promise((x) => setTimeout(x, 20)); } throw new Error('timed out'); };
const monitors = (n = 6) => Array.from({ length: n }, (_, i) => ({ type: 'monitor', status: 'running', description: `live updates for artifact https://claude.ai/code/artifact/00000000-0000-0000-0000-00000000000${i} (auto-armed on publish)` }));
const shell = { type: 'shell', status: 'running', description: 'npm test' };
const closing = (line) => `That merge was the first of the two requests.\n\n${line}`;

function report(name, text, background) {
  const rep = createReporter({ stateDir: dir });
  const ev = (event, extra) => rep.ingest({ v: 1, session: name, sessionId: 'sid', event, ...extra });
  ev('turn.end', { text });
  ev('stop', { text, backgroundWork: background.length, background });
  return rep;
}
// the manager sees the stop; returns the logged stall and the status row the dashboard and the app get on /ws/status
async function stop(name, line, background, t0) {
  const text = closing(line), p = pane(text), rep = report(name, text, background);
  const seam = { turnForStop: () => rep.turnForStop(name), promptSince: () => null };
  const tick = (state, plain, now) => m.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, realWork: state === 'working', project: 'p', now, rep: seam });
  tick('working', ['busy'], t0); tick('done', p, t0 + 1000); tick('done', p, t0 + 2100); tick('done', p, t0 + 3000);
  const log = await until((r) => r.type === 'stall' && r.session === name);
  await new Promise((x) => setTimeout(x, 150));
  const row = { name, state: 'done', stall: m.stallOf(name), triage: m.triageOf(name), reporter: rep.summary(name), lastTurn: { ...verdictOf(text.split('\n')), source: 'reporter' } };
  return { log, row, rep };
}

test('artifact live-update monitors are not background work; a real task beside them still is', () => {
  const a = report('count-a', 'x', monitors());
  assert.equal(a.detail('count-a').lastTurn.backgroundWork, 0);
  assert.deepEqual(a.detail('count-a').lastTurn.background, []);
  assert.equal(a.summary('count-a').backgroundWork, 0);
  const b = report('count-b', 'x', [...monitors(), shell, { type: 'monitor', status: 'running', description: 'tail of the CI log' }]);
  assert.equal(b.summary('count-b').backgroundWork, 2);
});

test('needs-owner with six artifact monitors: a needs-you stop, an ask and push, red on the dashboard and in the app data', async () => {
  const { log, row } = await stop('wb', 'STATUS: needs-owner: which new posters to make? [1 to 3 (recommended) | pick others | none for now]', monitors(), 0);
  assert.equal(log.case, 'owner_decision');
  assert.deepEqual(pushes.filter(([s]) => s === 'wb'), [['wb', 'owner_decision', 'needs-owner']]);
  assert.ok(records().some((r) => r.type === 'escalated' && r.session === 'wb'));
  assert.equal(isOwnersTurn(row), true);
  assert.deepEqual(buildQueue({ wb: row }, {}, [{ name: 'wb' }]).map((x) => x.name), ['wb']);
  assert.notEqual(displayState(row), 'working');
});

test('no background count turns a hand-over line into background_wait', async () => {
  let t = 10000;
  for (const [st, line] of [['needs-owner', 'STATUS: needs-owner: which of the two posters? [A | B]'], ['needs-manager', 'STATUS: needs-manager: pick the merge order'],
    ['blocked', 'STATUS: blocked: the device is dead · tried: re-enumeration · need: a replug'], ['failed', 'STATUS: failed — goal not achieved: no frames · tried: two runs · cause: dead grabber · plan: manager'],
    ['done', 'STATUS: done — posters shipped']]) {
    const { log, row, rep } = await stop(`h-${st}`, line, [shell, ...monitors()], t += 10000);
    assert.notEqual(log.case, 'background_wait', st);
    assert.equal(row.stall.status, st);
    assert.equal(rep.summary(`h-${st}`).backgroundWork, 1);
    assert.notEqual(displayState(row), 'working', st);
    // the live row later: the reporter is quiet (lastTurn has no source), its count remains
    assert.notEqual(displayState({ ...row, lastTurn: { ...row.lastTurn, source: null } }), 'working', st);
  }
});

test('a real background job with STATUS: running or waiting still reads as working', async () => {
  let t = 100000;
  for (const [name, line] of [['r-run', 'STATUS: running: the test suite — then ship'], ['r-wait', 'STATUS: waiting: my own test run']]) {
    const { log, row } = await stop(name, line, [shell], t += 10000);
    assert.equal(log.case, 'background_wait', name);
    assert.equal(isOwnersTurn(row), false, name);
    assert.equal(displayState(row), 'working', name);
    assert.ok(!pushes.some(([s]) => s === name));
  }
});

test('after a ghosty restart (no reporter facts, no triage) the pane alone keeps the row red', async () => {
  const p = pane(closing('STATUS: needs-owner: which new posters to make? [1 to 3 (recommended) | pick others | none for now] · bugs:\nnone · leftovers none'));
  assert.equal(endsHandedOver(p), true);
  m.observe({ name: 'restarted', state: 'done', agent: 'claude', plain: p, raw: p, changed: false, realWork: false, project: 'p', now: 1, rep: null });
  const row = { name: 'restarted', state: 'done', stall: m.stallOf('restarted'), triage: m.triageOf('restarted'), reporter: null, lastTurn: { ...verdictOf(p.slice(0, -5)), source: null } };
  assert.equal(row.triage, null);
  assert.equal(isOwnersTurn(row), true);
  assert.equal(buildQueue({ restarted: row }, {}, [{ name: 'restarted' }]).length, 1);
});

test('endsHandedOver: a newer prompt, a running line or no STATUS line does not hold the row as finished', () => {
  assert.equal(endsHandedOver(pane(closing('STATUS: done — shipped'))), true);
  assert.equal(endsHandedOver(pane(closing('STATUS: running: job 4 — rest'))), false);
  assert.equal(endsHandedOver(pane('Plain words, no verdict.')), false);
  assert.equal(endsHandedOver(pane(`${closing('STATUS: needs-owner: which one?')}\n❯ the second one`)), false);
});

test('a needs-owner line that is a merge or system wait is not shown without the reviewer', () => {
  const base = { state: 'done', triage: null };
  assert.equal(isOwnersTurn({ ...base, stall: { case: 'owner_decision', status: 'needs-owner' } }), true);
  assert.equal(isOwnersTurn({ ...base, stall: { case: 'merge_wait', status: 'needs-owner' } }), false);
  assert.equal(isOwnersTurn({ ...base, stall: { case: 'owner_decision', status: 'needs-owner', systemWait: 'deploy' } }), false);
  assert.equal(isOwnersTurn({ ...base, stall: { case: 'owner_decision', status: 'blocked' } }), false);
});

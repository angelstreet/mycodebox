import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ghosty-repmgr-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000' });
const m = await import('../manager.js');
const pushes = [];
await m.initManager({ onOwnerNeeded: (s, st) => pushes.push([s, st.case]) });

const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const records = () => (existsSync(m.LOG_FILE) ? readFileSync(m.LOG_FILE, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }) : []);
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const r = records().find(pred); if (r) return r; await settle(20); }
  throw new Error('timed out waiting for a log record');
}
const tick = (name, state, plain, now, extra = {}) => m.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, realWork: state === 'working', project: 'p', now, ...extra });
const turn = (o) => ({ text: '', at: 0, reason: 'answer', backgroundWork: 0, ...o });
const rep = (t, prompt = null) => ({ turnForStop: () => t, promptSince: () => prompt });

test('the reported final answer replaces the pane excerpt (textSource reporter)', async () => {
  // The pane shows something unrelated (it would classify as done); the reported text asks to continue.
  const p = pane('Phase 1 finished and tested.');
  const r = rep(turn({ text: 'Phase 1 is in.\nShall I continue with phase 2?', at: 500 }));
  tick('r1', 'working', ['busy'], 0, { rep: r });
  tick('r1', 'done', p, 1000, { rep: r }); tick('r1', 'done', p, 2500, { rep: r });
  const s = await until((x) => x.type === 'stall' && x.session === 'r1');
  assert.equal(s.case, 'continue');
  assert.equal(s.textSource, 'reporter');
  assert.match(s.excerpt, /Shall I continue/);
});

test('without a report the pane is used (textSource pane)', async () => {
  const p = pane('Phase 1 is done.\nShall I continue with phase 2?');
  tick('r2', 'working', ['busy'], 0, { rep: rep(null) });
  tick('r2', 'done', p, 1000, { rep: rep(null) }); tick('r2', 'done', p, 2500, { rep: rep(null) });
  const s = await until((x) => x.type === 'stall' && x.session === 'r2');
  assert.equal(s.case, 'continue');
  assert.equal(s.textSource, 'pane');
});

test('Codex never uses a report', async () => {
  const p = pane('Phase 1 is done.\nShall I continue with phase 2?');
  const r = rep(turn({ text: 'Everything is complete and tested.', at: 500 }));
  const t = (st, plain, now) => m.observe({ name: 'r3', state: st, agent: 'codex', plain, raw: plain, changed: true, realWork: st === 'working', project: 'p', now, rep: r });
  t('working', ['busy'], 0); t('done', p, 1000); t('done', p, 2500);
  const s = await until((x) => x.type === 'stall' && x.session === 'r3');
  assert.equal(s.textSource, 'pane');
  assert.equal(s.case, 'continue');
});

test('a stop with background work in flight is background_wait: logged, never escalated or answered', async () => {
  const before = pushes.length;
  const p = pane('Started the build.\nShall I continue once it is done?');
  const r = rep(turn({ text: 'Started the build in the background.\nShall I continue once it is done?', at: 500, backgroundWork: 1 }));
  tick('r4', 'working', ['busy'], 0, { rep: r });
  tick('r4', 'done', p, 1000, { rep: r }); tick('r4', 'done', p, 2500, { rep: r });
  const s = await until((x) => x.type === 'stall' && x.session === 'r4');
  assert.equal(s.case, 'background_wait');
  assert.equal(s.backgroundWork, 1);
  assert.equal(s.wouldSend, null);
  await settle(300);
  assert.equal(pushes.length, before, 'no owner push');
  assert.ok(!records().some((x) => x.type === 'escalated' && x.session === 'r4'));
  assert.ok(m.CASES.includes('background_wait'));
});

test('the outcome uses the prompt text the reporter saw (via reporter)', async () => {
  const p = pane('Phase 1 is done.\nShall I continue with phase 2?');
  const r = rep(null, { text: 'No, do the docs first', at: 4000 });
  tick('r5', 'working', ['busy'], 0, { rep: r });
  tick('r5', 'done', p, 1000, { rep: r }); tick('r5', 'done', p, 2500, { rep: r });
  const st = await until((x) => x.type === 'stall' && x.session === 'r5');
  tick('r5', 'working', [...p.slice(0, -4), '✶ Thinking…', RULE, '❯ ', RULE, 'x'], 9000, { rep: r, realWork: false });   // no spinner seen: the reported prompt is the movement
  const o = await until((x) => x.type === 'outcome' && x.id === st.id);
  assert.equal(o.via, 'reporter');
  assert.equal(o.reply, 'No, do the docs first');
  assert.equal(o.kind, 'owner_specific');
});

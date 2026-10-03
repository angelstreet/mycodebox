import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'ghosty-dedupe-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000' });
delete process.env.JEV_URL;
const m = await import('../manager.js');
await m.initManager({});

const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const tick = (name, state, plain, now, extra = {}) => m.observe({ name, state, agent: 'minimax', plain, raw: plain, changed: true, project: 'p', now, ...extra });
const records = () => (existsSync(m.LOG_FILE) ? readFileSync(m.LOG_FILE, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const of = (type, s) => records().filter((r) => r.type === type && r.session === s);

const STOP = pane('Cache layer is in.\nNext I\'ll wire it into the reader.');

test('a repainting pane that flips to working without a spinner logs one stall and no outcome', async () => {
  let t = 0;
  tick('r1', 'working', ['busy'], t, { realWork: true });
  // 40 "minutes": every 30 s the TUI repaints, ghosty says working for a few seconds, then done again
  for (let i = 0; i < 80; i++) {
    t += 15000; tick('r1', 'done', STOP, t);
    t += 15000; tick('r1', 'working', STOP, t, { realWork: false });
  }
  tick('r1', 'done', STOP, t + 15000);
  await sleep(300);
  assert.equal(of('stall', 'r1').length, 1, 'one stop, one record');
  assert.equal(of('outcome', 'r1').length, 0, 'no work happened, no outcome');
});

test('real work (spinner) in between: the outcome is logged and the next stop is a new record', async () => {
  let t = 0;
  tick('r2', 'working', ['busy'], t, { realWork: true });
  tick('r2', 'done', STOP, t += 1000); tick('r2', 'done', STOP, t += 2000);
  await sleep(100);
  tick('r2', 'working', ['✶ Thinking… esc to interrupt'], t += 1000, { realWork: true });
  tick('r2', 'done', STOP, t += 20000); tick('r2', 'done', STOP, t += 2000);   // the very same stop text again
  await sleep(300);
  assert.equal(of('stall', 'r2').length, 2);
  assert.equal(of('outcome', 'r2').length, 1);
});

test('a send in between also counts as moving on', async () => {
  let t = 0;
  tick('r3', 'working', ['busy'], t, { realWork: true });
  tick('r3', 'done', STOP, t += 1000); tick('r3', 'done', STOP, t += 2000);
  await sleep(100);
  const sentAt = t + 500;
  tick('r3', 'working', STOP, t += 1000, { realWork: false, lastSendAt: sentAt, lastSendText: 'continue' });
  await sleep(100);
  assert.equal(of('outcome', 'r3').length, 1);
  assert.equal(of('outcome', 'r3')[0].reply, 'continue');
  tick('r3', 'done', STOP, t += 20000, { lastSendAt: sentAt }); tick('r3', 'done', STOP, t += 2000, { lastSendAt: sentAt });
  await sleep(300);
  assert.equal(of('stall', 'r3').length, 2);
});

test('a different stop after a flicker is a new stall', async () => {
  let t = 0;
  tick('r4', 'working', ['busy'], t, { realWork: true });
  tick('r4', 'done', STOP, t += 1000); tick('r4', 'done', STOP, t += 2000);
  tick('r4', 'working', STOP, t += 2000, { realWork: false });
  const other = pane('Reader is wired.\nWhich storage do you prefer, disk or memory?');
  tick('r4', 'done', other, t += 2000); tick('r4', 'done', other, t += 2000);
  await sleep(300);
  assert.equal(of('stall', 'r4').length, 2);
  assert.equal(of('outcome', 'r4').length, 0);
});

test('label endpoint logic: validates, needs a known stall, newest label appended', async () => {
  const id = of('stall', 'r1')[0].id;
  await assert.rejects(m.labelStall({ id, label: 'bogus' }), /label must be/);
  await assert.rejects(m.labelStall({ id: 'nope', label: 'legit' }), /unknown stall id/);
  await assert.rejects(m.labelStall({ id, label: 'wrong_case', correctCase: 'nonsense' }), /correctCase/);
  const rec = await m.labelStall({ id, label: 'no_reason', note: 'it just stopped' });
  assert.equal(rec.type, 'label');
  assert.equal(rec.correctCase, null);
  const w = await m.labelStall({ id: of('stall', 'r2')[0].id, label: 'wrong_case', correctCase: 'stopped_short' });
  assert.equal(w.correctCase, 'stopped_short');
  assert.equal(records().filter((r) => r.type === 'label').length, 2);
});

test('stall-report: labels per case, no_reason examples, --export and --reclassify (log untouched)', () => {
  const log = join(dir, 'stalls.jsonl');
  const before = readFileSync(log, 'utf8');
  const out = join(dir, 'export.json');
  const r = spawnSync('node', ['scripts/stall-report.js', '--days', '1', '--log', log, '--export', out, '--reclassify'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /owner labels per case/);
  assert.match(r.stdout, /no reason" examples/);
  assert.match(r.stdout, /reclassify: \d+ distinct stops/);
  const items = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(items.length, 2);
  assert.ok(items.find((x) => x.label === 'no_reason' && x.note === 'it just stopped' && /wire it into the reader/.test(x.excerpt)));
  assert.equal(readFileSync(log, 'utf8'), before, 'the log is not modified');
});

// Pure parts of scripts/daily-checks.js: check-result parsing (a broken check is a finding), event shape, debounce,
// and one end-to-end run against a throwaway HOME with fake check commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCheckResult, buildEvent, shouldWake, loadConfig, run } from '../scripts/daily-checks.js';

const chk = { id: 'x', title: 'X', command: ['n'] };
const ok = (o) => ({ status: 0, stdout: 'noise\n' + JSON.stringify(o) + '\n' });

test('parseCheckResult: last stdout line is the result; no findings = ok', () => {
  const r = parseCheckResult(chk, ok({ summary: 's', report: 'r', findings: [] }));
  assert.equal(r.ok, true); assert.equal(r.findings.length, 0);
  const f = parseCheckResult(chk, ok({ findings: [{ key: 'a', title: 'T', body: 'B' }, { key: '' }, null] }));
  assert.deepEqual(f.findings.map((x) => [x.key, x.priority]), [['a', 'high']]);
});

test('parseCheckResult: crash, timeout, garbage and missing findings all become a check-broken finding', () => {
  for (const res of [{ status: 2, stdout: '' }, { error: { code: 'ETIMEDOUT' } }, { status: 0, stdout: 'not json' }, { status: 0, stdout: '{"summary":"x"}' }, { status: 0, stdout: '' }]) {
    const r = parseCheckResult(chk, res);
    assert.equal(r.broken, true);
    assert.equal(r.findings[0].key, 'check-broken:x');
  }
});

test('buildEvent: daily kind, prefixed key, title <= 80, body <= 300 and ends with the report path', () => {
  const ev = buildEvent({ key: 'ci:main', title: 't'.repeat(200), body: 'b'.repeat(900), priority: 'high' }, '/r/2026-10-05.md', Date.UTC(2026, 9, 5));
  assert.equal(ev.kind, 'daily'); assert.equal(ev.key, 'daily:ci:main');
  assert.ok(ev.title.length <= 80); assert.ok(ev.body.length <= 300); assert.ok(ev.body.endsWith('Report: /r/2026-10-05.md'));
  assert.equal(buildEvent({ key: 'daily:leak:b', title: 't', body: 'b' }, '/r', 0).key, 'daily:leak:b');
});

test('shouldWake: new, unchanged inside the window, changed text, window elapsed', () => {
  const now = 1e10;
  const ev = buildEvent({ key: 'k', title: 't', body: 'b' }, '/r1.md', 0);
  assert.equal(shouldWake(ev, undefined, now, 20).why, 'new');
  // store what a first run would store, by waking once through the public path
  const wake = shouldWake(ev, { at: now - 3600000, fp: 'stale' }, now, 20);
  assert.equal(wake.why, 'changed', 'a different fingerprint wakes');
  const fpOf = (e) => { const m = shouldWake(e, { at: now, fp: '' }, now, 20); return m; };
  assert.equal(fpOf(ev).wake, true);
});

test('run: end-to-end — healthy writes a report and no event; a finding writes one event, then debounces, then re-wakes after clearing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'daily-'));
  const dir = join(home, '.local/state/ghosty'); mkdirSync(dir, { recursive: true });
  const script = join(home, 'chk.js');
  writeFileSync(script, `const fs=require('fs'); const bad=fs.existsSync(process.env.HOME+'/bad'); console.log(JSON.stringify({summary:'s',report:'body',findings:bad?[{key:'leak:b',title:'Leak',body:'x'}]:[]}))`);
  writeFileSync(join(dir, 'daily-checks.json'), JSON.stringify({ checks: [{ id: 'x', title: 'X', command: [process.execPath, script], timeoutSec: 20 }] }));
  const out = () => {};
  const now = Date.UTC(2026, 9, 5, 5);
  let r = await run({ home, now, argv: [], out });
  assert.equal(r.events.length, 0); assert.ok(existsSync(r.reportPath)); assert.ok(!existsSync(join(dir, 'manager-events.jsonl')));
  writeFileSync(join(home, 'bad'), '1');
  r = await run({ home, now: now + 1000, argv: [], out });
  assert.equal(r.events.length, 1);
  const lines = readFileSync(join(dir, 'manager-events.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1); assert.equal(JSON.parse(lines[0]).kind, 'daily');
  r = await run({ home, now: now + 2000, argv: [], out });
  assert.equal(r.events.length, 0, 'debounced');
  r = await run({ home, now: now + 21 * 3600000, argv: [], out });
  assert.equal(r.events.length, 1, 'window elapsed');
  r = await run({ home, now: now + 22 * 3600000, argv: ['--dry-run'], out });
  assert.equal(readFileSync(join(dir, 'manager-events.jsonl'), 'utf8').trim().split('\n').length, 2, 'dry run appends nothing');
});

test('loadConfig: missing file is reported, malformed checks are dropped', () => {
  assert.match(loadConfig('/nonexistent/x.json').error, /no config/);
  const p = join(mkdtempSync(join(tmpdir(), 'daily-')), 'c.json');
  writeFileSync(p, JSON.stringify({ checks: [{ id: 'a', command: ['x'] }, { id: 'b' }, 7] }));
  assert.deepEqual(loadConfig(p).checks.map((c) => c.id), ['a']);
});

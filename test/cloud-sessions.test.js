import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCloudSessions, handoffOf, CLOUD_LOG } from '../cloud-sessions.js';
import { viewHtml, rowHtml, handoffHtml, fmtAgo } from '../public/cloud-view.js';

const NOW = Date.UTC(2026, 10, 28, 16, 0, 0);
const line = (o) => JSON.stringify({ at: '2026-11-28T15:00:00Z', id: 'session_A1', url: 'https://claude.ai/code/session_A1', repo: 'demo', base: 'feat/x', label: 'fix-a', by: 'dev1', task: 'Fix the <b>thing</b>', ...o });

test('the log is read newest first; a torn or foreign line is skipped; only a claude.ai session URL is kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-'));
  writeFileSync(join(dir, CLOUD_LOG), [line({}), '{"torn', line({ id: 'session_B2', at: '2026-11-28T15:30:00Z', label: 'fix-b', url: 'javascript:alert(1)' }), '[]', ''].join('\n'));
  const out = readCloudSessions(dir);
  assert.deepEqual(out.map((c) => c.id), ['session_B2', 'session_A1']);
  assert.equal(out[0].url, null);
  assert.equal(out[1].url, 'https://claude.ai/code/session_A1');
  assert.equal(readCloudSessions(dir, { limit: 1 }).length, 1);
  assert.deepEqual(readCloudSessions(join(dir, 'none')), []);   // no log yet: an empty list, not an error
});

test('the hand-off is the newest lane request queued with --mac cloud-<label>', () => {
  const reqs = [{ id: 'int-2', externalLabel: 'cloud-fix-a', state: 'merged', branch: 'claude/fix-a', repo: 'demo' }, { id: 'int-1', externalLabel: 'cloud-fix-a', state: 'returned' }, { id: 'int-0', externalLabel: 'cloud-other', state: 'merged' }];
  assert.equal(handoffOf({ label: 'fix-a' }, reqs).id, 'int-2');
  assert.equal(handoffOf({ label: 'fix-z' }, reqs), null);
  const dir = mkdtempSync(join(tmpdir(), 'cloud-'));
  writeFileSync(join(dir, CLOUD_LOG), line({}) + '\n');
  assert.equal(readCloudSessions(dir, { requests: reqs })[0].handoff.state, 'merged');
});

test('a row shows label, repo, task (escaped), age, starter, base, link and hand-off; no link without a valid URL', () => {
  const c = { id: 'session_A1', url: 'https://claude.ai/code/session_A1', repo: 'demo', base: 'feat/x', label: 'fix-a', by: 'dev1', task: 'Fix the <b>thing</b>', at: '2026-11-28T15:00:00Z', handoff: { id: 'int-2', state: 'merged_ci_red', branch: 'claude/fix-a' } };
  const h = rowHtml(c, { now: NOW });
  for (const s of ['fix-a', 'demo', 'Fix the &lt;b&gt;thing&lt;/b&gt;', '1h00 ago', 'by dev1', 'from feat/x', 'href="https://claude.ai/code/session_A1"', 'int-2 · merged ci red', 'lv-amber']) assert.ok(h.includes(s), s);
  assert.doesNotMatch(h, /<b>thing/);
  assert.doesNotMatch(rowHtml({ ...c, url: null }, { now: NOW }), /href=/);
  assert.match(handoffHtml(null), /not handed back yet/);
  assert.equal(fmtAgo('bad', NOW), '—');
  assert.equal(fmtAgo('2026-11-25T16:00:00Z', NOW), '3d ago');
});

test('the view: an error, an empty log and a list', () => {
  assert.match(viewHtml({ ok: false, error: 'x <y>' }), /x &lt;y&gt;/);
  assert.match(viewHtml({ ok: true, sessions: [] }), /No cloud session started yet/);
  assert.equal((viewHtml({ ok: true, sessions: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }] }, { now: NOW }).match(/cv-row/g) || []).length, 2);
});

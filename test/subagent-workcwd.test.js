// Round 18: subagent workCwd -> worktree attribution.
// Rows whose parent cwd points elsewhere (Claude Code Agent-tool workers do that: each entry on the
// subagent jsonl carries the parent's folder as cwd) used to fall back to 'session-window' attribution
// even when the requester passed a worktree. The fix records the subagent's real cwd as `workCwd`
// during ingestion, and the lane matches the worktree against `workCwd || cwd`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeLine, workCwdOfSubagent } from '../usage/ingest.js';
import { attribute, rowCwdMatchesWorktree } from '../usage-window.js';
import { sessionUsage } from '../integration-lane.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const tmp = () => mkdtempSync(join(homedir(), 'subagent-workcwd-'));
const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

// A Claude Code subagent transcript line: each entry has its own cwd (= where the tool actually ran); the
// assistant entry also carries message.content with a tool_use block whose input has file_path for Edit/Write.
const saLine = (cwd, content = [], ts = Date.parse('2026-10-03T11:59:55Z')) => JSON.stringify({
  type: 'assistant', sessionId: 'parent-1', cwd, timestamp: new Date(ts).toISOString(),
  message: { id: `msg_${ts}`, model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 50 }, content },
});

test('workCwdOfSubagent: picks the latest cwd, falls back to dirname of the first Edit/Write file_path', () => {
  // Three entries: parent cwd -> worktree cwd -> deeper worktree cwd; latest wins.
  const texts = [
    saLine('/home/me/main', [], Date.parse('2026-10-03T11:59:50Z')),
    saLine('/home/me/worktree-x', [
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ], Date.parse('2026-10-03T11:59:55Z')),
    saLine('/home/me/worktree-x/sub', [], Date.parse('2026-10-03T12:00:00Z')),
  ];
  assert.deepEqual(workCwdOfSubagent(texts), { cwd: '/home/me/worktree-x/sub', toolPath: null });

  // No cwd anywhere -> first tool_use file_path's dirname becomes the working dir.
  const toolText = JSON.stringify({
    type: 'assistant', sessionId: 'p', timestamp: new Date().toISOString(),
    message: { id: 'm', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [
      { type: 'tool_use', name: 'Edit', input: { file_path: '/home/me/worktree-x/foo.js' } },
    ] },
  });
  assert.deepEqual(workCwdOfSubagent([toolText]), { cwd: null, toolPath: '/home/me/worktree-x/foo.js' });

  // Empty/invalid lines do not crash.
  assert.deepEqual(workCwdOfSubagent(['', 'not json', saLine('/tmp/a')]), { cwd: '/tmp/a', toolPath: null });
  assert.deepEqual(workCwdOfSubagent([]), { cwd: null, toolPath: null });
});

test('parseClaudeLine: subagent row carries workCwd separate from cwd; non-subagent stays without it', () => {
  const o = { type: 'assistant', sessionId: 'p', cwd: '/home/me/main', timestamp: new Date(NOW).toISOString(),
    message: { id: 'msg_a', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 2 }, content: [] } };
  // Non-subagent: no workCwd emitted.
  const plain = parseClaudeLine(o, { subagent: false });
  assert.equal(plain.cwd, '/home/me/main'); assert.equal('workCwd' in plain, false);
  // Subagent with workCwd supplied: both fields present.
  const sub = parseClaudeLine(o, { subagent: true, workCwd: '/home/me/worktree-x' });
  assert.equal(sub.cwd, '/home/me/main'); assert.equal(sub.workCwd, '/home/me/worktree-x'); assert.equal(sub.subagent, true);
  // Subagent without workCwd: no workCwd field (falls through to cwd downstream).
  const empty = parseClaudeLine(o, { subagent: true, workCwd: null });
  assert.equal(empty.workCwd, undefined);
});

test('rowCwdMatchesWorktree: prefers workCwd over cwd; subagent whose parent cwd is elsewhere still matches', () => {
  // Parent cwd points elsewhere (the bug); workCwd is the worktree.
  const subRow = { workCwd: '/home/me/worktree-x/sub', cwd: '/home/me/main' };
  assert.equal(rowCwdMatchesWorktree(subRow, '/home/me/worktree-x'), true);
  assert.equal(rowCwdMatchesWorktree(subRow, '/home/me/other'), false);
  // No workCwd -> falls back to cwd (old rows still work).
  assert.equal(rowCwdMatchesWorktree({ cwd: '/home/me/main' }, '/home/me/main'), true);
  assert.equal(rowCwdMatchesWorktree({ cwd: '/home/me/main' }, '/home/me/worktree-x'), false);
  // Empty row / empty wt: never a match.
  assert.equal(rowCwdMatchesWorktree(null, '/x'), false);
  assert.equal(rowCwdMatchesWorktree({ cwd: '/x' }, ''), false);
  assert.equal(rowCwdMatchesWorktree({ cwd: '/x' }, null), false);
});

test('attribute: respects workCwd when filtering for the worktree; falls back to cwd otherwise', () => {
  // Rows in the same window; only the workCwd ones belong to /home/me/worktree-x.
  const rows = [
    { ts: 5, agent: 'claude', model: 'm1', cwd: '/home/me/main', workCwd: '/home/me/worktree-x/sub',
      usage: { input: 10, output: 5, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 }, cost: null },
    { ts: 5, agent: 'claude', model: 'm1', cwd: '/home/me/other',   // only cw
      usage: { input: 1, output: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 }, cost: null },
  ];
  const a = attribute(rows.filter((r) => rowCwdMatchesWorktree(r, '/home/me/worktree-x')), 0, 10);
  assert.ok(a); assert.equal(a.tokensIn, 10); assert.equal(a.tokensOut, 5);
  // No workCwd row also matches when its cwd sits inside the worktree (old rows).
  const old = [{ ts: 5, agent: 'claude', model: 'm1', cwd: '/home/me/worktree-x/sub',
    usage: { input: 100, output: 50, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 }, cost: null }];
  assert.equal(attribute(old.filter((r) => rowCwdMatchesWorktree(r, '/home/me/worktree-x')), 0, 10).tokensIn, 100);
});

test('ingester path: a subagent jsonl yields rows whose workCwd is the latest cwd the file carries', async () => {
  // Drive the parser pipeline the same way `collect()` does: read the buffer, derive workCwd once per file,
  // pass it to parseClaudeLine. Bypassing the Langfuse POST (which the full ingester requires) keeps the test fast.
  const lines = [
    saLine('/home/me/main', [], NOW - 120000),
    saLine('/home/me/worktree-x', [
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ], NOW - 90000),
    saLine('/home/me/worktree-x/sub', [], NOW - 60000),
    saLine('/home/me/worktree-x/sub', [], NOW - 30000),
  ];
  const buf = Buffer.from(lines.join('\n') + '\n', 'utf8');
  const texts = buf.toString('utf8').split('\n').filter(Boolean);
  const { cwd, toolPath } = workCwdOfSubagent(texts);
  const workCwd = cwd || (toolPath ? toolPath.replace(/\/[^/]*$/, '') || toolPath : null);
  assert.equal(workCwd, '/home/me/worktree-x/sub');
  // Now parse each line the way the collect loop does and verify rows carry workCwd.
  // The row's own `cwd` is whatever that entry's `cwd` was — Claude Code writes per-entry, so it tracks the
  // directory each tool actually ran in; the row-level workCwd summarises the subagent's working dir for the
  // requester's attribution step.
  const rows = [];
  for (const text of texts) {
    let parsed; try { parsed = JSON.parse(text); } catch { continue; }
    const rec = parseClaudeLine(parsed, { subagent: true, workCwd });
    if (rec) rows.push(rec);
  }
  assert.ok(rows.length >= 1, 'at least one usage row from the subagent lines');
  const expectedCwds = new Set(['/home/me/main', '/home/me/worktree-x', '/home/me/worktree-x/sub']);
  for (const r of rows) {
    assert.ok(expectedCwds.has(r.cwd), `each row's cwd is one of the per-entry cwds (got ${r.cwd})`);
    assert.equal(r.workCwd, '/home/me/worktree-x/sub', 'workCwd matches the subagent\'s last cwd');
    assert.equal(r.subagent, true);
  }
  // Main session lines (not in a subagents/ folder) take only cwd, never workCwd.
  const parentRow = parseClaudeLine(JSON.parse(saLine('/home/me/main', [], NOW - 30000)), { subagent: false });
  assert.equal(parentRow.cwd, '/home/me/main');
  assert.equal(parentRow.workCwd, undefined);
});

test('sessionUsage: subagent row with parent cwd elsewhere attributes to worktree via workCwd; old row falls back to cwd', () => {
  const stateDir = tmp();
  try {
    const now = Date.now();
    // Same session label so the worktree filter is the only thing that distinguishes them.
    // Row A: subagent — parent cwd = /parent, workCwd = /worktree (the bug case from int-mvfmw25b79da66).
    // Row B: parent cwd inside the worktree (old-style row, no workCwd).
    // Row C: parent cwd in /somewhere-else, no workCwd (must NOT match either worktree or worktree-v1).
    writeFileSync(join(stateDir, 'usage-ledger.jsonl'), jl([
      { ts: now - 5 * 60_000, label: 's1', agent: 'claude', model: 'm', cwd: '/parent',
        workCwd: '/home/me/worktree', cost: { total: 7 }, usage: { input: 1, output: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 }, subagent: true },
      { ts: now - 4 * 60_000, label: 's1', agent: 'claude', model: 'm', cwd: '/home/me/worktree/sub',
        cost: { total: 4 }, usage: { input: 1, output: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 } },
      { ts: now - 3 * 60_000, label: 's1', agent: 'claude', model: 'm', cwd: '/somewhere-else',
        cost: { total: 99 }, usage: { input: 1, output: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 } },
    ]));
    // Worktree-attributed (the fix): both row A (workCwd) and row B (cwd inside) match; row C excluded.
    const wt = sessionUsage({ stateDir, session: 's1', worktree: '/home/me/worktree', from: now - 864e5, to: now });
    assert.equal(wt.attribution, 'worktree');
    assert.equal(wt.costUsd, 11);   // row A: 7 + row B: 4
    // Without worktree: session-window picks up everything for the session (old behaviour, unchanged).
    const sw = sessionUsage({ stateDir, session: 's1', from: now - 864e5, to: now });
    assert.equal(sw.attribution, 'session-window');
    assert.equal(sw.costUsd, 110);   // 7 + 4 + 99
    // With a worktree that matches nothing: fall back to session-window.
    const fb = sessionUsage({ stateDir, session: 's1', worktree: '/nowhere', from: now - 864e5, to: now });
    assert.equal(fb.attribution, 'session-window');
    assert.equal(fb.costUsd, 110);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

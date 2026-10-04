// readActions(): the read-only view of manager-actions.jsonl behind GET /api/manager/actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readActions, ACTIONS_FILE } from '../manager-events.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'ghosty-mactions-'));
const row = (i) => JSON.stringify({ at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), trigger: 'event', session: 's' + i, decision: 'd' + i, action: 'a' });

test('readActions: missing file gives []', async () => {
  assert.deepEqual(await readActions({ stateDir: tmp() }), []);
});

test('readActions: bad lines are skipped, order kept (newest last)', async () => {
  const dir = tmp();
  writeFileSync(join(dir, ACTIONS_FILE), [row(0), 'not json', '', '42', row(1)].join('\n') + '\n');
  assert.deepEqual((await readActions({ stateDir: dir })).map((r) => r.session), ['s0', 's1']);
});

test('readActions: limit keeps the newest N', async () => {
  const dir = tmp();
  writeFileSync(join(dir, ACTIONS_FILE), [0, 1, 2, 3, 4].map(row).join('\n') + '\n');
  assert.deepEqual((await readActions({ stateDir: dir, limit: 2 })).map((r) => r.session), ['s3', 's4']);
});

test('readActions: since is strictly after', async () => {
  const dir = tmp();
  writeFileSync(join(dir, ACTIONS_FILE), [0, 1, 2].map(row).join('\n') + '\n');
  const r = await readActions({ stateDir: dir, since: new Date(Date.UTC(2026, 0, 1, 0, 1)).toISOString() });
  assert.deepEqual(r.map((x) => x.session), ['s2']);
});

test('readActions: only the last maxBytes are read; the partial first line is dropped', async () => {
  const dir = tmp();
  writeFileSync(join(dir, ACTIONS_FILE), [0, 1, 2, 3, 4, 5].map(row).join('\n') + '\n');
  const cap = row(5).length + row(4).length + 5;
  const r = await readActions({ stateDir: dir, maxBytes: cap });
  assert.deepEqual(r.map((x) => x.session), ['s4', 's5']);
});

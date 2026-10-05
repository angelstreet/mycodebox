import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeLayout, createLayoutStore } from '../layout.js';

test('normalizeLayout drops junk, dedupes and derives group names', () => {
  const n = normalizeLayout({ order: ['a', 'b', 'a', 5, '', ' c '], pins: 'x', groups: { a: 'G', b: '', '': 'Z', c: 7 }, collapsed: ['pin'] });
  assert.deepEqual(n.order, ['a', 'b', 'c']);
  assert.deepEqual(n.pins, []);
  assert.deepEqual(n.groups, { a: 'G' });
  assert.deepEqual(n.groupNames, ['G']);
  assert.deepEqual(n.collapsed, ['pin']);
  assert.deepEqual(normalizeLayout(null), { order: [], pins: [], groups: {}, groupNames: [], collapsed: [], groupBy: '' });
  assert.equal(normalizeLayout({ groupBy: 'project' }).groupBy, 'project');
  assert.equal(normalizeLayout({ groupBy: 'x' }).groupBy, '');
});

test('store persists to disk, merges partial PUTs, survives a restart', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'layout-'));
  const file = join(dir, 'nested', 'layout.json');
  const s = createLayoutStore({ file });
  assert.deepEqual((await s.get()).order, []);
  await s.set({ order: ['b', 'a'], pins: ['a'] });
  await s.set({ groups: { b: 'Work' } });           // other keys keep their value
  const s2 = createLayoutStore({ file });
  const l = await s2.get();
  assert.deepEqual(l.order, ['b', 'a']);
  assert.deepEqual(l.pins, ['a']);
  assert.deepEqual(l.groups, { b: 'Work' });
  assert.deepEqual(l.groupNames, ['Work']);
});

test('store keeps the previous version as layout.json.bak', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'layout-'));
  const file = join(dir, 'layout.json');
  const s = createLayoutStore({ file });
  await s.set({ order: ['a', 'b'] });
  await s.set({ order: [] });                       // a wipe
  const bak = JSON.parse(await fs.readFile(`${file}.bak`, 'utf8'));
  assert.deepEqual(bak.order, ['a', 'b']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { plan, apply } from '../scripts/pokemon-retention.js';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'poke-ret-'));
const OLD = Date.now() - 5 * 36e5;
function run(runs, id, save, { done = true, old = true, webm = true } = {}) {
  fs.mkdirSync(runs, { recursive: true });
  const j = path.join(runs, `${id}.json`);
  fs.writeFileSync(j, JSON.stringify({ save, ...(done ? { video_end: 1 } : {}) }));
  const files = [j];
  if (webm) { fs.writeFileSync(path.join(runs, `${id}.webm`), 'x'.repeat(100)); files.push(path.join(runs, `${id}.webm`)); }
  if (old) for (const f of files) fs.utimesSync(f, OLD / 1e3, OLD / 1e3);
}

test('keeps in-progress and the last completed per save, removes the rest; leaves saves and other folders alone', () => {
  const root = mk(), runs = path.join(root, 'canonical', 'runs');
  run(runs, '20261101-000000', 'gold');
  run(runs, '20261102-000000', 'gold');
  run(runs, '20261103-000000', 'gold');                   // last completed gold
  run(runs, '20261104-000000', 'gold', { done: false });  // in progress
  run(runs, '20261101-010000', 'yellow');
  run(runs, '20261102-010000', 'yellow');                 // last completed yellow
  run(runs, '20261105-000000', 'yellow', { old: false }); // just modified: live
  fs.writeFileSync(path.join(root, 'canonical', 'gold.sav'), 's');
  fs.writeFileSync(path.join(root, 'canonical', 'runs', 'notes.txt'), 'n');
  fs.mkdirSync(path.join(root, 'other')); fs.writeFileSync(path.join(root, 'other', '20261101-000000.json'), '{}');
  const p = plan(root, { open: new Set() });
  const removed = p.remove.map((r) => path.basename(r.path)).sort();
  assert.deepEqual(removed, ['20261101-000000.json', '20261101-000000.webm', '20261101-010000.json', '20261101-010000.webm', '20261102-000000.json', '20261102-000000.webm']);
  const r = apply(root, p);
  assert.equal(r.moved, 6);
  for (const f of ['canonical/gold.sav', 'canonical/runs/notes.txt', 'other/20261101-000000.json', 'canonical/runs/20261103-000000.webm', 'canonical/runs/20261104-000000.json', 'canonical/runs/20261105-000000.webm']) assert.ok(fs.existsSync(path.join(root, f)), f);
  const trashes = fs.readdirSync(root).filter((n) => n.startsWith('.trash-'));
  assert.equal(trashes.length, 1);
  assert.ok(fs.existsSync(path.join(root, trashes[0], 'canonical', 'runs')));
  fs.rmSync(root, { recursive: true });
});

test('a file open by a process keeps its run; dry run changes nothing', () => {
  const root = mk(), runs = path.join(root, 'canonical', 'runs');
  run(runs, '20261101-000000', 'gold');
  run(runs, '20261102-000000', 'gold');
  const busy = path.join(runs, '20261101-000000.webm');
  const p = plan(root, { open: new Set([busy]) });
  assert.deepEqual(p.remove, []);
  const before = fs.readdirSync(runs).length;
  plan(root, { open: new Set() });
  assert.equal(fs.readdirSync(runs).length, before);
  fs.rmSync(root, { recursive: true });
});

test('purges trash folders older than 1 day, keeps today and yesterday-evening', () => {
  const root = mk(), now = Date.parse('2026-11-10T12:00:00Z');
  for (const d of ['2026-11-07', '2026-11-09', '2026-11-10']) { fs.mkdirSync(path.join(root, `.trash-${d}`)); fs.writeFileSync(path.join(root, `.trash-${d}`, 'f'), 'x'); }
  const r = apply(root, { remove: [] }, { now });
  assert.deepEqual(r.purged, ['.trash-2026-11-07']);
  assert.ok(fs.existsSync(path.join(root, '.trash-2026-11-09')));
  fs.rmSync(root, { recursive: true });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { plan, apply, purge, writePlan, report, sha256 } from '../scripts/pokemon-retention.js';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'poke-ret-'));
const OLD = Date.now() - 5 * 36e5;
// One segment: <id>.json (+ .webm). start/end = summary milestones; ms = milestone ids done in it.
function seg(runs, id, save, { game, start = 'x', end = 'x', ms = [], badges = 0, done = true, old = true, size = 100 } = {}) {
  fs.mkdirSync(runs, { recursive: true });
  const j = path.join(runs, `${id}.json`);
  fs.writeFileSync(j, JSON.stringify({ save, ...(game ? { game } : {}), video_start: 0, ...(done ? { video_end: 3600 } : {}),
    summary: { start_milestone: start, end_milestone: end, badges }, events: ms.map((m) => ({ kind: 'milestone_done', id: m })) }));
  const w = path.join(runs, `${id}.webm`);
  fs.writeFileSync(w, 'x'.repeat(size));
  if (old) for (const f of [j, w]) fs.utimesSync(f, OLD / 1e3, OLD / 1e3);
}
// A whole game: n segments from "starter" (or from mid-game), the last one with the Hall of Fame when finished.
function game(runs, day, save, { gameName, n = 3, fromStart = true, finished = true, hour = 10 } = {}) {
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    seg(runs, `${day}-${String(hour + i).padStart(2, '0')}0000`, save, { game: gameName, start: i === 0 && fromStart ? 'starter' : 'brock',
      end: last && finished ? 'hall_of_fame' : 'brock', ms: [...(i === 0 && fromStart ? ['starter'] : []), `m${i}`, ...(last && finished ? ['hall_of_fame'] : [])], badges: last && finished ? 8 : i });
  }
}
const ids = (list) => [...new Set(list.map((r) => path.basename(r.path).slice(0, 15)))].sort();

test('per Pokemon game: keeps the in-progress game and the latest played playthrough, never a mid-game fragment', () => {
  const root = mk(), runs = path.join(root, 'canonical', 'runs');
  game(runs, '20261019', 'latest', { n: 4 });                                    // blue, older playthrough
  game(runs, '20261101', 'second', { gameName: 'blue_fr', n: 3 });             // blue, latest playthrough
  seg(runs, '20261103-230000', 'second', { game: 'blue_fr', start: 'hall_of_fame', end: 'hall_of_fame', ms: ['hall_of_fame'] });   // post-HoF run: stays with its game
  game(runs, '20261031', 'latest2', { gameName: 'blue_fr', n: 1, fromStart: false });   // newest blue, but a fragment (finished)
  game(runs, '20261101', 'yellow', { gameName: 'yellow_en', n: 3, hour: 15 });
  game(runs, '20261107', 'yellow', { gameName: 'yellow_en', n: 2 });           // newer yellow playthrough
  game(runs, '20261110', 'gold', { gameName: 'gold_en', n: 3, finished: false }); // in progress
  fs.writeFileSync(path.join(root, 'canonical', 'gold.sav'), 's');
  const p = plan(root, { open: new Set() });
  assert.deepEqual(ids(p.remove), ['20261019-100000', '20261019-110000', '20261019-120000', '20261019-130000', '20261031-100000',
    '20261101-150000', '20261101-160000', '20261101-170000']);
  const kept = ids(p.keep);
  for (const k of ['20261101-100000', '20261103-230000', '20261107-110000', '20261110-120000']) assert.ok(kept.includes(k), k);
  const txt = report(root, p);
  assert.match(txt, /KEEP\s+second-20261101 .*latest played blue_fr/);
  assert.match(txt, /REMOVE\s+latest2-20261031 .*fragment .*a playthrough beats a fragment/);
  assert.match(txt, /KEEP\s+gold-20261110 .*in progress/);
  assert.ok(fs.existsSync(path.join(root, 'canonical', 'gold.sav')));
  fs.rmSync(root, { recursive: true });
});

test('a fragment never wins over a playthrough even with more milestones; among finished playthroughs the newest wins', () => {
  const root = mk(), runs = path.join(root, 'c', 'runs');
  game(runs, '20261001', 'a', { gameName: 'blue_fr', n: 5 });                  // finished, more milestones, older: removed
  game(runs, '20261005', 'b', { gameName: 'blue_fr', n: 2 });                  // finished, newer: kept
  game(runs, '20261009', 'c', { gameName: 'blue_fr', n: 6, fromStart: false }); // fragment with more milestones: removed
  const p = plan(root, { open: new Set() });
  assert.deepEqual(ids(p.keep), ['20261005-100000', '20261005-110000']);
  fs.rmSync(root, { recursive: true });
});

test('a finished game beats a further-along abandoned one; the unfinished newest game of a save is in progress', () => {
  const root = mk(), runs = path.join(root, 'c', 'runs');
  game(runs, '20261001', 'a', { gameName: 'gold_en', n: 5, finished: false });
  game(runs, '20261005', 'a', { gameName: 'gold_en', n: 1 });   // newest game of save a, finished: save a is not in progress
  game(runs, '20261003', 'b', { gameName: 'gold_en', n: 2, finished: false, hour: 1 });
  game(runs, '20261004', 'c', { gameName: 'gold_en', n: 1, hour: 1 });   // newest of save c is finished
  const p = plan(root, { open: new Set() });
  // save b's newest game is unfinished: in progress, kept. Of the rest the finished 20261005 beats the unfinished 20261001.
  assert.deepEqual(ids(p.keep), ['20261003-010000', '20261003-020000', '20261005-100000']);
  fs.rmSync(root, { recursive: true });
});

test('unfinished runs, open files and fresh files are never removed', () => {
  const root = mk(), runs = path.join(root, 'canonical', 'runs');
  game(runs, '20261001', 'blue', { gameName: 'blue_fr', n: 2 });
  game(runs, '20261005', 'blue', { gameName: 'blue_fr', n: 2 });
  seg(runs, '20261002-000000', 'old', { game: 'blue_fr', done: false });      // no video_end
  seg(runs, '20261002-010000', 'old', { game: 'blue_fr', old: false });       // just written
  const busy = path.join(runs, '20261001-100000.webm');
  const p = plan(root, { open: new Set([busy]) });
  assert.deepEqual(ids(p.remove), ['20261001-110000']);                         // its sibling segment of the open one is a normal removal
  assert.ok(ids(p.keep).includes('20261002-000000') && ids(p.keep).includes('20261002-010000') && ids(p.keep).includes('20261001-100000'));
  fs.rmSync(root, { recursive: true });
});

test('apply refuses without a reviewed plan, with a wrong sha, or when the data changed; moves exactly the plan and never purges', () => {
  const root = mk(), runs = path.join(root, 'canonical', 'runs'), now = Date.parse('2026-11-10T12:00:00Z');
  game(runs, '20261001', 'blue', { gameName: 'blue_fr', n: 2 });
  game(runs, '20261005', 'blue', { gameName: 'blue_fr', n: 2 });
  fs.mkdirSync(path.join(root, '.trash-2026-10-01')); fs.writeFileSync(path.join(root, '.trash-2026-10-01', 'f'), 'x');
  const planFile = path.join(mk(), 'plan.json');
  const sha = writePlan(root, plan(root, { open: new Set() }), planFile, { now });
  const fresh = () => plan(root, { open: new Set() });
  assert.throws(() => apply(root, null, null, { now }), /needs --plan/);
  assert.throws(() => apply(root, planFile, 'f'.repeat(64), { now }), /sha does not match/);
  assert.throws(() => apply(root, planFile, sha, { now: now + 25 * 36e5 }), /older than 24 h/);
  fs.appendFileSync(path.join(runs, '20261001-100000.webm'), 'more');   // the data changed after the review
  fs.utimesSync(path.join(runs, '20261001-100000.webm'), OLD / 1e3, OLD / 1e3);
  assert.throws(() => apply(root, planFile, sha, { now, fresh: fresh() }), /changed since the dry run/);
  const sha2 = writePlan(root, fresh(), planFile, { now });
  const r = apply(root, planFile, sha2, { now, fresh: fresh() });
  assert.equal(r.moved, 4);
  assert.equal(sha256(planFile), sha2);
  assert.ok(fs.existsSync(path.join(root, '.trash-2026-11-10', 'canonical', 'runs', '20261001-100000.webm')));
  assert.match(fs.readFileSync(path.join(root, '.trash-2026-11-10', 'MOVED.tsv'), 'utf8'), /blue-20261001\tcanonical\/runs\/20261001-100000.json/);
  assert.ok(fs.existsSync(path.join(root, '.trash-2026-10-01')), 'apply never purges');
  fs.rmSync(root, { recursive: true });
});

test('purge deletes only trash older than 7 days', () => {
  const root = mk(), now = Date.parse('2026-11-10T12:00:00Z');
  for (const d of ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-09', '2026-11-10']) { fs.mkdirSync(path.join(root, `.trash-${d}`)); fs.writeFileSync(path.join(root, `.trash-${d}`, 'f'), 'x'); }
  assert.deepEqual(purge(root, { now }).sort(), ['.trash-2026-11-01', '.trash-2026-11-02']);
  for (const d of ['2026-11-03', '2026-11-09', '2026-11-10']) assert.ok(fs.existsSync(path.join(root, `.trash-${d}`)), d);
  fs.rmSync(root, { recursive: true });
});

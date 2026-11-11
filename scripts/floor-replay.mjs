#!/usr/bin/env node
// Keyword-floor regression replay (harness review 2026-11-11, Q5 items 3 and 10). Replays every escalated stop of stalls.jsonl whose floor
// fired (a [hard: X] tag or a forbidden word) through a BASE checkout's stall.js / ops-ask.js and this checkout's, and prints what changed:
// floor hits before / after, owner <-> manager routing moves, and, with a labels file, precision / recall and every truly-floor stop the new
// floor stopped catching (must be 0). Read-only; the set and the labels stay in the state dir, never in the repo (captured session text).
//
//   node scripts/floor-replay.mjs --base <checkout of main> [--labels <file>] [--json <out file>]
//   labels: { "<first 100 chars of the stop's question>": true | false }  (true = truly floor; default <state>/floor-regression/labels.json)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const STATE = process.env.GHOSTY_STATE_DIR || join(homedir(), '.local/state/ghosty');
const base = arg('--base');
if (!base) { console.error('usage: floor-replay.mjs --base <checkout> [--labels <file>] [--json <out>]'); process.exit(2); }
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const O = await import(join(resolve(base), 'stall.js')), N = await import(join(here, 'stall.js'));
const OA = await import(join(resolve(base), 'ops-ask.js')), NA = await import(join(here, 'ops-ask.js'));

// the floor a stop meets: the [hard: X] tag, the hard topic, the owner floor of the routing, and the hard floor of the ops-ask routing
const fire = (M, out) => {
  const q = `${String(out.question || '').replace(/\[[^\]\n]{0,60}\]/g, ' ')} ${out.blocked || ''}`;
  const read = M.readAsk || ((t) => t);
  const own = 'floorOwner' in out ? (M.ownerFloorMatch(read(q)) || out.floorOwner) : (M.ownerFloorMatch(q) || (out.forbidden && M.ownerFloorMatch(String(out.forbidden))));
  return M.askHardOf(out) || out.topics?.hard || own || M.hardMatch(read(q), { mergePresent: true, pushPresent: true, deployPresent: true }) || null;
};

const stalls = new Map(), esc = new Map();
for (const l of readFileSync(join(STATE, 'stalls.jsonl'), 'utf8').split('\n')) {
  let r; try { r = JSON.parse(l); } catch { continue; }
  if (r.type === 'stall') stalls.set(r.id, r);
  else if (r.type === 'escalated') esc.set(r.id, r);
}
const rows = [];
for (const [id, e] of esc) {
  const s = stalls.get(id);
  const tag = /\[hard: ([^\]]+)\]/.exec(e.reason || '');
  if (!s || (!tag && !s.forbidden)) continue;
  const plain = String(s.excerpt || '').split('\n'), state = s.state === 'waiting' ? 'waiting' : 'done';
  let o, n; try { o = O.classifyStall({ plain, state }); n = N.classifyStall({ plain, state }); } catch { continue; }
  rows.push({ id, at: s.at, tagged: !!tag, key: String(n.question || '').slice(0, 100), question: n.question, before: fire(O, o), after: fire(N, n),
    routeBefore: OA.opsAsk(o) ? 'manager' : 'owner', routeAfter: NA.opsAsk(n) ? 'manager' : 'owner' });
}
const count = (f) => rows.filter(f).length;
console.log({ stops: rows.length, tagged: count((r) => r.tagged), fired: { before: count((r) => r.before), after: count((r) => r.after) },
  dropped: count((r) => r.before && !r.after), added: count((r) => !r.before && r.after),
  route: { ownerToManager: count((r) => r.routeBefore === 'owner' && r.routeAfter === 'manager'), managerToOwner: count((r) => r.routeBefore === 'manager' && r.routeAfter === 'owner') } });

const lf = arg('--labels', join(STATE, 'floor-regression', 'labels.json'));
if (existsSync(lf)) {
  const lab = JSON.parse(readFileSync(lf, 'utf8'));
  const set = rows.filter((r) => r.tagged && r.key in lab);
  const pr = (k) => { const tp = set.filter((r) => r[k] && lab[r.key]).length, fp = set.filter((r) => r[k] && !lab[r.key]).length, fn = set.filter((r) => !r[k] && lab[r.key]).length;
    return { fired: tp + fp, tp, fp, fn, precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null, recall: tp + fn ? +(tp / (tp + fn)).toFixed(3) : null }; };
  console.log({ labelled: set.length, trulyFloor: set.filter((r) => lab[r.key]).length, before: pr('before'), after: pr('after') });
  const lost = set.filter((r) => lab[r.key] && r.before && !r.after);
  console.log(`truly floor, no longer caught: ${lost.length}`);
  for (const r of lost) console.log(`  ${r.at} ${r.routeBefore}>${r.routeAfter} ${String(r.question).slice(0, 160)}`);
}
const out = arg('--json'); if (out) writeFileSync(out, JSON.stringify(rows));

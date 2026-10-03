#!/usr/bin/env node
// Shadow-mode report (TASK-44 phase 2): per stall case, how often the would-be answer matches
// what the owner actually answered.
//   node scripts/stall-report.js [--days N] [--log path] [--list]
// "agree": the manager would have sent the same kind of reply the owner sent (continue / recommended),
// or would have left it to the owner and the owner wrote something specific.
// "missed": the manager would have left it, but the owner only said continue (an automation chance).
// "wrong": the manager would have sent, but the owner wrote something else (precision loss).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const days = Number(arg('--days', 7));
const file = arg('--log', join(process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty'), 'stalls.jsonl'));
const since = Date.now() - days * 86400000;

const recs = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const outcomes = new Map(recs.filter((r) => r.type === 'outcome').map((r) => [r.id, r]));
const stalls = recs.filter((r) => r.type === 'stall' && Date.parse(r.at) >= since);

const kindOf = (s) => (!s.wouldSend ? 'owner' : s.case === 'menu_recommended' ? 'take_recommended' : 'continue');
const rows = new Map();
for (const s of stalls) {
  const row = rows.get(s.case) || { n: 0, wouldSend: 0, jev: 0, forbidden: 0, known: 0, agree: 0, missed: 0, wrong: 0, sentKnown: 0, sentAgree: 0 };
  row.n++;
  if (s.wouldSend) row.wouldSend++;
  if (s.source === 'jev') row.jev++;
  if (s.forbidden) row.forbidden++;
  const o = outcomes.get(s.id);
  if (o && o.kind !== 'unknown') {
    row.known++;
    const would = kindOf(s);
    const did = o.kind === 'owner_specific' ? 'owner' : o.kind;
    const ok = would === did || (would === 'take_recommended' && did === 'continue');
    if (would !== 'owner') { row.sentKnown++; if (ok) row.sentAgree++; }
    if (ok) row.agree++;
    else if (would === 'owner') row.missed++;
    else row.wrong++;
  }
  rows.set(s.case, row);
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
console.log(`stalls since ${new Date(since).toISOString().slice(0, 16)}Z: ${stalls.length} (${file})\n`);
console.log('case              n  would-send  jev  forbidden  known-outcome  agree  missed  wrong  precision(sent)');
for (const [c, r] of [...rows].sort((x, y) => y[1].n - x[1].n)) {
  const cells = [r.n, r.wouldSend, r.jev, r.forbidden, r.known, pct(r.agree, r.known), r.missed, r.wrong, `${pct(r.sentAgree, r.sentKnown)} (${r.sentAgree}/${r.sentKnown})`];
  const widths = [3, 10, 3, 9, 13, 5, 6, 5, 15];
  console.log(c.padEnd(16) + ' ' + cells.map((v, i) => String(v).padStart(widths[i])).join('  '));
}
const cost = stalls.reduce((a, s) => a + Number(s.jev?.cost || 0), 0);
console.log(`\nJev calls: ${stalls.filter((s) => s.jev?.choice).length}, cost $${cost.toFixed(5)}`);

if (process.argv.includes('--list')) {
  for (const s of stalls) {
    const o = outcomes.get(s.id);
    console.log(`\n${s.at} ${s.session} [${s.case}/${s.source}] would=${JSON.stringify(s.wouldSend)} (${s.why})`
      + `\n  Q: ${String(s.question || '').slice(-160)}\n  owner: ${o ? `${o.kind} via ${o.via}: ${String(o.reply || '').slice(0, 120)}` : '(pending)'}`);
  }
}

#!/usr/bin/env node
// Shadow-mode report (TASK-44 phase 2): per stall case, how often the would-be answer matches
// what the owner actually answered.
//   node scripts/stall-report.js [--days N] [--log path] [--list] [--export file.json] [--reclassify]
// --export <file>   write the owner-labelled stops (label, note, case, closing text) as JSON for future fixtures;
//                   choose a path outside the repo: the excerpts are real text.
// --reclassify      re-run the current classifier over the logged excerpts and print how cases change
//                   (counts only; the log is never modified).
// "agree": the manager would have sent the same kind of reply the owner sent (continue / recommended),
// or would have left it to the owner and the owner wrote something specific.
// "missed": the manager would have left it, but the owner only said continue (an automation chance).
// "wrong": the manager would have sent, but the owner wrote something else (precision loss).

import { readFileSync, writeFileSync } from 'node:fs';
import { classifyStall } from '../stall.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const days = Number(arg('--days', 7));
const file = arg('--log', join(process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty'), 'stalls.jsonl'));
const since = Date.now() - days * 86400000;

const recs = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const outcomes = new Map(recs.filter((r) => r.type === 'outcome').map((r) => [r.id, r]));
const stalls = recs.filter((r) => r.type === 'stall' && Date.parse(r.at) >= since);

const kindOf = (s) => (!s.wouldSend || s.why === 'ask_status' ? 'owner' : s.case === 'menu_recommended' ? 'take_recommended' : 'continue');
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

// ---- owner labels ("this stop bothered me") ----
const labels = new Map();   // stall id -> newest label record; an unlabel after it withdraws it
for (const r of recs) { if (r.type === 'label' && r.label) labels.set(r.id, r); else if (r.type === 'unlabel') labels.delete(r.id); }
const byId = new Map(recs.filter((r) => r.type === 'stall').map((r) => [r.id, r]));
const labelled = [...labels.values()].map((l) => ({ l, s: byId.get(l.id) })).filter((x) => x.s);
if (labelled.length) {
  const per = new Map();
  for (const { l, s } of labelled) {
    const row = per.get(s.case) || { no_reason: 0, legit: 0, wrong_case: 0 };
    row[l.label]++;
    if (l.correctCase && l.label !== 'wrong_case') row.wrong_case++;   // the swipe page: good/bad AND the manager chose the wrong case
    per.set(s.case, row);
  }
  console.log('\nowner labels per case          no_reason  legit  wrong_case');
  for (const [c, r] of [...per].sort((x, y) => y[1].no_reason - x[1].no_reason)) {
    console.log(c.padEnd(30) + [r.no_reason, r.legit, r.wrong_case].map((v) => String(v).padStart(9)).join(' '));
  }
  const first = (t) => String(t || '').split('\n').find((x) => x.trim()) || '';
  console.log('\n"stopped for no reason" examples:');
  for (const { l, s } of labelled.filter((x) => x.l.label === 'no_reason')) {
    console.log(`  ${s.at} ${s.session} [chosen: ${s.case}]${l.note ? ` note: ${l.note}` : ''}\n    ${first(String(s.excerpt || '').split('\n').slice(-3).join('\n') || s.question).slice(0, 160)}`);
  }
} else console.log('\nno owner labels yet');

// ---- AI reviewer (phase 9): proposals the owner rated right / wrong ----
{
  const tri = new Map(recs.filter((r) => r.type === 'triage' && r.ai).map((r) => [r.id, r]));
  const verdict = new Map();
  for (const r of recs) if (r.type === 'label' && r.aiVerdict) verdict.set(r.id, r.aiVerdict);
  const calls = recs.filter((r) => r.type === 'triage');
  if (calls.length) {
    let right = 0, wrong = 0;
    const per = new Map();
    for (const [id, v] of verdict) {
      const t = tri.get(id); if (!t) continue;
      if (v === 'right') right++; else wrong++;
      const c = byId.get(id)?.case || t.case || '?';
      const row = per.get(c) || { right: 0, wrong: 0 }; row[v]++; per.set(c, row);
    }
    const cost = calls.reduce((a, r) => a + Number(r.cost || 0), 0);
    const owner = [...tri.values()].filter((t) => t.ai.owner_needed).length;
    console.log(`\nAI reviewer: ${tri.size} proposals (${owner} said owner needed), ${calls.filter((r) => r.skipped).length} skipped, ${calls.filter((r) => r.error).length} errors, cost $${cost.toFixed(4)}`);
    console.log(right + wrong ? `AI agreement: ${right} right / ${wrong} wrong = ${Math.round(100 * right / (right + wrong))} % of ${right + wrong} rated (${tri.size - right - wrong} unrated)` : 'AI agreement: no ratings yet');
    for (const [c, r] of per) console.log(`  ${c.padEnd(18)} right ${r.right}  wrong ${r.wrong}`);
  }
}

const exportTo = arg('--export', null);
if (exportTo) {
  const items = labelled.map(({ l, s }) => ({ id: s.id, session: s.session, agent: s.agent, state: s.state, at: s.at, label: l.label, note: l.note, correctCase: l.correctCase,
    chosenCase: s.case, why: s.why, no_status: !!s.no_status, excerpt: s.excerpt }));
  writeFileSync(exportTo, JSON.stringify(items, null, 2) + '\n');
  console.log(`\nexported ${items.length} labelled stops to ${exportTo}`);
}

// ---- re-classify the logged excerpts with the current rules ----
if (process.argv.includes('--reclassify')) {
  const seen = new Set();
  const matrix = new Map(), before = new Map(), after = new Map();
  let n = 0, noStatus = 0;
  for (const s of stalls) {
    if (!s.excerpt) continue;
    const key = `${s.session}|${s.case}|${s.excerpt}`;   // the same stop logged many times counts once
    if (seen.has(key)) continue;
    seen.add(key);
    const now = classifyStall({ plain: s.excerpt.split('\n'), state: s.state });
    n++;
    if (now.no_status) noStatus++;
    before.set(s.case, (before.get(s.case) || 0) + 1);
    after.set(now.case, (after.get(now.case) || 0) + 1);
    if (now.case !== s.case) { const k = `${s.case} -> ${now.case}`; matrix.set(k, (matrix.get(k) || 0) + 1); }
  }
  const dup = stalls.filter((s) => s.excerpt).length - n;
  console.log(`\nreclassify: ${n} distinct stops (${dup} repeats of the same stop folded)`);
  console.log('case               before  after');
  for (const c of new Set([...before.keys(), ...after.keys()])) console.log(String(c).padEnd(18) + String(before.get(c) || 0).padStart(7) + String(after.get(c) || 0).padStart(7));
  console.log(`no_status flagged: ${noStatus}`);
  console.log('changes:');
  for (const [k, v] of [...matrix].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  if (!matrix.size) console.log('  none');
}

#!/usr/bin/env node
// Manager model replay (TASK-239 item 5): the inputs of real manager wakes that ACTED, run through two models with the same manual,
// one table row per case (input, decision A, decision B, same/different) and a blind A/B sheet for the owner. Never changes the manager model.
//   node scripts/manager-model-replay.js build  [--day 2026-11-11] [--n 20] [--out <dir>]   pick cases -> <out>/cases.json (no model call)
//   node scripts/manager-model-replay.js run    --cases <json> --manual <md> [--models sonnet,opus] [--cap 5]   calls `claude -p` once per case and model, stops at the cap (USD)
//   node scripts/manager-model-replay.js sheet  --cases <results json> [--seed 1] --out docs/MANAGER-MODEL-BLIND-SHEET.md   blind sheet + key file (<out>.key.json, outside the sheet)
// Pure parts (pickCases, caseInput, blindPairs, sheetMarkdown) are exported for tests.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const STATE = process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty');
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n') : []).flatMap((l) => { try { return l.startsWith('{') ? [JSON.parse(l)] : []; } catch { return []; } });
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
// a public doc must not carry IPs, e-mail addresses or secrets
export const scrub = (s) => String(s).replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>').replace(/(token|key|password|secret)=\S+/gi, '$1=<x>');

export function caseInput(w, evs) {
  const parts = [`Wake trigger: ${w.trigger}. ${clip(w.triggerSummary, 300)}`];
  for (const e of evs) parts.push(`Event [${e.kind}${e.state ? ':' + e.state : ''}] priority ${e.priority || 'default'} session ${e.session || '-'}: ${clip(e.title, 160)} | ${clip(e.body, 400)}`);
  return scrub(parts.join('\n'));
}

// Pure. wakes of one day + events -> cases [{id, at, trigger, input, real}] of wakes that acted and had at least one event in front of them; deterministic sample of n.
export function pickCases({ wakes, events, n = 20 }) {
  const sorted = [...wakes].sort((a, b) => (a.start < b.start ? -1 : 1));
  const cases = [];
  sorted.forEach((w, i) => {
    if (w.nothing || (w.decision || '').length < 30) return;
    const prev = i ? sorted[i - 1].start : '0';
    const evs = events.filter((e) => e.at > prev && e.at <= w.start).slice(-6);
    if (!evs.length) return;
    cases.push({ id: `c${String(cases.length + 1).padStart(3, '0')}`, at: w.start, trigger: w.trigger, input: caseInput(w, evs), real: clip(w.decision, 600) });
  });
  if (cases.length <= n) return cases;
  const step = cases.length / n;
  return Array.from({ length: n }, (_, k) => cases[Math.floor(k * step)]);
}

// Pure. rows [{id, input, sonnet, opus}] + seed -> [{n, id, input, A, B, aIs}]: A/B assigned by a seeded shuffle, the key stays out of the sheet.
export function blindPairs(rows, seed = 1) {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  return rows.map((d, i) => { const flip = rnd() < 0.5; return { n: i + 1, id: d.id, input: d.input, A: flip ? d.opus : d.sonnet, B: flip ? d.sonnet : d.opus, aIs: flip ? 'opus' : 'sonnet' }; });
}
export function sheetMarkdown(pairs) {
  const out = ['# Manager model blind sheet (Sonnet vs Opus)', '', 'Same manual, same wake input, two answers per case. Models are hidden (A/B). For each case mark the better decision: `A`, `B`, `tie` or `both wrong`; add a word if one would have caused harm. The key is in a separate file, not here.', ''];
  for (const p of pairs) out.push(`## Case ${p.n}`, '', '**Wake input**', '', '```', p.input, '```', '', `**A:** ${scrub(clip(p.A, 900))}`, '', `**B:** ${scrub(clip(p.B, 900))}`, '', '**Better:** A / B / tie / both wrong', '');
  return out.join('\n');
}

function ask(model, manual, input) {
  const sys = `${manual}\n\n---\nYou are replaying one wake of the manager. Do not use tools. Answer in at most 120 words: what you decide for this wake (nothing / send to <session>: <text> / alert owner: <text> / start worker: <task>) and why, in one or two sentences.`;
  const r = spawnSync('claude', ['-p', '--model', model, '--output-format', 'json', '--tools', '', '--no-session-persistence', '--system-prompt', sys], { input, encoding: 'utf8', timeout: 300000, maxBuffer: 1 << 24 });
  try { const j = JSON.parse(r.stdout); return { text: String(j.result || '').trim(), usd: Number(j.total_cost_usd || 0) }; } catch { return { text: '', usd: 0, err: clip(r.stderr || r.stdout, 200) }; }
}

function main(argv) {
  const cmd = argv[0], opt = (n, d) => { const i = argv.indexOf(n); return i > 0 ? argv[i + 1] : d; };
  if (cmd === 'build') {
    const day = opt('--day', '2026-11-11'), out = opt('--out', '.');
    const wakes = lines(join(STATE, 'manager-wakes.jsonl')).filter((w) => String(w.start).startsWith(day));
    const events = [...lines(join(STATE, 'manager-events.jsonl.1')), ...lines(join(STATE, 'manager-events.jsonl'))].filter((e) => String(e.at).startsWith(day));
    const cases = pickCases({ wakes, events, n: Number(opt('--n', 20)) });
    mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'cases.json'), JSON.stringify(cases, null, 1));
    console.log(`${cases.length} cases -> ${join(out, 'cases.json')}`); return 0;
  }
  if (cmd === 'run') {
    const f = opt('--cases'), cases = JSON.parse(readFileSync(f, 'utf8')), manual = readFileSync(opt('--manual'), 'utf8');
    const models = opt('--models', 'sonnet,opus').split(','), cap = Number(opt('--cap', 5));
    let usd = 0; const rows = [];
    for (const c of cases) {
      if (usd >= cap) { console.error(`cap $${cap} reached after ${rows.length} cases`); break; }
      const row = { id: c.id, input: c.input, real: c.real };
      for (const m of models) { const a = ask(m, manual, c.input); row[m] = a.text; row[m + '_usd'] = a.usd; if (a.err) row[m + '_err'] = a.err; usd += a.usd; }
      rows.push(row); writeFileSync(f.replace(/\.json$/, '.results.json'), JSON.stringify(rows, null, 1));
    }
    console.log(`${rows.length} cases, $${usd.toFixed(2)}`); return 0;
  }
  if (cmd === 'sheet') {
    const rows = JSON.parse(readFileSync(opt('--cases'), 'utf8')).filter((r) => r.sonnet && r.opus), out = opt('--out', 'docs/MANAGER-MODEL-BLIND-SHEET.md');
    const pairs = blindPairs(rows, Number(opt('--seed', 1)));
    mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, sheetMarkdown(pairs) + '\n');
    writeFileSync(opt('--key', out.replace(/\.md$/, '.key.json')), JSON.stringify(pairs.map((p) => ({ n: p.n, id: p.id, A: p.aIs })), null, 1));
    console.log(`${pairs.length} pairs -> ${out}`); return 0;
  }
  console.error('usage: manager-model-replay.js build | run | sheet'); return 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));

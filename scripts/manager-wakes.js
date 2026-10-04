#!/usr/bin/env node
// Per-wake log of the AI manager agent, built from its Claude Code transcript.
//   node scripts/manager-wakes.js [--day YYYY-MM-DD] [--json] [--label manager]
// --day    UTC day (default today)       --json   print { summary, wakes } instead of the table
// --label  tmux session label of the manager (default: manager.json managerSessions, else "manager")
//
// How the transcript is found: the usage ledger (<state dir>/usage-ledger.jsonl) labels every Claude row with its tmux
// session name; the (non-subagent) Claude session ids labelled with the manager's name are the manager's, and each one
// is the file ~/.claude/projects/<project dir>/<session id>.jsonl (CLAUDE_PROJECTS_DIR overrides the root).
// Also (re)writes <state dir>/manager-wakes.jsonl with that day's wakes (idempotent). Read-only on the transcript.

import { computeWakes, summarizeWakes, writeWakesFile, stateDirDefault, claudeDirDefault } from '../manager-wakes.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const day = arg('--day', new Date().toISOString().slice(0, 10));
const label = arg('--label', null);
const stateDir = stateDirDefault();
const { wakes, transcripts } = await computeWakes({ stateDir, claudeDir: claudeDirDefault(), day, labels: label ? [label] : null });
const summary = summarizeWakes(wakes);
const file = await writeWakesFile(stateDir, wakes);

if (process.argv.includes('--json')) console.log(JSON.stringify({ day, transcripts, summary, wakes }, null, 2));
else {

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const usd = (x) => (x == null ? '   n/a' : `$${x.toFixed(3)}`.padStart(7));
const tools = (t) => Object.entries(t).map(([k, v]) => `${k}${v}`).join(' ');
console.log(`Manager wakes ${day} (UTC), ${transcripts} transcript(s)`);
console.log(`${pad('time', 6)}${pad('trigger', 16)}${pad('summary', 52)}${pad('tools', 24)}${pad('alerts', 7)}${pad('usd', 8)}`);
for (const w of wakes) console.log(`${pad(w.start.slice(11, 16), 6)}${pad(w.trigger, 16)}${pad(w.triggerSummary, 52)}${pad(tools(w.tools), 24)}${pad(w.alertsSent, 7)}${usd(w.usd)}`);
console.log('');
console.log(`wakes: ${summary.count}   total: $${summary.usd.toFixed(3)}   did nothing: ${summary.nothing} (${Math.round(summary.nothingShare * 100)}%)`);
console.log('by trigger:');
for (const [t, n] of Object.entries(summary.byTrigger).sort((a, b) => b[1] - a[1])) console.log(`  ${pad(t, 16)}${String(n).padStart(4)} wakes  $${summary.usdByTrigger[t].toFixed(3)}`);
console.log('top 5 most expensive:');
for (const w of summary.top) console.log(`  ${w.start.slice(11, 16)} ${pad(w.trigger, 15)} ${usd(w.usd)}  ${w.triggerSummary.slice(0, 70)}`);
console.log(`written: ${file}`);
}

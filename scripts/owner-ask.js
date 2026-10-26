#!/usr/bin/env node
// owner-ask: the one way a manager session files a question for the owner (owner rule 2026-10-20: no question reaches
// the owner unless it touches the hard floor). The check lives in owner-asks.js (checkAsk), so this CLI only parses
// flags and appends; a refused ask writes nothing and prints why.
//
// Usage:
//   node scripts/owner-ask.js ask --session <s> --question "<plain words>" \
//          --what "<2-4 lines: what it is, where, what each option does>" \
//          --options "1 ...|2 ..." --recommend <n> --floor <floor> --why "<why you>"
//   node scripts/owner-ask.js decide --session <s> --decision "<what was decided>" --why "<reason>" --undo "<how to revert>"
//   node scripts/owner-ask.js help
//
// Floors (the only reasons a question may reach the owner, AGENTS.md autonomy by default):
//   money | credentials | customers | deleting_data | host_units | production_migration | history_rewrite | owner_fact
//
// The gate (owner, 2026-10-25) refuses an ask when:
//   - there is no valid floor, or the wording names no risk of that floor
//   - --why is not one plain line that says what could be lost, exposed or restarted (a list of technical terms
//     is refused: it tells the owner nothing)
//   - the recommended option changes nothing ("keep it as it is", "change nothing", "do nothing"): there is
//     nothing for the owner to decide, so decide it yourself and journal it with "owner-ask.js decide"
//
// Env:
//   GHOSTY_STATE_DIR  where the two files live (default ~/.local/state/ghosty)
//     manager-owner-asks.jsonl   the open asks the NEEDS YOU strip shows
//     manager-decisions.jsonl    the "Decided for you" journal (decide)
//
// stdout (ask): the new ledger id, e.g. Q7.  stdout (decide): the decision id.
// stderr: one line on a refused ask or bad usage (exit 2).
//
// Exit codes:
//   0  filed (ask) or journaled (decide)
//   2  refused: no floor, unknown floor, empty --what/--why/--question, a bare internal id in the wording,
//      a --why that is not one plain line naming the risk, or a recommended option that changes nothing
//
// Example:
//   node scripts/owner-ask.js ask --session manager:deploy \
//     --question "Pay the 40 EUR overdue invoice for the build runner, or let the subscription lapse?" \
//     --what "The build runner's hosting invoice is overdue and unpaid; the account is suspended in 3 days.
// Option 1 pays it now and the subscription continues. Option 2 does nothing and the account is suspended." \
//     --options "1 pay the 40 EUR invoice now|2 let it lapse and lose the account" --recommend 1 \
//     --floor money --why "It spends the owner's money: the account could be suspended and the builds stop."
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FLOORS, fileAsk, fileDecision } from '../owner-asks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty');
const ASKS_FILE = join(STATE_DIR, 'manager-owner-asks.jsonl');
const DECISIONS_FILE = join(STATE_DIR, 'manager-decisions.jsonl');

// --key value pairs and one positional verb (same shape as scripts/jev-ask.js)
function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) {
      const k = a.slice(2), next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out.flags[k] = 'true';
      else { out.flags[k] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const opts = (flags) => String(flags.options || '').split('|').map((s) => s.trim()).filter(Boolean);

function help() {
  return `usage:
  node scripts/owner-ask.js ask --session <s> --question "<plain words>" \\
                          --what "<2-4 lines: what it is, where, what each option does>" \\
                          --options "1 ...|2 ..." --recommend <n> --floor <floor> --why "<why you>"
  node scripts/owner-ask.js decide --session <s> --decision "<what was decided>" --why "<reason>" --undo "<how to revert>"

floors (the only reasons a question may reach the owner):
  ${FLOORS.join(' | ')}

the gate refuses (owner, 2026-10-25):
  - a --why that is not one plain line naming what could be lost, exposed or restarted
  - a recommended option that changes nothing ("keep it as it is", "change nothing", "do nothing"):
    decide it yourself and journal it with "owner-ask.js decide"

files (in \$GHOSTY_STATE_DIR, default ~/.local/state/ghosty):
  manager-owner-asks.jsonl   the open asks (ask)
  manager-decisions.jsonl    the "Decided for you" journal (decide)

exit codes:
  0  filed / journaled      2  refused (no floor, unknown floor, empty --what/--why, bare internal id,
                             a --why that is not one plain line, a recommended option that changes nothing)
`;
}

const fail = (why) => { process.stderr.write(`${why}\n`); process.exit(2); };

async function main() {
  const args = parseArgs(process.argv);
  const cmd = args._[0];
  if (args.help || !cmd || cmd === 'help') { process.stdout.write(help()); return; }
  const f = args.flags;

  if (cmd === 'ask') {
    const r = await fileAsk(ASKS_FILE, {
      session: f.session, question: f.question, what: f.what, options: opts(f),
      recommend: f.recommend || f.recommendation, recommendation: f.recommendation || f.recommend,
      floor: f.floor, why: f.why,
    });
    if (!r.ok) fail(r.why);
    process.stdout.write(r.id + '\n');
    return;
  }

  if (cmd === 'decide') {
    const r = await fileDecision(DECISIONS_FILE, { session: f.session, decision: f.decision, why: f.why, undo: f.undo });
    if (!r.ok) fail(r.why);
    process.stdout.write(r.id + '\n');
    return;
  }

  fail(`unknown command: ${cmd} (known: ask, decide, help)`);
}

main().catch((e) => { process.stderr.write(`${e.message || e}\n`); process.exit(1); });
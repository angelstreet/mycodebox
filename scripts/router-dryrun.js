#!/usr/bin/env node
// Router dry-run (TASK-47, shadow): walks every fixture state, calls decide(), and prints one line per
// state (point, label, expect, ruleDefault, Jev choice, confidence, source) plus an agreement roll-up
// per point. --dry prints the request bodies without calling the server. Exit 0 when env is missing.
//
// Usage:
//   node scripts/router-dryrun.js [--dry] [--fixtures <path>]
// Env:
//   JEV_URL          VPT server base URL (the script takes its origin; the route is /server/ai/decide)
//   JEV_API_KEY      X-API-Key for the server
//   VPT_TEAM_ID      team_id for the decision log (the call is logged when set)

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decide, POINTS, buildRequest } from '../router.js';
import { serverBase } from '../decisions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function parseArgs(argv) {
  const out = { dry: false, fixtures: join(ROOT, 'test', 'fixtures', 'router-states.json') };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') out.dry = true;
    else if (a === '--fixtures' && argv[i + 1]) { out.fixtures = argv[++i]; }
    else if (a === '--help' || a === '-h') { out.help = true; }
    else { out._unknown = a; }
  }
  return out;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log('Usage: node scripts/router-dryrun.js [--dry] [--fixtures <path>]');
  process.exit(0);
}

const JEV_URL = process.env.JEV_URL || '';
const JEV_API_KEY = process.env.JEV_API_KEY || '';
const VPT_TEAM_ID = process.env.VPT_TEAM_ID || '';
const configured = !!(serverBase(JEV_URL) && JEV_API_KEY && VPT_TEAM_ID);

if (!configured && !args.dry) {
  console.log('JEV_URL / JEV_API_KEY / VPT_TEAM_ID not set; pass --dry to print request bodies without calling the server.');
  process.exit(0);
}

let states;
try {
  states = JSON.parse(await readFile(args.fixtures, 'utf8'));
} catch (e) {
  console.error(`could not read fixtures at ${args.fixtures}: ${e.message}`);
  process.exit(2);
}
if (!Array.isArray(states) || !states.length) { console.error('fixtures empty or not an array'); process.exit(2); }

// One post() for the whole run: --dry returns the body; otherwise POSTs to /server/ai/decide.
const origin = serverBase(JEV_URL);
const post = args.dry
  ? async (body) => { body.__dry = true; return body; }
  : async (body) => {
      try {
        const r = await fetch(`${origin}/server/ai/decide`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-API-Key': JEV_API_KEY },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20000),
        });
        const j = await r.json().catch(() => null);
        return (j && j.success !== false) ? j : null;
      } catch { return null; }
    };

const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
const rows = [];
const stats = {};   // per point: { jev: { agree, total }, rule: { agree, total } }
for (const p of Object.keys(POINTS)) stats[p] = { jev: { agree: 0, total: 0 }, rule: { agree: 0, total: 0 }, forced: 0, called: 0 };

for (const s of states) {
  const out = await decide(s.point, s.facts, { post, teamId: VPT_TEAM_ID });
  const body = args.dry ? buildRequest(s.point, s.facts, { teamId: VPT_TEAM_ID }) : null;
  if (body) stats[s.point].called++;
  if (out.source === 'forced') stats[s.point].forced++;

  stats[s.point].jev.total++;
  if (out.choice === s.expect) stats[s.point].jev.agree++;
  stats[s.point].rule.total++;
  if (out.ruleDefault === s.expect) stats[s.point].rule.agree++;

  rows.push({
    point: s.point, label: s.label, expect: s.expect,
    ruleDefault: out.ruleDefault, choice: out.choice, confidence: out.confidence,
    source: out.source, decision_id: out.decision_id || null,
    allowed: out.allowed,
  });

  if (args.dry) {
    console.log('---', s.point, '/', s.label, '---');
    console.log(JSON.stringify(body, null, 2));
  }
}

// Per-state lines.
console.log('');
console.log(pad('point', 10), pad('label', 44), pad('expect', 18), pad('ruleDefault', 14), pad('choice', 18), pad('conf', 6), pad('source', 8));
console.log('-'.repeat(120));
for (const r of rows) {
  const conf = r.confidence == null ? 'n/a' : r.confidence.toFixed(2);
  console.log(pad(r.point, 10), pad(r.label, 44), pad(r.expect, 18), pad(r.ruleDefault || '-', 14), pad(r.choice || '-', 18), pad(conf, 6), pad(r.source, 8));
}

// Per-point agreement.
console.log('');
console.log('Agreement with fixture expect:');
console.log(pad('point', 10), pad('jev', 16), pad('rule', 16), pad('forced', 8), pad('called', 8));
console.log('-'.repeat(60));
for (const [p, s] of Object.entries(stats)) {
  const jev = `${s.jev.agree}/${s.jev.total}`;
  const rule = `${s.rule.agree}/${s.rule.total}`;
  console.log(pad(p, 10), pad(jev, 16), pad(rule, 16), pad(String(s.forced), 8), pad(String(s.called), 8));
}
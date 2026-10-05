#!/usr/bin/env node
// router-replay-stop: replays stop-delegation.json cases against either the new stop point
// (router.js `stop`) or STOP_V1 (frozen copy of today's stop). Same env loading as jev-ask.js
// (JEV_URL, JEV_API_KEY, VPT_TEAM_ID from process.env or <repoRoot>/.env via GHOSTY_ENV_FILE
// override); the API key is never printed. log:false in the request body so replays do not
// pollute the decision log.
//
// Usage:
//   node scripts/router-replay-stop.js <cases.json> [--old] [--threshold 0.7]
//
// Cases file shape: [{id, facts, expect}], expect is 'answer' | 'escalate'.
// Output: one row per case (id / expect / pick / p / source) plus a summary:
//   - agreement: pick === expect
//   - UNSAFE:    expect === 'escalate' AND pick === 'answer'  (the dangerous direction)

import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { stop, STOP_V1 } from '../router.js';
import { serverBase } from '../decisions.js';
import { isDisabledReply } from '../jev-switch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const STATE_DIR = process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty');
const ASKS_LOG = join(STATE_DIR, 'router-replay-stop.jsonl');

// ---- tiny .env parser (same shape as jev-ask.js) ----
async function loadDotEnv() {
  const out = {};
  try {
    const raw = await readFile(process.env.GHOSTY_ENV_FILE || join(REPO_ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const m = s.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return out;
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--old') out.flags.old = true;
    else if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out.flags[k] = 'true'; }
      else { out.flags[k] = next; i++; }
    }
    else out._.push(a);
  }
  return out;
}

// Build a request body for a given stop definition (new or STOP_V1). Replays set log:false
// so the run does not pollute the server's decision log.
function buildBody(pointDef, facts, allowed, rulePick) {
  const criteria = {};
  for (const id of allowed) if (pointDef.options[id]) criteria[id] = pointDef.options[id];
  return {
    usage: 'text.decision.manager',
    profile: 'jev',
    log: false,
    timeout_s: 20,
    refs: { source: 'ghosty-router-replay', rule_default: rulePick, replay: true },
    state: JSON.stringify(facts),
    questions: { choice: { type: 'choice', instructions: pointDef.instructions, criteria } },
  };
}

// decide using a given stop definition (mirrors router.js decide, but takes the point def directly).
async function decideStop(pointDef, { post, facts, threshold }) {
  const f = pointDef.floor(facts) || { allowed: [], forced: null, reasons: [] };
  const allowed = Array.isArray(f.allowed) ? f.allowed.slice() : [];
  if (f.forced && !allowed.includes(f.forced)) allowed.unshift(f.forced);
  const rd = pointDef.ruleDefault(facts, allowed);
  const rulePick = allowed.includes(rd) ? rd : (allowed[0] || null);
  if (f.forced) return { choice: f.forced, source: 'forced', confidence: 1, ruleDefault: rulePick, allowed };
  if (typeof post !== 'function') return { choice: rulePick, source: 'rule', confidence: 0, ruleDefault: rulePick, allowed };
  const body = buildBody(pointDef, facts, allowed, rulePick);
  let reply = null;
  try {
    reply = await post(body);
  } catch {
    reply = null;
  }
  const a = reply && reply.answers && reply.answers.choice;
  const ok = !!(reply && reply.success !== false && a);
  const choice = ok ? a.choice : null;
  const confidenceRaw = ok ? Number(a.probabilities?.[a.choice] ?? a.confidence) : null;
  const confidence = Number.isFinite(confidenceRaw) ? confidenceRaw : null;
  if (ok && choice != null && allowed.includes(choice) && confidence != null && confidence >= threshold) {
    return { choice, source: 'jev', confidence, ruleDefault: rulePick, allowed };
  }
  return { choice: rulePick, source: 'rule', confidence: confidence ?? 0, ruleDefault: rulePick, allowed };
}

async function main() {
  const args = parseArgs(process.argv);
  const casesPath = args._[0];
  if (!casesPath) {
    process.stderr.write('usage: router-replay-stop.js <cases.json> [--old] [--threshold 0.7]\n');
    process.exit(2);
  }
  const threshold = args.flags.threshold != null ? Number(args.flags.threshold) : 0.7;
  const useOld = !!args.flags.old;
  const pointDef = useOld ? STOP_V1 : stop;

  const raw = await readFile(casesPath, 'utf8');
  let cases;
  try { cases = JSON.parse(raw); }
  catch (e) { process.stderr.write(`could not parse cases: ${e.message}\n`); process.exit(2); }
  if (!Array.isArray(cases)) { process.stderr.write('cases must be a JSON array\n'); process.exit(2); }

  const dot = await loadDotEnv();
  const JEV_URL = process.env.JEV_URL || dot.JEV_URL || '';
  const JEV_API_KEY = process.env.JEV_API_KEY || dot.JEV_API_KEY || '';
  const VPT_TEAM_ID = process.env.VPT_TEAM_ID || dot.VPT_TEAM_ID || '';
  const origin = serverBase(JEV_URL);
  let jevDisabled = false;
  const post = origin && JEV_API_KEY
    ? async (body) => {
        try {
          const r = await fetch(`${origin}/server/ai/decide`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'X-API-Key': JEV_API_KEY },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(20000),
          });
          const j = await r.json().catch(() => null);
          if (isDisabledReply(j)) jevDisabled = true;
          return (j && j.success !== false) ? j : null;
        } catch { return null; }
      }
    : null;

  const mode = useOld ? 'old' : 'new';
  process.stdout.write(`# router-replay-stop mode=${mode} threshold=${threshold} cases=${cases.length} jev=${post ? 'on' : 'off'}\n`);

  let agreement = 0;
  let unsafe = 0;
  for (const c of cases) {
    if (!c || typeof c !== 'object' || !c.id || !c.facts || !c.expect) {
      process.stderr.write(`skipping malformed case (need id, facts, expect): ${JSON.stringify(c).slice(0, 80)}\n`);
      continue;
    }
    const out = await decideStop(pointDef, { post, facts: c.facts, threshold });
    const ok = out.choice === c.expect;
    if (ok) agreement++;
    if (c.expect === 'escalate' && out.choice === 'answer') unsafe++;
    const pStr = out.confidence != null ? out.confidence.toFixed(2) : '-';
    process.stdout.write(`${String(c.id).padEnd(22)} expect=${c.expect.padEnd(9)} pick=${out.choice.padEnd(9)} p=${pStr.padStart(4)} source=${out.source}${ok ? '' : '  MISMATCH'}\n`);
  }

  process.stdout.write(`# summary mode=${mode} agreement=${agreement}/${cases.length} unsafe=${unsafe}\n`);

  try {
    await mkdir(STATE_DIR, { recursive: true });
    await appendFile(ASKS_LOG, JSON.stringify({
      at: new Date().toISOString(),
      mode,
      threshold,
      cases: casesPath,
      total: cases.length,
      agreement,
      unsafe,
      jev: post ? (jevDisabled ? 'disabled' : 'on') : 'off',
      ...(VPT_TEAM_ID ? { team_id: VPT_TEAM_ID } : {}),
    }) + '\n');
  } catch { /* logging is best-effort; never block the answer */ }

  process.exit(unsafe > 0 ? 1 : 0);
}

main().catch((e) => { process.stderr.write(`${e.message || e}\n`); process.exit(1); });
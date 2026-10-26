#!/usr/bin/env node
// manager-ask: the one command that makes a manager question real (owner, 2026-10-23). It allocates the next Q<n>,
// appends the ledger line the NEEDS YOU strip reads, POSTs /api/alert, and checks both landed (GET /api/owner-asks).
// Non-zero exit when either did not land. Idempotent: the same session+question while still open returns the same id.
//
// Every ask passes the same gate as scripts/owner-ask.js (owner-asks.js checkAsk), so a question that skips it can
// never reach the owner: a refused ask writes nothing and prints why (owner, 2026-10-25: Q231 reached the owner
// because this command wrote the ledger line without the gate).
//
//   node scripts/manager-ask.js --session S --question "<plain words>" \
//     --what "<2-4 lines: what it is, where, what each option does>" \
//     --options "1 ...|2 ..." --recommendation "1 - <your view, one line>" \
//     --floor <floor> --why "<why you: what could be lost, exposed or restarted>" [--jev "..."] \
//     [--supersedes Q12,Q13]     (only these, or the same question reworded, are closed; other open asks stay open)
//   node scripts/manager-ask.js --resolve Q12 --answer "..."
//
// Floors (the only reasons a question may reach the owner, AGENTS.md autonomy by default):
//   money | credentials | customers | deleting_data | host_units | production_migration | history_rewrite | owner_fact
//
// Env: GHOSTY_STATE_DIR (ledger, reporter.token), GHOSTY_URL (default http://127.0.0.1:7777).
// Exit: 0 landed, 1 not verified (ledger or alert), 2 refused by the gate / bad usage.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, appendFile } from 'node:fs/promises';
import { readLedger, openAsksFromRecords, withFileLock, appendRecord, fileAsk } from '../owner-asks.js';
import { askLine } from '../public/manager-ask.js';

const STATE_DIR = process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty');
const BASE = (process.env.GHOSTY_URL || `http://127.0.0.1:${process.env.PORT || 7777}`).replace(/\/$/, '');
const LEDGER = join(STATE_DIR, 'manager-owner-asks.jsonl');
const ALERTS = join(STATE_DIR, 'manager-ask-alerts.jsonl');

function flags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) f[argv[i].slice(2)] = 'true'; else { f[argv[i].slice(2)] = next; i++; }
  }
  return f;
}
const die = (code, msg) => { console.error(`manager-ask: ${msg}`); process.exit(code); };
const token = async () => (await readFile(join(STATE_DIR, 'reporter.token'), 'utf8')).trim();

async function postAlert(title, body, tag) {
  const r = await fetch(`${BASE}/api/alert`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ghosty-reporter-token': await token() },
    body: JSON.stringify({ title: title.slice(0, 120), body: body.slice(0, 1000), tag, priority: 'high' }) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.ok === true, sent: j.sent === true, status: r.status, error: j.error };
}
const served = async () => {
  const r = await fetch(`${BASE}/api/owner-asks`);
  return r.ok ? ((await r.json()).asks || []) : null;
};

async function ask(f) {
  const session = String(f.session || '').trim(), question = String(f.question || '').trim();
  if (!session || !question) die(2, '--session and --question are required');
  const options = String(f.options || '').split('|').map((s) => s.trim()).filter(Boolean);
  // the same ask (session + question) while it is still open: the same id, no second question
  const { records } = await readLedger(LEDGER);
  const same = openAsksFromRecords(records).find((a) => a.session === session && a.question === question);
  if (same) { console.log(same.id); return; }
  // the gate (owner-asks.js checkAsk): a refused ask writes nothing and prints why
  const filed = await fileAsk(LEDGER, {
    session, question, what: f.what, options,
    recommend: f.recommend || f.recommendation, recommendation: f.recommendation || f.recommend,
    floor: f.floor, why: f.why, jev: f.jev, supersedes: f.supersedes,
  });
  if (!filed.ok) die(2, filed.why);
  const id = filed.id;
  // fileAsk closed the session's older open asks only when this is the same question or --supersedes names them
  let alertErr = null;
  try {
    const alerted = (await readFile(ALERTS, 'utf8').catch(() => '')).split('\n').some((l) => { try { return JSON.parse(l).id === id; } catch { return false; } });
    if (!alerted) {
      const a = await postAlert(`Needs you: ${id}`, `${askLine(filed.record)} (answer in /?s=${session})`, `ask-${id}`);
      if (!a.ok) alertErr = `alert not accepted (${a.status} ${a.error || ''})`;
      else { await withFileLock(ALERTS, () => appendFile(ALERTS, JSON.stringify({ id, at: Date.now(), via: 'manager-ask' }) + '\n')); }
    }
  } catch (e) { alertErr = `alert failed: ${e.message}`; }
  let listed = null;
  try { listed = await served(); } catch {}
  if (!listed || !listed.some((a) => a.id === id)) die(1, `${id} written but GET /api/owner-asks does not list it${alertErr ? `; ${alertErr}` : ''}`);
  if (alertErr) die(1, `${id} is in the ledger but ${alertErr}`);
  console.log(id);
}

async function resolve(f) {
  const id = String(f.resolve);
  if (!/^Q\d+$/.test(id)) die(2, '--resolve needs an id like Q12');
  const { records } = await readLedger(LEDGER);
  if (!openAsksFromRecords(records).some((a) => a.id === id)) die(1, `${id} is not open in the ledger`);
  await appendRecord(LEDGER, { at: new Date().toISOString(), id, state: 'answered', answer: String(f.answer || '') });
  const listed = await served().catch(() => null);
  if (listed && listed.some((a) => a.id === id)) die(1, `${id} still listed by GET /api/owner-asks`);
  console.log(id);
}

const f = flags(process.argv.slice(2));
if (f.help) { console.log('usage: manager-ask --session S --question Q --what W --options "1 ..|2 .." --recommendation "1 - why" --floor F --why "why you" [--jev J] [--supersedes Q1,Q2] | --resolve Q<n> --answer A'); process.exit(0); }
await (f.resolve ? resolve(f) : ask(f));

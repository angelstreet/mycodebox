#!/usr/bin/env node
// Scheduled bug drain (owner, 2026-11-11: "when or how frequent do you check and drain bugs?"). One tick, started every 3 h by
// systemd/ghosty-bug-drain.timer (docs/BUG-DRAIN.md): read the bugs ledger, pick up to 3 bugs a worker can fix, start one
// `cbsession` worker per bug (max 2 drain workers alive), journal one line, tell the manager with one event line.
//
//   node scripts/bug-drain-tick.js [--dry | --live] [--json]
// Mode: `dry` (prints what it would start, claims and starts nothing) unless <state>/bug-drain/mode says `live` (the manager flips
// it after reading one dry tick). --dry / --live on the command line win over the file. Never starts anything at disk >= 90 %.
// Env: GHOSTY_URL (default http://127.0.0.1:$PORT|7777), GHOSTY_STATE_DIR, BUG_DRAIN_CBSESSION (default: cbsession next to this
// file's repo on PATH), BUG_DRAIN_DIR (the main checkout the workers get a worktree of, default ~/ghosty-sessions).
// Reads the ledger and the quota over the loopback API; the only writes are the journal, scorecard.json, one manager-events.jsonl
// line and (live) `POST /api/bugs/<id>/claim` before a worker starts.

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TICK_LIMIT = 3;          // bugs per tick
export const MAX_ALIVE = 2;           // drain workers alive at once
export const RECENT_MS = 2 * 3600 * 1000;   // a claim / a live filer's report this young is left alone
export const DISK_HOLD_PCT = 90;
export const MINIMAX_MAX_PCT = 80;    // MiniMax 5h window
export const CLAUDE_MAX_PCT = 85;     // Claude default account, weekly window
export const WORKER_PREFIX = 'bugdrain-';
const HOUR = 3600 * 1000;

// Owner-only / hard floor: the report says so (why), or it names data deletion, a db repair, a physical action, credentials/login or money.
const OWNER_WHY = new Set(['owner-floor', 'credentials']);
const OWNER_TEXT = /\b(db|database|sqlite|postgres)\b.*\b(repair|corrupt|restore|migrat\w+|drop)\b|\b(re-?plug|unplug|power[- ]cycle|physically|physical)\b|\b(credential|password|passwd|login|sign[- ]?in|api[- ]?key|token|2fa|sms code)\b|\b(money|billing|payment|invoice|refund|purchase)\b/i;
const IDEA = /^\s*idea\s*:/i;
const GENERIC = new Set(['fix', 'bug', 'bugs', 'drain', 'build', 'task', 'tasks', 'opus', 'sonnet', 'haiku', 'check', 'main', 'work', 'test', 'tests', 'session', 'worker', 'manager', 'review', 'nightly', 'daily', 'quick', 'with', 'from', 'that', 'this']);

const text = (b) => [b.title, b.endpoint, b.repro, b.error].filter(Boolean).join(' ');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// Hard floor by subject (manager, 2026-11-11: a worker must never start on sudo / cron / units / hypervisor hosts / host config / secrets / DNS / firewall / data deletion / DB work).
const FLOOR = /\b(sudo|sudoers|cron|crontab|cron ?jobs?|systemd|systemctl|units?\s+(?:file|on)|proxmox\d*|hypervisor|docker\s+(?:daemon|socket)|dockerd|nginx|host[- ]?config|\.env|secrets?|dns|firewall|iptables|ufw|credentials?|delet\w+\s+(?:of\s+)?(?:the\s+)?(?:data|database|db)|(?:db|database)\s+(?:migration|repair)s?|corrupt\w*\s+(?:heap|pages?|table|index|database|db)|(?:heap|index)\s+pages?|pg_\w+|vacuum|reindex|postgres(?:ql)?|sqlite|wal\s+(?:file|corrupt\w*)|migrations?\s+(?:of|on)\s+(?:the\s+)?(?:db|database))\b/i;
export const fullText = (b) => [b.title, b.endpoint, b.repro, b.error, b.workaround, b.reason].filter(Boolean).join(' ');
// Hosts a bug is about; a worker needs a lease/inventory entry to reach one.
const HOST = /\b(vpt-(?:pi|mf|lenovo|wise|nipogi|windows)\d*|host-clone-\d+|labox-(?:web|backend|dongle|mobile|tablet)|runner-\d+)\b/gi;
export const hostsOf = (b) => [...new Set((fullText(b).match(HOST) || []).map((h) => h.toLowerCase()))];

export function isOwnerOnly(b) {
  return OWNER_WHY.has(b.why) || OWNER_TEXT.test(`${b.title} ${b.reason || ''}`) || FLOOR.test(fullText(b));
}

// reachable = Set of host names that have a healthy lease-inventory entry, or null when the inventory is unknown (then any host-bound bug is held back).
export const unreachableHosts = (b, reachable) => hostsOf(b).filter((h) => !reachable || !reachable.has(h));

// `vpt-lease inventory <env>` lines: "group: host[/device] (state)  host (UNHEALTHY: ...)". Healthy = not UNHEALTHY.
export function reachableFrom(inventoryText) {
  const set = new Set();
  for (const m of String(inventoryText).matchAll(/([a-z][\w-]*?)(?:\/device\d+)?\s+\(([^)]*)\)/gi)) if (!/^UNHEALTHY/i.test(m[2])) set.add(m[1].toLowerCase());
  return set.size ? set : null;
}

// 3 deploy / lease / CI / data, 2 everything else real, 1 UI, 0 idea (owner: "deploy/lease/CI/data > UI > idea")
export function impactOf(b) {
  if (IDEA.test(b.title)) return 0;
  const t = text(b);
  if (/\b(deploy\w*|lease\w*|ci|ci\/cd|integration|merge|lane|data|ledger|migrat\w+|disk|oom|crash\w*|lost|loss)\b/i.test(t)) return 3;
  if (/\b(ui|css|page|card|button|layout|mobile|screen|banner|icon|tab)\b/i.test(t)) return 1;
  return 2;
}

// Small and clear: a repro and an exact error, not blocking, not an idea, not reported as large. -> MiniMax; the rest -> Sonnet.
export function isSmall(b) {
  return !b.blocking && b.why !== 'large' && !IDEA.test(b.title) && String(b.repro || '').length >= 20 && String(b.error || '').length >= 5 && text(b).length < 1200;
}

const tokens = (name) => String(name).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !GENERIC.has(t) && !/^\d+$/.test(t));

// Why a bug is NOT drained now, or '' when it is a candidate. live = Set of live tmux session names, now = ms.
export function skipReason(b, { live, now, reachable = null }) {
  if (b.test) return 'test report';
  if (isOwnerOnly(b)) return 'owner-only / hard floor';
  const bad = unreachableHosts(b, reachable);
  if (bad.length) return `host not reachable from a worker (no lease inventory entry): ${bad.join(', ')}`;
  if (b.claim && (!b.claim.until || Date.parse(b.claim.until) > now || now - Date.parse(b.claim.at) < RECENT_MS)) return `claimed by ${b.claim.by}`;
  const filerLive = live.has(b.session);
  if (filerLive && now - Date.parse(b.at) < RECENT_MS) return 'filed by a live session in the last 2 h (send-back wake)';
  if (filerLive && b.why === 'live-session-task') return 'belongs to a live session task';
  const words = new Set(text(b).toLowerCase().split(/[^a-z0-9]+/));
  for (const s of live) {
    if (s.startsWith(WORKER_PREFIX) || s === b.session) continue;
    const ts = tokens(s);
    if (ts.length && ts.every((t) => words.has(t))) return `area owned by live session ${s}`;
  }
  return '';
}

// blocking first, then age (older first), then impact (higher first)
export function rank(bugs) {
  return [...bugs].sort((a, b) => (b.blocking ? 1 : 0) - (a.blocking ? 1 : 0) || Date.parse(a.at) - Date.parse(b.at) || impactOf(b) - impactOf(a));
}

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// The owner's numbers. all = every ledger row (open + resolved), 24 h window ending at now.
export function stats(all, now) {
  const rows = all.filter((b) => b.title && !b.test);
  const open = rows.filter((b) => !b.resolved);
  const day = now - 24 * HOUR;
  const closedAt = (b) => Date.parse(b.resolvedAt || b.fixedAt || '');
  const closed = rows.filter((b) => b.resolved && closedAt(b) >= day);
  const fixedAll = rows.filter((b) => b.resolved && b.state === 'fixed');
  const byWorker = (b) => String(b.resolvedBy || '').startsWith(WORKER_PREFIX) || /^bug-?drain/.test(String(b.resolvedBy || ''));
  const byFinder = (b) => b.resolvedBy && b.resolvedBy === b.session;
  const ages = open.map((b) => (now - Date.parse(b.at)) / HOUR).filter((x) => Number.isFinite(x));
  return {
    open: open.length, blocking: open.filter((b) => b.blocking).length,
    opened24h: rows.filter((b) => Date.parse(b.at) >= day).length, closed24h: closed.length,
    medianAgeHours: median(ages) == null ? null : Math.round(median(ages) * 10) / 10,
    fixed: fixedAll.length, fixedByFinder: fixedAll.filter(byFinder).length, fixedByWorker: fixedAll.filter(byWorker).length,
    fixedByOther: fixedAll.filter((b) => !byFinder(b) && !byWorker(b)).length,
  };
}

// Pure planner. -> { start: [{bug, provider, model, why}], skipped: [{id, why}], gates: {...} }
export function plan({ bugs, live, quota, diskPct, now, reachable = null }) {
  const alive = [...live].filter((s) => s.startsWith(WORKER_PREFIX)).length;
  const win = (planName, name) => quota?.plans?.find((p) => p.plan === planName)?.windows?.find((w) => w.name === name)?.usedPercent;
  const mmPct = num(win('minimax', '5h')), clPct = num(win('claude', 'week'));
  const gates = { diskPct, aliveWorkers: alive, minimax5hPct: mmPct, claudeWeekPct: clPct };
  const out = { start: [], skipped: [], gates, halt: '' };
  if (diskPct != null && diskPct >= DISK_HOLD_PCT) { out.halt = `disk ${diskPct}% >= ${DISK_HOLD_PCT}%`; return out; }
  const room = Math.min(TICK_LIMIT, MAX_ALIVE - alive);
  if (room <= 0) { out.halt = `${alive} drain workers alive (max ${MAX_ALIVE})`; return out; }
  const cand = [];
  for (const b of bugs) { const why = skipReason(b, { live, now, reachable }); if (why) out.skipped.push({ id: b.id, why }); else cand.push(b); }
  for (const b of rank(cand)) {
    if (out.start.length >= room) break;
    if (isSmall(b)) {
      if (mmPct != null && mmPct > MINIMAX_MAX_PCT) { out.skipped.push({ id: b.id, why: `small, MiniMax 5h at ${mmPct}% > ${MINIMAX_MAX_PCT}%` }); continue; }
      out.start.push({ bug: b, provider: 'minimax', model: 'MiniMax-M3', size: 'small' });
    } else {
      if (clPct == null || clPct >= CLAUDE_MAX_PCT) { out.skipped.push({ id: b.id, why: `needs Sonnet, Claude default week at ${clPct ?? 'unknown'}% (limit < ${CLAUDE_MAX_PCT}%)` }); continue; }
      out.start.push({ bug: b, provider: 'claude', model: 'sonnet', size: 'medium' });
    }
  }
  return out;
}

// The standard brief. Public repo: ids and rules only.
export function brief(b, { provider }) {
  return `Goal: fix ${b.id} (${String(b.title).slice(0, 120)}) and ship it, or say why it cannot be fixed.

Done when:
1. \`found-bug list\` shows ${b.id} resolved: state fixed with a commit or integration id, or wontfix / duplicate with the reason in the note.
2. For a fix: the integration request of your branch is merged (the lane's result names the merge commit).
3. The tests your change touches pass (\`npm test\` output, last lines in your closing message).
Time box: 2 h.

You are a bug-drain worker (scripts/bug-drain-tick.js, docs/BUG-DRAIN.md), 1 bug, started by the scheduled drain. Your worktree is already made.
Bug ${b.id}, filed by ${b.session} at ${b.at}${b.blocking ? ' (BLOCKING)' : ''}:
- title: ${b.title}
- endpoint: ${b.endpoint || '-'}
- repro: ${b.repro || '-'}
- error: ${b.error || '-'}
- workaround: ${b.workaround || '-'}
- filed because: ${b.why || '-'} ${b.reason || ''}

Rules:
1. First command: \`found-bug --claim ${b.id}\`. Exit 3 means someone else is fixing it: stop with STATUS: done only if nothing else is asked, else \`STATUS: blocked: claimed\`.
2. Reproduce it first (the repro above; fresh evidence beats the report). If it is already fixed on main, resolve it with the commit: \`found-bug --resolve ${b.id} --commit <sha> --state fixed\`.
3. Fix it in your own worktree, run the tests your change touches (\`npm test\`), commit by explicit path, \`git push -u origin <branch>\`, \`integrate request <branch>\`; the lane merges and deploys. Never merge, push main or deploy yourself.
4. After the lane merges: \`found-bug --resolve ${b.id} --commit <sha|integration id>\`. Not fixable (owner-floor, credentials, another host or device you cannot lease): resolve with --state wontfix and the reason, or file the blocker with found-bug --why-not-fixed.
5. Public repo: no credentials, real IPs, host names or captured output in commits or notes. Do not touch the live checkout. Kill only your own processes.
6. Fix other small bugs you meet only when they block this one.${provider === 'minimax' ? `\n7. You are on MiniMax: keep the change small; if it grows past ~100 lines or needs design, release the claim (found-bug --claim ${b.id} --release) and end with STATUS: failed — goal not achieved: too large for the small-bug lane.` : ''}

STATUS vocabulary (owner 2026-11-11): end every turn with a STATUS line. \`done\` only when the goal was achieved, as \`STATUS: done — goal: achieved · evidence: <links / integration id / commit> · closing review: docs <list|none needed> · leftovers <none|filed ids> · unverified <none|list> · bugs: none|fixed <what>|reported <id>\`;
\`failed — goal not achieved: <why> · tried: <list>\`; \`blocked: <system id or reason + what you tried>\`; \`waiting: <system id>\` (an integration id while the lane works); \`needs-owner:\` only for a hard-floor item. A green / pass claim carries its evidence.
`;
}

const j = (r) => JSON.stringify(r);
function defaultReachable() {
  const r = spawnSync(process.env.BUG_DRAIN_LEASE || 'vpt-lease', ['inventory', process.env.BUG_DRAIN_LEASE_ENV || 'node1-vpt'], { encoding: 'utf8', timeout: 20000 });
  return r.status === 0 ? reachableFrom(r.stdout) : null;
}
async function get(url, path) {
  const r = await fetch(url + path, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

export async function tick({ reachable = defaultReachable, url, stateDir, mode, now = Date.now(), cbsession, dir, diskPct, fetchJson = get, run = (cmd, args, env) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 240000, env: { ...process.env, ...env } }) }) {
  const out = join(stateDir, 'bug-drain');
  mkdirSync(out, { recursive: true });
  const [openRes, allRes, sess, quota] = await Promise.all([
    fetchJson(url, '/api/bugs?limit=1000&state=open'), fetchJson(url, '/api/bugs?limit=1000'),
    fetchJson(url, '/api/sessions').catch(() => null), fetchJson(url, '/api/quota').catch(() => null)]);
  if (!sess) throw new Error('/api/sessions unreachable: cannot tell which sessions are live, starting nothing');
  const live = new Set((sess.sessions || []).map((s) => s.name));
  const bugs = (openRes.bugs || []).filter((b) => b.title && !b.resolved);
  const st = stats(allRes.bugs || [], now);
  const p = plan({ bugs, live, quota, diskPct, now, reachable: reachable() });
  const started = [];
  for (const s of p.start) {
    const b = s.bug, name = `${WORKER_PREFIX}${b.id.replace(/^bug-/, '')}`;
    const rec = { id: b.id, session: name, provider: s.provider, model: s.model, size: s.size, title: b.title.slice(0, 80) };
    if (mode === 'live') {
      const file = join(out, `brief-${b.id}.md`);
      writeFileSync(file, brief(b, s));
      // claim for the worker's session name so nobody else (the send-back wake, another worker) fixes it in parallel
      const c = await fetch(`${url}/api/bugs/${b.id}/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ session: name }) }).catch((e) => ({ ok: false, status: 0, e }));
      if (!c.ok) { rec.error = `claim refused (HTTP ${c.status})`; started.push(rec); continue; }
      const args = ['-n', name, '-d', dir, '-p', s.provider, ...(s.provider === 'claude' ? ['-m', s.model] : []), '-g', `fix ${b.id}`, '-A', '-f', file];
      const r = run(cbsession, args, { CBSESSION_BY: 'bug-drain-tick' });
      if (r.status !== 0) { rec.error = `cbsession exit ${r.status}: ${String(r.stderr || r.stdout || '').trim().slice(-160)}`; await fetch(`${url}/api/bugs/${b.id}/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ session: name, release: true }) }).catch(() => {}); }
    }
    started.push(rec);
  }
  const line = { at: new Date(now).toISOString(), mode, started, halt: p.halt || undefined, skipped: p.skipped.length, ownerOnly: p.skipped.filter((x) => x.why.startsWith('owner-only')).map((x) => x.id), unreachable: p.skipped.filter((x) => x.why.startsWith('host not reachable')).map((x) => x.id), skippedWhy: countBy(p.skipped.map((x) => x.why.replace(/ [\d.]+%.*$/, '').replace(/by .*$/, 'by <who>').replace(/session .*$/, 'session <s>').replace(/: [\w, -]+$/, ''))), gates: p.gates, candidates: bugs.length, stats: st };
  appendFileSync(join(out, 'journal.jsonl'), j(line) + '\n');
  writeFileSync(join(out, 'scorecard.json'), j({ at: line.at, ...st, lastTick: { mode, started: started.length, halt: p.halt || null } }) + '\n');
  const what = started.length ? started.map((r) => `${r.id}->${r.provider}${r.error ? ` (${r.error})` : ''}`).join(', ') : (p.halt || 'nothing to start');
  const ev = { at: line.at, key: 'bug-drain:tick', kind: 'bug-drain', title: `bug drain ${mode}: ${started.length} started`.slice(0, 80),
    body: `${mode}: ${what}. open ${st.open} (blocking ${st.blocking}), +${st.opened24h}/-${st.closed24h} in 24 h, median age ${st.medianAgeHours} h, fixed by finder ${st.fixedByFinder} / worker ${st.fixedByWorker} / other ${st.fixedByOther}.`.slice(0, 300), url: '/', priority: 'low' };
  appendFileSync(join(stateDir, 'manager-events.jsonl'), j(ev) + '\n');
  return { line, plan: p, event: ev };
}

const countBy = (xs) => xs.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {});

export function diskPctOf(path = '/') {
  if (process.env.BUG_DRAIN_DISK_PCT) return Number(process.env.BUG_DRAIN_DISK_PCT);
  try { const s = statfsSync(path); return Math.round((1 - s.bavail / s.blocks) * 100); } catch { return null; }
}

export function printable({ line, plan: p }) {
  const L = [`bug-drain tick ${line.at} mode=${line.mode}`, `gates: ${j(line.gates)}`];
  if (p.halt) L.push(`HALT: ${p.halt}`);
  L.push(`open ${line.stats.open} (blocking ${line.stats.blocking}) · opened 24h ${line.stats.opened24h} · closed 24h ${line.stats.closed24h} · median age ${line.stats.medianAgeHours} h · fixed by finder ${line.stats.fixedByFinder}, worker ${line.stats.fixedByWorker}, other ${line.stats.fixedByOther}`);
  L.push(`candidates after filters: ${line.candidates - p.skipped.length} of ${line.candidates}; skipped: ${j(line.skippedWhy)}`);
  for (const r of line.started) L.push(`${line.mode === 'live' ? 'STARTED' : 'WOULD START'} ${r.session}: ${r.id} [${r.size}] via ${r.provider}${r.provider === 'claude' ? ' sonnet' : ' MiniMax-M3'} — ${r.title}${r.error ? ` !! ${r.error}` : ''}`);
  if (!line.started.length && !p.halt) L.push('nothing to start');
  return L.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const stateDir = process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty');
  const flag = process.argv.includes('--live') ? 'live' : process.argv.includes('--dry') ? 'dry' : '';
  let mode = flag;
  if (!mode) { try { mode = readFileSync(join(stateDir, 'bug-drain', 'mode'), 'utf8').trim() === 'live' ? 'live' : 'dry'; } catch { mode = 'dry'; } }
  const url = (process.env.GHOSTY_URL || `http://127.0.0.1:${process.env.PORT || 7777}`).replace(/\/$/, '');
  try {
    const r = await tick({ url, stateDir, mode, cbsession: process.env.BUG_DRAIN_CBSESSION || 'cbsession', dir: process.env.BUG_DRAIN_DIR || join(homedir(), 'ghosty-sessions'), diskPct: diskPctOf(stateDir) });
    console.log(process.argv.includes('--json') ? j(r.line) : printable(r));
  } catch (e) {
    console.error(`bug-drain-tick: ${e.message}`);
    process.exit(1);
  }
}

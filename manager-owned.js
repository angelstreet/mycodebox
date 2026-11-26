// A session the manager started answers to the manager (owner, 2026-11-26): "there is 2 sessiosn that you opened those should not ask me since you opened
// you need to handle them ... if there is things i need to answer it has to come from your session". So its questions and suggestions are the manager's:
// no owner push, NEEDS YOU row or owner ask of its own; the manager answers, and raises what only the owner may decide (scripts/manager-ask.js --source).
// The hard floor itself does not change. The same holds for the sessions such a session starts. Owner-started sessions: nothing changes.
// Rule text: AGENTS.md "Sessions the manager started".
// CLI (cbsession): node manager-owned.js <starter> -> when a session started by <starter> is the manager's: prints MANAGER_RULE, exit 0; else exit 1.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createSessionHistory } from './session-history.js';

export const MANAGER_ACTOR = 'manager-agent';   // `by` of the manager's own sends
export const MANAGER_NAMES = ['mm-manager', 'manager'];
const OWNER_STARTS = new Set(['owner', 'dashboard', 'v2']);
const NO_ANSWER = new Set(['', 'unknown', 'cbsession']);   // the starter was not recorded: manager-children.jsonl may know it
const STALE_MS = 86400e3;   // a manager-children line this much older than the running instance belongs to an earlier session of that name

// manager-children.jsonl is written by hand by the manager: {name|session|id, started|at|ts?}. -> Map(name -> newest time or null)
export function childrenOf(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    const name = r?.name || r?.session || r?.id;
    if (typeof name !== 'string' || !name) continue;
    const t = Date.parse(r.started || r.at || r.ts || '');
    const prev = out.get(name);
    out.set(name, Number.isFinite(t) ? Math.max(t, prev || 0) : prev ?? null);
  }
  return out;
}

// Pure. startedBy(name): sessions.json; instanceOf(name): the latest history instance; children: childrenOf(); managers: the manager sessions.
export function isManagerStarted(name, { startedBy = () => null, instanceOf = () => null, children = new Map(), managers = MANAGER_NAMES } = {}, seen = new Set()) {
  if (!name || managers.includes(name) || seen.has(name) || seen.size > 8) return false;
  seen.add(name);
  const inst = instanceOf(name);
  const by = [startedBy(name), inst?.parent, inst?.started_by].find((b) => b && !NO_ANSWER.has(b)) || '';
  if (by === MANAGER_ACTOR || managers.includes(by)) return true;
  if (OWNER_STARTS.has(by)) return false;
  if (by) return isManagerStarted(by, { startedBy, instanceOf, children, managers }, seen);
  if (!children.has(name)) return false;
  const t = children.get(name);
  return t == null || !inst?.start || t >= inst.start - STALE_MS;
}

export const latestInstance = (instances, name) => { let best = null; for (const i of instances) if (i.name === name && (!best || i.start >= best.start)) best = i; return best; };

// The facts read from the state dir. history / startedBy: the server's own objects; without them (a CLI) the files are read.
export function createManagerOwned({ stateDir, history = null, startedBy = null, managers = null, log = console } = {}) {
  const hist = history || createSessionHistory({ file: join(stateDir, 'session-history.jsonl'), readOnly: true });
  const readJson = (f) => { try { return JSON.parse(readFileSync(join(stateDir, f), 'utf8')); } catch { return null; } };
  const metaOf = startedBy || ((n) => readJson('sessions.json')?.[n]?.startedBy || null);
  const managerList = managers || (() => { const l = readJson('manager.json')?.managerSessions; return Array.isArray(l) && l.length ? l : MANAGER_NAMES; });
  const childFile = join(stateDir, 'manager-children.jsonl');
  let cache = { sig: '', map: new Map() };
  function children() {
    try { const st = statSync(childFile), sig = `${st.mtimeMs}:${st.size}`; if (sig !== cache.sig) cache = { sig, map: childrenOf(readFileSync(childFile, 'utf8')) }; }
    catch (e) { if (e.code !== 'ENOENT') log.error?.('[manager-owned] children', e.message); cache = { sig: '', map: new Map() }; }
    return cache.map;
  }
  return (name) => {
    try { return isManagerStarted(name, { startedBy: metaOf, instanceOf: (n) => latestInstance(hist.instances(), n), children: children(), managers: managerList() }); }
    catch (e) { log.error?.('[manager-owned]', e.message); return false; }
  };
}

// Who an owner ask belongs to (scripts/manager-ask.js, scripts/owner-ask.js). A session the manager started never files one (caller: its
// CBSESSION_PARENT); the manager files it, naming that session (--source, or --session). The ask then sits under `manager:<source>`: the
// source session's later turns never close it (resolveMovedOn) and it shows as the manager's question. -> { session, source } | { refuse }
export function ownerAskRoute(owned, { session = '', source = '', caller = '' } = {}) {
  if (caller && owned(caller)) return { refuse: 'the manager started your session: you never ask the owner. End `STATUS: needs-manager: <the owner-only item>`; the manager files it (--source)' };
  const src = String(source || '').trim() || (owned(String(session).trim()) ? String(session).trim() : '');
  return src ? { session: `manager:${src}`, source: src } : { session: String(session || '').trim(), source: '' };
}

// What such a session is told (cbsession's prompt, and under any harness text that names needs-owner).
export const MANAGER_RULE = '**The manager started your session** (owner 2026-11-26): never ask the owner and never end `STATUS: needs-owner`, whatever another line here says. Every question, decision and suggestion list ends `STATUS: needs-manager: ...`, and the manager answers it. An item only the owner may decide (money, customers, publishing, credentials, deleting data, a physical action) also ends needs-manager and says so: the manager asks the owner from its own session. The hard floor does not change.';
const SHORT_RULE = '[mycodebox: the manager started your session: read every "needs-owner" above as needs-manager. Never ask the owner; the manager answers, and asks the owner itself for an owner-only item.]';
// Pure. A harness text for such a session: the status line it is told to write is needs-manager.
export function forManagerSession(text) {
  const t = String(text || '');
  if (!/needs-owner/.test(t) || t.includes(SHORT_RULE)) return t;
  return `${t.replace(/STATUS: needs-owner/g, 'STATUS: needs-manager')} ${SHORT_RULE}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const starter = process.argv[2] || '';
  const stateDir = process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty');
  const owned = createManagerOwned({ stateDir });
  let managers = MANAGER_NAMES;
  try { const l = JSON.parse(readFileSync(join(stateDir, 'manager.json'), 'utf8')).managerSessions; if (Array.isArray(l) && l.length) managers = l; } catch { /* default */ }
  if (starter === MANAGER_ACTOR || managers.includes(starter) || owned(starter)) process.stdout.write(`${MANAGER_RULE}\n`);
  else process.exitCode = 1;
}

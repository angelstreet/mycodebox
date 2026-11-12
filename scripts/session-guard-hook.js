#!/usr/bin/env node
// PreToolUse(Bash) guard for codebox sessions (owner 2026-11-11, harness pass 2 item 3). Refuses, with the fix printed:
//   (a) sql       a raw SQL WRITE (UPDATE/INSERT/DELETE/DROP/TRUNCATE/ALTER) through psql / pgcli: platform data is written through the
//                 platform PUT routes (kpi-web wrote navigation_edges.kpi_references by psql over the jump host, 2026-11-11 13:34 UTC)
//   (b) restart   `systemctl restart|stop` of a vpt-* unit on a lab host when a `vpt-lease claim` in the same command line is not checked
//                 (`;`, `||`, newline or a pipe between them) or when this session holds no lease on that host (fp194-opus-status restarted
//                 vpt-host after a BUSY claim, 2026-11-11 ~11:00 UTC); also another session's lease on it (restartBlocker, bug-486f0188)
//   (c) host-config  POST /host/system/config or /server/settings/host-config with no `devices` object or an empty one (web-kpi-unblock's
//                 `devices:{}` deleted every DEVICE key of a host .env, 2026-11-11 14:27 UTC, bug-591e8166)
//   (d) manager-bg  the MANAGER session starting a background command that is not its event wait: every background command wakes the manager
//                 again when it ends (61 such wakes on 2026-11-11, 53 did nothing; TASK-239 G6). Only manager-wait.sh, `integrate wait`,
//                 a `vpt-lease ... --wait` / `vpt-lease run` and cbsession may run in the background there.
// Owner override: GHOSTY_GUARD_OVERRIDE=sql|restart|host-config|all in the SESSION's environment (the owner starts it so). An override typed
// into the command itself is refused: the agent cannot grant it to itself. Fails open when the lease registry cannot be read.
// Installed by scripts/install-guard-hooks.js into ~/.claude/settings.json (next to kill-guard.py). Pure logic in guardCommand().
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { restartBlocker } from '../routine-restart.js';

const deny = (rule, why) => ({ rule, why: `session-guard (${rule}): ${why}` });

// ---- (a) raw SQL writes ----
const SQL_CLIENT = /(?:^|[\s;&|('"`])(?:\S*\/)?(?:psql|pgcli)(?=\s|$)/;
const SQL_WRITE = /\b(?:UPDATE\s+[\w."]+\s+SET|INSERT\s+INTO|DELETE\s+FROM|DROP\s+(?:TABLE|SCHEMA|DATABASE|INDEX|VIEW|COLUMN|FUNCTION|TRIGGER)|TRUNCATE(?:\s+TABLE)?\s+[\w."]+|ALTER\s+TABLE)\b/i;
const LOCAL_TEST_DB = /(?:-h\s*|host=|@)(?:localhost|127\.0\.0\.1)\b[^;&|]*\b\w*test\w*\b|\bpostgres(?:ql)?:\/\/[^\s/]*@(?:localhost|127\.0\.0\.1)(?::\d+)?\/\w*test\w*/i;
// heredoc bodies: a file being written (a test, a .sql to review) is not a client call; the client must appear outside them
export const withoutHeredocs = (cmd) => String(cmd).replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '<<heredoc');
export function sqlWrite(cmd, { readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  if (!SQL_CLIENT.test(withoutHeredocs(cmd))) return null;
  let text = cmd;
  for (const m of cmd.matchAll(/(?:^|\s)(?:-f|--file(?:=|\s))\s*['"]?([^\s'"]+)/g)) { try { text += '\n' + readFile(m[1]); } catch { /* unreadable: the inline text decides */ } }
  const w = SQL_WRITE.exec(text);
  if (!w || LOCAL_TEST_DB.test(cmd)) return null;
  return deny('sql', `\`${w[0]}\` through psql writes the platform database behind the platform's back (no version history, no cache invalidation, no tree lock). `
    + 'Write through the platform routes instead: a tree node / edge with its PUT route (the save the editor uses), host settings with the settings routes, '
    + 'a KPI reference with the edge PUT. Reads (SELECT) are fine. If no route exists, say so in a STATUS: needs-manager line with the exact statement and its rollback; '
    + 'the owner can allow it with GHOSTY_GUARD_OVERRIDE=sql in the session environment.');
}

// ---- (b) restart / stop of a vpt-* unit ----
const RESTART = /\bsystemctl\s+(?:-{1,2}[\w=-]+\s+)*(restart|stop)\s+(?:-{1,2}[\w=-]+\s+)*([^;&|\n'"]*?\bvpt-[\w@.*-]+)/i;
const UNIT_NAME = /^vpt-(?:host|monitor[\w-]*|stream[\w@-]*|grabber[\w@-]*|kpi|avq|archiver|timeline|audio[\w-]*|mediamtx|ble-remote@.*|server|vnc|websockify)(?:\.service)?$/;
const mineLease = (l, session) => !!session && [l.session, l.agent].some((x) => { const v = String(x || '').toLowerCase(); return v === session || v.endsWith(`:${session}`); });
const resOf = (l) => [...(l.resources || []), l.resource, ...(l.legacy || [])].filter(Boolean).map((x) => String(x).toLowerCase());
const SSH_HOST = /\bssh\s+(?:-[bcDEeFIiJLlmOoPpQRSWw]\s*\S+\s+|-\S+\s+)*(?:[\w.-]+@)?([\w.-]+)/g;
const TEXT_ARG = /\bfound-bug\b|--(?:title|reason|repro|error|workaround)\b|\/api\/send\b|"keys"/;
export function restartWithoutLease(raw, { leases, session = '' } = {}) {
  const cmd = withoutHeredocs(raw);   // a script or doc being written that mentions a restart is not a restart
  const m = RESTART.exec(cmd);
  if (!m) return null;
  const at = m.index, verb = m[1].toLowerCase(), unit = m[2].trim().split(/\s+/).pop();
  const before = cmd.slice(0, at);
  // `vpt-lease run <claim args> -- ... systemctl restart ...`: the run holds the lease for the command, nothing else to check
  if (/\bvpt-lease\s+run\b[^;\n]*\s--\s/.test(before)) return null;
  const claimAt = before.lastIndexOf('vpt-lease claim');
  if (claimAt >= 0) {
    const between = before.slice(claimAt);
    if (/;|\n|\|\||(?<!\|)\|(?!\|)/.test(between)) return deny('restart', `the \`vpt-lease claim\` before \`systemctl ${verb} ${unit}\` is not checked (\`;\`, \`||\` or a pipe between them): a BUSY claim still runs the ${verb}. `
      + `Chain it with \`&&\` (\`vpt-lease claim <env>/<host> --kind host --wait && ssh <host> sudo systemctl ${verb} ${unit}\`) or use \`vpt-lease run <env>/<host> --kind host -- ssh <host> sudo systemctl ${verb} ${unit}\`.`);
    return null;   // `claim ... && systemctl ...`: the restart runs only on a granted claim
  }
  // lab hosts are named vpt-* too (vpt-mf1, vpt-pi1): drop only unit names (2026-11-12: every real host was dropped, the rule never fired)
  // the host is the nearest `ssh <host>` before the systemctl, with no bug report / message text in between (2026-11-12 replay: found-bug
  // reasons and manager messages that mention a restart). Lab hosts are named vpt-* too: only unit names are dropped (every real host was).
  const ssh = [...before.matchAll(SSH_HOST)].pop();
  if (!ssh || TEXT_ARG.test(before.slice(ssh.index)) || TEXT_ARG.test(before.slice(0, ssh.index))) return null;
  const hosts = [ssh[1].toLowerCase()].filter((h) => !UNIT_NAME.test(h) && !/^(?:sudo|systemctl)$/.test(h));
  if (!hosts.length || !Array.isArray(leases)) return null;   // a local unit, or the registry is unreadable: not decidable here
  const s = String(session || '').toLowerCase();
  const own = leases.filter((l) => (l.mode || 'exclusive') === 'exclusive' && mineLease(l, s));
  const missing = hosts.filter((h) => !own.some((l) => resOf(l).some((x) => x === '*' || x === h || x.startsWith(`${h}/`) || x.endsWith(`:${h}`) || x.includes(`/${h}/`) || x.endsWith(`/${h}`))));
  if (!missing.length) return null;
  return deny('restart', `this session holds no lease on ${missing.join(', ')}, so \`systemctl ${verb} ${unit}\` there may break someone's run. `
    + `Claim it first and chain the result: \`vpt-lease claim <env>/${missing[0]} --kind host --wait && ssh ${missing[0]} sudo systemctl ${verb} ${unit}\`, or \`vpt-lease run <env>/${missing[0]} --kind host -- ssh ${missing[0]} sudo systemctl ${verb} ${unit}\`. `
    + 'A per-device unit needs that device\'s lease (or the host lease). Never ask the owner about a lease.');
}

// ---- (c) host config saves without devices ----
// the curl TARGET is the route (a URL or a $VAR-prefixed path), not a message that mentions it (the manager's /api/send text did)
const HOST_CONFIG = /(?:https?:\/\/|\$\{?\w+\}?)[^\s'"]*\/(?:host\/system\/config|server\/settings\/host-config)(?![\w/-])/;
export function hostConfigWithoutDevices(cmd, { readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  const outer = withoutHeredocs(cmd);   // a script being written that mentions the route is not a call
  if (!HOST_CONFIG.test(outer) || !/\bcurl\b/.test(outer)) return null;
  const posts = /-X\s*['"]?(?:POST|PUT|PATCH)\b|--request\s+['"]?(?:POST|PUT|PATCH)\b|\s(?:-d|--data(?:-raw|-binary|-urlencode)?|--json|-F|--form)(?=[\s=]|['"@{])/i.test(cmd);
  if (!posts) return null;
  const bodies = [];
  for (const m of cmd.matchAll(/(?:\s-d|--data(?:-raw|-binary)?|--json)(?:\s+|=)?\s*(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(@\S+)|(\{\S*))/g)) {
    const b = m[1] ?? m[2] ?? m[4] ?? '';
    if (m[3]) { const p = m[3].slice(1).replace(/^['"]|['"]$/g, ''); if (p === '-') { bodies.push(null); continue; } try { bodies.push(readFile(p)); } catch { bodies.push(null); } }
    else bodies.push(m[2] !== undefined ? b.replace(/\\"/g, '"') : b);
  }
  const fix = 'Read the current config first (GET the same route), change only your key, and send the whole object back with its `devices` filled in; an empty or missing `devices` deletes every DEVICE key of that host (bug-591e8166).';
  if (!bodies.length) return deny('host-config', `a save to the host config with no body I can read. ${fix}`);
  for (const b of bodies) {
    if (b === null) return deny('host-config', `the body comes from stdin or an unreadable file, so its \`devices\` cannot be checked. Pass it inline or as a readable @file. ${fix}`);
    if (!/"devices"\s*:/.test(b)) return deny('host-config', `the body has no \`devices\` object. ${fix}`);
    if (/"devices"\s*:\s*(?:\{\s*\}|\[\s*\]|null)/.test(b)) return deny('host-config', `the body sends \`devices\` empty. ${fix}`);
  }
  return null;
}

// ---- (d) the manager's own background commands ----
const MANAGER_BG_OK = /manager-wait\.sh|\bintegrate\s+wait\b|\bvpt-lease\b[^;&|\n]*(?:--wait|\brun\b)|\bcbsession\b/;
export function managerBackground(cmd, { background = false, session = '', managers = [] } = {}) {
  if (!background || !session || !managers.map((m) => String(m).toLowerCase()).includes(String(session).toLowerCase())) return null;
  if (MANAGER_BG_OK.test(String(cmd))) return null;
  return deny('manager-bg', 'a background command wakes you again when it ends, for nothing (61 such wakes on 2026-11-11, 53 did nothing). Run this command in the '
    + 'foreground (Bash timeout up to 600000 ms). Only the event wait (scripts/manager-wait.sh), `integrate wait`, a `vpt-lease ... --wait` / `vpt-lease run` and '
    + 'cbsession run in the background.');
}

// -> { rule, why } | null. override: the session environment's GHOSTY_GUARD_OVERRIDE (never the command's).
export function guardCommand(cmd, { leases = undefined, session = '', override = '', readFile, background = false, managers = [] } = {}) {
  const c = String(cmd || '');
  if (!c.trim()) return null;
  if (/\bGHOSTY_GUARD_OVERRIDE\s*=/.test(c)) return deny('override', 'GHOSTY_GUARD_OVERRIDE is the owner\'s switch, read from the session environment; it cannot be set inside a command. Use the route / lease the refusal named, or ask with STATUS: needs-manager.');
  const off = new Set(String(override || '').toLowerCase().split(/[\s,]+/).filter(Boolean));
  const on = (r) => !off.has(r) && !off.has('all');
  const opts = readFile ? { readFile } : {};
  if (on('manager-bg')) { const r = managerBackground(c, { background, session, managers }); if (r) return r; }
  if (on('sql')) { const r = sqlWrite(c, opts); if (r) return r; }
  if (on('host-config')) { const r = hostConfigWithoutDevices(c, opts); if (r) return r; }
  if (on('restart') && RESTART.test(c)) {
    const ls = typeof leases === 'function' ? leases() : leases;
    const r = restartWithoutLease(c, { leases: ls, session });
    if (r) return r;
    if (/systemctl\s+restart/.test(c)) { const b = restartBlocker({ text: c, leases: ls, session }); if (b) return { rule: 'restart', why: b }; }   // another session's lease (bug-486f0188)
  }
  return null;
}

const sessionName = () => {
  const a = process.env.VPT_LEASE_AGENT;
  if (a) return a.replace(/^codebox:/, '').toLowerCase();
  try { return execFileSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf8', timeout: 2000 }).trim().toLowerCase(); } catch { return ''; }
};
const liveLeases = () => { try { return JSON.parse(execFileSync('vpt-lease', ['list', '--json'], { encoding: 'utf8', timeout: 10000 })).leases; } catch { return null; } };

if (import.meta.url === `file://${process.argv[1]}`) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; }).on('end', () => {
    let cmd = '', background = false;
    try { const ti = JSON.parse(raw)?.tool_input; cmd = ti?.command || ''; background = ti?.run_in_background === true; } catch { /* not a hook call */ }
    let managers = ['manager'];
    try { const j = JSON.parse(readFileSync(`${process.env.GHOSTY_STATE_DIR || `${process.env.HOME}/.local/state/ghosty`}/manager.json`, 'utf8')); if (Array.isArray(j?.managerSessions) && j.managerSessions.length) managers = j.managerSessions; } catch { /* default */ }
    let r = null;
    try { r = guardCommand(cmd, { leases: liveLeases, session: sessionName(), override: process.env.GHOSTY_GUARD_OVERRIDE || '', background, managers }); } catch { r = null; }   // a guard bug never blocks a session
    if (r) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.why } }));
  });
}

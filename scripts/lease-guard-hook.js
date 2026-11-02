#!/usr/bin/env node
// PreToolUse(Bash) hook: refuse `systemctl restart <device-driving unit>` on a lab host while another session's lease covers that
// host or one of its devices (bug-486f0188). Logic: restartBlocker() in routine-restart.js. Session = $VPT_LEASE_AGENT, else the tmux session.
// Fails open when the lease registry cannot be read.
import { execFileSync } from 'node:child_process';
import { restartBlocker } from '../routine-restart.js';

const sessionName = () => {
  const a = process.env.VPT_LEASE_AGENT;
  if (a) return a.replace(/^codebox:/, '');
  try { return execFileSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf8', timeout: 2000 }).trim(); } catch { return ''; }
};
const liveLeases = () => {
  try { return JSON.parse(execFileSync('vpt-lease', ['list', '--json'], { encoding: 'utf8', timeout: 10000 })).leases; } catch { return null; }
};

export function guard(command, { leases, session } = {}) {
  if (!/systemctl\s+restart/.test(command)) return null;
  return restartBlocker({ text: command, leases: leases ?? liveLeases(), session: session ?? sessionName() });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; }).on('end', () => {
    let cmd = '';
    try { cmd = JSON.parse(raw)?.tool_input?.command || ''; } catch { /* not a hook call */ }
    const why = guard(cmd);
    if (why) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } }));
  });
}

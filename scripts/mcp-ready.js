#!/usr/bin/env node
// Wait until the HTTP MCP servers of a Claude Code project answer, before cbsession starts Claude in it.
//
// Why (2026-11-16, VirtualPyTest TASK-208 round 6b): Claude Code connects each MCP server once, when the session
// starts. The virtualpytest entry points at the VirtualPyTest backend server, which every server deploy restarts
// (its port is closed for about 15 s; 8 restarts in 3 hours that day). A worker started at 16:13:44 UTC, inside
// the restart of 16:13:39 to 16:13:53, got "virtualpytest (ECONNREFUSED)" and had no MCP tool for its whole
// life: it read code and wrote its own client, 20 turns more than a worker started between two deploys.
//
//   node mcp-ready.js <project dir> [--wait 60]
//
// Reads ~/.claude.json: the project entry of <dir>, else of the main checkout of <dir> (a git worktree), plus the
// user-scope entries. Each http / sse entry is asked once every 3 s until it answers (any HTTP status, a 401
// included: the server is up) or the wait ends. Prints nothing and exits 0 when all answer; otherwise prints one
// line "name (host:port)" per server still down and exits 3. Sends no header and never prints one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The main checkout of a git worktree (its project entry holds the MCP servers), or '' when dir is not one.
export function mainCheckout(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  if (r.status !== 0) return '';
  const common = r.stdout.trim();
  return path.basename(common) === '.git' ? path.dirname(common) : '';
}

// [{ name, url }] of the http / sse MCP servers a session started in `dir` connects to.
export function serversOf(claudeJson, dir, main = '') {
  const out = new Map();
  const add = (servers) => {
    for (const [name, e] of Object.entries(servers || {})) {
      if (e && typeof e.url === 'string' && /^https?:\/\//.test(e.url) && !out.has(name)) out.set(name, e.url);
    }
  };
  const projects = claudeJson?.projects || {};
  add(projects[dir]?.mcpServers);
  if (main && main !== dir) add(projects[main]?.mcpServers);
  add(claudeJson?.mcpServers);
  return [...out].map(([name, url]) => ({ name, url }));
}

// True when the server answers at all: a refused or timed-out connection is "down", any HTTP status is "up".
export async function answers(url, timeoutMs = 4000) {
  try {
    await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return true;
  } catch (e) {
    return false;
  }
}

// The servers still down after `waitMs` (asked every `everyMs`); [] as soon as all answer.
export async function waitReady(servers, waitMs, everyMs = 3000, ask = answers) {
  const deadline = Date.now() + waitMs;
  let down = servers;
  for (;;) {
    const up = await Promise.all(down.map((s) => ask(s.url)));
    down = down.filter((_, i) => !up[i]);
    if (down.length === 0 || Date.now() + everyMs > deadline) return down;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

const where = (url) => { try { return new URL(url).host; } catch { return '?'; } };

async function main() {
  const args = process.argv.slice(2);
  const wi = args.indexOf('--wait');
  const waitS = wi >= 0 ? Number(args[wi + 1]) : 60;
  const dir = args.find((a, i) => !a.startsWith('--') && (wi < 0 || i !== wi + 1));
  if (!dir || !Number.isFinite(waitS)) { console.error('usage: mcp-ready.js <project dir> [--wait seconds]'); process.exit(2); }
  let cj;
  try { cj = JSON.parse(fs.readFileSync(path.join(process.env.HOME || os.homedir(), '.claude.json'), 'utf8')); } catch { process.exit(0); }
  const abs = path.resolve(dir);
  const down = await waitReady(serversOf(cj, abs, mainCheckout(abs)), waitS * 1000, Number(process.env.MCP_READY_EVERY_MS) || 3000);
  for (const s of down) console.log(`${s.name} (${where(s.url)})`);
  process.exit(down.length ? 3 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

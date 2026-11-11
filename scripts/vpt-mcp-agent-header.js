#!/usr/bin/env node
// Make every Claude Code project entry of the VirtualPyTest MCP server send `X-Agent-Name: ${VPT_AGENT_NAME:-}`
// (bug-c6a65805). The host lease guard compares that name with the lease holder of a device, so an agent that
// drives a device another agent holds is refused. cbsession exports VPT_AGENT_NAME=<host>:<session>; a shell
// that does not (the Mac desktop) sends an empty header, which the server treats as "no name".
//
// Claude Code expands ${VAR:-default} in the headers of a local-scope entry (checked 2026-11-11), so the entry
// is written once and every session fills in its own name. The edit goes through `claude mcp`, never by hand
// into ~/.claude.json (running sessions rewrite that file all the time). The Authorization value is passed on
// to the new entry and never printed.
//
//   node vpt-mcp-agent-header.js            list the projects that still lack the header
//   node vpt-mcp-agent-header.js --apply    fix them (idempotent: nothing to do = no change)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SERVER = 'virtualpytest';
export const HEADER = 'X-Agent-Name';
export const HEADER_VALUE = '${VPT_AGENT_NAME:-}';

// Projects whose virtualpytest entry is an http entry without the header (or with a different value).
export function plan(claudeJson) {
  const out = [];
  for (const [dir, proj] of Object.entries(claudeJson?.projects || {})) {
    const e = proj?.mcpServers?.[SERVER];
    if (!e || e.type !== 'http' || !e.url) continue;
    const headers = e.headers || {};
    if (headers[HEADER] === HEADER_VALUE) continue;
    out.push({ dir, url: e.url, headers });
  }
  return out;
}

export function addArgs(entry) {
  const a = ['mcp', 'add', SERVER, entry.url, '--transport', 'http', '--scope', 'local'];
  for (const [k, v] of Object.entries({ ...entry.headers, [HEADER]: HEADER_VALUE })) a.push('--header', `${k}: ${v}`);
  return a;
}

function main() {
  const file = path.join(process.env.HOME || os.homedir(), '.claude.json');
  let cj;
  try { cj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error(`vpt-mcp-agent-header: cannot read ${file}: ${e.message}`); process.exit(0); }
  const todo = plan(cj);
  if (!process.argv.includes('--apply')) { for (const t of todo) console.log(`missing ${HEADER}: ${t.dir}`); console.log(`${todo.length} project(s) without the header`); return; }
  let failed = 0;
  for (const t of todo) {
    if (!fs.existsSync(t.dir)) continue;
    const rm = spawnSync('claude', ['mcp', 'remove', SERVER, '--scope', 'local'], { cwd: t.dir, encoding: 'utf8' });
    const add = spawnSync('claude', addArgs(t), { cwd: t.dir, encoding: 'utf8' });
    if (add.status !== 0) { // never leave the project without its MCP entry: put the old one back
      const restore = { url: t.url, headers: t.headers };
      const a = ['mcp', 'add', SERVER, restore.url, '--transport', 'http', '--scope', 'local'];
      for (const [k, v] of Object.entries(restore.headers)) a.push('--header', `${k}: ${v}`);
      spawnSync('claude', a, { cwd: t.dir, encoding: 'utf8' });
      failed++; console.error(`vpt-mcp-agent-header: ${t.dir}: add failed (${(add.stderr || rm.stderr || '').slice(0, 120)})`); }
    else console.log(`header set: ${t.dir}`);
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();

#!/usr/bin/env node
// Token-free daily checks (run once a day, 07:00 Europe/Zurich, by systemd/ghosty-daily-checks.timer).
//
// This file is the GENERIC runner. It knows nothing about any repository, term list or customer: the check
// definitions live in a private config that is not in git, ~/.local/state/ghosty/daily-checks.json:
//
//   { "debounceHours": 20, "keepDays": 14,
//     "checks": [ { "id": "ci", "title": "CI/CD", "command": ["/usr/local/bin/node", "/path/to/check.js"], "timeoutSec": 600 } ] }
//
// Each check command prints ONE JSON object on stdout (the last non-empty line wins) and exits 0:
//   { "summary": "one line", "report": "markdown body", "findings": [ { "key": "ci:main-failed", "title": "...", "body": "...", "priority": "high" } ] }
// No findings = healthy. A check that crashes, times out or prints nothing parseable is itself a finding
// (`daily:check-broken:<id>`): a silent check is worse than a noisy one.
//
// 1. RUN every check, 2. WRITE a full report to ~/.local/state/ghosty/daily-reports/<date>.md (kept keepDays),
// 3. WAKE THE MANAGER (one line in manager-events.jsonl, kind 'daily') only for findings, debounced per key
//    (the same key with the same text is not appended again inside debounceHours; a key that clears is forgotten,
//    so a recurrence wakes again).
//
// Flags: --dry-run  run the checks, write the report, but append no event and keep no state
//        --only <id>  run a single check (state is not updated)
// No dependencies, no AI calls.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_CONFIG = { debounceHours: 20, keepDays: 14, checks: [] };

const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export function loadConfig(path) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return { ...DEFAULT_CONFIG, error: e.code === 'ENOENT' ? `no config at ${path}` : `config unreadable: ${e.message}` }; }
  const cfg = { ...DEFAULT_CONFIG, ...raw };
  cfg.checks = (Array.isArray(raw.checks) ? raw.checks : []).filter((c) => c && typeof c.id === 'string' && Array.isArray(c.command) && c.command.length);
  return cfg;
}

// Pure: turn a check's raw process result into { ok, summary, report, findings } or a synthetic "broken" finding.
export function parseCheckResult(check, res) {
  const name = check.title || check.id;
  const broken = (why) => ({
    ok: false, broken: true, summary: `check broken: ${why}`, report: `The check command did not produce a usable result: ${why}`,
    findings: [{ key: `check-broken:${check.id}`, title: `${name} check is broken`, body: `The daily ${name} check could not run: ${why}. Nothing was verified today.`, priority: 'high' }],
  });
  if (res.error) return broken(res.error.code === 'ETIMEDOUT' ? `timed out after ${check.timeoutSec || 600}s` : `spawn failed (${res.error.code || res.error.message})`);
  if (res.status !== 0) return broken(`exit ${res.status}${res.signal ? ` signal ${res.signal}` : ''}`);
  const lines = String(res.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  let obj;
  try { obj = JSON.parse(lines[lines.length - 1] || ''); } catch { return broken('stdout had no JSON result on its last line'); }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.findings)) return broken('JSON result has no findings array');
  const findings = obj.findings.filter((f) => f && typeof f.key === 'string' && f.key).map((f) => ({
    key: f.key, title: String(f.title || f.key), body: String(f.body || ''), priority: f.priority === 'default' ? 'default' : 'high',
  }));
  return { ok: findings.length === 0, summary: String(obj.summary || ''), report: String(obj.report || ''), findings };
}

export function buildEvent(finding, reportPath, now) {
  const key = finding.key.startsWith('daily:') ? finding.key : `daily:${finding.key}`;
  const tail = ` Report: ${reportPath}`;
  const body = cut(finding.body, Math.max(40, 300 - tail.length)) + tail;
  return { at: new Date(now).toISOString(), key, kind: 'daily', title: cut(finding.title, 80), body: cut(body, 300), url: '/', priority: finding.priority || 'high' };
}

const fp = (ev) => createHash('sha1').update(ev.title + '\n' + ev.body.replace(/ Report: \S+$/, '')).digest('hex').slice(0, 12);

// Debounce: wake when never written, when the text changed, or when the window elapsed.
export function shouldWake(ev, prev, now, debounceHours) {
  if (!prev) return { wake: true, why: 'new' };
  if (prev.fp !== fp(ev)) return { wake: true, why: 'changed' };
  if (now - prev.at >= debounceHours * 3600000) return { wake: true, why: 'window elapsed' };
  return { wake: false, why: 'debounced' };
}

function loadState(p) { try { const s = JSON.parse(readFileSync(p, 'utf8')); return { events: s.events || {} }; } catch { return { events: {} }; } }

export async function run({ home = homedir(), now = Date.now(), argv = process.argv.slice(2), out = console.log } = {}) {
  const dryRun = argv.includes('--dry-run');
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
  const stateDir = join(home, '.local/state/ghosty');
  const reportsDir = join(stateDir, 'daily-reports');
  const statePath = join(stateDir, 'daily-checks-state.json');
  const cfg = loadConfig(join(stateDir, 'daily-checks.json'));
  const day = new Date(now).toISOString().slice(0, 10);
  const reportPath = join(reportsDir, `${day}${dryRun ? '-dry' : ''}.md`);
  const R = [`# Daily checks ${new Date(now).toISOString()}${dryRun ? ' (dry run)' : ''}`, ''];

  const results = [];
  if (cfg.error) { R.push(`Config: ${cfg.error}. Nothing ran.`, ''); out(`daily-checks: ${cfg.error}`); }
  for (const check of cfg.checks.filter((c) => !only || c.id === only)) {
    const t0 = Date.now();
    const res = spawnSync(check.command[0], check.command.slice(1), { encoding: 'utf8', timeout: (check.timeoutSec || 600) * 1000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, HOME: home } });
    const r = { check, ...parseCheckResult(check, res), secs: Math.round((Date.now() - t0) / 1000) };
    results.push(r);
    R.push(`## ${check.title || check.id} — ${r.ok ? 'OK' : r.broken ? 'BROKEN' : 'FINDINGS'} (${r.secs}s)`, '', r.summary, '');
    if (r.findings.length) R.push('Findings:', ...r.findings.map((f) => `- \`${f.key}\` [${f.priority}] ${f.title}: ${f.body}`), '');
    if (r.report) R.push(r.report.trim(), '');
  }

  const state = loadState(statePath);
  const seen = new Set();
  const events = [];
  R.push('## Manager wake', '');
  const all = results.flatMap((r) => r.findings);
  if (!all.length) R.push('No finding: manager NOT woken.');
  for (const f of all) {
    const ev = buildEvent(f, reportPath, now);
    seen.add(ev.key);
    const d = shouldWake(ev, state.events[ev.key], now, cfg.debounceHours);
    if (!d.wake) { R.push(`- ${ev.key}: ${d.why}, not written`); continue; }
    events.push(ev);
    R.push(`- ${ev.key}: ${dryRun ? 'WOULD write' : 'wrote'} (${d.why}): \`${JSON.stringify(ev)}\``);
    if (!dryRun) {
      await appendFile(join(stateDir, 'manager-events.jsonl'), JSON.stringify(ev) + '\n');
      state.events[ev.key] = { at: now, fp: fp(ev) };
    }
  }
  if (!only) for (const k of Object.keys(state.events)) if (!seen.has(k)) delete state.events[k]; // cleared: a recurrence wakes again
  R.push('', '## Manager filter', '', 'monitor-filter.sh drops only kind "deploy" start/done and `jev.pick=="ignore"` deploy lines: kind "daily" lines pass.');

  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(reportPath, R.join('\n') + '\n');
  try { for (const f of readdirSync(reportsDir)) { const p = join(reportsDir, f); if (f.endsWith('.md') && now - statSync(p).mtimeMs > (cfg.keepDays || 14) * 86400000) rmSync(p); } } catch {}
  if (!dryRun && !only) writeFileSync(statePath, JSON.stringify(state, null, 1));
  out(`daily-checks: ${results.length} check(s), ${all.length} finding(s), ${events.length} event(s) ${dryRun ? 'would be written' : 'written'}, report ${reportPath}`);
  return { results, events, reportPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error('daily-checks failed:', e); process.exit(1); });
}

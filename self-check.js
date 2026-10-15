// Self-check before asking (round 9, item 5): questions the manager can settle from the registry and the hosts are answered, not escalated.
//   version   "what version is deployed on env-a?"      from the deploy runner's "deployed now" ledger
//   progress  "is the run finished?" / "progress?"       from the session's own job (own-jobs.js), else not answered
//   file      "does docs/x.md exist?"                    fs.stat inside the session's repo or a configured root, never outside
// (Lease questions are answered by lease-ask.js.) Pure detection + small read-only resolvers; every answer is plain text that goes through
// the hard floor like any other reply (composeReply). Nothing here reads file content, only existence, kind, size and age.
import { stat, realpath } from 'node:fs/promises';
import { resolve, sep, isAbsolute, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { sensitivePath } from './merge-policy.js';

const ASKY = /\?|^\W*(?:is|are|does|do|did|has|have|what|which|how|can you tell|tell me|let me know|check)\b/i;
const VERSION_RE = /\b(?:what|which)\b[^?.\n]{0,40}\b(?:version|build(?: number)?|release|commit|sha)\b[^?.\n]{0,60}\b(?:deployed|live|running|installed|out|on|in|at)\b|\b(?:what|which)(?:'s| is| are)? (?:the )?(?:current |latest |deployed )?(?:version|build)\b|\bwhich (?:build|version|commit) is (?:deployed|live|running)\b/i;
const PROGRESS_RE = /\bis (?:the|my|that|this|our) (?:\w[\w.-]* ){0,3}(?:run|job|build|test run|tests|process|task|script|export|sync|import|batch|pipeline|render|training)\b[^?.\n]{0,25}\b(?:finished|done|complete[d]?|over|still running|ready|through)\b|\b(?:what(?:'s| is) (?:the )?(?:current )?(?:progress|status) of)\b|\b(?:what(?:'s| is) the progress|how far (?:along|is)|is it (?:finished|done|complete[d]?|still running))\b|\bhas (?:the|it|that) (?:\w+ ){0,2}(?:finished|completed|ended)\b/i;
const EXISTS_RE = /\b(?:does|do|is|are)\b[^?.\n]{0,60}\b(?:exist|exists|existing|there)\b|\b(?:exists?|existing)\b|\bis there (?:a|an|any)\b[^?.\n]{0,30}\b(?:file|dir|directory|folder|script|doc)\b|\bwhether\b[^?.\n]{0,60}\bexists?\b/i;
const PATHISH = /`([^`\s]+)`|(~?\/[\w.@+-]+(?:\/[\w.@+-]+)*|(?:\.{1,2}\/)?[\w.@+-]+(?:\/[\w.@+-]+)+|\b[\w.@+-]+\.[a-z][a-z0-9]{0,5}\b)/g;

// -> { kind } | null
export function selfAsk(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t || !ASKY.test(t)) return null;
  if (EXISTS_RE.test(t) && pathsIn(t).length === 1) return { kind: 'file' };
  if (VERSION_RE.test(t)) return { kind: 'version' };
  if (PROGRESS_RE.test(t)) return { kind: 'progress' };
  return null;
}

export function pathsIn(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(PATHISH)) {
    const tok = (m[1] || m[2] || '').replace(/[.,;:)\]'"?!]+$/, '');
    if (!tok || /:\/\/|[?=#@*]/.test(tok) || /^\d+(?:\.\d+)+$/.test(tok) || /^(?:e\.g|i\.e)\.?$/i.test(tok)) continue;
    if (!/[A-Za-z]/.test(tok)) continue;
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}

const short = (s) => String(s || '').slice(0, 12);
const clean = (s, n = 80) => String(s ?? '').replace(/[`\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// version: the ledger is { env: { frontend|server|host: { ref, commit, version } } }
export function answerVersion({ ask, deployed = {}, envs = [] } = {}) {
  const names = Object.keys(deployed || {});
  const t = String(ask ?? '');
  const named = [...new Set([...envs, ...names])].filter((n) => new RegExp(String.raw`(?<![\w-])${String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\w-])`, 'i').test(t));
  const pick = named.length ? named : names;
  const targets = ['frontend', 'server', 'host'].filter((x) => new RegExp(String.raw`\b${x}\b`, 'i').test(t));
  const rows = [];
  for (const env of pick.slice(0, 3)) {
    const per = deployed[env] || {};
    const parts = (targets.length ? targets : ['frontend', 'server', 'host']).filter((x) => per[x]?.commit || per[x]?.ref)
      .map((x) => `${x} ${clean(per[x].ref, 40) || '?'}@${short(per[x].commit)}${per[x].version ? ` (version ${clean(per[x].version, 40)})` : ''}`);
    if (parts.length) rows.push(`${env}: ${parts.join(', ')}`);
  }
  if (!rows.length) return null;
  return `Running now (from the ledger): ${rows.join('; ')}.`;
}

// file: stat only, and only inside `roots` (the session's repo, configured info roots). A symlink that leaves a root counts as outside.
async function inside(roots, abs) {
  for (const r of roots) {
    let rr; try { rr = await realpath(r); } catch { continue; }
    let probe = abs, real = null;
    for (let i = 0; i < 40 && !real; i++) { try { real = await realpath(probe); } catch { const up = dirname(probe); if (up === probe) break; probe = up; } }
    if (real && (real === rr || real.startsWith(rr + sep)) && (abs === rr || abs.startsWith(rr + sep))) return rr;
  }
  return null;
}
export async function answerFile({ ask, roots = [], now = Date.now() } = {}) {
  const toks = pathsIn(ask);
  if (toks.length !== 1) return null;
  const tok = toks[0];
  if (/\.\.(?:\/|$)/.test(tok)) return null;
  const rootsOk = roots.filter(Boolean).map((r) => resolve(r));
  if (!rootsOk.length) return null;
  const expanded = tok.startsWith('~/') ? resolve(homedir(), tok.slice(2)) : tok;
  const cands = isAbsolute(expanded) ? [expanded] : rootsOk.map((r) => resolve(r, expanded));
  if (sensitivePath(tok) || cands.some((c) => sensitivePath(c))) return null;   // never confirm or deny a secret-looking path
  let checked = null, rel = tok;
  for (const abs of cands) {
    const root = await inside(rootsOk, abs);
    if (!root) continue;
    checked = root; rel = abs === root ? '.' : abs.slice(root.length + 1);
    let st = null; try { st = await stat(abs); } catch { st = null; }
    if (st) {
      const age = Math.max(0, Math.round((now - st.mtimeMs) / 60000));
      return `Yes: ${rel} exists in ${basename(root)} (${st.isDirectory() ? 'directory' : st.isFile() ? `file, ${st.size} bytes` : 'special file'}, modified ${age < 120 ? `${age} min` : `${Math.round(age / 60)} h`} ago).`;
    }
  }
  if (!checked) return null;   // outside every root: not the manager's to look at
  return `No: ${rel} does not exist in ${basename(checked)}.`;
}

// -> { label, answer } | null. ctx: { deployed, envs, roots, progress (string|null: the session's own job state), now }
export async function answerSelf(part, ctx = {}) {
  const text = typeof part === 'string' ? part : part?.text;
  const k = selfAsk(text);
  if (!k) return null;
  let answer = null, label = null;
  if (k.kind === 'version') { answer = answerVersion({ ask: text, deployed: ctx.deployed, envs: ctx.envs }); label = 'Version'; }
  else if (k.kind === 'progress') { answer = ctx.progress ? String(ctx.progress) : null; label = 'Progress'; }
  else { answer = await answerFile({ ask: text, roots: ctx.roots, now: ctx.now }); label = 'File'; }
  return answer ? { label, answer, source: '', kind: k.kind } : null;
}

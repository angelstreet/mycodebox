// Information part of a mixed question (round 7): "(a) send the SRF 1 buffer path, (b) say whether to merge X".
// splitAsk cuts the ask into parts; lookupInfo answers an information part from the docs of the session's repo
// (or the configured infoRoots) when exactly one path matches. Read-only: git grep and a bounded directory walk.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { mergeMatch, hardMatch } from './stall.js';
import { SECRET_PATTERNS } from './merge-policy.js';

const execFileP = promisify(execFile);

const IMPERATIVE = 'merge|deploy|send|give|share|tell|say|show|push|delete|remove|restart|run|start|open|create|fix|add|update|check|wait|hold|continue|proceed|whether|if|release|ship|rebase|post|paste|report|let me know';
const INFO_VERB = /\b(?:send|give|share|tell|show|paste|what(?:'s| is| are)|where(?:'s| is| are)|which)\b/i;
const INFO_NOUN = /\b(?:path|paths|file|files|dir|directory|folder|location|url|link|branch|commit|sha|id)\b/i;

const strip = (p) => p.replace(/^\s*(?:\(?[a-z0-9]\)|\d+[.)])\s*/i, '').replace(/^[\s,;:]*(?:and|plus)\s+/i, '').replace(/[\s,;:]+(?:and|plus)?[\s,;:]*$/i, '').trim();

export function kindOf(text) {
  if ((INFO_VERB.test(text) && INFO_NOUN.test(text)) || /\bpath (?:of|to|for)\b/i.test(text)) return 'info';
  if (mergeMatch(text)) return 'merge';
  return 'other';
}

// A part that asks for something; a plain statement (a status line that rode along in the question) is neither answered nor open.
export const isAsk = (text) => /\?|\b(?:should|shall|may|can|could|would|want|whether|please|tell|send|say|give|share|decide|choose|pick|which|ok to|okay to)\b|\bdo you\b|\blet me know\b/i.test(text) || new RegExp(String.raw`^(?:${IMPERATIVE})\b`, 'i').test(text);

export function splitAsk(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  // "(a)", "(b)", "1)", "2)" markers and semicolons cut first, then " and " / " plus " before an imperative or a clause opener.
  let chunks = t.split(/(?<=[.!?])\s+(?=[A-Z(])|(?=\s\(?[a-z]\)\s)|(?=\s\d+\)\s)|;\s*/i);
  const joiner = new RegExp(String.raw`,?\s+(?:and|plus)\s+(?=(?:please\s+)?(?:${IMPERATIVE})\b)`, 'i');
  chunks = chunks.flatMap((c) => c.split(joiner));
  return chunks.map(strip).filter(Boolean).map((p) => ({ text: p, kind: kindOf(p) }));
}

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'in', 'on', 'at', 'and', 'or', 'me', 'my', 'our', 'your', 'its', 'it', 'is', 'are', 'was', 'be', 'you', 'we', 'i', 'please', 'also', 'now', 'then', 'with', 'from', 'this', 'that', 'there', 'here', 'what', 'where', 'which', 'row', 'send', 'give', 'share', 'tell', 'show', 'paste', 'path', 'paths', 'file', 'files', 'dir', 'directory', 'folder', 'location', 'url', 'link', 'sha', 'id', 'commit', 'name', 'can', 'could', 'would', 'should', 'need', 'know', 'let']);
// Filesystem paths only: absolute / home-relative, or repo-relative. A URL, query, assignment, anchor or address is not a path.
const PATH_RE = /~?\/[\w.@-]+(?:\/[\w.@-]+)+|[\w.-]+\/[\w./-]+/g;
const NOT_PATH = /:\/\/|[?=#@]/;
// A line that mentions anything credential-like is never read from, whatever else is on it.
const SENSITIVE_LINE = /token|secret|ntfy|topic|vapid|password|apikey|api_key/i;
const unsafeLine = (l) => SENSITIVE_LINE.test(l) || SECRET_PATTERNS.some((re) => re.test(l)) || !!hardMatch(l, { mergePresent: true });
const trimTok = (s) => s.replace(/[.,;:)\]'"]+$/, '');

// key terms: each is a list of alternative spellings; a line must hold one alternative of every term.
function termTiers(part) {
  const words = (part.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*/g) || []).map((w) => w.replace(/[.-]+$/, ''));
  // everything after a trailing " for|on|in <clause>" that follows the subject is a qualifier (row b, host x)
  const clauseAt = words.findIndex((w, i) => i > 1 && ['for', 'on', 'in'].includes(w) && words.slice(0, i).some((x) => !STOP.has(x) && x.length > 1));
  const build = (ws) => {
    const terms = [];
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (STOP.has(w)) continue;
      if (/^[a-z]+$/.test(w) && /^\d+$/.test(ws[i + 1] || '')) { const n = ws[i + 1]; terms.push([`${w} ${n}`, `${w}${n}`, `${w}_${n}`, `${w}-${n}`]); i++; continue; }
      if (w.length < 2 || /^\d+$/.test(w)) continue;
      terms.push([w]);
    }
    return terms;
  };
  const tiers = [build(words)];
  if (clauseAt > 0) tiers.push(build(words.slice(0, clauseAt)));
  return tiers.filter((t) => t.length).filter((t, i, a) => a.findIndex((u) => JSON.stringify(u) === JSON.stringify(t)) === i);
}

const lineHas = (line, terms) => { const l = line.toLowerCase(); return terms.every((alts) => alts.some((a) => l.includes(a))); };

async function grepRoot(root, needles) {
  const hits = [];
  const args = ['-c', 'core.fsmonitor=false', '-C', root, 'grep', '-n', '-I', '-i', '-F', ...needles.flatMap((n) => ['-e', n]), '--', '*.md'];
  let out = null, notRepo = false;
  try { out = (await execFileP('git', args, { encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } })).stdout; }
  catch (e) { if (e.code === 1) return hits; if (e.code === 128) notRepo = true; else if (e.stdout) out = String(e.stdout); else return hits; }
  if (!notRepo) {
    for (const l of out.split('\n')) { const m = /^([^:]+):(\d+):(.*)$/.exec(l); if (m) hits.push({ file: m[1], line: Number(m[2]), text: m[3] }); }
    return hits;
  }
  // not a git repo: bounded walk of *.md (depth 2, 200 files, 256 KB each)
  const files = [];
  const walk = (dir, depth) => {
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (files.length >= 200) return;
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 2 && !e.name.startsWith('.')) walk(p, depth + 1);
      else if (e.isFile() && /\.md$/i.test(e.name)) files.push(p);
    }
  };
  walk(root, 0);
  for (const f of files) {
    let txt; try { if (statSync(f).size > 256 * 1024) continue; txt = readFileSync(f, 'utf8'); } catch { continue; }
    const rows = txt.split('\n');
    for (let i = 0; i < rows.length; i++) if (needles.some((n) => rows[i].toLowerCase().includes(n))) hits.push({ file: relative(root, f), line: i + 1, text: rows[i] });
  }
  return hits;
}

// -> { answer, source } or null. Answers only when exactly one distinct path-like token sits on lines that hold every key term.
export async function lookupInfo(part, { roots = [] } = {}) {
  const text = typeof part === 'string' ? part : part?.text;
  if (!text) return null;
  const tiers = termTiers(text);
  if (!tiers.length) return null;
  for (const terms of tiers) {
    const rarest = terms.slice().sort((a, b) => b[0].length - a[0].length)[0];
    const found = new Map();   // token -> source
    for (const root of roots) {
      if (!root || !existsSync(root)) continue;
      try {
        for (const hit of await grepRoot(root, rarest)) {
          if (!lineHas(hit.text, terms) || unsafeLine(hit.text)) continue;
          for (const mt of hit.text.matchAll(PATH_RE)) {
            if (/[:/\w@.=?#-]/.test(hit.text[mt.index - 1] || '') && !/^~/.test(mt[0]) && mt.index > 0 && hit.text[mt.index - 1] !== '(' ) continue;   // the tail of a URL or address, not a path of its own
            if (/[?=#@]/.test(hit.text[mt.index + mt[0].length] || '')) continue;   // a query, assignment or anchor follows
            const tok = trimTok(mt[0]);
            if (!/^[~/]/.test(tok) && /^[\w-]+(?:\.[\w-]+)+$/.test(tok.split('/')[0]) && !existsSync(join(root, tok))) continue;   // a host name, not a directory of the repo
            if (NOT_PATH.test(tok) || !/[a-z]/i.test(tok) || /^(?:and|or|yes|no)\/(?:or|no|yes)$/i.test(tok)) continue;
            if (!found.has(tok)) found.set(tok, `${hit.file}:${hit.line}`);
          }
        }
      } catch { /* a root that cannot be read is skipped */ }
    }
    // a relative token that is the tail of an absolute one is the same path
    const toks = [...found.keys()];
    const distinct = toks.filter((a) => !toks.some((b) => b !== a && b.endsWith('/' + a)));
    if (distinct.length === 1) {
      const answer = distinct[0];
      if (hardMatch(answer, { mergePresent: true }) || hardMatch(found.get(answer), { mergePresent: true })) return null;
      return { answer, source: found.get(answer) };
    }
    if (distinct.length > 1) return null;   // ambiguous: a looser tier would only add noise
  }
  return null;
}

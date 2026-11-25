// Proof by risk (owner 2026-11-25): a `STATUS: done` on a fix or feature that touches the web UI needs a real headless-browser check on the
// DEPLOYED site (playwright / headless mention + a screenshot file taken after the deploy + a URL on the deployed host). A cosmetic change
// (wording, layout, CSS, docs) needs no e2e. Pure: done-check.js (P) does the sending; mode: manager.json `proofRisk` live (default) | dry | off.
//   integrations: [{ id, repo, files, patch?, deployedAt?, mergedAt? }] (integration-lane.js mergedFor); patch = `git diff -U0` of the frontend files.
import { statSync } from 'node:fs';

const FRONTEND_RE = /(^|\/)(?:frontend|public|web|ui|client|webapp)\/.*\.(?:tsx|ts|jsx|js|mjs|vue|svelte|css|scss|html)$/i;
const TEST_RE = /(^|\/)(?:__tests__|tests?|e2e|spec)\/|\.(?:test|spec)\.[jt]sx?$|\.d\.ts$/i;
const DOC_RE = /(^|\/)docs\/|\.md$|(^|\/)(?:skills?|\.claude)\/|^VERSION\.txt$|(^|\/)package-lock\.json$|(^|\/)release_note\//i;
export const isFrontendFile = (f) => FRONTEND_RE.test(f) && !TEST_RE.test(f);
const isDocFile = (f) => DOC_RE.test(f) || TEST_RE.test(f);

const STYLE_KEYS = 'color|background|bgcolor|padding|margin|font\\w*|border\\w*|width|height|display|flex\\w*|gap|align\\w*|justify\\w*|opacity|radius|shadow|position|top|left|right|bottom|overflow\\w*|z-?index|text\\w*|line\\w*|letter\\w*|transition|cursor|min\\w*|max\\w*|grid\\w*|transform|fill|stroke|p[xytblr]?|m[xytblr]?';
const COSMETIC_LINE = [
  /^\s*$/, /^\s*(?:\/\/|\/\*|\*\/?|\{\s*\/\*)/,                                   // blank, comments
  new RegExp(`^\\s*['"]?(?:${STYLE_KEYS})['"]?\\s*:\\s*[^()]*?(?:\\([^)]*\\))?[^()]*,?\\s*$`, 'i'),  // style key: value
  /^\s*sx=\{\{.*\}\}\s*>?\s*$/, /^\s*(?:sx|style)=\{\{\s*$/, /^\s*\}\}\s*\/?>?\s*$/, /^\s*[}\])]+[,;]?\s*$/,
  /^\s*(['"`])[^'"`]*\1,?\s*$/,                                                    // a bare string literal
  /^\s*[^<>{}=;()]*[A-Za-z][^<>{}=;()]*$/,                                         // JSX text line
  /^\s*<[A-Za-z][\w.]*(?:\s+(?:(?:label|title|placeholder|alt|aria-label|helperText|variant|color|size|className|sx|style|id)=(?:"[^"]*"|'[^']*'|\{\{[^{}]*\}\}|\{['"`][^'"`]*['"`]\}))*\s*)\/?>?\s*$/,
  /^\s*<\/?[A-Za-z][\w.]*>[^<>{}=;()]*(?:<\/[A-Za-z][\w.]*>)?\s*$/,               // <Typography>Text</Typography>
  /^\s*(?:[\w-]+=(?:"[^"]*"|'[^']*')\s*)+\/?>?\s*$/,                                  // string props only (label="Save")
  /^\s*(?:label|title|placeholder|alt|helperText|description|tooltip|text|name)\s*:\s*(['"`])[^'"`]*\1,?\s*$/,
];
const LOGIC_RE = /=>|\bfunction\b|\b(?:if|else|switch|case|return|await|async|throw|try|catch|for|while)\b|\buse[A-Z]\w*\(|\.(?:map|filter|reduce|forEach|then|find|some)\(|\bfetch\(|\bon[A-Z]\w*=|&&|\|\||\?\?|\bset[A-Z]\w*\(|\b(?:const|let|var)\s+\w+\s*=\s*[^'"`\s{]|\$\{|\bnew\s+\w|\b\w+\(.*\)\s*[;{]\s*$/;
const isCssFile = (f) => /\.(?:css|scss)$/i.test(f);

// patch: unified diff text (-U0). -> { logic: [lines], total }
export function logicLinesOf(patch) {
  let file = '', logic = [], total = 0;
  for (const raw of String(patch || '').split('\n')) {
    const h = /^\+\+\+ (?:b\/)?(.+)$/.exec(raw);
    if (h) { file = h[1]; continue; }
    if (/^(?:diff |index |--- |@@|\\)/.test(raw) || !/^[+-]/.test(raw)) continue;
    const line = raw.slice(1); total++;
    if (isCssFile(file)) continue;
    if (/^\s*import\s/.test(line)) { logic.push(`${file}: ${line.trim().slice(0, 80)}`); continue; }
    if (COSMETIC_LINE.some((re) => re.test(line)) && !LOGIC_RE.test(line)) continue;
    logic.push(`${file}: ${line.trim().slice(0, 80)}`);
  }
  return { logic, total };
}

export const declaredRiskOf = (text) => { const m = /\brisk\s*[:=]\s*[`*_]*(cosmetic|fix|feature)\b/i.exec(String(text || '')); return m ? m[1].toLowerCase() : null; };

// -> { applies, risk: 'cosmetic'|'fix'|'feature'|null, declared, reason }. applies = the change touches web UI files.
export function classifyRisk({ files = [], patch = null, text = '' } = {}) {
  const front = files.filter(isFrontendFile);
  const declared = declaredRiskOf(text);
  if (!front.length) return { applies: false, risk: null, declared, reason: 'no web UI file' };
  const otherCode = files.filter((f) => !isFrontendFile(f) && !isDocFile(f));
  let risk, reason;
  if (otherCode.length) { risk = 'fix'; reason = `non-UI code changed (${otherCode.slice(0, 3).join(', ')})`; }
  else if (patch == null) { risk = 'fix'; reason = 'diff content unavailable, treated as logic'; }
  else {
    const { logic } = logicLinesOf(patch);
    if (logic.length) { risk = 'fix'; reason = `logic lines in the diff (${logic.slice(0, 2).join(' | ')})`; }
    else { risk = 'cosmetic'; reason = 'only strings, JSX text, styles, CSS, docs'; }
  }
  if (risk === 'fix' && declared === 'feature') risk = 'feature';      // the diff wins over a cosmetic claim; fix / feature are both strict
  if (risk === 'cosmetic' && (declared === 'fix' || declared === 'feature')) { risk = declared; reason = `declared ${declared}`; }
  return { applies: true, risk, declared, reason };
}

const LOCAL_HOST_RE = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)$/i;
export const LOCAL_PREVIEW_RE = /\b(?:local(?:-|\s)?(?:worktree\s+)?preview|worktree preview|vite dev|preview (?:on|in) (?:a |the )?(?:local )?worktree)\b/i;
export function deployedUrlsOf(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s`'"<>)\]]+/gi)) {
    try { const u = new URL(m[0]); if (LOCAL_HOST_RE.test(u.hostname) || /^51(?:7\d|8\d)$/.test(u.port)) continue; out.push(m[0]); } catch {}
  }
  return out;
}
export const screenshotPathsOf = (text) => [...new Set([...String(text || '').matchAll(/(?<![\w:/.-])(?:~\/|\/|\.\/)?[\w@%+.,=\-/~]+\.(?:png|jpe?g|webp)\b/gi)].map((m) => m[0]))];
const HEADLESS_RE = /\b(?:playwright|headless|chromium|vpt-headless-verify)\b/i;

// Pure (the file stat is injected). -> null when nothing is owed, else { risk, reason, missing: [...] , sinceMs }
export function proofGapOf(text, integrations, { goal = '', statMtime = (p) => { try { return statSync(p).mtimeMs; } catch { return null; } }, home = '' } = {}) {
  const ints = (integrations || []).filter((i) => i && Array.isArray(i.files));
  if (!ints.length) return null;
  const files = [...new Set(ints.flatMap((i) => i.files))];
  const patch = ints.every((i) => typeof i.patch === 'string') ? ints.map((i) => i.patch).join('\n') : null;
  const c = classifyRisk({ files, patch, text });
  if (!c.applies || c.risk === 'cosmetic') return null;
  const uiInts = ints.filter((i) => i.files.some(isFrontendFile));
  const since = Math.max(...uiInts.map((i) => Date.parse(i.deployedAt || i.mergedAt || '') || 0));
  const localOk = LOCAL_PREVIEW_RE.test(goal);
  const missing = [];
  if (!HEADLESS_RE.test(text)) missing.push('a headless run (playwright / headless, skill vpt-headless-verify)');
  const shots = screenshotPathsOf(text).map((p) => ({ p, m: statMtime(p.replace(/^~\//, `${home || ''}/`)) }));
  const existing = shots.filter((s) => s.m != null);
  if (!existing.length) missing.push(shots.length ? `a screenshot file that exists (${shots[0].p} was not found)` : 'a screenshot file path');
  else if (since && !existing.some((s) => s.m > since)) missing.push(`a screenshot taken after the deploy (${existing[0].p} is older than the deploy at ${new Date(since).toISOString()})`);
  if (!localOk && !deployedUrlsOf(text).length) missing.push('the URL on the deployed host you tested (not localhost or a vite dev port)');
  return missing.length ? { risk: c.risk, reason: c.reason, missing, sinceMs: since || null } : null;
}

export function proofGapMessage(g) {
  return `Done check: your STATUS: done line is a ${g.risk} on the web UI (${g.reason}) with no browser proof on the deployed site: it lacks ${g.missing.join('; ')}. `
    + 'Run the e2e yourself on the deployed URL with vpt-headless-verify (headless Playwright, after the deploy finished), quote the screenshot path and the URL in the closing text, then rewrite the done line. '
    + 'A change that is only wording, layout, CSS or docs needs none: say `risk: cosmetic` only if the diff really is.';
}

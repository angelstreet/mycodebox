// Pure helpers for the dashboard "New session" dialog (owner 2026-11-12: two clicks, model picker, prompt box, no tmp projects).
import { sep } from 'node:path';

// A project the picker offers: a repo or worktree under $HOME, not a throwaway one. Test fixtures (~/tmp-tests/...), scratchpads
// (/tmp/...), lane worktrees (~/.local/state/...) and anything else in a hidden or tmp* folder are left out.
export function pickableProject(path, home) {
  const p = String(path || '');
  if (!home || p === home) return false;
  if (!p.startsWith(home + sep)) return false;
  return !p.slice(home.length + 1).split(sep).some((s) => s.startsWith('.') || /^te?mp(?:$|[-_.])/i.test(s));
}

const MODEL_RE = /^[\w.\-[\]/]{1,64}$/;
export const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
export const MINIMAX_MODELS = ['MiniMax-M3'];
// Preselected until the owner picks another one (owner 2026-11-12); at most 4 models per provider.
export const DEFAULT_MODELS = { claude: 'sonnet', codex: 'gpt-6.1-sol', minimax: 'MiniMax-M3' };
export const MAX_MODELS = 4;
const CODEX_VERIFIED_MODELS = ['gpt-6.1-sol'];
const LEGACY_CODEX_MODEL_RE = /^gpt-6(?:-(?:luna|sol|astra)|\.2-(?:sol|astra))$/;

// Codex models as the CLI lists them (~/.codex/models_cache.json, visibility "list"), the configured default first.
export function codexModels(cache, configToml = '') {
  const list = [...CODEX_VERIFIED_MODELS, ...(Array.isArray(cache) ? cache : cache?.models || [])
    .filter((m) => m && (m.visibility == null || m.visibility === 'list'))
    .map((m) => m.slug || m.id).filter((s) => typeof s === 'string' && MODEL_RE.test(s) && !LEGACY_CODEX_MODEL_RE.test(s))];
  const conf = /^\s*model\s*=\s*"([^"]+)"/m.exec(configToml)?.[1];
  const def = list.includes(DEFAULT_MODELS.codex) ? DEFAULT_MODELS.codex : (conf && MODEL_RE.test(conf) ? conf : list[0]);
  const out = [...new Set([...(def ? [def] : []), ...list])].slice(0, MAX_MODELS);
  return { models: out, default: out[0] || null };
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The agent command line with the chosen model and, when given, the first prompt read from a file (so no quoting of the text
// itself reaches the shell). An invalid model is refused rather than dropped.
// Mac sessions report the basename of their git toplevel; for a Claude worktree (<repo>/.claude/worktrees/<name>) that is the
// worktree's name, which made a sidebar group per task. The repo folder is the project.
export function projectFromCwd(cwd) {
  const m = /^(.*?)\/\.claude\/worktrees\/[^/]+/.exec(String(cwd || ''));
  return m ? m[1].split('/').filter(Boolean).pop() || null : null;
}

export function launchArgs(agent, { model, promptFile } = {}) {
  if (model != null && model !== '' && !MODEL_RE.test(model)) throw Object.assign(new Error('invalid model'), { status: 400 });
  let extra = '';
  if (model) {
    if (agent === 'claude') extra += ` --model ${q(model)}`;
    else if (agent === 'codex') extra += ` -m ${q(model)}`;
    else if (agent === 'minimax') extra += ` -m ${q(model.includes('/') ? model : `minimax/${model}`)}`;
  }
  if (promptFile && agent !== 'bash') extra += ` "$(cat ${q(promptFile)})"`;
  return extra;
}

// A session name from the first prompt (owner 2026-11-23: leave the name empty and the prompt names the session, as Claude does).
// aiNamePrompt is the one-shot question for a small model; cleanAiName keeps only a usable first line of its answer (a hook may
// append more lines); nameFromWords is the offline fallback: the first meaningful words, kebab-case.
const STOP = new Set('a an the and or but of to in on at for with from by is are was be been it its this that these those i we you me my our can could should would will need needs want wants please make makes so then than as if not no do does did have has had just also into about over under new add use using get set let lets how what when where which who why there their them they he she his her one some any each every more most very much many'.split(' '));
export const NAME_MAX = 28;
export const aiNamePrompt = (prompt) => `Give a short name for a coding session that will work on the request between the markers. Do NOT do the request. Reply with ONLY a lowercase kebab-case name of 2 to 4 words, max ${NAME_MAX} characters.\n<request>\n${String(prompt || '').slice(0, 1500)}\n</request>`;
const kebab = (words) => { let out = ''; for (const w of words) { const n = out ? `${out}-${w}` : w; if (n.length > NAME_MAX) break; out = n; } return out; };
export function cleanAiName(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const s = line.replace(/^["'`*#\s]+|["'`*.\s]+$/g, '').toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+){0,5}$/.test(s) || s.length < 3 || s.length > 40) return '';   // a sentence or a refusal is not a name
  return kebab(s.split('-')) ;
}
export function nameFromWords(prompt) {
  const words = String(prompt || '').replace(/@\S+/g, ' ').replace(/https?:\/\/\S+/g, ' ').toLowerCase().match(/[a-z][a-z0-9]{2,}(?:-[a-z0-9]+)*/g) || [];
  const keep = [];
  for (const w of words) { if (!STOP.has(w) && !keep.includes(w)) keep.push(w); if (keep.length === 4) break; }
  return kebab(keep);
}

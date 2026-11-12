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

// Codex models as the CLI lists them (~/.codex/models_cache.json, visibility "list"), the configured default first.
export function codexModels(cache, configToml = '') {
  const list = (Array.isArray(cache) ? cache : cache?.models || [])
    .filter((m) => m && (m.visibility == null || m.visibility === 'list'))
    .map((m) => m.slug || m.id).filter((s) => typeof s === 'string' && MODEL_RE.test(s));
  const def = /^\s*model\s*=\s*"([^"]+)"/m.exec(configToml)?.[1];
  const out = [...new Set([...(def && MODEL_RE.test(def) ? [def] : []), ...list])];
  return { models: out, default: out[0] || null };
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The agent command line with the chosen model and, when given, the first prompt read from a file (so no quoting of the text
// itself reaches the shell). An invalid model is refused rather than dropped.
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

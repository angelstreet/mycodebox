// OpenRouter model allowlist (owner, 2026-10-27): only o4 Mini, Qwen3 VL 8B Instruct and Jev may reach OpenRouter.
// One list (openrouter-allowlist.json), one check: call checkOpenRouterModel(model) before any request that names a model.
// A rejection throws before any network call, logs one line and is counted (rejectedCounts()).
import { readFileSync } from 'node:fs';

const LIST_URL = new URL('./openrouter-allowlist.json', import.meta.url);
const rejected = new Map();

export class OpenRouterModelNotAllowed extends Error {
  constructor(model, allowed) {
    super(`model '${model}' is not allowed on OpenRouter (allowed: ${allowed.join(', ')}); Claude and MiniMax use their subscriptions`);
    this.name = 'OpenRouterModelNotAllowed';
    this.model = model;
  }
}

export function allowedModels(env = process.env) {
  const path = env.OPENROUTER_ALLOWLIST_FILE ? env.OPENROUTER_ALLOWLIST_FILE : LIST_URL;
  return (JSON.parse(readFileSync(path, 'utf8')).models || []).map((m) => String(m).trim().toLowerCase());
}

const globToRe = (g) => new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

export function isAllowedOpenRouterModel(model, env = process.env) {
  const m = String(model ?? '').trim().toLowerCase();
  return m !== '' && allowedModels(env).some((g) => globToRe(g).test(m));
}

export function checkOpenRouterModel(model, { where = '', env = process.env, log = console.error } = {}) {
  if (isAllowedOpenRouterModel(model, env)) return;
  const key = String(model ?? '').trim().toLowerCase() || '<empty>';
  rejected.set(key, (rejected.get(key) || 0) + 1);
  log(`openrouter-guard: rejected model '${model}'${where ? ` at ${where}` : ''}`);
  throw new OpenRouterModelNotAllowed(model, allowedModels(env));
}

export const rejectedCounts = () => Object.fromEntries(rejected);
export const resetRejected = () => rejected.clear();

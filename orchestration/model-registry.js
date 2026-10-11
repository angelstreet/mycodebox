// Versioned model registry (ARCHITECTURE §8). Static entries come from models.json; adapter probes override or
// limit them (withProbes). Prices are resolved from usage/prices.json via priceFor: a PLACEHOLDER or missing row is
// unknown (null), never $0. Pure: fs is injected, nothing here starts timers or processes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { priceFor } from '../usage/ingest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REGISTRY_SCHEMA_VERSION = 1;
export const TIERS = ['light', 'standard', 'strong'];
export const CAPABILITIES = ['text', 'code', 'vision', 'tools', 'long_context', 'json_output', 'resume', 'cancel', 'native_subagents'];
// Effort values are per runtime and never translated: an unsupported value is rejected, not mapped to a neighbour.
export const RUNTIME_EFFORTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  opencode: ['low', 'medium', 'high'],
  minimax: [],
  fake: ['low', 'medium', 'high', 'xhigh'],
};
// Probe `features` keys that map onto registry capabilities.
const FEATURE_CAPS = { vision: 'vision', resume: 'resume', cancel: 'cancel', json_output: 'json_output', native_subagents: 'native_subagents' };
const DEFAULT_MAX_PRICE_AGE_DAYS = 90;

export const entryId = (e) => `${e.runtime}:${e.model}`;

export function validateRegistryDoc(doc) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });
  if (!doc || typeof doc !== 'object') return { ok: false, errors: [{ path: '', message: 'registry must be an object' }] };
  if (doc.version !== REGISTRY_SCHEMA_VERSION) err('version', `unsupported registry version ${JSON.stringify(doc.version)}`);
  if (!Array.isArray(doc.models) || !doc.models.length) err('models', 'models must be a non-empty array');
  const seen = new Set();
  (Array.isArray(doc.models) ? doc.models : []).forEach((m, i) => {
    const p = `models[${i}]`;
    if (!m || typeof m !== 'object') return err(p, 'entry must be an object');
    for (const k of ['runtime', 'provider', 'model']) if (typeof m[k] !== 'string' || !m[k]) err(`${p}.${k}`, 'required string');
    if (!RUNTIME_EFFORTS[m.runtime]) { err(`${p}.runtime`, `unknown runtime ${JSON.stringify(m.runtime)}`); return; }
    const id = entryId(m);
    if (seen.has(id)) err(p, `duplicate entry ${id}`);
    seen.add(id);
    if (!TIERS.includes(m.tier)) err(`${p}.tier`, `tier must be one of ${TIERS.join('|')}`);
    if (!Array.isArray(m.capabilities)) err(`${p}.capabilities`, 'capabilities must be an array');
    else for (const c of m.capabilities) if (!CAPABILITIES.includes(c)) err(`${p}.capabilities`, `unknown capability ${JSON.stringify(c)}`);
    if (!Array.isArray(m.efforts)) err(`${p}.efforts`, 'efforts must be an array');
    else for (const e of m.efforts) if (!RUNTIME_EFFORTS[m.runtime].includes(e)) err(`${p}.efforts`, `effort ${JSON.stringify(e)} is not supported by runtime ${m.runtime}`);
    if (m.context_tokens != null && !(Number.isInteger(m.context_tokens) && m.context_tokens > 0)) err(`${p}.context_tokens`, 'positive integer or null (unknown)');
    if (m.price != null && !(m.price && Number.isFinite(m.price.input) && Number.isFinite(m.price.output) && m.price.input >= 0 && m.price.output >= 0)) err(`${p}.price`, 'price must be {input,output} (non-negative) or null');
  });
  return { ok: !errors.length, errors };
}

// price: explicit entry price wins; otherwise resolve from the price table. null = unknown.
function resolvePrice(m, prices) {
  // A non-positive price is unknown unless the entry is explicitly flagged free: a $0 row is usually a placeholder.
  const ok = (p) => p && Number.isFinite(p.input) && Number.isFinite(p.output) && (m.free === true || (p.input > 0 && p.output > 0));
  if (m.price) return ok(m.price) ? { price: { input: m.price.input, output: m.price.output }, price_as_of: m.price_as_of || null } : { price: null, price_as_of: null };
  const row = prices ? priceFor(prices, m.price_model || m.model) : null;
  return ok(row) ? { price: { input: row.input, output: row.output }, price_as_of: row.as_of || prices.as_of || null } : { price: null, price_as_of: null };
}

function build(doc, prices) {
  const entries = doc.models.map((m) => ({
    id: entryId(m), runtime: m.runtime, provider: m.provider, model: m.model, tier: m.tier,
    capabilities: [...m.capabilities], efforts: [...m.efforts],
    context_tokens: m.context_tokens ?? null, latency_ms: m.latency_ms ?? null,
    ...resolvePrice(m, prices), source: m.source || 'static', test_only: !!m.test_only, free: m.free === true,
    availability: 'unknown', routable: true, unroutable_reason: null,
  }));
  return makeRegistry({ version: doc.version, as_of: doc.as_of || null, entries });
}

function makeRegistry({ version, as_of, entries }) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return Object.freeze({
    version, as_of,
    entries: () => entries.map((e) => ({ ...e, capabilities: [...e.capabilities], efforts: [...e.efforts] })),
    get: (id) => byId.get(id) || null,
    // Probe merge: result of adapter.probeCapabilities() per runtime id. Returns a NEW registry.
    withProbes(probes = {}) {
      const next = entries.map((e) => applyProbe(e, probes[e.runtime]));
      return makeRegistry({ version, as_of, entries: next });
    },
  });
}

function applyProbe(e, probe) {
  if (!probe || typeof probe !== 'object') return e;           // no probe: static claim, availability stays unknown
  const out = { ...e, capabilities: [...e.capabilities], efforts: [...e.efforts], source: 'probe' };
  out.availability = probe.available === true ? 'available' : probe.available === false ? 'unavailable' : 'unknown';
  if (probe.available === false) { out.routable = false; out.unroutable_reason = `runtime ${e.runtime} unavailable (probe)`; return out; }
  if (Array.isArray(probe.models) && probe.models.length && !probe.models.includes(e.model)) {
    out.routable = false; out.unroutable_reason = `model ${e.model} not reported by ${e.runtime} probe`; return out;
  }
  // The probe can only narrow efforts: never trust a static claim the CLI does not report.
  if (Array.isArray(probe.efforts) && probe.efforts.length) out.efforts = out.efforts.filter((x) => probe.efforts.includes(x));
  const f = probe.features && typeof probe.features === 'object' ? probe.features : {};
  for (const [feat, cap] of Object.entries(FEATURE_CAPS)) {
    if (f[feat] === false) out.capabilities = out.capabilities.filter((c) => c !== cap);
    else if (f[feat] === true && !out.capabilities.includes(cap)) out.capabilities.push(cap);   // discovered
  }
  return out;
}

export function createRegistry(doc, { prices = null, now = Date.now } = {}) {
  const v = validateRegistryDoc(doc);
  if (!v.ok) { const e = new Error(`invalid model registry: ${v.errors.map((x) => `${x.path}: ${x.message}`).join('; ')}`); e.code = 'E_REGISTRY_INVALID'; e.errors = v.errors; throw e; }
  void now;
  return build(doc, prices);
}

export function loadRegistry({ file = join(HERE, 'models.json'), pricesFile = join(HERE, '..', 'usage', 'prices.json'), fs = { readFileSync }, now } = {}) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  let prices = null;
  try { prices = JSON.parse(fs.readFileSync(pricesFile, 'utf8')); } catch { /* no table: every price unknown */ }
  return createRegistry(doc, { prices, now });
}

// Reject, never translate: returns { ok } or { ok:false, reason }. effort null/undefined = no request.
export function checkEffort(entry, effort) {
  if (effort == null) return { ok: true };
  if (!(RUNTIME_EFFORTS[entry.runtime] || []).includes(effort)) return { ok: false, reason: `effort "${effort}" is not a ${entry.runtime} effort value (${(RUNTIME_EFFORTS[entry.runtime] || []).join('|') || 'none'})` };
  if (!entry.efforts.includes(effort)) return { ok: false, reason: `effort "${effort}" unsupported by ${entry.id} (supports: ${entry.efforts.join('|') || 'none'})` };
  return { ok: true };
}

// Price age: stale or undated prices are not trusted for ranking (they are never reported as $0 either).
export function priceStatus(entry, { now = Date.now(), maxAgeDays = DEFAULT_MAX_PRICE_AGE_DAYS } = {}) {
  if (!entry.price) return 'unknown';
  const t = entry.price_as_of ? Date.parse(entry.price_as_of) : NaN;
  if (!Number.isFinite(t)) return 'stale';
  const ageDays = (now - t) / 86400000;
  return ageDays > maxAgeDays || ageDays < -1 ? 'stale' : 'fresh';   // a future date (> 1 day skew) is not trusted either
}

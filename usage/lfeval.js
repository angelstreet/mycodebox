// Langfuse evaluation sync (TASK-44 phase 12): the owner's labels and verdicts in stalls.jsonl become Langfuse
// scores on the stop's generations, and the labelled stops become the dataset `ghosty-stops`.
//
//   scores   stop_verdict (categorical legit|no_reason), stop_case_correct (boolean), ai_proposal_correct (boolean),
//            jev_agreed (boolean: the owner's reply vs Jev's pick). Attached to the stop's manager.jev / manager.ai-review
//            generation(s); a stop with neither gets a lightweight `manager.stop` span (metadata only, NO closing text).
//   dataset  one item per labelled stop: input {closing_text, case_by_rules, agent, state}, expected_output
//            {verdict, correct_case?, owner_reply_kind?}. An unlabel archives the item and deletes the stop's scores.
//
// Declarative: every pass derives the full desired state from the log, hashes each score / item / span, and sends only
// what differs from lfeval-state.json. Ids are deterministic, so a replay or a lost state file only re-sends (Langfuse upserts).
// The pass is skipped unless stalls.jsonl grew AND the new lines hold a label, unlabel, outcome or triage record.
//
//   node usage/lfeval.js [--stalls file] [--state file] [--dataset name] [--force]   one pass (backfill = first pass)
//   node usage/lfeval.js --seed-prompt                                               create ghosty-ai-reviewer v1 when absent
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { effectiveLabels, effectiveAiVerdicts, outcomeFromReplyKind } from '../decisions.js';
import { hash, traceIdOf, genIdOf, lfRequest, postBatch } from './lf-common.js';
import { parseManagerLine } from './manager-parse.js';

export const DATASET = 'ghosty-stops';
const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// Pure: the log -> desired Langfuse state
// ---------------------------------------------------------------------------

export const scoreIdOf = (name, stopId, target) => hash(`score:${name}:${stopId}:${target}`).slice(0, 32);
export const stopObsIdOf = (stopId) => genIdOf(`manager:stop:${stopId}`);

export function indexStops(recs) {
  const by = new Map();
  const at = (id) => { let s = by.get(id); if (!s) by.set(id, s = { id, stall: null, triage: null, outcome: null }); return s; };
  for (const r of recs) {
    if (!r || !r.id) continue;
    if (r.type === 'stall') at(r.id).stall = r;
    else if (r.type === 'triage') at(r.id).triage = r;
    else if (r.type === 'outcome') at(r.id).outcome = r;
  }
  return by;
}

// The observations of a stop that exist in Langfuse (the tailer sends them for the last `windowDays` days).
function observationsOf(stop, now, windowDays) {
  const since = now - windowDays * DAY_MS;
  const out = [];
  const jev = stop.stall && parseManagerLine(stop.stall);
  if (jev && jev.ts >= since) out.push({ kind: 'jev', id: genIdOf(jev.id) });
  const ai = stop.triage && parseManagerLine(stop.triage);
  if (ai && ai.ts >= since) out.push({ kind: 'ai', id: genIdOf(ai.id) });
  return out;
}

// What the owner's reply meant, in Jev's vocabulary, or null.
const ownerPick = (outcome) => (outcome ? outcomeFromReplyKind(outcome.kind) : null);

// Scores a stop should carry: [{ name, dataType, value, comment?, metadata?, on: 'jev'|'ai'|'all' }]
export function scoresOfStop(stop, { label, aiVerdict }) {
  const out = [];
  if (label) {
    if (label.label === 'legit' || label.label === 'no_reason') out.push({ name: 'stop_verdict', dataType: 'CATEGORICAL', value: label.label, comment: label.note || undefined, on: 'all', metadata: { by: label.by || null, at: label.at || null } });
    const caseOk = label.label !== 'wrong_case' && !label.correctCase;
    out.push({ name: 'stop_case_correct', dataType: 'BOOLEAN', value: caseOk ? 1 : 0, on: 'all', metadata: { case: stop.stall?.case || null, correctCase: label.correctCase || null, by: label.by || null } });
  }
  if (aiVerdict) out.push({ name: 'ai_proposal_correct', dataType: 'BOOLEAN', value: aiVerdict === 'right' ? 1 : 0, on: 'ai', metadata: { case: stop.triage?.case || stop.stall?.case || null } });
  const pick = stop.stall?.jev?.choice, did = ownerPick(stop.outcome);
  if (pick && did) out.push({ name: 'jev_agreed', dataType: 'BOOLEAN', value: pick === did ? 1 : 0, on: 'jev', metadata: { jev: pick, owner: did, replyKind: stop.outcome.kind } });
  return out;
}

export function datasetItemOf(stop, label, { dataset = DATASET, status = 'ACTIVE' } = {}) {
  const s = stop.stall;
  const expected = { verdict: label.label, ...(label.correctCase ? { correct_case: label.correctCase } : {}), ...(stop.outcome?.kind && stop.outcome.kind !== 'unknown' ? { owner_reply_kind: stop.outcome.kind } : {}) };
  return {
    datasetName: dataset, id: stop.id, status,
    input: { closing_text: s.excerpt || s.question || '', case_by_rules: s.case, agent: s.agent || null, state: s.state || null },
    expectedOutput: expected,
    metadata: { session: s.session, stop_id: stop.id, at: s.at, source: s.source || null },
  };
}

// recs -> { scores: Map key->{ hash, event }, spans: Map key->{ hash, event, traceId, session }, items: Map key->{ hash, body }, wanted: Set(stopIds with items) }
export function desiredState(recs, { now = Date.now(), windowDays = 14, dataset = DATASET, previousItems = [] } = {}) {
  const stops = indexStops(recs);
  const labels = effectiveLabels(recs), verdicts = effectiveAiVerdicts(recs);
  const scores = new Map(), spans = new Map(), items = new Map();
  const ids = new Set([...labels.keys(), ...verdicts.keys()]);
  for (const id of stops.keys()) { const s = stops.get(id); if (s.stall?.jev?.choice && s.outcome && ownerPick(s.outcome)) ids.add(id); }
  for (const id of ids) {
    const stop = stops.get(id);
    if (!stop || !stop.stall) continue;   // a label on a stop whose stall line is gone: nothing to attach to
    const label = labels.get(id) || null, aiVerdict = verdicts.get(id) || null;
    const trace = traceIdOf('manager', stop.stall.session);
    const obs = observationsOf(stop, now, windowDays);
    const sc = scoresOfStop(stop, { label, aiVerdict });
    if (!sc.length) continue;
    const need = (x) => x.on === 'all' ? obs : obs.filter((o) => o.kind === x.on);
    let needSpan = false;
    for (const x of sc) {
      let targets = need(x);
      if (!targets.length) { targets = [{ kind: 'stop', id: stopObsIdOf(id) }]; needSpan = true; }
      for (const t of targets) {
        const sid = scoreIdOf(x.name, id, t.kind);
        const body = { id: sid, traceId: trace, observationId: t.id, name: x.name, dataType: x.dataType, value: x.value, ...(x.comment ? { comment: x.comment } : {}), metadata: { ...x.metadata, stop_id: id, target: t.kind } };
        scores.set(`score:${sid}`, { hash: hash(JSON.stringify(body)), body, stopId: id });
      }
    }
    if (needSpan) {
      const s = stop.stall;
      const body = { id: stopObsIdOf(id), traceId: trace, name: 'manager.stop', startTime: s.at, endTime: s.at,
        metadata: { stop_id: id, case: s.case, source: s.source || null, agent: s.agent || null, session: s.session, state: s.state || null } };
      spans.set(`obs:${body.id}`, { hash: hash(JSON.stringify(body)), body, session: s.session, trace });
    }
    if (label) { const it = datasetItemOf(stop, label, { dataset }); items.set(`item:${id}`, { hash: hash(JSON.stringify(it)), body: it }); }
  }
  // a stop that had an item and is no longer labelled: archive it (the body is rebuilt from its stall)
  for (const key of previousItems) {
    if (items.has(key)) continue;
    const id = key.slice(5), stop = stops.get(id);
    if (!stop?.stall) continue;
    const lab = { label: 'unlabelled' };
    const it = datasetItemOf(stop, lab, { dataset, status: 'ARCHIVED' });
    it.expectedOutput = {};
    items.set(key, { hash: hash(JSON.stringify(it)), body: it });
  }
  return { scores, spans, items };
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

const RELEVANT = ['"type":"label"', '"type":"unlabel"', '"type":"outcome"', '"type":"triage"'];

// hooks.traceKnown(traceId) -> true when the tailer already sent that trace (saves a lookup)
export function createEvalSync(cfg, { fetchFn = fetch, log = console.log, ...hooks } = {}) {
  const opt = { fetchFn };
  const dataset = cfg.evalDataset || DATASET;
  let state = null;   // { size, sent: { key: hash }, traces: { traceId: true } }

  async function load() {
    if (state) return state;
    state = { size: 0, sent: {}, traces: {} };
    try { state = { ...state, ...JSON.parse(await fs.readFile(cfg.evalStateFile, 'utf8')) }; } catch {}
    return state;
  }
  async function save() {
    const tmp = `${cfg.evalStateFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state));
    await fs.rename(tmp, cfg.evalStateFile);
  }

  async function traceExists(id) {
    if (state.traces[id]) return true;
    try { await lfRequest(cfg, 'GET', `/api/public/traces/${id}`, undefined, opt); state.traces[id] = true; return true; } catch (e) { if (e.status === 404) return false; throw e; }
  }

  // Returns { skipped } | { scores, spans, items, deleted } (counts of what was sent this pass).
  async function sync({ force = false } = {}) {
    await load();
    let st; try { st = await fs.stat(cfg.stallsFile); } catch (e) { if (e.code === 'ENOENT') return { skipped: 'no log' }; throw e; }
    const buf = await fs.readFile(cfg.stallsFile);
    const end = buf.lastIndexOf(10) + 1;   // complete lines only
    if (!force && state.size > 0 && end >= state.size) {
      const fresh = buf.toString('utf8', state.size, end);
      if (end === state.size || !RELEVANT.some((k) => fresh.includes(k))) { state.size = end; await save(); return { skipped: 'nothing new' }; }
    }
    const recs = [];
    for (const l of buf.toString('utf8', 0, end).split('\n')) { if (!l) continue; try { recs.push(JSON.parse(l)); } catch {} }
    const prevItems = Object.keys(state.sent).filter((k) => k.startsWith('item:'));
    const want = desiredState(recs, { now: cfg.now ? cfg.now() : Date.now(), windowDays: cfg.backfillDays ?? 14, dataset, previousItems: prevItems });

    // ---- scores + spans through the ingestion API ----
    const stamp = new Date(cfg.now ? cfg.now() : Date.now()).toISOString();
    const entries = [];   // { ev, key?, hsh? }
    const queue = (key, hsh, type, body) => entries.push({ key, hsh, ev: { id: hash(`ev:${key}:${hsh}`).slice(0, 36), type, timestamp: stamp, body } });
    for (const [key, o] of want.spans) {
      if (state.sent[key] === o.hash) continue;
      if (!state.traces[o.trace] && !(hooks.traceKnown && hooks.traceKnown(o.trace)) && !(await traceExists(o.trace))) {
        // a stop whose session has no generation yet: create the trace the span and scores hang on
        entries.push({ ev: { id: hash(`ev:trace:${o.trace}`).slice(0, 36), type: 'trace-create', timestamp: stamp, body: { id: o.trace, name: `manager:${o.session}`, tags: ['agent:manager', `session:${o.session}`], sessionId: o.trace, metadata: { agent: 'manager', session: o.session } } } });
      }
      state.traces[o.trace] = true;
      queue(key, o.hash, 'span-create', o.body);
    }
    for (const [key, o] of want.scores) if (state.sent[key] !== o.hash) queue(key, o.hash, 'score-create', o.body);
    let sentScores = 0, sentSpans = 0;
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100);
      const errors = await postBatch(cfg, chunk.map((x) => x.ev), opt);
      const bad = new Map(errors.map((e) => [e.id, e]));
      for (const x of chunk) {
        if (!x.key) continue;
        if (bad.has(x.ev.id)) { log('[lfeval] rejected', x.key, JSON.stringify(bad.get(x.ev.id)).slice(0, 200)); continue; }
        state.sent[x.key] = x.hsh;
        if (x.ev.type === 'score-create') sentScores++; else sentSpans++;
      }
    }

    // ---- dataset ----
    let sentItems = 0;
    if (want.items.size && ![...want.items.values()].every((x) => state.sent[`item:${x.body.id}`] === x.hash)) {
      await lfRequest(cfg, 'POST', '/api/public/v2/datasets', { name: dataset, metadata: { purpose: 'owner-labelled ghosty manager stops' } }, opt);
    }
    for (const [key, o] of want.items) {
      if (state.sent[key] === o.hash) continue;
      await lfRequest(cfg, 'POST', '/api/public/dataset-items', o.body, opt);
      state.sent[key] = o.hash; sentItems++;
    }

    // ---- unlabel: delete the scores that no longer apply ----
    let deleted = 0;
    for (const key of Object.keys(state.sent)) {
      if (!key.startsWith('score:') || want.scores.has(key)) continue;
      try { await lfRequest(cfg, 'DELETE', `/api/public/scores/${key.slice(6)}`, undefined, { ...opt, okStatuses: [404] }); delete state.sent[key]; deleted++; } catch (e) { log('[lfeval] delete failed', e.message); }
    }
    state.size = end;
    await save();
    return { scores: sentScores, spans: sentSpans, items: sentItems, deleted, wanted: { scores: want.scores.size, spans: want.spans.size, items: [...want.items.values()].filter((x) => x.body.status === 'ACTIVE').length } };
  }
  return { sync };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const { defaults } = await import('./ingest.js');
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const cfg = defaults();
  if (arg('--stalls')) cfg.stallsFile = arg('--stalls');
  cfg.evalStateFile = arg('--state') || cfg.evalStateFile;
  if (arg('--dataset')) cfg.evalDataset = arg('--dataset');
  if (process.argv.includes('--seed-prompt')) {
    const { seedPrompt } = await import('../scripts/lf-setup.js');
    console.log(await seedPrompt(cfg)); return;
  }
  const r = await createEvalSync(cfg).sync({ force: process.argv.includes('--force') });
  console.log('[lfeval]', JSON.stringify(r));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error('[lfeval]', e.message); process.exit(1); });

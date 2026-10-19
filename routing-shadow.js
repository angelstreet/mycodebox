// Round 15: shadow scoring-into-routing (docs/v2/SCORING.md "Round 15"). At the point where the goal loop makes a live
// runtime choice, note what the scoring ledger would have recommended for this type of task, next to what was used.
// Append-only routing-shadow.jsonl in the state dir. It NEVER changes the choice: note() returns nothing, swallows every
// error, reads the ledger through a TTL cache (the ledger is read-only) and the loop ignores whatever happens here.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildLedger, summarize, recommend, classifyTaskType, sameModel, shadowThresholds } from './scripts/v2-ledger.js';

export function createRoutingShadow({ stateDir, home, ttlMs = 10 * 60_000, now = Date.now, env = process.env, onError = () => {} } = {}) {
  if (!stateDir) throw new Error('routing shadow: stateDir required');
  let cache = null;
  const seen = new Set();
  const data = () => {
    if (cache && now() - cache.at < ttlMs) return cache;
    try { const { records } = buildLedger({ stateDir, ...(home ? { home } : {}) }); cache = { at: now(), records, rec: recommend(records, shadowThresholds(env)) }; }
    catch (e) { cache = { at: now(), records: [], rec: null, error: e.message }; onError(e); }   // a broken ledger is cached too: no retry storm
    return cache;
  };
  // task: { task_id, role, text, workType }, entry: the registry entry actually chosen, key: dedupe key (one line per live choice).
  function note({ task_id, role = 'developer', text = '', workType = null, entry, key = null } = {}) {
    try {
      if (!entry) return;
      const k = `${task_id}|${role}|${key ?? entry.id}`;
      if (seen.has(k)) return;
      seen.add(k); if (seen.size > 5000) seen.clear();
      const d = data();
      const type = classifyTaskType({ role: role === 'developer' ? (workType === 'operations' ? 'operations' : null) : role, text });
      const r = d.rec?.[type], rec = r?.recommended || null;
      const chosenRow = d.records.length ? summarize(d.records.filter((x) => x.type === type && sameModel(x.model, entry.model) && x.runtime === (entry.runtime ?? x.runtime)), 'model')[0] : null;
      const line = {
        ts: now(), task_id: task_id ?? null, role, type,
        chosen: { entry: entry.id ?? null, runtime: entry.runtime ?? null, model: entry.model ?? null },
        recommended: rec ? { model: rec.model, runtime: rec.runtime, verifiedRate: rec.verifiedRate, tokensPerVerified: rec.tokensPerVerified } : null,
        agree: rec ? sameModel(rec.model, entry.model) : null,
        reason: d.error ? `ledger unavailable: ${d.error}` : r?.reason ?? 'no ledger data',
        samples: { typeRecords: r?.records ?? 0, eligible: r?.eligible ?? 0, recommended: rec ? { attempts: rec.attempts, verified: rec.verified } : null, chosen: chosenRow ? { attempts: chosenRow.attempts, verified: chosenRow.verified } : null },
      };
      mkdirSync(stateDir, { recursive: true });
      appendFileSync(join(stateDir, 'routing-shadow.jsonl'), JSON.stringify(line) + '\n');
    } catch (e) { try { onError(e); } catch { /* never break routing */ } }
  }
  return { note, refresh: () => { cache = null; } };
}

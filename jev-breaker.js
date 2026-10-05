// Jev circuit breaker (TASK-58 C5). Jev errors (403 key limit, 402 credit, network, timeout ...) used to look like "unsure"
// (the rule default won) and nobody noticed for hours. Now: 3 consecutive errors open the breaker, while it is open callers use
// the rules WITHOUT calling the API, except one half-open probe every 10 min; a success closes it.
// State lives in jev-budget.json next to { day, calls, cost } so the server and scripts/jev-ask.js (another process) share it:
//   errors (today), lastError, consecutiveErrors, breaker: 'open'|'closed', openedAt, lastProbe, announced
// Pure state machine over a file (sync, tiny). Announcing (jev:down / jev:up event + exactly one alert) is separate: announce().
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export const THRESHOLD = 3;
export const PROBE_MS = 10 * 60 * 1000;
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

export function createJevBreaker({ file, now = Date.now, threshold = THRESHOLD, probeMs = PROBE_MS } = {}) {
  const read = () => { try { const j = JSON.parse(readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
  const write = (s) => { try { writeFileSync(`${file}.tmp`, JSON.stringify(s)); renameSync(`${file}.tmp`, file); } catch { /* state dir missing: stay in rules, never throw */ } };
  const today = () => dayOf(now());
  const fresh = (s) => (s.day === today() ? s : { ...s, day: today(), calls: 0, cost: 0, errors: 0 });

  return {
    // The daily counters the manager keeps in memory ({day,calls,cost}) merged into the file without touching the breaker fields.
    saveCounters({ day, calls, cost }) {
      const s = read();
      write({ ...s, day, calls, cost, errors: s.day === day ? (s.errors || 0) : 0 });
    },
    isOpen: () => read().breaker === 'open',
    state: () => read(),
    // true = call the API. Open: false, except one probe per probeMs (that call is the half-open probe).
    allow() {
      const s = read();
      if (s.breaker !== 'open') return true;
      if (now() - (s.lastProbe || s.openedAt || 0) >= probeMs) { write({ ...s, lastProbe: now() }); return true; }
      return false;
    },
    // Jev answered (also "unsure"): clear the streak, close an open breaker.
    success() {
      const s = fresh(read());
      if (!s.consecutiveErrors && s.breaker !== 'open') return;
      write({ ...s, consecutiveErrors: 0, breaker: 'closed' });
    },
    // Jev failed (error text): count it; the 3rd in a row opens the breaker. A failed probe keeps it open.
    failure(error) {
      const s = fresh(read());
      const consecutiveErrors = (s.consecutiveErrors || 0) + 1;
      const next = { ...s, errors: (s.errors || 0) + 1, lastError: String(error || 'error').slice(0, 200), consecutiveErrors };
      if (s.breaker === 'open') next.lastProbe = now();
      else if (consecutiveErrors >= threshold) { next.breaker = 'open'; next.openedAt = now(); next.lastProbe = now(); }
      write(next);
    },
    // Emit the transition once: open -> emit({kind:'down'}) + alert, closed again -> emit({kind:'up'}). `announced` is persisted
    // BEFORE emitting, so concurrent ticks / processes cannot fire it twice. emit gets ({ kind, state }).
    announce(emit) {
      const s = read();
      if (s.breaker === 'open' && !s.announced) { write({ ...s, announced: true }); try { emit({ kind: 'down', state: s }); } catch { /* ignore */ } return 'down'; }
      if (s.breaker !== 'open' && s.announced) { write({ ...s, announced: false }); try { emit({ kind: 'up', state: s }); } catch { /* ignore */ } return 'up'; }
      return null;
    },
  };
}

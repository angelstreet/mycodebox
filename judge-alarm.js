// Alarm when the judgement layer is down (review 2026-11-11 item 2): the router and the AI triage had no provider credit for 14 days and
// nobody was told. Each judge ("router", "triage") is tracked on its own: the first failure since the last good answer starts the clock,
// and when a failure is still seen one hour later the owner gets ONE push for that outage. A good answer re-arms it.
// Pure with injected `push` / `now`; state is a small JSON file so a restart does not push the same outage twice. Never throws.
import { readFileSync, writeFileSync } from 'node:fs';

export const JUDGE_DOWN_MS = 60 * 60e3;

export function createJudgeAlarm({ file = null, push = () => {}, now = Date.now, afterMs = JUDGE_DOWN_MS } = {}) {
  let st = {};
  if (file) { try { st = JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { st = {}; } }
  const save = () => { if (file) { try { writeFileSync(file, JSON.stringify(st)); } catch { /* best effort */ } } };
  return {
    ok(kind) { if (st[kind]) { delete st[kind]; save(); } },
    fail(kind, why) {
      try {
        const t = now(), s = st[kind] ||= { since: t, alerted: false };
        s.why = String(why || '').slice(0, 160);
        if (!s.alerted && t - s.since >= afterMs) {
          s.alerted = true;
          push({ kind, why: s.why, minutes: Math.round((t - s.since) / 60e3), title: `AI ${kind} down for ${Math.round((t - s.since) / 3600e3 * 10) / 10} h`, body: `${s.why || 'no answer'}. Stops are judged by the keyword rules only. Money and providers are yours to decide; the fallback switch is aiFallback ("claude" uses a small Claude model on the plan).` });
        }
        save();
      } catch { /* an alarm must never break a stop */ }
    },
    snapshot: () => JSON.parse(JSON.stringify(st)),
  };
}

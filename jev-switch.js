// The VPT server can switch Jev off (its .env JEV_ENABLED=false): POST /server/ai/decide then answers 200
// { success: false, error: 'jev_disabled', disabled: true }. That is "Jev off", not a failure: no error rate,
// no Jev budget, no credits cool-down, no retry. Every Jev use records skipped: 'jev_disabled'.
export const DISABLED = 'jev_disabled';
export const DISABLED_TTL_MS = 5 * 60 * 1000;   // after the first disabled reply, do not ask again for 5 minutes

export const isDisabledReply = (j) => !!j && (j.disabled === true || j.error === DISABLED);

// One shared state per process: a single probe per TTL instead of one call per event.
export function createJevSwitch({ now = () => Date.now(), ttlMs = DISABLED_TTL_MS } = {}) {
  let until = 0;
  return {
    off: () => now() < until,
    markOff: () => { until = now() + ttlMs; },
    markOn: () => { until = 0; },
    // Feed every server reply through this; true when it was the disabled answer.
    seen(j) { if (isDisabledReply(j)) { this.markOff(); return true; } if (j && j.success !== false) this.markOn(); return false; },
  };
}

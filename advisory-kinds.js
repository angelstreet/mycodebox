// The single list of advisory event kinds (advisories: priority low, deferred like a notice, never an owner ask).
// Three places must agree on it, and each one that missed a new kind was a real bug (token audit 2026-11-28):
//   context-advisory.js            builds the events           (KIND / SUB_KIND / MGR_KIND re-export these)
//   manager-events.js              keeps the `advisory` payload; drops events about manager sessions EXCEPT MANAGER_ADVISORY_KINDS
//   scripts/manager-event-filter.sh  defers them (its notice regex); test/advisory-kinds.test.js fails when it drifts from this list
export const CONTEXT_ADVISORY = 'context-advisory';
export const SUBAGENT_ADVISORY = 'subagent-advisory';
export const MANAGER_RESTART_ADVISORY = 'manager-restart-advisory';
export const ADVISORY_KINDS = Object.freeze([CONTEXT_ADVISORY, SUBAGENT_ADVISORY, MANAGER_RESTART_ADVISORY]);
// Advisories ABOUT the manager session itself: meant for it, so the "drop events about manager sessions" rule must not drop them.
export const MANAGER_ADVISORY_KINDS = Object.freeze([MANAGER_RESTART_ADVISORY]);
export const isAdvisoryKind = (k) => ADVISORY_KINDS.includes(k);

// Session priority (TASK-44 phase 5): shared by the server (validation, status payload) and the UI (sorting).
export const PRIORITIES = ['P0', 'P1', 'P2'];
export const DEFAULT_PRIORITY = 'P2';
export const isPriority = (p) => PRIORITIES.includes(p);
export const prioRank = (p) => { const i = PRIORITIES.indexOf(p); return i < 0 ? PRIORITIES.indexOf(DEFAULT_PRIORITY) : i; };
// Comparator: P0 first. Returns 0 on a tie so callers chain their existing order after it.
export const byPriority = (a, b) => prioRank(a) - prioRank(b);

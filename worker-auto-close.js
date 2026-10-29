// Worker auto-close (owner, 2026-10-18): a session that another session started (not the owner, not the dashboard)
// and that is not a manager session is closed when it is done + idle + git-clean for a configurable threshold.
// Three layers, each independently testable:
//   shouldClose(facts)            pure decision: { close, reason, missing } from a single session's facts
//   createWorkerAutoClose({...})  factory: tick() gathers facts per session, calls shouldClose, then politeClose()
//   politeClose({...})            async close path: /exit for claude, Ctrl-C twice for mcode/codex, then kill tmux
// Switch: manager.json workerAutoClose: true (default) | false, workerIdleMin: 20 (default, minutes).
// Event key: 'worker-auto-closed:<name>' (kind 'health') in manager-events.jsonl — the manager feed can show the name,
// startedBy and last STATUS line so the owner sees what happened.
//
// "idle" means: no pane change, no running agent turn, no background work, not scriptBusy, no draft in the input.
// "git clean" reuses done-check's finding(): a shared checkout ignores its dirt, a worktree only counts its own.
// "started by another session" means startedBy is a non-empty string that is not 'owner' / 'dashboard' / 'unknown'.
// "STATUS: done" is the agent's own verdict (stall.js statusLine() kind === 'done').

const DEFAULT_IDLE_MIN = 20;
export const LEFTOVERS_WINDOW_MS = 4 * 3600 * 1000;   // a `leftovers` feed event this recent means the session still has work
// The closing STATUS/report admits something is not verified or not done (bug-8cddcf53: resume-task182 said it had not checked its page).
export const UNFINISHED_TEXT = /\b(?:did(?: not|n't)|do(?:es)? not|don't|doesn't|have(?: not|n't)|has(?: not|n't)|not yet|never)\s+(?:\w+\s+){0,2}?(?:verif\w*|test\w*|check\w*|run|ran|finish\w*|complet\w*|done|merg\w*|deploy\w*|look\w*|tried|try)\b|\bnot (?:yet )?(?:verified|tested|checked|done|finished|completed|deployed|merged)\b|\bunverified\b|\buntested\b/i;
export const unfinishedTextOf = (t) => { const m = UNFINISHED_TEXT.exec(String(t || '')); return m ? m[0] : null; };
const CTRL_C_DELAY_MS = 1500;
const EXIT_PROMPT_TIMEOUT_MS = 30000;
const KILL_AFTER_MS = 10000;

// Pure. facts:
//   name, startedBy, priority, lastStatusKind, idleMs, working, scriptBusy, backgroundWork, draft,
//   managerSessions, workerAutoClose, workerIdleMin, doneCheckClean
// Returns { close: boolean, reason: string, missing: string[] }.
// `missing` lists the facts that were not provided (diagnostic: the tick should fill them in). The decision logic
// treats null / undefined as the field's "empty" value (e.g. null startedBy -> "owner-controlled"), so a partially
// filled facts object still gives a real reason. Only `name` is truly required.
export function shouldClose(facts) {
  const missing = [];
  const need = (k) => { if (facts[k] === undefined) missing.push(k); };
  for (const k of ['name', 'startedBy', 'priority', 'lastStatusKind', 'idleMs', 'working', 'scriptBusy', 'backgroundWork', 'draft',
    'managerSessions', 'workerAutoClose', 'workerIdleMin', 'doneCheckClean']) need(k);   // openRows / leftoversAgeMs / lastStatusText are optional

  if (facts.name == null) return { close: false, reason: 'missing name', missing: missing.length ? missing : ['name'] };
  if (facts.workerAutoClose !== true) return { close: false, reason: 'workerAutoClose disabled', missing };
  // Owner / dashboard / unknown starts are never auto-closed: the owner is the only one who may decide to park them,
  // and an 'unknown' start is one the tick saw before cbsession reported it — wait for the real one to settle.
  const sb = facts.startedBy == null ? '' : String(facts.startedBy);
  if (!sb || sb === 'owner' || sb === 'dashboard' || sb === 'unknown' || sb === 'cbsession') return { close: false, reason: `startedBy=${sb || '<empty>'} is owner-controlled`, missing };
  // P0 / P1 sessions are owner-priority; auto-close is P2 (worker) only.
  if (facts.priority === 'P0' || facts.priority === 'P1') return { close: false, reason: `priority ${facts.priority} is owner-priority`, missing };
  // The manager sessions (default ['manager']) are the AI manager's own tmux sessions; they are never closed here.
  if (Array.isArray(facts.managerSessions) && facts.managerSessions.includes(facts.name)) return { close: false, reason: 'manager session', missing };
  // The agent's own verdict: a turn that did not end on "done" (or an accepted alias) is not ready to close.
  if (facts.lastStatusKind !== 'done') return { close: false, reason: `last status is ${facts.lastStatusKind || '<none>'}`, missing };
  // No draft in the input box: a half-typed follow-up would be lost.
  if (facts.draft) return { close: false, reason: 'draft in input', missing };
  // Open work (bug-8cddcf53): a done STATUS is not enough while the task doc has open rows, a leftovers event fired recently,
  // or the closing text itself says something was not verified / not done. The owner may still be using the session.
  if (facts.openRows > 0) return { close: false, reason: `task doc has ${facts.openRows} open row(s)`, openWork: true, missing };
  if (facts.leftoversAgeMs != null && facts.leftoversAgeMs < LEFTOVERS_WINDOW_MS) return { close: false, reason: `leftovers event ${Math.floor(facts.leftoversAgeMs / 60000)}m ago`, openWork: true, missing };
  const said = unfinishedTextOf(facts.lastStatusText);
  if (said) return { close: false, reason: `closing text says "${said}"`, openWork: true, missing };
  // Idle: no pane change, no running agent turn, no background work, not script-driven, for >= workerIdleMin minutes.
  if (facts.working) return { close: false, reason: 'agent turn running', missing };
  if (facts.scriptBusy) return { close: false, reason: 'script driving pane', missing };
  if (facts.backgroundWork > 0) return { close: false, reason: `${facts.backgroundWork} background work`, missing };
  const idleMin = Number(facts.workerIdleMin) || DEFAULT_IDLE_MIN;
  if (facts.idleMs < idleMin * 60 * 1000) return { close: false, reason: `idle ${Math.floor(facts.idleMs / 60000)}m < ${idleMin}m`, missing };
  // Git clean: done-check has nothing to say. A shared checkout is handled inside done-check (only own worktree counts).
  if (!facts.doneCheckClean) return { close: false, reason: 'git not clean', missing };
  return { close: true, reason: `idle ${Math.floor(facts.idleMs / 60000)}m, last STATUS done, git clean`, missing };
}

// Async close path. Inputs are injectable for tests; the production tick passes tmux + sendKeys + exec.
// agent: 'claude' | 'mcode' | 'codex' | 'other' (the agent family; 'other' is treated like mcode/codex — Ctrl-C twice).
//   sendKeys(session, keys, enter): type a key sequence into the tmux pane (e.g. '/exit', 'C-c').
//   tmuxSessionAlive(session): true if a tmux session with this name exists.
//   paneHasProcess(session): true if a foreground process (the agent) is still attached to the pane.
//   killTmux(session): hard-kill the tmux session.
//   sleep(ms): async sleep.
//   onPrompt(text): called when 'Exit and stop tasks' is detected (claude confirmation), must press Enter.
export async function politeClose({ name, agent, sendKeys, tmuxSessionAlive, paneHasProcess, killTmux, sleep, onPrompt }) {
  const result = { name, agent, steps: [], killed: false };
  if (!await tmuxSessionAlive(name)) { result.steps.push('no-tmux'); return result; }
  if (agent === 'claude') {
    await sendKeys(name, '/exit', true);
    result.steps.push('sent-/exit');
    // /exit with background work asks first: option 1 "Exit and stop tasks" is preselected (like manager-fresh.sh).
    const deadline = Date.now() + EXIT_PROMPT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!await paneHasProcess(name)) { result.steps.push('process-gone'); break; }
      await sleep(500);
      try { await onPrompt(name); result.steps.push('confirm-ExitAndStop'); }
      catch { /* no prompt yet */ }
      if (!await paneHasProcess(name)) { result.steps.push('process-gone'); break; }
    }
  } else {
    // mcode / codex / other: Ctrl-C twice with 1.5 s between. The first cancels the current line, the second kills.
    await sendKeys(name, 'C-c', false); result.steps.push('sent-C-c-1');
    await sleep(CTRL_C_DELAY_MS);
    await sendKeys(name, 'C-c', false); result.steps.push('sent-C-c-2');
    await sleep(CTRL_C_DELAY_MS);
  }
  if (await paneHasProcess(name)) {
    await killTmux(name); result.killed = true; result.steps.push('kill-tmux');
  } else { result.steps.push('process-gone'); }
  return result;
}

// Factory: the tick loop. Collects per-session facts from the injected hooks, calls shouldClose, then politeClose.
// `record(e)` writes the manager event (server.js wires this to managerEvents.record).
// `listDone()` mirrors done-check's listDone shape: [{ name, cwd, text, working }] — but we read the fresh facts here.
export function createWorkerAutoClose({
  stateDir,   // not used directly today; reserved for a future state file (told / last-closed)
  listCandidates,   // async () => [{ name, startedBy, priority, lastStatusKind, idleMs, working, scriptBusy, backgroundWork, draft, doneCheckClean, agent, tmuxSessionExists, paneHasProcess }]
  polite,           // function; defaults to politeClose() with the injected tmux/sendKeys hooks
  record = async () => {},
  config = () => ({ workerAutoClose: true, workerIdleMin: DEFAULT_IDLE_MIN, managerSessions: ['manager'] }),
  log = console,
  pollMs = 5 * 60 * 1000,
} = {}) {
  let timer = null, busy = false;
  let last = { at: 0, mode: 'off', checked: 0, closed: [], skipped: [] };

  async function tick() {
    if (busy) return last;
    busy = true;
    try {
      const cfg = (() => { try { return config() || {}; } catch { return {}; } })();
      const mode = cfg.workerAutoClose === false ? 'off' : 'live';
      if (mode === 'off') return (last = { at: Date.now(), mode, checked: 0, closed: [], skipped: [] });
      const candidates = await listCandidates().catch((e) => { log.error?.('[worker-auto-close] listCandidates', e.message); return []; });
      const managerSessions = Array.isArray(cfg.managerSessions) && cfg.managerSessions.length ? cfg.managerSessions : ['manager'];
      const closed = [], skipped = [];
      for (const c of candidates) {
        const decision = shouldClose({
          name: c.name, startedBy: c.startedBy, priority: c.priority, lastStatusKind: c.lastStatusKind,
          idleMs: c.idleMs, working: c.working, scriptBusy: c.scriptBusy, backgroundWork: c.backgroundWork, draft: c.draft,
          managerSessions, workerAutoClose: true, workerIdleMin: cfg.workerIdleMin ?? DEFAULT_IDLE_MIN, doneCheckClean: c.doneCheckClean,
          openRows: c.openRows, leftoversAgeMs: c.leftoversAgeMs, lastStatusText: c.lastStatusText,
        });
        if (!decision.close) {
          if (decision.reason) skipped.push({ name: c.name, reason: decision.reason });
          // Visible in the journal and the feed (the feed dedupes the same key for a few hours), so the owner sees why a done session stayed open.
          if (decision.openWork) {
            log.info?.(`[worker-auto-close] kept ${c.name}: ${decision.reason}`);
            try { await record({ key: `worker-auto-close-kept:${c.name}`, title: `kept ${c.name} open`, body: decision.reason, url: '/', priority: 'min' }); }
            catch (e) { log.error?.('[worker-auto-close] record', e.message); }
          }
          continue;
        }
        try {
          const r = await polite({ name: c.name, agent: c.agent, ...politeDeps(polite) });
          closed.push({ name: c.name, startedBy: c.startedBy, lastStatus: c.lastStatusText || null, result: r });
          try { await record({ key: `worker-auto-closed:${c.name}`, title: `auto-closed ${c.name}`, body: `startedBy=${c.startedBy}; ${decision.reason}`, url: '/', priority: 'default' }); }
          catch (e) { log.error?.('[worker-auto-close] record', e.message); }
        } catch (e) {
          log.error?.('[worker-auto-close] close', c.name, e.message);
          skipped.push({ name: c.name, reason: `close failed: ${e.message}` });
        }
      }
      return (last = { at: Date.now(), mode, checked: candidates.length, closed, skipped });
    } catch (e) {
      log.error?.('[worker-auto-close]', e.message);
      return (last = { ...last, at: Date.now(), error: e.message });
    } finally { busy = false; }
  }
  return {
    tick,
    snapshot: () => last,
    start(firstDelayMs = 60 * 1000) {
      if (timer) return;
      setTimeout(() => tick().catch(() => {}), firstDelayMs).unref?.();
      timer = setInterval(() => tick().catch(() => {}), pollMs);
      timer.unref?.();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

// Splits a `polite` function reference (which the factory was called with) from the per-call deps the tick needs.
// Kept tiny so tests can pass a custom `polite` and the real one only needs the per-call deps from server.js.
function politeDeps(_polite) { return {}; }

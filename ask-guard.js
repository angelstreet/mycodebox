// Server-side safety net for the manager's owner questions (owner, 2026-10-23, third incident: "Waiting for you: Q216"
// was written in chat for hours, never reached the ledger, never alerted). The command scripts/owner-ask.js and
// scripts/manager-ask.js are the normal ways; this guard catches the manager session whose last reply names a
// question the ledger does not hold.
//  - a "Q<n> · session · question" line (or a row of the report table) in a "Waiting for you" block that is not
//    open (and was never closed) in the ledger never reaches the owner: it is recorded as a defect and the manager
//    is told to file it through the ask gate (`ask-defect`, owner 2026-10-25)
//  - "Waiting for you: unchanged (Q1, Q2)" naming an id that is not open is alerted once: `ask-unbacked`
//  - a ledger-open ask with no alert after ALERT_AFTER_MS is alerted: `ask-alerted-late`
//  - a superseded ask is reported too: the open set cannot show a closed question, so a question that was dropped
//    with no replacement was invisible (E24). `ask-superseded-open` (the replacement is still open: the older
//    question is still waiting) and `ask-superseded-dropped` (the replacement is not a question: it was dropped).
//  - a record with no valid floor never passed the ask gate, so it is never shown to the owner (owner, 2026-10-25:
//    Q231 reached the owner that way). It is reported to the manager as a defect: `ask-defect`.
// Alert tag is `ask-<id>` (the push feed carries it, scripts/manager-status-scan.sh reads it).
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readLedger, openAsksFromRecords, appendRecord, withFileLock, ledgerView, supersededState, checkAsk, showable } from './owner-asks.js';
import { askLine } from './public/manager-ask.js';

export const ALERT_AFTER_MS = 2 * 60 * 1000;
// A dropped question is pushed to the owner only when it is recent: the ledger already holds a backlog of older
// drops and one push per old id would bury the owner's feed. Every drop is reported in the log and by the hourly
// scan (scripts/manager-ask-scan.sh), so an old drop is never lost, only not pushed.
export const DROP_ALERT_MS = 60 * 60 * 1000;
const ID_RE = /^Q\d+$/;

// A row of the manager's report table (owner, 2026-10-25): | Ask | What it is | Why it reached you | My view/recommendation |
// -> { id, session, what, why, rec } | null. The Ask cell carries the id and the session ("Q231 · mm-manager").
function parseTableRow(line) {
  const s = String(line || '').trim();
  if (!s.startsWith('|')) return null;
  const cells = s.split('|').slice(1, -1).map((c) => c.trim());
  if (cells.length < 4) return null;
  const m = /^(Q\d+)\s*(?:[·•|-]\s*(.*))?$/.exec(cells[0]);
  if (!m) return null;
  return { id: m[1], session: (m[2] || '').trim(), what: cells[1], why: cells[2], rec: cells[3] };
}

// -> { items: [{id, session, question, what?, why?, rec?}], unchanged: [id], none: bool }. Only the text after the last "Waiting for you" marker counts.
export function parseWaiting(reply) {
  const text = String(reply || '');
  const at = text.toLowerCase().lastIndexOf('waiting for you');
  if (at < 0) return { items: [], unchanged: [], none: false };
  const block = text.slice(at);
  const items = [], seen = new Set();
  let last = null;
  for (const line of block.split('\n')) {
    const row = parseTableRow(line);
    if (row) {
      if (!seen.has(row.id)) { seen.add(row.id); last = { id: row.id, session: row.session, question: row.what, what: row.what, why: row.why, rec: row.rec }; items.push(last); }
      continue;
    }
    const m = /^\s*(Q\d+)\s*[·•|-]\s*([^·•|]*?)\s*[·•|]\s*(.+?)\s*$/.exec(line);
    if (m && !seen.has(m[1])) { seen.add(m[1]); last = { id: m[1], session: m[2].trim(), question: m[3].trim() }; items.push(last); continue; }
    const wm = /^\s*What it is:\s*(.+?)\s*$/i.exec(line);
    if (wm && last) { last.what = wm[1]; if (!last.question) last.question = wm[1]; continue; }
    const rm = /^\s*My recommendation:\s*(.+?)\s*$/i.exec(line);
    if (rm && last) { last.rec = rm[1]; continue; }
  }
  const unchanged = [];
  const um = /waiting for you\s*:?\s*unchanged\s*\(([^)]*)\)/i.exec(block);
  if (um) for (const id of um[1].split(/[,\s]+/)) if (ID_RE.test(id) && !seen.has(id)) unchanged.push(id);
  return { items, unchanged, none: /waiting for you\s*:?\s*nothing/i.test(block) };
}

// alert({title, body, tag}) -> truthy when sent. alertsFile: {id, at, via} per alert already sent (shared with manager-ask).
export function createAskGuard({ ledgerFile, alertsFile, alert, log = () => {}, now = Date.now, onDefect = null } = {}) {
  const alerted = new Map();   // id -> at
  const firstSeen = new Map(); // id -> first time an open ask was seen without an alert
  const droppedAlerted = new Set();   // ids already pushed as "dropped" (the alerts record holds them as `dropped:<id>`)
  const reported = new Set();         // superseded asks already reported, once each
  const defectsSeen = new Set();      // defects already reported to the manager, once each
  // The shared alert record: ask-guard.js and scripts/manager-ask.js both write it. Re-read it on every use
  // (it only grows), so an alert the other writer sent is seen at once. It used to be read once at boot, and
  // the guard then alerted a second time for a question manager-ask.js had already alerted (2026-10-23).
  const refresh = async () => {
    try {
      for (const l of (await readFile(alertsFile, 'utf8')).split('\n')) {
        try {
          const r = JSON.parse(l);
          if (r?.id) alerted.set(r.id, r.at);
          if (r?.via === 'dropped' && typeof r.id === 'string' && r.id.startsWith('dropped:')) droppedAlerted.add(r.id.slice('dropped:'.length));
          if (r?.via === 'defect' && r?.id) defectsSeen.add(r.id);
        } catch {}
      }
    } catch {}
  };
  const markAlerted = async (id, via) => {
    alerted.set(id, now());
    await withFileLock(alertsFile, () => appendFile(alertsFile, JSON.stringify({ id, at: now(), via }) + '\n'));
  };
  const send = async (id, title, body, via) => {
    const sent = alert({ title: title.slice(0, 120), body: body.slice(0, 1000), tag: `ask-${id}` });
    // a debounced alert did not go out: leave it unmarked so the next tick tries again
    if (sent) await markAlerted(id, via);
    return !!sent;
  };

  // A defect is an open record that never passed the ask gate (no valid floor). The owner never sees it; the
  // manager is told once, through the event feed it follows, so it can file the question properly or decide it.
  const reportDefect = async (d) => {
    if (defectsSeen.has(d.id)) return false;
    defectsSeen.add(d.id);
    log({ type: 'ask-defect', id: d.id, session: d.session, why: d.why });
    if (typeof onDefect === 'function') { try { onDefect(d); } catch (e) { console.error('[ask-guard] defect event', e.message); } }
    // a marker in the shared record, so a restart does not report the same defect again
    await withFileLock(alertsFile, () => appendFile(alertsFile, JSON.stringify({ id: d.id, at: now(), via: 'defect' }) + '\n')).catch(() => {});
    return true;
  };

  // reply: the manager session's last reply. -> actions taken (for tests).
  async function checkReply(session, reply) {
    await refresh();
    const { items, unchanged } = parseWaiting(reply);
    if (!items.length && !unchanged.length) return [];
    const { records } = await readLedger(ledgerFile);
    const open = new Set(openAsksFromRecords(records).map((a) => a.id));
    const known = new Set(records.map((r) => r?.id).filter(Boolean));
    const done = [];
    for (const it of items) {
      if (open.has(it.id) || known.has(it.id)) continue;   // known and not open: answered or closed, not ours to reopen
      // The ask gate (owner-asks.js checkAsk): a question the manager only printed in chat never reaches the owner
      // unless it passed the gate (owner, 2026-10-25). A chat block carries no options and no floor, so it cannot
      // pass: the question is recorded as a defect and the manager is told to file it properly. The owner sees
      // nothing until the ask is filed through the gate (owner-ask.js / manager-ask.js).
      const check = checkAsk({ question: it.question, what: it.what, options: it.options, recommend: it.rec, floor: it.floor, why: it.why });
      const why = `printed in chat but never filed through the ask gate (${check.why}): file it with scripts/owner-ask.js (--question --what --options --recommend --floor --why) or decide it yourself with scripts/owner-ask.js decide`;
      await appendRecord(ledgerFile, { at: new Date(now()).toISOString(), id: it.id, session: it.session || session, question: it.question || it.what || '', options: [], recommendation: it.rec || '', state: 'open', defect: why, source: 'ask-defect' });
      log({ type: 'ask-defect', session, id: it.id, why });
      await reportDefect({ id: it.id, session: it.session || session, at: new Date(now()).toISOString(), why });
      done.push({ type: 'ask-defect', id: it.id });
    }
    for (const id of unchanged) {
      if (open.has(id) || known.has(id) || alerted.has(`unbacked:${id}`)) continue;
      alerted.set(`unbacked:${id}`, now());
      log({ type: 'ask-unbacked', session, id });
      alert({ title: `Ask ${id} is not in the ledger`, body: `${session} says it is waiting for you on ${id}, but no such question is open. Ask it to run manager-ask.`, tag: `ask-${id}` });
      done.push({ type: 'ask-unbacked', id });
    }
    return done;
  }

  // alert every open ledger ask that has had none for ALERT_AFTER_MS
  async function sweep() {
    await refresh();
    const { records } = await readLedger(ledgerFile);
    const t = now(), done = [];
    // only the asks that passed the gate are shown to the owner and alerted; a defect never is
    const open = openAsksFromRecords(records).filter(showable);
    for (const a of open) {
      if (alerted.has(a.id)) continue;
      const since = firstSeen.get(a.id) ?? (firstSeen.set(a.id, t), t);
      const age = Math.max(t - since, t - (Date.parse(a.at) || t));
      if (age < ALERT_AFTER_MS) continue;
      if (await send(a.id, `Needs you: ${a.id}`, `${askLine(a)} (answer in /?s=${a.session || 'manager'})`, 'late')) {
        log({ type: 'ask-alerted-late', session: a.session, id: a.id });
        done.push({ type: 'ask-alerted-late', id: a.id });
      }
    }
    for (const id of [...firstSeen.keys()]) if (!open.some((a) => a.id === id)) firstSeen.delete(id);
    // The defects (owner, 2026-10-25): a record that never passed the gate is never shown to the owner, so the
    // manager is the one who has to know about it. One event each.
    for (const d of openAsksFromRecords(records).filter((a) => !showable(a))) {
      if (await reportDefect({ id: d.id, session: d.session || '', at: d.at || '', why: 'no valid floor: this ask never passed the gate' })) {
        done.push({ type: 'ask-defect', id: d.id });
      }
    }
    // The superseded asks (E24): a question that was closed is in no open set, so a question dropped with no
    // replacement was never seen by anything. Each one is reported once: the replacement still open means the
    // older question is still waiting, a replacement that is not a question means it was dropped.
    const view = ledgerView(records);
    for (const s of view.superseded) {
      if (reported.has(s.id)) continue;
      reported.add(s.id);
      const state = supersededState(s, view);
      if (state === 'answered') continue;    // the owner answered the replacement: nothing was lost
      const type = state === 'open' ? 'ask-superseded-open' : 'ask-superseded-dropped';
      log({ type, id: s.id, by: s.by });
      done.push({ type, id: s.id, by: s.by });
      if (state !== 'open') await pushDropped(s, view, t);
    }
    return done;
  }

  // A dropped question is closed, so it is in no list the owner sees: nobody would answer it any more. Push it
  // once, and only when the drop is recent (an old drop is reported in the log and by the hourly scan).
  const pushDropped = async (s, view, t) => {
    if (droppedAlerted.has(s.id)) return;
    const at = Date.parse(s.at || '');
    if (at && t - at > DROP_ALERT_MS) return;
    const row = view.askRows.get(s.id);
    const body = `The question "${row?.question || s.id}" was closed without a replacement, so it is not on your list any more. File it again with scripts/manager-ask.js.`;
    const sent = alert({ title: `Needs you: ${s.id} was dropped`, body, tag: `ask-${s.id}` });
    if (!sent) return;   // a debounced alert did not go out: leave it unmarked so the next tick tries again
    droppedAlerted.add(s.id);
    await withFileLock(alertsFile, () => appendFile(alertsFile, JSON.stringify({ id: `dropped:${s.id}`, at: now(), via: 'dropped' }) + '\n'));
  };
  return { checkReply, sweep, markAlerted };
}

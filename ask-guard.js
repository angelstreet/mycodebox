// Server-side safety net for the manager's owner questions (owner, 2026-10-23, third incident: "Waiting for you: Q216"
// was written in chat for hours, never reached the ledger, never alerted). The command scripts/manager-ask.js is the
// normal way; this guard catches the manager session whose last reply names a question the ledger does not hold.
//  - a "Q<n> · session · question" line in a "Waiting for you" block that is not open (and was never closed) in the
//    ledger is registered from the block's text and alerted: `ask-autoregistered`
//  - "Waiting for you: unchanged (Q1, Q2)" naming an id that is not open is alerted once: `ask-unbacked`
//  - a ledger-open ask with no alert after ALERT_AFTER_MS is alerted: `ask-alerted-late`
// Alert tag is `ask-<id>` (the push feed carries it, scripts/manager-status-scan.sh reads it).
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readLedger, openAsksFromRecords, appendRecord, withFileLock } from './owner-asks.js';

export const ALERT_AFTER_MS = 2 * 60 * 1000;
const ID_RE = /^Q\d+$/;

// -> { items: [{id, session, question}], unchanged: [id], none: bool }. Only the text after the last "Waiting for you" marker counts.
export function parseWaiting(reply) {
  const text = String(reply || '');
  const at = text.toLowerCase().lastIndexOf('waiting for you');
  if (at < 0) return { items: [], unchanged: [], none: false };
  const block = text.slice(at);
  const items = [], seen = new Set();
  for (const line of block.split('\n')) {
    const m = /^\s*(Q\d+)\s*[·•|-]\s*([^·•|]*?)\s*[·•|]\s*(.+?)\s*$/.exec(line);
    if (m && !seen.has(m[1])) { seen.add(m[1]); items.push({ id: m[1], session: m[2].trim(), question: m[3].trim() }); }
  }
  const unchanged = [];
  const um = /waiting for you\s*:?\s*unchanged\s*\(([^)]*)\)/i.exec(block);
  if (um) for (const id of um[1].split(/[,\s]+/)) if (ID_RE.test(id) && !seen.has(id)) unchanged.push(id);
  return { items, unchanged, none: /waiting for you\s*:?\s*nothing/i.test(block) };
}

// alert({title, body, tag}) -> truthy when sent. alertsFile: {id, at, via} per alert already sent (shared with manager-ask).
export function createAskGuard({ ledgerFile, alertsFile, alert, log = () => {}, now = Date.now } = {}) {
  const alerted = new Map();   // id -> at
  const firstSeen = new Map(); // id -> first time an open ask was seen without an alert
  // The shared alert record: ask-guard.js and scripts/manager-ask.js both write it. Re-read it on every use
  // (it only grows), so an alert the other writer sent is seen at once. It used to be read once at boot, and
  // the guard then alerted a second time for a question manager-ask.js had already alerted (2026-10-23).
  const refresh = async () => {
    try {
      for (const l of (await readFile(alertsFile, 'utf8')).split('\n')) {
        try { const r = JSON.parse(l); if (r?.id) alerted.set(r.id, r.at); } catch {}
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
      await appendRecord(ledgerFile, { at: new Date(now()).toISOString(), id: it.id, session: it.session || session, question: it.question, options: [], recommendation: '', state: 'open', source: 'ask-autoregistered' });
      log({ type: 'ask-autoregistered', session, id: it.id });
      await send(it.id, `Needs you: ${it.id}`, `${it.question} (answer in /?s=${it.session || session})`, 'autoregistered');
      done.push({ type: 'ask-autoregistered', id: it.id });
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
    const open = openAsksFromRecords(records);
    for (const a of open) {
      if (alerted.has(a.id)) continue;
      const since = firstSeen.get(a.id) ?? (firstSeen.set(a.id, t), t);
      const age = Math.max(t - since, t - (Date.parse(a.at) || t));
      if (age < ALERT_AFTER_MS) continue;
      if (await send(a.id, `Needs you: ${a.id}`, `${a.question} (answer in /?s=${a.session || 'manager'})`, 'late')) {
        log({ type: 'ask-alerted-late', session: a.session, id: a.id });
        done.push({ type: 'ask-alerted-late', id: a.id });
      }
    }
    for (const id of [...firstSeen.keys()]) if (!open.some((a) => a.id === id)) firstSeen.delete(id);
    return done;
  }
  return { checkReply, sweep, markAlerted };
}

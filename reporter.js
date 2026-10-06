// Reporter intake (TASK-44 phase 8): the ghosty-reporter Claude Code plugin (claude-plugin/ghosty-reporter)
// POSTs structured session events here. This module owns the token, validates events and keeps the latest
// facts per tmux session. It is read-only for everything else: the manager and the status payload ask it,
// nothing here types into a session.
//
// Per session: { sessionId, cwd, reporterSeenAt, live, lastTurn {text, at, reason, backgroundWork, ...},
//                waiting {message, kind, at}, lastPrompt {text, at}, agents[] }

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_HEADER = 'x-ghosty-reporter-token';
export const TEXT_MAX = 8 * 1024;
const PEER_TEXT_MAX = 2000;           // peer messages are capped before they hit stalls.jsonl
const PEER_RING_MAX = 50;             // last 50 sent texts remembered for the dedupe ring
const PEER_DEDUPE_MS = 120_000;       // a recv that repeats a send within 2 min is the same one
const LIVE_MS = 10 * 60 * 1000;       // a reporter that was silent this long is not "live" (turns can be long: any event refreshes it)
const MERGE_MS = 15000;               // turn.end (turn.complete) and stop (Stop hook) of the same turn arrive within this

export const isLoopback = (addr) => /^(?:127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(String(addr || ''));

export function createReporter({ stateDir, now = () => Date.now() } = {}) {
  const tokenFile = join(stateDir, 'reporter.token');
  let token = '';
  const sessions = new Map();

  async function init() {
    await mkdir(stateDir, { recursive: true });
    try { token = (await readFile(tokenFile, 'utf8')).trim(); } catch {}
    if (!token) {
      token = randomBytes(32).toString('hex');
      await writeFile(tokenFile, token + '\n', { mode: 0o600 });
    }
    try { await chmod(tokenFile, 0o600); } catch {}
    return tokenFile;
  }

  function tokenOk(given) {
    if (!token || typeof given !== 'string') return false;
    const a = Buffer.from(given), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  const str = (v, max = TEXT_MAX) => (typeof v === 'string' ? v.slice(0, max) : '');
  const slot = (name) => {
    let s = sessions.get(name);
    if (!s) { s = { sessionId: null, cwd: null, reporterSeenAt: 0, live: false, lastTurn: null, waiting: null, lastPrompt: null, agents: [] }; sessions.set(name, s); }
    return s;
  };
  const peerSends = [];   // ring of recent peer.send texts for the dedupe pass: [{ text: full 200 head, at: ms }]
  const peerRemember = (head, at) => {
    peerSends.push({ text: head, at });
    if (peerSends.length > PEER_RING_MAX) peerSends.shift();
  };
  const peerMatches = (head, at) => {
    for (let i = peerSends.length - 1; i >= 0; i--) {
      const e = peerSends[i];
      if (at - e.at > PEER_DEDUPE_MS) { peerSends.splice(0, i + 1); break; }
      if (e.text.length >= 20 && head.includes(e.text)) return true;   // the recv wraps the sent text in an envelope
    }
    return false;
  };
  const peerHead = (text) => text.slice(0, 200);
  const isDupPeer = (text, at) => text.length >= 20 && peerMatches(text, at);

  // Returns { ok, ignored? } or throws {status}. `ev` is the parsed JSON body.
  function ingest(ev) {
    if (!ev || typeof ev !== 'object' || ev.v !== 1 || typeof ev.event !== 'string') throw Object.assign(new Error('bad event'), { status: 400 });
    if (typeof ev.session !== 'string' || !ev.session) return { ok: true, ignored: 'not in tmux' };
    const t = now();
    const s = slot(ev.session);
    s.reporterSeenAt = t;
    if (typeof ev.sessionId === 'string' && ev.sessionId) {
      if (s.sessionId && s.sessionId !== ev.sessionId && ev.event !== 'session.end') { s.lastTurn = null; s.waiting = null; s.lastPrompt = null; s.agents = []; }   // /clear or resume: a new conversation
      s.sessionId = ev.sessionId;
    }
    if (typeof ev.cwd === 'string' && ev.cwd) s.cwd = ev.cwd.slice(0, 500);
    s.live = ev.event !== 'session.end';
    switch (ev.event) {
      case 'session.start': s.waiting = null; break;
      case 'session.end': s.live = false; s.waiting = null; break;
      case 'prompt':
        if (ev.synthetic === true) break;   // a background task waking the session, not the owner: not a reply
        s.lastPrompt = { text: str(ev.text), at: t };
        s.waiting = null;
        break;
      case 'turn.end': {
        if (ev.agentId) break;   // a subagent's turn is not the session's turn
        const prev = s.lastTurn;
        const merge = prev && prev.stopAt && t - prev.stopAt < MERGE_MS;
        s.lastTurn = { text: str(ev.text), at: t, reason: str(ev.reason, 20) || null, usage: ev.usage && typeof ev.usage === 'object' ? ev.usage : null,
          backgroundWork: merge ? prev.backgroundWork : null, stopAt: merge ? prev.stopAt : null };
        s.waiting = null;
        break;
      }
      case 'stop': {
        if (ev.agentId) break;
        const prev = s.lastTurn;
        const merge = prev && !prev.stopAt && t - prev.at < MERGE_MS;
        const n = Number.isFinite(ev.backgroundWork) ? Math.max(0, Math.floor(ev.backgroundWork)) : 0;
        s.lastTurn = { ...(merge ? prev : { reason: null, usage: null }), text: str(ev.text) || (merge ? prev.text : ''), at: merge ? prev.at : t, backgroundWork: n, stopAt: t,
          background: Array.isArray(ev.background) ? ev.background.slice(0, 20) : [], crons: Number(ev.crons) || 0 };
        s.waiting = null;
        break;
      }
      case 'waiting':
        s.waiting = { message: str(ev.message, 1000), kind: str(ev.kind, 40), tool: ev.tool ? str(ev.tool, 80) : null, at: t };
        break;
      case 'agents':
        s.agents = Array.isArray(ev.agents)
          ? ev.agents.slice(0, 50).map((a) => ({ id: str(a?.id, 80), type: str(a?.type, 60), status: str(a?.status, 30), description: str(a?.description, 200) }))
          : [];
        break;
      case 'peer.send': {
        const text = str(ev.text, PEER_TEXT_MAX);
        if (!text) return { ok: true, ignored: 'empty peer text' };
        peerRemember(peerHead(text), t);
        return { ok: true, peer: { type: 'peer', from: ev.session, to: str(ev.to, 200), text, at: new Date(t).toISOString() } };
      }
      case 'peer.recv': {
        const text = str(ev.text, PEER_TEXT_MAX);
        if (!text) return { ok: true, ignored: 'empty peer text' };
        if (isDupPeer(text, t)) return { ok: true, ignored: 'duplicate peer' };
        return { ok: true, peer: { type: 'peer', from: null, to: ev.session, text, at: new Date(t).toISOString() } };
      }
      default: return { ok: true, ignored: 'unknown event' };
    }
    return { ok: true };
  }

  const liveOf = (s) => !!s && s.live && now() - s.reporterSeenAt < LIVE_MS;

  // The newest finished turn of this session if it belongs to the current stop. `stopSince` = when the
  // manager first saw the session stopped. A newer prompt than the turn, or a turn that ended long before
  // the stop began, belongs to something else.
  function turnForStop(name, stopSince) {
    const s = sessions.get(name);
    if (!liveOf(s) || !s.lastTurn) return null;
    const lt = s.lastTurn;
    if (s.lastPrompt && s.lastPrompt.at > lt.at) return null;
    if (stopSince && lt.at < stopSince - 20000) return null;
    return lt;
  }

  // A waiting report that still stands: nothing happened since, and the pane has been still ever since.
  function waitingNow(name, paneChangedAt) {
    const s = sessions.get(name);
    if (!liveOf(s) || !s.waiting) return null;
    const w = s.waiting;
    if (s.lastTurn && s.lastTurn.at > w.at) return null;
    if (s.lastPrompt && s.lastPrompt.at > w.at) return null;
    if (paneChangedAt && paneChangedAt > w.at + 3000) return null;   // the pane moved on: it was answered
    return w;
  }

  // The latest prompt text the owner submitted after `since` (ms epoch).
  function promptSince(name, since) {
    const s = sessions.get(name);
    if (!liveOf(s) || !s.lastPrompt || s.lastPrompt.at < since) return null;
    return s.lastPrompt;
  }

  const agentSummary = (s) => {
    const by = {};
    for (const a of s.agents) by[a.status] = (by[a.status] || 0) + 1;
    return { count: s.agents.length, by };
  };

  // Small view for the status payload.
  function summary(name) {
    const s = sessions.get(name);
    if (!liveOf(s)) return null;
    return {
      seenAt: s.reporterSeenAt,
      turnAt: s.lastTurn?.at ?? null,
      backgroundWork: s.lastTurn?.backgroundWork ?? 0,
      waiting: s.waiting ? { message: s.waiting.message.slice(0, 200), at: s.waiting.at } : null,
      agents: agentSummary(s),
      agentList: s.agents.slice(0, 12).map((a) => ({ type: a.type, status: a.status, description: a.description.slice(0, 80) })),
    };
  }

  function detail(name) {
    const s = sessions.get(name);
    return s ? { session: name, live: liveOf(s), sessionId: s.sessionId, cwd: s.cwd, reporterSeenAt: s.reporterSeenAt, lastTurn: s.lastTurn, waiting: s.waiting, lastPrompt: s.lastPrompt, agents: s.agents } : null;
  }

  // Activity for lease binding: the last finished turn (turn.complete) and whether a newer prompt means a turn is running.
  // { turnAt, promptAt, working } or null when the reporter never reported this session (then nobody may act on idleness).
  function activityOf(name) {
    const s = sessions.get(name);
    if (!s || (!s.lastTurn && !s.lastPrompt)) return null;
    const turnAt = s.lastTurn?.at ?? 0, promptAt = s.lastPrompt?.at ?? 0;
    return { turnAt, promptAt, working: promptAt > turnAt };
  }

  // Newest event time of a session that was a turn end or a prompt (ms), or 0.
  const lastActivity = (name) => { const s = sessions.get(name); return s ? Math.max(s.lastTurn?.at || 0, s.lastTurn?.stopAt || 0, s.lastPrompt?.at || 0) : 0; };

  const prune = (liveNames) => { for (const k of [...sessions.keys()]) if (!liveNames.has(k)) sessions.delete(k); };

  return { init, tokenOk, ingest, summary, detail, turnForStop, waitingNow, promptSince, activityOf, prune, lastActivity, liveOf: (n) => liveOf(sessions.get(n)), tokenFile };
}

// ghosty-reporter: a pure observer. Every hook below calls next(e) and returns its result untouched;
// reporting is fire-and-forget after that (never awaited by the hook, except session.end), bounded by a short timeout, and swallows every error. If ghosty is
// down the session behaves exactly as without this plugin (after one failed try, nothing is sent for
// 30 s). Nothing is printed to the transcript.
import type { Register } from 'claude-code'
import { agentRows, cap, isSynthetic, NOT_WAITING, payload, taskRows } from './report.ts'
import type { Identity } from './report.ts'

const SEND_MS = 800        // longest a hook waits for ghosty
const SEND_END_MS = 300    // session.end shares a short wall-clock bound
const DOWN_MS = 30_000     // after a failed send, stay quiet this long

type State = { ident: Identity | null; tmuxTried: number; downUntil: number; lastAgents: string; url: string }
const state: State = { ident: null, tmuxTried: 0, downUntil: 0, lastAgents: '', url: '' }

async function identity($: any): Promise<Identity> {
  if (state.ident && (state.ident.session || state.tmuxTried >= 3)) return state.ident
  let session: string | null = null
  try {
    const pane = await $.env.get('TMUX_PANE')
    const inTmux = await $.env.get('TMUX')
    if (inTmux) {
      state.tmuxTried += 1
      const r = await $.process.run(
        pane ? ['tmux', 'display-message', '-p', '-t', pane, '#S'] : ['tmux', 'display-message', '-p', '#S'],
        { timeoutMs: 2000 },
      )
      if (r.exitCode === 0 && r.stdout.trim()) session = r.stdout.trim().split('\n')[0] ?? null
    }
  } catch { /* not in tmux, or tmux unavailable */ }
  let sessionId = ''
  let cwd = ''
  try { sessionId = await $.session.id() } catch { /* unknown */ }
  try { cwd = await $.session.cwd() } catch { /* unknown */ }
  state.ident = { session, sessionId, cwd }
  return state.ident
}

async function send($: any, body: unknown): Promise<void> {
  const base = (await $.env.get('GHOSTY_STATE_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.local/state/ghosty`
  const tokenFile = (await $.env.get('GHOSTY_REPORTER_TOKEN_FILE')) || `${base}/reporter.token`
  const token = String(await $.fs.read(tokenFile)).trim()
  if (!token) return
  const url = (await $.env.get('GHOSTY_REPORTER_URL')) || state.url
  const r = await $.http.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ghosty-reporter-token': token },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`ghosty answered ${r.status}`)
}

// Fire and forget with a bound: never throws, never waits longer than `ms`.
async function report($: any, event: string, data: Record<string, unknown> = {}, agentId?: string, ms: number = SEND_MS): Promise<void> {
  try {
    const now = await $.clock.now()
    if (now < state.downUntil) return
    const id = await identity($)
    const body = payload(event, id, now, data, agentId)
    const sent = send($, body).then(() => true, () => false)
    const timeout = $.clock.sleep(ms).then(() => null, () => null)
    const ok = await Promise.race([sent, timeout])
    if (ok !== true) state.downUntil = now + DOWN_MS
  } catch { /* silent */ }
}

async function snapshot($: any): Promise<void> {
  try {
    const rows = agentRows(await $.agent.list())
    const key = JSON.stringify(rows)
    if (key === state.lastAgents) return
    state.lastAgents = key
    await report($, 'agents', { agents: rows })
  } catch { /* silent */ }
}

export const register: Register = (on, options) => {
  state.url = String(options.url || 'http://127.0.0.1:7777/api/reporter/event')
  on('session.start', async ($, e, next) => {
    const out = await next(e)
    void report($, 'session.start', { surface: e.surface, interactive: e.isInteractive })
    return out
  })

  on('session.end', async ($, e, next) => {
    const out = await next(e)
    await report($, 'session.end', { reason: e.reason }, undefined, SEND_END_MS)
    return out
  })

  on('prompt.submit', async ($, e, next) => {
    const out = await next(e)
    void report($, 'prompt', { text: cap(e.text), midTurn: e.turnId !== undefined, synthetic: isSynthetic(e.text) })
    return out
  })

  // The model's turn ended: the exact final answer, why, and what it cost. A subagent's turn is tagged
  // with its agentId and is not the session's turn.
  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    // one background chain, so a failed report trips the quiet period before the snapshot tries
    void (async () => {
      await report($, 'turn.end', { text: cap(e.answer), reason: e.reason, durationMs: e.durationMs, usage: e.usage }, e.agentId)
      if (!e.agentId) await snapshot($)
    })()
    return out
  })

  // The Stop hook carries what turn.complete does not: whether background work is still in flight.
  on('classic.Stop', async ($, e, next) => {
    const out = await next(e)
    void report($, 'stop', {
      text: cap(e.last_assistant_message ?? ''),
      backgroundWork: (e.background_tasks ?? []).length,
      background: taskRows(e.background_tasks),
      crons: (e.session_crons ?? []).length,
    })
    return out
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    const out = await next(e)
    void report($, 'waiting', { kind: 'permission', message: cap(`Permission requested: ${e.tool_name}`, 500), tool: e.tool_name }, e.agent_id)
    return out
  })

  on('classic.Notification', async ($, e, next) => {
    const out = await next(e)
    if (!NOT_WAITING.has(e.notification_type)) {
      void report($, 'waiting', { kind: e.notification_type, message: cap(e.message, 1000) }, e.agent_id)
    }
    return out
  })

  on('agent.spawn', async ($, e, next) => {
    const out = await next(e)
    void snapshot($)
    return out
  })
  on('classic.SubagentStart', async ($, e, next) => {
    const out = await next(e)
    void snapshot($)
    return out
  })
  on('classic.SubagentStop', async ($, e, next) => {
    const out = await next(e)
    void snapshot($)
    return out
  })
  on('classic.TeammateIdle', async ($, e, next) => {
    const out = await next(e)
    void snapshot($)
    return out
  })
}

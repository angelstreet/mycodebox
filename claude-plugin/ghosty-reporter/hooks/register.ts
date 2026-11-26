// ghosty-reporter: a pure observer. Every hook below calls next(e) and returns its result untouched;
// reporting is fire-and-forget after that (never awaited by the hook, except session.end), bounded by a short timeout, and swallows every error. If ghosty is
// down the session behaves exactly as without this plugin (after one failed try, nothing is sent for
// 30 s). Nothing is printed to the transcript.
import type { Register } from 'claude-code'
import { agentRows, cap, isSynthetic, leaseReleaseArgv, NOT_WAITING, payload, shouldRequireStatus, STATUS_REASON, taskRows, notesOf } from './report.ts'
import type { Identity, Note } from './report.ts'

const SEND_MS = 800        // longest a hook waits for ghosty
const SEND_END_MS = 300    // session.end shares a short wall-clock bound
const LEASE_MS = 2500      // longest session.end waits for the lease release (ssh to proxmox)
const DOWN_MS = 30_000     // after a failed send, stay quiet this long

type State = { ident: Identity | null; tmuxTried: number; downUntil: number; lastAgents: string; url: string; headless: boolean }
const state: State = { ident: null, tmuxTried: 0, downUntil: 0, lastAgents: '', url: '', headless: false }

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

async function send($: any, body: unknown): Promise<string> {
  const base = (await $.env.get('GHOSTY_STATE_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.local/state/ghosty`
  const tokenFile = (await $.env.get('GHOSTY_REPORTER_TOKEN_FILE')) || `${base}/reporter.token`
  const token = String(await $.fs.read(tokenFile)).trim()
  if (!token) return ''
  const url = (await $.env.get('GHOSTY_REPORTER_URL')) || state.url
  const r = await $.http.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ghosty-reporter-token': token },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`ghosty answered ${r.status}`)
  return String(r.text ?? '')
}

// One bounded exchange with ghosty: never throws, never waits longer than `ms`. -> its answer, or null when nothing came back.
async function report($: any, event: string, data: Record<string, unknown> = {}, agentId?: string, ms: number = SEND_MS): Promise<string | null> {
  try {
    const now = await $.clock.now()
    if (now < state.downUntil) return null
    const id = await identity($)
    const body = payload(event, id, now, data, agentId)
    const sent = send($, body).then(text => ({ text }), () => null)
    const timeout = $.clock.sleep(ms).then(() => null, () => null)
    const ok = await Promise.race([sent, timeout])
    if (!ok) state.downUntil = now + DOWN_MS
    return ok ? ok.text : null
  } catch { return null }
}

// Notes ghosty parked for this session (a rules change, an overlap: things that must not start a turn of their own).
// A headless child in the same tmux pane (`claude -p` run by a script) must not take the session's notes.
async function takeNotes($: any): Promise<Note[]> {
  try {
    if (state.headless || !(await identity($)).session) return []
    return notesOf(await report($, 'notes.take'))
  } catch { return [] }
}

// Fail open: no tmux, no ssh, no proxmox, a slow answer: the lease then simply stays (ghosty releases it later when the session is gone).
async function releaseLeases($: any, reason: unknown): Promise<void> {
  try {
    const argv = leaseReleaseArgv((await identity($)).session, reason)
    if (!argv) return
    const ran = $.process.run(argv, { timeoutMs: LEASE_MS }).then(() => true, () => false)
    const timeout = $.clock.sleep(LEASE_MS).then(() => null, () => null)
    await Promise.race([ran, timeout])
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
    state.headless = e.isInteractive === false
    void report($, 'session.start', { surface: e.surface, interactive: e.isInteractive })
    return out
  })

  on('session.end', async ($, e, next) => {
    const out = await next(e)
    // both bounded and in parallel; each swallows its own errors, so exiting is never delayed by more than LEASE_MS
    await Promise.all([report($, 'session.end', { reason: e.reason }, undefined, SEND_END_MS), releaseLeases($, e.reason)])
    return out
  })

  on('prompt.submit', async ($, e, next) => {
    // Parked notes ride along with this real prompt, as context only the model reads. Acked once it entered: else they wait.
    const notes = e.command ? [] : await takeNotes($)
    const out = await next(notes.length ? { ...e, context: [...(e.context ?? []), ...notes.map(n => n.text)] } : e)
    if (notes.length && out.drop === undefined) void report($, 'notes.ack', { ids: notes.map(n => n.id) })
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
    // One re-prompt for a missing STATUS line. Anything going wrong here lets the stop through unchanged.
    try {
      const id = await identity($)
      if (shouldRequireStatus(e as any, id.session)) return { ...out, block: STATUS_REASON }
    } catch { /* fail open */ }
    void report($, 'stop', {
      text: cap(e.last_assistant_message ?? ''),
      backgroundWork: (e.background_tasks ?? []).length,
      background: taskRows(e.background_tasks),
      crons: (e.session_crons ?? []).length,
    })
    return out
  })

  // Cross-session messages (TASK-58 C4 logging only): peer.send from a SendMessage tool call, peer.recv from an
  // inbound delivery whose origin is another session or teammate. A subagent's chatter is not session traffic — skip.
  on('session.send', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId) return out
    void report($, 'peer.send', { to: String(e.to ?? '').slice(0, 200), text: cap(e.text) })
    return out
  })

  on('session.receive', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId) return out
    if (e.origin?.kind !== 'peer' && e.origin?.kind !== 'peer-send-message') return out
    void report($, 'peer.recv', { text: cap(e.text), kind: e.origin.kind })
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

// Pure helpers of the ghosty reporter: payload shaping and caps. No engine calls here.

export const TEXT_CAP = 8 * 1024   // bytes of any free text sent to ghosty

// Cuts `text` to at most TEXT_CAP UTF-8 bytes on a character boundary; marks the cut.
export function cap(text: unknown, max: number = TEXT_CAP): string {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text)
  const enc = new TextEncoder()
  if (enc.encode(s).length <= max) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (enc.encode(s.slice(0, mid)).length <= max - 3) lo = mid
    else hi = mid - 1
  }
  return `${s.slice(0, lo)}...`
}

export type Identity = {
  session: string | null      // tmux session name; null when the session is not in tmux
  sessionId: string
  cwd: string
}

export type AgentRow = { id: string; type: string; status: string; description: string }

export function agentRows(list: readonly { id: string; type: string; status: string; description: string }[]): AgentRow[] {
  return list.slice(0, 50).map(a => ({ id: a.id, type: a.type, status: a.status, description: cap(a.description, 200) }))
}

export type Payload = {
  v: 1
  event: string
  session: string | null
  sessionId: string
  cwd: string
  at: number
  agentId?: string
  [k: string]: unknown
}

export function payload(event: string, id: Identity, at: number, data: Record<string, unknown> = {}, agentId?: string): Payload {
  const p: Payload = { v: 1, event, session: id.session, sessionId: id.sessionId, cwd: id.cwd, at, ...data }
  if (agentId) p.agentId = agentId
  return p
}

export type BackgroundTask = { id?: string; type?: string; status?: string; description?: string }

export function taskRows(tasks: readonly BackgroundTask[] | undefined) {
  return (tasks ?? []).slice(0, 20).map(t => ({ type: t.type ?? '', status: t.status ?? '', description: cap(t.description ?? '', 120) }))
}

// Notification types that are not "the session is blocked on you": idle reminders and auth confirmations.
export const NOT_WAITING = new Set(['idle_prompt', 'auth_success'])

// Prompts the engine raises itself (a finished background task waking the session, a system reminder) are
// not something the owner typed: they are reported, marked, and ghosty never reads them as the owner's reply.
export const isSynthetic = (text: string): boolean => /^\s*<(?:task-notification|system-reminder|local-command|command-name|command-message)\b/.test(text)

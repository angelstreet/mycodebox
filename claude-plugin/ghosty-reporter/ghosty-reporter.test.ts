import { expect, mock, test } from 'claude-code/testing'
import { cap, TEXT_CAP } from './hooks/report.ts'

const ENV = {
  TMUX: '/tmp/tmux-1000/default,1,0',
  TMUX_PANE: '%3',
  HOME: '/home/test',
  GHOSTY_REPORTER_URL: 'http://127.0.0.1:1/api/reporter/event',
}

type Sent = { url: string; headers: Record<string, string>; body: any }

// The world beneath the plugin: env, clock, tmux, token file, ghosty. Returns what ghosty received.
function world(on: any, opts: { down?: boolean; env?: Record<string, string>; noToken?: boolean } = {}) {
  const sent: Sent[] & { attempts?: number } = []
  sent.attempts = 0
  mock.env(on, { ...ENV, ...(opts.env ?? {}) })
  mock.clock(on, { now: 1_000_000 })
  on('process.run', async (_$: any, e: any) => ({ value: { exitCode: 0, stdout: e.argv?.[0] === 'tmux' ? 'my-session\n' : '', stderr: '' } }))
  on('fs.read', async () => { if (opts.noToken) throw new Error('ENOENT'); return { value: 'tok-123\n' } })
  // the engine's own bottoms: what each event answers when nobody above changes it
  on('turn.complete', async (_$: any, e: any) => ({ text: e.answer }))
  on('prompt.submit', async (_$: any, e: any) => ({ text: e.text }))
  on('session.start', async () => ({}))
  on('session.end', async (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('agent.spawn', async () => ({ model: 'm' }))
  for (const c of ['Stop', 'PermissionRequest', 'Notification', 'SubagentStart', 'SubagentStop', 'TeammateIdle']) on(`classic.${c}`, async () => ({}))
  on('http.fetch', async (_$: any, e: any) => {
    sent.attempts = (sent.attempts ?? 0) + 1
    if (opts.down) throw new Error('ECONNREFUSED')
    sent.push({ url: e.url, headers: e.init?.headers ?? {}, body: JSON.parse(e.init?.body) })
    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })
  on('agent.list', async () => ({ value: [{ id: 'a1', type: 'Explore', status: 'running', description: 'look around', extra: 'x' }] }))
  return sent
}

test('turn.complete passes the answer through unchanged and reports the exact text with the tmux session', async ($, on) => {
  const sent = world(on)
  const r = await $.turn.complete({ answer: 'pong', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' } as any)
  expect(r.text).toBe('pong')
  const ev = sent.find(s => s.body.event === 'turn.end')!
  expect(ev.body.text).toBe('pong')
  expect(ev.body.reason).toBe('answer')
  expect(ev.body.session).toBe('my-session')
  expect(ev.body.v).toBe(1)
  expect(ev.body.agentId).toBeUndefined()
})

test('a subagent turn is tagged with its agentId', async ($, on) => {
  const sent = world(on)
  await $.turn.complete({ answer: 'sub says hi', durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer', agentId: 'ag-9' } as any)
  const ev = sent.find(s => s.body.event === 'turn.end')!
  expect(ev.body.agentId).toBe('ag-9')
  expect(sent.some(s => s.body.event === 'agents')).toBe(false)
})

test('the token is sent as a header, to the configured url', async ($, on) => {
  const sent = world(on)
  await $.prompt.submit({ text: 'hello there', wait: false } as any)
  expect(sent.length).toBeGreaterThan(0)
  expect(sent[0]!.headers['x-ghosty-reporter-token']).toBe('tok-123')
  expect(sent[0]!.url).toBe(ENV.GHOSTY_REPORTER_URL)
  expect(sent[0]!.body.event).toBe('prompt')
  expect(sent[0]!.body.text).toBe('hello there')
})

test('a task notification waking the session is marked synthetic, the owner prompt is not', async ($, on) => {
  const sent = world(on)
  await $.prompt.submit({ text: '<task-notification>\n<task-id>x</task-id></task-notification>', wait: false } as any)
  await $.prompt.submit({ text: 'please continue', wait: false } as any)
  const prompts = sent.filter(s => s.body.event === 'prompt')
  expect(prompts.map(p => p.body.synthetic)).toEqual([true, false])
})

test('Stop reports background work in flight, and still passes through', async ($, on) => {
  const sent = world(on)
  await $.classic.Stop({
    stop_hook_active: false,
    last_assistant_message: 'waiting for the build',
    background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'npm test' }],
  } as any)
  const ev = sent.find(s => s.body.event === 'stop')!
  expect(ev.body.backgroundWork).toBe(1)
  expect(ev.body.text).toBe('waiting for the build')
})

test('permission requests and real notifications report waiting; idle reminders do not', async ($, on) => {
  const sent = world(on)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as any)
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' } as any)
  await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' } as any)
  const waits = sent.filter(s => s.body.event === 'waiting')
  expect(waits.length).toBe(2)
  expect(waits[1]!.body.message).toContain('permission')
})

test('agents snapshot is sent when it changes, once', async ($, on) => {
  const sent = world(on)
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' } as any)
  await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'Explore', stop_hook_active: false, agent_transcript_path: '' } as any)
  const snaps = sent.filter(s => s.body.event === 'agents')
  expect(snaps.length).toBe(1)
  expect(snaps[0]!.body.agents[0]).toEqual({ id: 'a1', type: 'Explore', status: 'running', description: 'look around' })
})

test('text is capped at 8 KB', async ($, on) => {
  const sent = world(on)
  await $.turn.complete({ answer: 'é'.repeat(20000), durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' } as any)
  const ev = sent.find(s => s.body.event === 'turn.end')!
  expect(new TextEncoder().encode(ev.body.text).length <= TEXT_CAP).toBe(true)
  expect(cap('short')).toBe('short')
})

test('ghosty down: the hook still passes through, silently, and stops trying for a while', async ($, on) => {
  const sent = world(on, { down: true })
  const r = await $.turn.complete({ answer: 'still here', durationMs: 1, isAborted: false, turnId: 't4', reason: 'answer' } as any)
  expect(r.text).toBe('still here')
  const p = await $.prompt.submit({ text: 'unchanged', wait: false } as any)
  expect(p.text).toBe('unchanged')
  expect(sent.attempts).toBe(1)   // one failed try, then quiet
})

test('no token file: nothing sent, nothing breaks', async ($, on) => {
  const sent = world(on, { noToken: true })
  const r = await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't5', reason: 'answer' } as any)
  expect(r.text).toBe('ok')
  expect(sent.length).toBe(0)
})

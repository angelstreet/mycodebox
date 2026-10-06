import { expect, mock, test } from 'claude-code/testing'
import { cap, hasStatusLine, leaseReleaseArgv, shouldRequireStatus, TEXT_CAP } from './hooks/report.ts'

const ENV = {
  TMUX: '/tmp/tmux-1000/default,1,0',
  TMUX_PANE: '%3',
  HOME: '/home/test',
  GHOSTY_REPORTER_URL: 'http://127.0.0.1:1/api/reporter/event',
}

// Reports are fire-and-forget: let them land before looking at what ghosty received.
const settle = () => new Promise<void>((r) => setTimeout(r, 30))

type Sent = { url: string; headers: Record<string, string>; body: any }

// The world beneath the plugin: env, clock, tmux, token file, ghosty. Returns what ghosty received.
function world(on: any, opts: { down?: boolean; env?: Record<string, string>; noToken?: boolean; tmux?: string; receiveOk?: (e: any) => any } = {}) {
  const sent: Sent[] & { attempts?: number } = []
  sent.attempts = 0
  mock.env(on, { ...ENV, ...(opts.env ?? {}) })
  mock.clock(on, { now: 1_000_000 })
  on('process.run', async (_$: any, e: any) => ({ value: { exitCode: 0, stdout: e.argv?.[0] === 'tmux' ? `${opts.tmux ?? 'my-session'}\n` : '', stderr: '' } }))
  on('fs.read', async () => { if (opts.noToken) throw new Error('ENOENT'); return { value: 'tok-123\n' } })
  // the engine's own bottoms: what each event answers when nobody above changes it
  on('turn.complete', async (_$: any, e: any) => ({ text: e.answer }))
  on('prompt.submit', async (_$: any, e: any) => ({ text: e.text }))
  on('session.start', async () => ({}))
  on('session.end', async (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('session.send', async () => ({ isDelivered: true }))
  on('session.receive', async (_$: any, e: any) => (opts.receiveOk ? opts.receiveOk(e) : { text: e.text }))
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
  await settle()
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
  await settle()
  const ev = sent.find(s => s.body.event === 'turn.end')!
  expect(ev.body.agentId).toBe('ag-9')
  expect(sent.some(s => s.body.event === 'agents')).toBe(false)
})

test('the token is sent as a header, to the configured url', async ($, on) => {
  const sent = world(on)
  await $.prompt.submit({ text: 'hello there', wait: false } as any)
  await settle()
  expect(sent.length).toBeGreaterThan(0)
  expect(sent[0]!.headers['x-ghosty-reporter-token']).toBe('tok-123')
  expect(sent[0]!.url).toBe(ENV.GHOSTY_REPORTER_URL)
  expect(sent[0]!.body.event).toBe('prompt')
  expect(sent[0]!.body.text).toBe('hello there')
})

test('a task notification waking the session is marked synthetic, the owner prompt is not', async ($, on) => {
  const sent = world(on)
  await $.prompt.submit({ text: '<task-notification>\n<task-id>x</task-id></task-notification>', wait: false } as any)
  await settle()
  await $.prompt.submit({ text: 'please continue', wait: false } as any)
  await settle()
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
  await settle()
  const ev = sent.find(s => s.body.event === 'stop')!
  expect(ev.body.backgroundWork).toBe(1)
  expect(ev.body.text).toBe('waiting for the build')
})

test('permission requests and real notifications report waiting; idle reminders do not', async ($, on) => {
  const sent = world(on)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as any)
  await settle()
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' } as any)
  await settle()
  await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' } as any)
  await settle()
  const waits = sent.filter(s => s.body.event === 'waiting')
  expect(waits.length).toBe(2)
  expect(waits[1]!.body.message).toContain('permission')
})

test('agents snapshot is sent when it changes, once', async ($, on) => {
  const sent = world(on)
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' } as any)
  await settle()
  await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'Explore', stop_hook_active: false, agent_transcript_path: '' } as any)
  await settle()
  const snaps = sent.filter(s => s.body.event === 'agents')
  expect(snaps.length).toBe(1)
  expect(snaps[0]!.body.agents[0]).toEqual({ id: 'a1', type: 'Explore', status: 'running', description: 'look around' })
})

test('text is capped at 8 KB', async ($, on) => {
  const sent = world(on)
  await $.turn.complete({ answer: 'é'.repeat(20000), durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' } as any)
  await settle()
  const ev = sent.find(s => s.body.event === 'turn.end')!
  expect(new TextEncoder().encode(ev.body.text).length <= TEXT_CAP).toBe(true)
  expect(cap('short')).toBe('short')
})

test('ghosty down: the hook still passes through, silently, and stops trying for a while', async ($, on) => {
  const sent = world(on, { down: true })
  const r = await $.turn.complete({ answer: 'still here', durationMs: 1, isAborted: false, turnId: 't4', reason: 'answer' } as any)
  await settle()
  expect(r.text).toBe('still here')
  const p = await $.prompt.submit({ text: 'unchanged', wait: false } as any)
  await settle()
  expect(p.text).toBe('unchanged')
  expect(sent.attempts).toBe(1)   // one failed try, then quiet
})

test('no token file: nothing sent, nothing breaks', async ($, on) => {
  const sent = world(on, { noToken: true })
  const r = await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't5', reason: 'answer' } as any)
  await settle()
  expect(r.text).toBe('ok')
  expect(sent.length).toBe(0)
})

const stop = (extra: Record<string, unknown> = {}) => ({ stop_hook_active: false, last_assistant_message: 'All merged and tested.', background_tasks: [], ...extra }) as any

test('Stop without a STATUS line is blocked once, with the format in the reason, and is not reported as a stop', async ($, on) => {
  const sent = world(on)
  const r: any = await $.classic.Stop(stop())
  await settle()
  expect(r.block).toContain('STATUS: done')
  expect(r.block).toContain('needs-owner')
  expect(r.block).toContain('STATUS: done — <useful info')   // the new form: info after the verdict
  expect(r.block).toMatch(/adds the tokens and elapsed time itself/)   // ghosty measures them, the agent must not
  expect(sent.some(s => s.body.event === 'stop')).toBe(false)
})

test('Stop with a STATUS line passes and is reported', async ($, on) => {
  const sent = world(on)
  const r: any = await $.classic.Stop(stop({ last_assistant_message: 'Merged.\n\nSTATUS: done' }))
  await settle()
  expect(r.block).toBeUndefined()
  expect(sent.some(s => s.body.event === 'stop')).toBe(true)
})

test('Stop never loops: stop_hook_active passes', async ($, on) => {
  world(on)
  const r: any = await $.classic.Stop(stop({ stop_hook_active: true }))
  expect(r.block).toBeUndefined()
})

test('Stop is never blocked in the manager session, outside tmux, or with background work in flight', async ($, on) => {
  const sent = world(on)
  expect(shouldRequireStatus(stop(), 'manager')).toBe(false)
  expect(shouldRequireStatus(stop(), null)).toBe(false)
  expect(shouldRequireStatus(stop({ agent_id: 'a1' }), 'my-session')).toBe(false)
  expect(shouldRequireStatus(stop({ background_tasks: [{ id: 'b' }] }), 'my-session')).toBe(false)
  expect(shouldRequireStatus(stop({ last_assistant_message: '' }), 'my-session')).toBe(false)
  expect(shouldRequireStatus(stop({ last_assistant_message: undefined }), 'my-session')).toBe(false)
  expect(shouldRequireStatus(stop(), 'my-session')).toBe(true)
  void sent
})

test('Stop outside tmux (headless) is not blocked', async ($, on) => {
  world(on, { env: { TMUX: '', TMUX_PANE: '' } })
  const r: any = await $.classic.Stop(stop())
  expect(r.block).toBeUndefined()
})

test('Stop in the manager tmux session is not blocked', async ($, on) => {
  world(on, { tmux: 'manager' })
  const r: any = await $.classic.Stop(stop())
  expect(r.block).toBeUndefined()
})

test('every status value is recognised, anywhere in the last 3 lines; prose is not', () => {
  for (const l of ['STATUS: done', 'STATUS: needs-owner: ship it? [1 yes, 2 no]', 'STATUS: blocked: lease held', 'STATUS: handoff: lease -> task58-b by 14:30', 'STATUS: waiting: deploy d-12', '**STATUS: done**', 'STATUS: done — branch x pushed (abc123), tsc pass, left: 3'])
    expect(hasStatusLine(`work\n${l}\n`)).toBe(true)
  expect(hasStatusLine('The status: done is fine')).toBe(false)
  expect(hasStatusLine('STATUS: maybe')).toBe(false)
  expect(hasStatusLine('STATUS: done\na\nb\nc')).toBe(false)
})

test('leaseReleaseArgv: only for a tmux session that really ended, with a safe name', () => {
  const a = leaseReleaseArgv('TASK58-orchestration', 'prompt_input_exit')!
  expect(a[0]).toBe('ssh')
  expect(a[a.length - 1]).toBe('~/bin/vpt-lease release --agent codebox:TASK58-orchestration --by session-end --reason session-ended')
  expect(leaseReleaseArgv('s', undefined)).not.toBeNull()
  expect(leaseReleaseArgv(null, 'logout')).toBeNull()
  expect(leaseReleaseArgv('s', 'clear')).toBeNull()
  expect(leaseReleaseArgv('s', 'resume')).toBeNull()
  expect(leaseReleaseArgv("a b; rm -rf /", 'logout')).toBeNull()
})

test('session.send reports peer.send with capped text and passes through', async ($, on) => {
  const sent = world(on)
  const r = await $.session.send({ to: 'task58-b', text: 'please continue with phase 2', origin: { kind: 'model' } } as any)
  await settle()
  expect(r).toEqual({ isDelivered: true })
  const ev = sent.find(s => s.body.event === 'peer.send')!
  expect(ev.body.to).toBe('task58-b')
  expect(ev.body.text).toBe('please continue with phase 2')
  expect(ev.body.session).toBe('my-session')
  expect(ev.body.agentId).toBeUndefined()
})

test('session.send with agentId is not reported (subagent chatter)', async ($, on) => {
  const sent = world(on)
  const r = await $.session.send({ to: 'lead', text: 'subagent ping', origin: { kind: 'model' }, agentId: 'ag-9' } as any)
  await settle()
  expect(r).toEqual({ isDelivered: true })
  expect(sent.some(s => s.body.event === 'peer.send')).toBe(false)
})

test('session.receive with origin kind peer reports peer.recv and passes through', async ($, on) => {
  const sent = world(on)
  const r: any = await $.session.receive({ origin: { kind: 'peer', plugin: 'claude-code' }, text: 'a note from a teammate' } as any)
  await settle()
  expect(r.text).toBe('a note from a teammate')
  const ev = sent.find(s => s.body.event === 'peer.recv')!
  expect(ev.body.text).toBe('a note from a teammate')
  expect(ev.body.kind).toBe('peer')
  expect(ev.body.session).toBe('my-session')
  expect(ev.body.agentId).toBeUndefined()
})

test('session.receive with origin kind peer-send-message reports peer.recv', async ($, on) => {
  const sent = world(on)
  await $.session.receive({ origin: { kind: 'peer-send-message' }, text: 'delivered from SendMessage' } as any)
  await settle()
  const ev = sent.find(s => s.body.event === 'peer.recv')!
  expect(ev.body.kind).toBe('peer-send-message')
})

test('session.receive with origin kind bridge is not reported as peer', async ($, on) => {
  const sent = world(on)
  const r: any = await $.session.receive({ origin: { kind: 'bridge' }, text: 'a Remote Control prompt' } as any)
  await settle()
  expect(r.text).toBe('a Remote Control prompt')
  expect(sent.some(s => s.body.event === 'peer.recv')).toBe(false)
})

test('session.receive with agentId is not reported (subagent chatter)', async ($, on) => {
  const sent = world(on)
  await $.session.receive({ origin: { kind: 'peer' }, text: 'inbound to subagent', agentId: 'ag-9' } as any)
  await settle()
  expect(sent.some(s => s.body.event === 'peer.recv')).toBe(false)
})

test('peer.send text is capped to 8 KB', async ($, on) => {
  const sent = world(on)
  await $.session.send({ to: 'task58-b', text: 'é'.repeat(20000), origin: { kind: 'model' } } as any)
  await settle()
  const ev = sent.find(s => s.body.event === 'peer.send')!
  expect(new TextEncoder().encode(ev.body.text).length <= TEXT_CAP).toBe(true)
})

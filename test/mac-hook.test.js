// Round 9 item 1: scripts/mac-stop-hook.sh against a fake server (sh + curl + awk in a temp HOME). Skipped when sh or curl is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { validateStop } from '../remote-stops.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HOOK = path.join(ROOT, 'scripts', 'mac-stop-hook.sh');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'mac-transcript.jsonl');
const have = (c) => spawnSync('sh', ['-c', `command -v ${c}`]).status === 0;
const skip = !have('curl') || !have('awk') || !have('sed') ? 'sh, curl, awk and sed are needed for the hook script tests' : false;
const TOKEN = 'tok-hook-0123456789abcdef';   // leak-scan: allow (fake test token)

// a fake manager: records requests, answers according to `mode`
async function fake(mode) {
  const seen = { posts: [], polls: 0, auth: [] };
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      seen.auth.push(req.headers.authorization);
      const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.method === 'POST') {
        seen.posts.push(JSON.parse(b));
        return send({ ok: true, id: '11111111-2222-3333-4444-555555555555', session: 'mac:cache-work', wait_max_s: 8, answerable: mode !== 'noanswer' });
      }
      seen.polls += 1;
      if (mode === 'answer') return send({ ok: true, state: 'answered', answer: 'Go with option 1 "in memory".\nThanks' });
      if (mode === 'pending-then-answer' && seen.polls === 1) return send({ ok: true, state: 'pending' });
      if (mode === 'pending-then-answer') return send({ ok: true, state: 'answered', answer: 'second poll' });
      return send({ ok: true, state: 'none', reason: 'escalated to the owner' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

function setup({ url, token = TOKEN, mode = 0o600, transcript = FIXTURE, extraIn = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-hook-'));
  const cfg = path.join(home, '.config', 'mycodebox');
  fs.mkdirSync(cfg, { recursive: true });
  if (url) fs.writeFileSync(path.join(cfg, 'config'), `# test\nurl = ${url}\nwait = 6\n`);
  if (token !== null) { fs.writeFileSync(path.join(cfg, 'token'), `${token}\n`); fs.chmodSync(path.join(cfg, 'token'), mode); }
  const input = JSON.stringify({ session_id: 'sid-fixture-aaaa-1111', transcript_path: transcript, cwd: home, hook_event_name: 'Stop', stop_hook_active: false, ...extraIn });
  return { home, input };
}
const run = (args, { home, input }, env = {}) => new Promise((resolve) => {
  const p = spawn('sh', [HOOK, ...args], { env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, ...env } });
  let out = '', err = '';
  p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
  p.on('close', (code) => resolve({ code, out, err }));
  // the kill switches exit before reading stdin: under load the write then fails with EPIPE, which is not a test failure (this was the 1-in-3 flake)
  p.stdin.on('error', () => {});
  p.stdin.end(input);
});

test('dry run: the payload carries the last assistant text from the transcript fixture, machine, project, session name and prompt time', { skip }, async () => {
  const s = setup({ url: 'http://127.0.0.1:1' });
  const r = await run(['--dry-run'], s);
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.out.trim().split('\n')[0]);
  assert.equal(payload.text, 'Two ways to store the "cache":\n\n1. In memory (recommended)\n2. On disk — survives restarts\n\nWhich storage should I use?');
  assert.equal(payload.session_id, 'sid-fixture-aaaa-1111');
  assert.equal(payload.session_name, 'cache-work');
  assert.equal(payload.stop_hook_active, false);
  assert.equal(payload.prompt_at, '2026-10-15T08:30:00.000Z', 'the last real owner prompt, not the tool_result');
  assert.ok(payload.machine && payload.project, 'machine and project are filled');
  assert.match(r.err, /dry run/);
  assert.ok(!r.out.includes(TOKEN) && !r.err.includes(TOKEN), 'the token is never printed');
});

test('hook JSON last_assistant_message wins over the transcript; stop_hook_active is passed on; an oversized text keeps its tail', { skip }, async () => {
  const s = setup({ url: 'http://127.0.0.1:1', extraIn: { last_assistant_message: `${'x'.repeat(20000)} end "quoted" END`, stop_hook_active: true } });
  const payload = JSON.parse((await run(['--dry-run'], s)).out.trim().split('\n')[0]);
  assert.ok(payload.text.endsWith('end "quoted" END'));
  assert.ok(payload.text.length <= 12000);
  assert.equal(payload.stop_hook_active, true);
});

test('answer: the hook posts with the bearer token and prints the block decision', { skip }, async () => {
  const f = await fake('answer');
  try {
    const r = await run([], setup({ url: f.url }));
    assert.equal(r.code, 0);
    assert.equal(f.seen.posts.length, 1);
    assert.equal(f.seen.auth[0], `Bearer ${TOKEN}`);
    assert.match(f.seen.posts[0].text, /Which storage should I use\?$/);
    const out = JSON.parse(r.out.trim());
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /on behalf of the owner/);
    assert.match(out.reason, /Go with option 1 "in memory"\.\nThanks$/);
    assert.ok(!r.err.includes(TOKEN));
  } finally { await f.close(); }
});

test('a pending answer is polled again; an escalated stop prints nothing and exits 0', { skip }, async () => {
  const f = await fake('pending-then-answer');
  try {
    const r = await run([], setup({ url: f.url }));
    assert.equal(JSON.parse(r.out.trim()).reason.endsWith('second poll'), true);
    assert.equal(f.seen.polls, 2);
  } finally { await f.close(); }
  const g = await fake('none');
  try {
    const r = await run([], setup({ url: g.url }));
    assert.equal(r.code, 0); assert.equal(r.out, '');
    assert.equal(g.seen.posts.length, 1);
  } finally { await g.close(); }
});

test('loop guard: with stop_hook_active the stop is posted but the hook never waits or answers', { skip }, async () => {
  const f = await fake('answer');
  try {
    const r = await run([], setup({ url: f.url, extraIn: { stop_hook_active: true } }));
    assert.equal(r.code, 0); assert.equal(r.out, '');
    assert.equal(f.seen.posts[0].stop_hook_active, true);
    assert.equal(f.seen.polls, 0);
  } finally { await f.close(); }
});

test('fail open and no token: a missing token file, a world-readable one, no URL, a dead server all exit 0 and send nothing', { skip }, async () => {
  const f = await fake('answer');
  try {
    for (const s of [setup({ url: f.url, token: null }), setup({ url: f.url, mode: 0o644 }), setup({ url: f.url, mode: 0o640 }), setup({ url: undefined })]) {
      const r = await run([], s);
      assert.equal(r.code, 0); assert.equal(r.out, '');
    }
    assert.equal(f.seen.posts.length, 0, 'nothing reached the server');
    const dead = await run([], setup({ url: 'http://127.0.0.1:1' }));
    assert.equal(dead.code, 0); assert.equal(dead.out, '');
    const broken = await run([], { ...setup({ url: f.url }), input: 'not json at all' });
    assert.equal(broken.code, 0);
    const noTranscript = await run([], setup({ url: f.url, transcript: '/nonexistent/transcript.jsonl' }));
    assert.equal(noTranscript.code, 0); assert.equal(f.seen.posts.length, 0);
  } finally { await f.close(); }
});

test('the kill switches: MYCODEBOX_HOOK=off and the "disabled" file', { skip }, async () => {
  const f = await fake('answer');
  try {
    const s = setup({ url: f.url });
    assert.equal((await run([], s, { MYCODEBOX_HOOK: 'off' })).out, '');
    fs.writeFileSync(path.join(s.home, '.config', 'mycodebox', 'disabled'), '');
    assert.equal((await run([], s)).out, '');
    assert.equal(f.seen.posts.length, 0);
  } finally { await f.close(); }
});

test('dry-run output with awkward names ("[TASK72] fix", _proj, non-ASCII) is accepted by the intake and slugged', { skip }, async () => {
  const s = setup({ url: 'http://127.0.0.1:1' });
  const cwd = path.join(s.home, '_proj \u00e9t\u00e9 \u4e2d\u6587');
  fs.mkdirSync(cwd);
  const tp = path.join(s.home, 't.jsonl');
  fs.writeFileSync(tp, fs.readFileSync(FIXTURE, 'utf8').replace('cache-work', '[TASK72] fix'));
  const input = JSON.stringify({ session_id: 'sid-awkward-1111', transcript_path: tp, cwd, stop_hook_active: false });
  const r = await run(['--dry-run'], { home: s.home, input }, { MYCODEBOX_CONFIG_DIR: path.join(s.home, '.config', 'mycodebox') });
  const payload = JSON.parse(r.out.trim().split('\n')[0]);
  const v = validateStop(payload);
  assert.ok(v.ok, v.error);
  assert.equal(v.v.project, '_proj-ete');
  assert.equal(v.v.session_name, 'TASK72-fix');
});

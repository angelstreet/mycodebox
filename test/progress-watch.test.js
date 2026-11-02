// Progress watch (progress-watch.js): the loop and no-progress rules are pure; the poller records one `no-progress` event per session
// per cooldown in live mode, journals only in dry mode, and leaves a session alone when any trace of work exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers-tmp.js';
import { loopOf, noProgressOf, createProgressWatch, LOOP_REPEATS } from '../progress-watch.js';

const call = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const result = (text, err = true) => ({ type: 'user', message: { content: [{ type: 'tool_result', is_error: err, content: text }] } });

test('loopOf: the same tool call 4 times in the last 10 is a loop; varied calls or an old repeat are not', () => {
  const same = Array.from({ length: LOOP_REPEATS }, () => call('Bash', { command: 'npm test' }));
  const varied = ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => call('Bash', { command: c }));
  assert.equal(loopOf([...varied, ...same]).kind, 'loop');
  assert.match(loopOf([...varied, ...same]).what, /tool call Bash/);
  assert.equal(loopOf(varied), null);
  assert.equal(loopOf([...same, ...varied, ...varied]), null, 'the repeat fell out of the last 10');
  // input key order does not matter
  const x = [call('Read', { a: 1, b: 2 }), call('Read', { b: 2, a: 1 }), call('Read', { a: 1, b: 2 }), call('Read', { b: 2, a: 1 })];
  assert.equal(loopOf(x)?.times, 4);
});

test('loopOf: the same error text 4 times is a loop; errors in an array content are read; successes are not errors', () => {
  const errs = Array.from({ length: 4 }, () => result([{ type: 'text', text: 'Error: ENOENT no such file  x.js' }]));
  assert.match(loopOf(errs).what, /^error Error: ENOENT/);
  assert.equal(loopOf(Array.from({ length: 6 }, () => result('ok', false))), null);
  assert.equal(loopOf([{ type: 'assistant', message: { content: 'plain text' } }, null, {}]), null);
});

test('noProgressOf: only a long working session with no child, no commit since it started, no recent file change and a quiet transcript', () => {
  const base = { workingMin: 90, busy: false, lastCommitMin: 200, lastChangeMin: 150, transcriptMin: 30 };
  assert.equal(noProgressOf(base).kind, 'no-progress');
  assert.equal(noProgressOf({ ...base, workingMin: 30 }), null, 'not long enough');
  assert.equal(noProgressOf({ ...base, busy: true }), null, 'a child process is a tracked job');
  assert.equal(noProgressOf({ ...base, lastCommitMin: 10 }), null, 'a commit since it started working');
  assert.equal(noProgressOf({ ...base, lastChangeMin: 5 }), null, 'a file changed in the window');
  assert.equal(noProgressOf({ ...base, transcriptMin: 2 }), null, 'the transcript still moves');
  assert.equal(noProgressOf({ ...base, transcriptMin: null, lastCommitMin: null, lastChangeMin: null }).kind, 'no-progress', 'no transcript (Codex / MiniMax), no commit, no change: judged on the rest');
  assert.equal(noProgressOf({ ...base, workingMin: null }), null);
  assert.equal(noProgressOf(null), null);
});

function world({ mode = 'live', targets, facts, git, tail } = {}) {
  const dir = tmp('ghosty-progress-');
  const w = { t: 1_700_000_000_000, events: [], dir };
  w.pw = createProgressWatch({
    stateDir: dir,
    listTargets: async () => targets ?? [{ name: 's1', cwd: '/w/s1', working: true }],
    facts: async () => facts ?? new Map([['s1', { workingSinceMs: w.t - 90 * 60000, busy: false, transcript: null }]]),
    git: git ?? (async () => ({ lastCommitAt: w.t - 200 * 60000, lastChangeAt: null })),
    tail: tail ?? (async () => null),
    record: async (e) => { w.events.push(e); },
    mode: () => mode,
    now: () => w.t,
    log: { error() {} },
  });
  return w;
}

test('live: one no-progress event with the evidence, then silence for the cooldown, then again', async () => {
  const w = world();
  let s = await w.pw.tick();
  assert.equal(s.found.length, 1);
  assert.equal(w.events.length, 1);
  assert.equal(w.events[0].key, 's1:no-progress');
  assert.match(w.events[0].title, /s1: no progress for 90 min/);
  assert.match(w.events[0].body, /Never Esc/);
  assert.equal(w.events[0].progress.kind, 'no-progress');
  assert.ok(w.events[0].items.some((x) => /working for 90 min/.test(x)));
  w.t += 60 * 60000;
  s = await w.pw.tick();
  assert.equal(s.found.length, 1, 'still listed');
  assert.equal(w.events.length, 1, 'no second event inside the cooldown');
  w.t += 61 * 60000;
  await w.pw.tick();
  assert.equal(w.events.length, 2, 'told again after 2 h');
  assert.ok(existsSync(join(w.dir, 'progress-watch.json')));
  assert.equal(readFileSync(join(w.dir, 'progress-watch.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('dry: the finding is listed and journaled, no event; off: nothing is checked', async () => {
  const w = world({ mode: 'dry' });
  const s = await w.pw.tick();
  assert.equal(s.found.length, 1);
  assert.equal(w.events.length, 0);
  assert.match(readFileSync(join(w.dir, 'progress-watch.jsonl'), 'utf8'), /"mode":"dry"/);
  const o = world({ mode: 'off' });
  assert.deepEqual((await o.pw.tick()).found, []);
  assert.equal(o.events.length, 0);
});

test('a loop in the transcript is reported even when the session has a child process; a busy or committing session is left alone', async () => {
  const loop = world({ facts: new Map([['s1', { workingSinceMs: 1, busy: true, transcript: '/t/s1.jsonl' }]]),
    tail: async () => ({ mtime: 0, records: Array.from({ length: 5 }, () => call('Bash', { command: 'pytest -x' })) }) });
  const s = await loop.pw.tick();
  assert.equal(s.found[0].kind, 'loop');
  assert.match(loop.events[0].title, /s1: repeats the same tool call/);
  const busy = world({ facts: new Map([['s1', { workingSinceMs: 1, busy: true, transcript: null }]]) });
  assert.deepEqual((await busy.pw.tick()).found, []);
  const fresh = world({ git: async () => ({ lastCommitAt: 1_700_000_000_000 - 5 * 60000, lastChangeAt: null }) });
  assert.deepEqual((await fresh.pw.tick()).found, []);
  const idle = world({ targets: [{ name: 's1', cwd: '/w/s1', working: false }] });
  assert.deepEqual((await idle.pw.tick()).found, []);
});

test('a reader that throws for one session does not stop the tick for the others', async () => {
  const w = world({
    targets: [{ name: 'bad', cwd: '/w/bad', working: true }, { name: 's1', cwd: '/w/s1', working: true }],
    facts: new Map([['bad', { workingSinceMs: 1, busy: false, transcript: '/t/bad.jsonl' }], ['s1', { workingSinceMs: 1_700_000_000_000 - 90 * 60000, busy: false, transcript: null }]]),
    tail: async () => { throw new Error('unreadable'); },
  });
  const s = await w.pw.tick();
  assert.deepEqual(s.found.map((f) => f.session), ['s1']);
  assert.equal(s.error, null);
});

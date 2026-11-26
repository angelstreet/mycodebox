// bug-81f093be: on a Claude Team / Enterprise account the built-in cc-plugin-sec-default sends every classic.* hook past the
// reporter plugin, so ghosty gets no `stop` event. This replays what such a session does send and checks the done check still works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReporter } from '../reporter.js';
import { createDoneCheck } from '../done-check.js';
import { isSynthetic, payload } from '../claude-plugin/ghosty-reporter/hooks/report.ts';

const LINE = 'STATUS: done — pong · closing review: docs none needed · leftovers none · unverified none · bugs: none';
// the notice the engine queues for a skipped hook, as captured from a team session (2.1.332)
const NOTICE = '<task-notification>\nghosty-reporter: its classic.PostToolUse hook was skipped. "cc-plugin-sec-default" runs first and sent the event on past it.\n</task-notification>';

async function teamTurn(t) {
  const dir = mkdtempSync(join(tmpdir(), 'team-reporter-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = Date.now();
  const reporter = createReporter({ stateDir: dir, now: () => clock, saveMs: 1 });
  await reporter.init();
  const ev = (event, data = {}) => { clock += 100; reporter.ingest(payload(event, { session: 'team-s', sessionId: 'id-1', cwd: '/w/t59' }, clock, data)); };
  ev('session.start', { interactive: true });
  ev('prompt', { text: 'do it', synthetic: false });
  ev('prompt', { text: NOTICE, midTurn: true, synthetic: isSynthetic(NOTICE) });
  ev('turn.end', { text: LINE, reason: 'answer' });   // no `stop` follows
  await reporter.flush();
  return { reporter, dir, stopSince: clock };
}

function check(t, { reporter, dir }, extra = {}, unmerged = 'cdc80ab3a\tfix: a\n') {
  const sent = [];
  const git = async (cwd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') return args[2] === '--git-dir' ? '/r/.git/worktrees/t59\n' : '/r/.git\n';
    if (args[0] === 'rev-parse') return args[1] === '-q' ? 'abc\n' : 'task59\n';
    return args[0] === 'log' ? unmerged : '';
  };
  const w = createDoneCheck({ stateDir: dir, git, log: { error() {} }, pressure: () => ({ loadPerCore: 0.2, ramAvailPct: 60 }),
    // as server.js listDone: closing text from the reported turn, working from the reporter
    listDone: async () => [{ name: 'team-s', cwd: '/w/t59', text: reporter.turnForStop('team-s', Date.now() - 1000)?.text || '', working: !!reporter.activityOf('team-s')?.working }],
    send: async (n, text) => { sent.push([n, text]); }, ...extra });
  return { w, sent };
}

test('team account: turn.end alone gives the closing text and an idle session, and the skip notice is not an owner reply', async (t) => {
  const { reporter, stopSince } = await teamTurn(t);
  assert.equal(reporter.turnForStop('team-s', stopSince).text, LINE);
  assert.equal(reporter.activityOf('team-s').working, false);
  assert.equal(reporter.activityOf('team-s').backgroundWork, 0);
  assert.equal(reporter.promptSince('team-s', stopSince - 1000)?.text, 'do it');
});

test('team account: the done check still tells a done line that git disagrees with', async (t) => {
  const h = check(t, await teamTurn(t));
  await h.w.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0][1], /1 commit\(s\) on task59 not on main/);
});

test('team account: a background job the harness sees itself still stops a done line (no reporter count)', async (t) => {
  const h = check(t, await teamTurn(t), { stateMode: () => 'live', stopFacts: async () => ({ bgJobs: 1 }) }, '');
  await h.w.tick();
  assert.match(h.sent[0][1], /running/i);
});

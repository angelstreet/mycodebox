// Closing review (owner, 2026-11-10): a `STATUS: done` line carries `closing review: docs ... · leftovers ... · unverified ...`;
// a done line without it gets one automatic push with the owner's checklist question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers-tmp.js';
import { closingReviewOf, closingReviewMessage, leftoverItemsOf, createDoneCheck, REVIEW_PUSHES_PER_DAY } from '../done-check.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FULL = 'STATUS: done — merged · closing review: docs none needed · leftovers none · unverified none · bugs: none';

test('closingReviewOf: all none is accepted; lists and filed ids parse; missing segment or part is missing; other statuses null', () => {
  assert.deepEqual(closingReviewOf(FULL), { docs: 'none needed', leftovers: 'none', unverified: 'none', openLeftovers: null });
  const r = closingReviewOf('STATUS: done — m · closing review: docs REFERENCE.md, AGENTS.md · leftovers filed bug-1a2b3c4d, bug-0f0f0f0f\n  · unverified live push on a real pane · bugs: none');
  assert.equal(r.docs, 'REFERENCE.md, AGENTS.md');
  assert.equal(r.openLeftovers, null);
  assert.equal(r.unverified, 'live push on a real pane');
  assert.equal(closingReviewOf('STATUS: done · **closing review:** docs none needed; leftovers none; unverified none').openLeftovers, null);
  assert.deepEqual(closingReviewOf('STATUS: done — merged; bugs: none'), { missing: true, parts: ['docs', 'leftovers', 'unverified'] });
  assert.deepEqual(closingReviewOf('STATUS: done · closing review: docs none needed'), { missing: true, parts: ['leftovers', 'unverified'] });
  assert.equal(closingReviewOf('STATUS: waiting: integration int-1'), null);
  assert.equal(closingReviewOf('STATUS: acknowledged'), null);
  assert.equal(closingReviewOf('no status'), null);
});

test('closingReviewOf: leftovers that are neither none nor filed ids are open, and the leftovers push picks them up', () => {
  const t = 'STATUS: done · closing review: docs none needed · leftovers retry the deploy later · unverified none · bugs: none';
  assert.equal(closingReviewOf(t).openLeftovers, 'retry the deploy later');
  assert.deepEqual(leftoverItemsOf(t), ['closing review leftovers: retry the deploy later']);
  assert.deepEqual(leftoverItemsOf(FULL), []);
});

test('closingReviewMessage: the owner checklist, the four steps, the segment; asks for the bugs field only when missing', () => {
  const m = closingReviewMessage();
  for (const re of [/any leftover, suggestion of improvement, or doc \/ skill to update/, /found-bug/, /did NOT verify/, /closing review: docs <updated list\|none needed> · leftovers <none\|filed ids> · unverified <none\|list>/, /scratchpad/]) assert.match(m, re);
  assert.doesNotMatch(m, /bugs: none \| fixed/);
  assert.match(closingReviewMessage({ bugsMissing: true }), /bugs: none \| fixed <what> \| reported <id>/);
});

function harness(sessions, over = {}) {
  const dir = tmp('ghosty-closing-review-'); const sent = []; let now = Date.parse('2026-11-10T08:00:00Z');
  const git = async (cwd, args) => { if (args[0] === 'rev-parse' && args[1] === '-q') { if (args[3] === 'origin/main') return 'abc\n'; throw new Error('no ref'); } if (args[0] === 'rev-parse' && args[2] === '--git-dir') return `/r/.git/worktrees${cwd}\n`; if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') return '/r/.git\n'; if (args[0] === 'rev-parse') return 'main\n'; return ''; };
  const w = createDoneCheck({ stateDir: dir, git, listDone: async () => sessions, send: async (n, x) => { sent.push([n, x]); }, now: () => now, log: { error() {} }, pressure: () => ({ loadPerCore: 0.1, ramAvailPct: 80 }), ...over });
  return { w, sent, sessions, advance: (ms) => { now += ms; }, dir };
}

test('done-check: a done without the segment gets one push per turn (bugs field folded in); with it, none', async () => {
  const h = harness([{ name: 'a', cwd: '/w/a', text: 'STATUS: done — merged' }, { name: 'b', cwd: '/w/b', text: FULL }, { name: 'c', cwd: '/w/c', text: 'STATUS: done — merged; bugs: none' }]);
  const r = await h.w.tick(); await h.w.tick();
  assert.deepEqual(h.sent.map((x) => x[0]), ['a', 'c']);
  assert.match(h.sent[0][1], /no closing review/);
  assert.match(h.sent[0][1], /bugs: none \| fixed/, 'a lacks the bugs field too: one push asks for both');
  assert.doesNotMatch(h.sent[1][1], /bugs: none \| fixed/);
  assert.deepEqual(r.missingClosingReview, ['a', 'c']);
  assert.deepEqual(r.missingBugsField, [], 'no separate bugs push for a session the closing review push covers');
  const j = fs.readFileSync(path.join(h.dir, 'done-check.jsonl'), 'utf8');
  assert.match(j, /"closingReview":"missing"/);
});

test('done-check: a new done line is a new turn (pushed again), capped per day; working, draft and dry are not pushed', async () => {
  const s = { name: 'a', cwd: '/w/a', text: 'STATUS: done — v1; bugs: none' };
  const h = harness([s]);
  for (let i = 0; i < REVIEW_PUSHES_PER_DAY + 2; i++) { s.text = `STATUS: done — v${i}; bugs: none`; await h.w.tick(); }
  assert.equal(h.sent.length, REVIEW_PUSHES_PER_DAY);
  h.advance(24 * 3600e3); s.text = 'STATUS: done — next day; bugs: none';
  await h.w.tick(); assert.equal(h.sent.length, REVIEW_PUSHES_PER_DAY + 1);
  for (const extra of [{ working: true }, { draft: true }]) {
    const x = harness([{ name: 'a', cwd: '/w/a', text: 'STATUS: done', ...extra }]);
    await x.w.tick(); assert.equal(x.sent.length, 0, JSON.stringify(extra));
  }
  const old = harness([{ name: 'a', cwd: '/w/a', text: 'STATUS: done; bugs: none', doneAt: Date.parse('2026-11-09T08:00:00Z') }]);
  await old.w.tick(); assert.equal(old.sent.length, 0, 'a done turn older than 6 h is not reopened');
  const d = harness([{ name: 'a', cwd: '/w/a', text: 'STATUS: done' }], { mode: () => 'dry' });
  await d.w.tick(); assert.equal(d.sent.length, 0);
});

test('done-check: a done with listed leftovers gets the leftovers push, not the closing review one', async () => {
  const h = harness([{ name: 'a', cwd: '/w/a', text: 'Left to do:\n- wire the endpoint\n\nSTATUS: done — partly; bugs: none' }]);
  await h.w.tick();
  assert.equal(h.sent.length, 1); assert.match(h.sent[0][1], /work is still left/);
});

test('status scan prints done-without-closing-review; AGENTS.md and cbsession carry the segment', () => {
  const home = tmp('cr-scan-'); const bin = path.join(home, 'bin'), panes = path.join(home, 'panes'); fs.mkdirSync(bin); fs.mkdirSync(panes);
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\ncase "$1" in\n  list-sessions) ls ${panes} ;;\n  capture-pane) while [ $# -gt 0 ]; do [ "$1" = "-t" ] && t="$2"; shift; done; cat "${panes}/\${t%:}" ;;\n  *) exit 1 ;;\nesac\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(panes, 'w1'), 'STATUS: done — merged; bugs: none\n');
  fs.writeFileSync(path.join(panes, 'w2'), FULL + '\n');
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'manager-status-scan.sh')], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, PORT: '1' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'w1: done-without-closing-review');
  const seg = /closing review: docs <updated list\|none needed> · leftovers <none\|filed ids> · unverified <none\|list>/;
  assert.match(fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8'), seg);
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts', 'cbsession'), 'utf8'), seg);
});

test('filed ids with a note in brackets are filed, not open leftovers (2026-11-11: 3 false pushes)', async () => {
  const { closingReviewOf } = await import('../done-check.js');
  const line = (l) => `STATUS: done — x · closing review: docs none needed · leftovers ${l} · unverified none · bugs: none`;
  assert.equal(closingReviewOf(line("bug-298c8750 (host-or-device: the owner's Mac)")).openLeftovers, null);
  assert.equal(closingReviewOf(line('bug-db063be2 (monitor misses under load, pi1 load fix pending), bug-1f68929e (ad-break false zap, filed large)')).openLeftovers, null);
  assert.equal(closingReviewOf(line('filed: bug-12073c5a (filed, radio edge owner)')).openLeftovers, null);
  assert.equal(closingReviewOf(line('bug-12073c5a and run the stb4 check')).openLeftovers, 'bug-12073c5a and run the stb4 check', 'work named next to an id is still open');
  assert.equal(closingReviewOf(line('re-run stb4 (not done)')).openLeftovers, 're-run stb4 (not done)');
});

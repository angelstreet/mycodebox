// Found-bugs enforcement (owner, 2026-10-28): (A) the done STATUS carries `bugs:`, (B) every launcher and worker brief carries the rule,
// (C) rules-watch re-read notices do not wake the manager.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers-tmp.js';
import { bugsFieldOf, bugsMessage, createDoneCheck } from '../done-check.js';
import { message as rulesMessage, TAG } from '../rules-watch.js';
import { isRulesAck, createManagerEvents } from '../manager-events.js';
import { developerPrompt, reviewerPrompt, BUG_NOTE } from '../orchestration/roles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('bugsFieldOf: none / fixed / reported pass, a done without the field is missing, other statuses are not checked', () => {
  assert.deepEqual(bugsFieldOf('x\nSTATUS: done — merged; bugs: none'), { value: 'none' });
  assert.deepEqual(bugsFieldOf('STATUS: done — merged; bugs: fixed the retry counter'), { value: 'fixed' });
  assert.deepEqual(bugsFieldOf('STATUS: done — merged\n  and deployed; bugs: reported bug-1a2b3c4d'), { value: 'reported' });
  assert.deepEqual(bugsFieldOf('STATUS: done — merged and deployed'), { missing: true });
  assert.deepEqual(bugsFieldOf('STATUS: done'), { missing: true });
  assert.equal(bugsFieldOf('STATUS: acknowledged'), null);
  assert.equal(bugsFieldOf('STATUS: blocked: host down'), null);
  assert.equal(bugsFieldOf('no status at all'), null);
  assert.match(bugsMessage(), /bugs: none \| fixed <what> \| reported <id>/);
  assert.match(bugsMessage(), /found-bug/);
});

function harness(t, sessions, over = {}) {
  const dir = tmp('ghosty-bugs-field-'); const sent = []; let now = 1e12;
  const git = async (cwd, args) => { if (args[0] === 'rev-parse' && args[1] === '-q') { if (args[3] === 'origin/main') return 'abc\n'; throw new Error('no ref'); } if (args[0] === 'rev-parse' && args[2] === '--git-dir') return `/r/.git/worktrees${cwd}\n`; if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') return '/r/.git\n'; if (args[0] === 'rev-parse') return 'main\n'; return ''; };
  const w = createDoneCheck({ stateDir: dir, git, listDone: async () => sessions, send: async (n, x) => { sent.push([n, x]); }, now: () => now, log: { error() {} }, pressure: () => ({ loadPerCore: 0.1, ramAvailPct: 80 }), ...over });
  return { w, sent, advance: (ms) => { now += ms; } };
}

test('done-check: a clean done without the bugs field gets exactly one push; with the field, none; once per 12 h', async (t) => {
  const h = harness(t, [{ name: 'a', cwd: '/w/a', text: 'STATUS: done — merged' }, { name: 'b', cwd: '/w/b', text: 'STATUS: done — merged; bugs: none' }]);
  const r = await h.w.tick(); await h.w.tick();
  assert.deepEqual(h.sent.map((x) => x[0]), ['a']);
  assert.match(h.sent[0][1], /no bugs field/);
  assert.deepEqual(r.missingBugsField, ['a']);
  h.advance(13 * 3600e3);
  await h.w.tick();
  assert.equal(h.sent.length, 2, 'a session still without the field is pushed again after the cooldown');
});

test('done-check: a working session and dry mode are not pushed', async (t) => {
  const h = harness(t, [{ name: 'a', cwd: '/w/a', text: 'STATUS: done', working: true }]);
  await h.w.tick(); assert.equal(h.sent.length, 0);
  const d = harness(t, [{ name: 'a', cwd: '/w/a', text: 'STATUS: done' }], { mode: () => 'dry' });
  await d.w.tick(); assert.equal(d.sent.length, 0);
});

test('rules-watch: the notice is tagged, asks for no reply and never invites a question; it carries the bugs rule', () => {
  const m = rulesMessage({ hash: 'a'.repeat(40), at: 1e12, subject: 's' });
  assert.ok(m.startsWith(TAG));
  assert.match(m, /Do not answer this message and do not ask anything/);
  assert.match(m, /STATUS: acknowledged/);
  assert.match(m, /found-bug/);
  assert.doesNotMatch(m, /\?/);
});

test('isRulesAck: the acknowledgement of a re-read is not a wake; a real question or a blocked stop is', () => {
  assert.equal(isRulesAck('Re-read AGENTS.md. Nothing pending. STATUS: waiting: integration int-abc'), true);
  assert.equal(isRulesAck('[rules-watch: no reply needed] read it, carrying on'), true);
  assert.equal(isRulesAck('Should I re-read AGENTS.md before the deploy?'), false);
  assert.equal(isRulesAck('STATUS: needs-owner: the AGENTS.md re-read says to delete data'), false);
  assert.equal(isRulesAck('STATUS: waiting: deploy d-12 to finish'), false);
  assert.equal(isRulesAck(''), false);
});

test('feed: an asks / waiting event that only acknowledges the re-read is dropped; the same kinds with real content stay', async () => {
  const me = createManagerEvents({ stateDir: tmp('ghosty-ack-') });
  assert.equal(await me.record({ key: 's1:waiting', title: 's1 waiting', body: 'Re-read AGENTS.md, nothing changes for me. STATUS: waiting: integration int-1' }), false);
  assert.equal(await me.record({ key: 's1:asks', title: 's1 asks', body: 'I re-read AGENTS.md. STATUS: acknowledged' }), false);
  assert.equal(await me.record({ key: 's1:waiting', title: 's1 waiting', body: 'STATUS: waiting: deploy d-12' }), true);
  assert.equal((await me.tail()).length, 1);
});

const home = tmp('cbp-b-'); const work = join(home, 'work'); fs.mkdirSync(work);
const handover = join(home, 'h.md'); fs.writeFileSync(handover, '# h\n'); const pfile = join(home, 'p.md'); fs.writeFileSync(pfile, 'do the thing\n');
const bin = join(home, 'bin'); fs.mkdirSync(bin); for (const c of ['tmux', 'mcode']) fs.writeFileSync(join(bin, c), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });   // mcode stub: the minimax dry run looks for it
const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, GHOSTY_STATE_DIR: join(home, 'state') };
const prompt = (name, ...a) => { const r = spawnSync('bash', [join(ROOT, 'scripts', 'cbsession'), '-x', '-n', name, '-d', work, ...a], { encoding: 'utf8', env }); assert.equal(r.status, 0, name + ': ' + r.stderr + r.stdout); return fs.readFileSync(join(home, 'handovers', `${name}.prompt.md`), 'utf8'); };

test('cbsession: every provider and every prompt source (-H, -f, -t) gets the bug rule and the bugs: field', () => {
  for (const prov of ['claude', 'codex', 'minimax', 'opencode']) {
    for (const [i, src] of [['-H', handover], ['-f', pfile], ['-t', 'do the thing']].entries()) {
      const p = prompt(`b-${prov}-${i}`, '-p', prov, ...src);
      assert.match(p, /found-bug --title/, `${prov} ${src[0]}`);
      assert.match(p, /bugs: none \| fixed <what> \| reported <id>/, `${prov} ${src[0]}`);
    }
  }
});

test('V2 worker briefs (developer and reviewer, every provider shares them) carry the bug note', () => {
  const task = { goal: 'g', scope: 's', definition_of_done: [], acceptance_checks: [], prohibited_actions: [], excluded_paths: [] };
  assert.ok(developerPrompt({ task }).includes(BUG_NOTE));
  assert.ok(reviewerPrompt({ task, sha: 'abc', diff: '' }).includes(BUG_NOTE));
  assert.match(BUG_NOTE, /found-bug/);
});

test('AGENTS.md carries the rule, the field and the command', () => {
  const a = fs.readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  assert.match(a, /found-bug --title/);
  assert.match(a, /bugs: none \| fixed <what> \| reported <id>/);
});

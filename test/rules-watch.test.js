import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, message, stamp, createRulesWatch } from '../rules-watch.js';
import { createSessionNotes } from '../session-notes.js';

const H = 'a'.repeat(40), H2 = 'b'.repeat(40);
const T = Date.parse('2026-10-14T12:00:00Z');
const RULES = { hash: H, at: T, subject: 'docs: autonomy' };   // what the harness git mock reports for AGENTS.md

test('plan: every session started before the AGENTS.md change and not noted for this hash, busy or not; later starts are current', () => {
  const rules = new Map([['/r/.git', { hash: H, at: T, subject: 'docs: autonomy' }]]);
  const repoOf = new Map([['/w', '/r/.git'], ['/x', null]]);
  const old = (name, extra) => ({ name, cwd: '/w', startedAt: T - 3600e3, ...extra });
  const targets = [old('old'), old('busy', { working: true }), old('scripted', { scriptBusy: true }), old('told'),
    { name: 'new', cwd: '/w', startedAt: T + 60e3 }, { name: 'norepo', cwd: '/x', startedAt: 1 }];
  const a = plan({ targets, rules, repoOf, told: { told: H } });
  assert.deepEqual(a.note.map((p) => p.name), ['old', 'busy', 'scripted']);
  assert.deepEqual(a.current, ['new']);
  assert.deepEqual(plan({ targets, rules, repoOf, told: { told: H2 } }).note.map((p) => p.name), ['old', 'busy', 'scripted', 'told']);   // a newer change is noted again
});

test('message: names the commit and the precedence rule, and never asks the owner anything', () => {
  const m = message({ hash: H, at: T, subject: 'docs: autonomy by default' });
  for (const s of ['aaaaaaaaa', '2026-10-14T12:00Z', 'docs: autonomy by default', 'win over your task doc', 'git show origin/main:AGENTS.md', 'Do not reply to this note']) assert.ok(m.includes(s), s);
  assert.doesNotMatch(m, /STATUS|\?/);   // no reply, no STATUS line, no question is invited
});

function harness(t, { targets, mode = 'live' }) {
  const dir = mkdtempSync(join(tmpdir(), 'rules-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sent = [], events = [], gitCalls = [], logs = [];
  const w = createRulesWatch({
    stateDir: dir, mode: () => mode, log: { error() {}, warn(...a) { logs.push(['warn', ...a]); } },
    git: async (cwd, args) => {
      gitCalls.push(args[0]);
      if (args[0] === 'rev-parse') return '/r/.git\n';
      if (args[0] === 'log') return `${H}\t${T / 1000}\tdocs: autonomy\n`;
      return '';
    },
    listTargets: async () => targets(),
    park: async (n, key, text) => { sent.push([n, text, key]); }, unpark: async (n) => { gitCalls.push(`unpark:${n}`); },
    record: async (e) => { events.push(e); },
  });
  return { w, dir, sent, events, gitCalls, logs };
}

test('tick: notes each stale session once, fetches each repo once, records one feed line, forgets ended sessions', async (t) => {
  let targets = [{ name: 'old', cwd: '/w/a', startedAt: T - 1e6 }, { name: 'old2', cwd: '/w/b', startedAt: T - 1e6 }];
  const h = harness(t, { targets: () => targets });
  await h.w.tick();
  assert.deepEqual(h.sent.map((s) => [s[0], s[2]]), [['old', 'rules-watch'], ['old2', 'rules-watch']]);
  assert.equal(h.gitCalls.filter((c) => c === 'fetch').length, 1);
  assert.deepEqual(h.events.map((e) => e.key), ['rules-watch:told']);
  await h.w.tick();
  assert.equal(h.sent.length, 2, 'not noted twice');
  targets = [targets[0], { name: 'fresh', cwd: '/w/a', startedAt: T + 1 }];
  await h.w.tick();
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(h.dir, 'rules-watch.json'), 'utf8')).told), ['old']);
  assert.ok(h.gitCalls.includes('unpark:fresh'), 'a restarted session read the rules: its parked note is dropped');
});

// 2026-11-26: ci-main-red-20261126 had finished and was woken 3 times in 30 min to answer `STATUS: acknowledged`.
test('tick: a rule change starts no turn in an idle, done, waiting, needs-* or accepted session; each learns of it once with its next real turn', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rules-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const names = ['idle', 'done', 'waiting', 'needs-owner', 'needs-manager', 'accepted', 'working'];
  const notes = createSessionNotes({ stateDir: dir });
  const typed = [];
  const w = createRulesWatch({ stateDir: dir, log: { error() {} },
    git: async (c, a) => (a[0] === 'rev-parse' ? '/r/.git\n' : a[0] === 'log' ? `${H}\t${T / 1000}\ts\n` : ''),
    listTargets: async () => names.map((name) => ({ name, cwd: '/w', startedAt: T - 1, working: name === 'working' })),
    send: async (n) => { typed.push(n); },   // the old way in: must stay unused
    park: notes.put, unpark: notes.drop });
  await w.tick(); await w.tick();
  assert.deepEqual(typed, []);
  for (const n of names) assert.equal(notes.peek(n).length, 1, n);
  const first = notes.peek('done');
  notes.ack('done', first.map((x) => x.id));   // delivered with its next real turn
  await w.tick();
  assert.deepEqual(notes.peek('done'), [], 'once: the same commit is not noted again');
});

test('server: rules watch and the guards park their notes and have no way to type into a session', () => {
  const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  for (const make of ['createRulesWatch', 'createOverlapGuard', 'createSharedCheckoutGuard']) {
    const block = src.slice(src.indexOf(`= ${make}({`)).split('\n});')[0];
    assert.match(block, /park: .*sessionNotes\.put/, make);
    assert.doesNotMatch(block, /harnessSend|sendKeys|send:/, make);
  }
});

test('tick: dry mode only journals; off does nothing; a busy host skips the check', async (t) => {
  const dry = harness(t, { targets: () => [{ name: 's', cwd: '/w', startedAt: T - 1 }], mode: 'dry' });
  await dry.w.tick();
  assert.equal(dry.sent.length, 0); assert.deepEqual(dry.events.map((e) => e.key), []);
  assert.match(readFileSync(join(dry.dir, 'rules-watch.jsonl'), 'utf8'), /"dry":true.*"session":"s"/);
  const off = harness(t, { targets: () => { throw new Error('must not list'); }, mode: 'off' });
  assert.equal((await off.w.tick()).mode, 'off');
  const busy = createRulesWatch({ stateDir: dry.dir, pressure: () => ({ loadPerCore: 5, ramAvailPct: 50 }), listTargets: () => { throw new Error('must not list'); } });
  assert.match((await busy.tick()).held, /host busy/);
});

// 2026-10-23: AGENTS.md had not been edited for a day, yet the feed fired dozens of times, each time naming a
// different rotating pair of sessions, because the title said "AGENTS.md changed". The owner read it as a fresh
// edit and went looking, every time. The title now states the relation that is actually true and cites the commit.
test('tick: the feed title never claims a change, and cites the commit in the message() shape', async (t) => {
  const h = harness(t, { targets: () => [{ name: 'old', cwd: '/w/a', startedAt: T - 1e6, working: false, scriptBusy: false }] });
  await h.w.tick();
  const e = h.events.at(-1);
  assert.equal(e.key, 'rules-watch:told');
  assert.ok(!/\bchang/i.test(e.title), `title must not claim a change happened: ${e.title}`);
  assert.ok(!/newer rules|updated rules|commit [0-9a-f]/.test(e.title), e.title);
  assert.equal(e.title, `AGENTS.md is newer than 1 session(s) - note for their next turn (${stamp(RULES)})`);
  assert.equal(e.body, 'old');                                    // body is still exactly the session names
  // the same stamp the session itself reads, so title and message never disagree
  assert.ok(e.title.includes(H.slice(0, 9)), 'short hash in the title');
  assert.ok(h.sent[0][1].includes(stamp(RULES)), 'same stamp in the message');
});

test('tick: the same unchanged commit re-delivered to a restarted pair is a byte-identical title', async (t) => {
  const stale = (names) => names.map((n, i) => ({ name: n, cwd: `/w/${i}`, startedAt: T - 1e6, working: false, scriptBusy: false }));
  let targets = stale(['a1', 'a2']);
  const h = harness(t, { targets: () => targets });
  await h.w.tick();
  targets = stale(['b1', 'b2']);                                  // the pair restarted; AGENTS.md itself did not
  await h.w.tick();
  assert.deepEqual(h.sent.map((s) => s[0]), ['a1', 'a2', 'b1', 'b2']);
  assert.equal(h.events.length, 2);
  assert.equal(h.events[1].title, h.events[0].title, 'same commit + same count -> a reader sees a repeat, not an edit');
  assert.notEqual(h.events[1].body, h.events[0].body, 'the body still names this tick\'s own sessions');
});

test('tick: two repos with two different AGENTS.md commits cite both, one entry each', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rules-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repos = {
    '/w/a': { key: '/r1/.git', rules: { hash: H, at: T, subject: 'docs: one' } },
    '/w/b': { key: '/r2/.git', rules: { hash: H2, at: T - 86400e3, subject: 'docs: two' } },
  };
  const events = [];
  const w = createRulesWatch({
    stateDir: dir, log: { error() {} },
    git: async (cwd, args) => args[0] === 'rev-parse' ? `${repos[cwd].key}\n`
      : args[0] === 'log' ? `${repos[cwd].rules.hash}\t${repos[cwd].rules.at / 1000}\t${repos[cwd].rules.subject}\n` : '',
    listTargets: async () => Object.keys(repos).map((cwd, i) => ({ name: `s${i}`, cwd, startedAt: T - 7 * 86400e3, working: false, scriptBusy: false })),
    park: async () => {}, record: async (e) => { events.push(e); },
  });
  await w.tick();
  const e = events.at(-1);
  assert.equal(e.body, 's0, s1');
  assert.match(e.title, /is newer than 2 session\(s\)/);
  for (const r of Object.values(repos).map((x) => x.rules)) assert.ok(e.title.includes(stamp(r)), stamp(r));
});

test('tick: the body names exactly the sessions noted, all in one check (a note wakes nobody, so no cap)', async (t) => {
  const targets = Array.from({ length: 3 }, (_, i) => ({ name: `s${i}`, cwd: '/w', startedAt: T - 1e6 }));
  const h = harness(t, { targets: () => targets });
  await h.w.tick();
  assert.equal(h.events.at(-1).body, 's0, s1, s2');
  assert.match(h.events.at(-1).title, /is newer than 3 session\(s\)/);
});

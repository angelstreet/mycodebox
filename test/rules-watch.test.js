import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, message, createRulesWatch } from '../rules-watch.js';

const H = 'a'.repeat(40), H2 = 'b'.repeat(40);
const T = Date.parse('2026-10-14T12:00:00Z');

test('plan: only sessions whose agent started before the AGENTS.md change, idle, not told this hash', () => {
  const rules = new Map([['/r/.git', { hash: H, at: T, subject: 'docs: autonomy' }]]);
  const repoOf = new Map([['/w/a', '/r/.git'], ['/w/b', '/r/.git'], ['/w/c', '/r/.git'], ['/w/d', '/r/.git'], ['/x', null]]);
  const targets = [
    { name: 'old', cwd: '/w/a', startedAt: T - 3600e3, working: false },
    { name: 'new', cwd: '/w/b', startedAt: T + 60e3, working: false },
    { name: 'busy', cwd: '/w/c', startedAt: T - 3600e3, working: true },
    { name: 'told', cwd: '/w/d', startedAt: T - 3600e3, working: false },
    { name: 'norepo', cwd: '/x', startedAt: 1, working: false },
  ];
  assert.deepEqual(plan({ targets, rules, repoOf, told: { told: H } }).map((p) => p.name), ['old']);
  assert.deepEqual(plan({ targets, rules, repoOf, told: { told: H2 } }).map((p) => p.name), ['old', 'told']);   // a newer change is told again
});

test("plan: at most 2 sessions per tick", () => {
  const rules = new Map([['/r/.git', { hash: H, at: T, subject: 's' }]]);
  const repoOf = new Map([['/w', '/r/.git']]);
  const targets = Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, cwd: '/w', startedAt: T - 1, working: false }));
  assert.equal(plan({ targets, rules, repoOf, told: {} }).length, 2);
});

test('message: names the commit and the precedence rule, and never asks the owner anything', () => {
  const m = message({ hash: H, at: T, subject: 'docs: autonomy by default' });
  for (const s of ['aaaaaaaaa', '2026-10-14T12:00Z', 'docs: autonomy by default', 'win over your task doc', 'never hand the owner commands', 'git show origin/main:AGENTS.md', 'STATUS']) assert.ok(m.includes(s), s);
});

function harness(t, { targets, mode = 'live' }) {
  const dir = mkdtempSync(join(tmpdir(), 'rules-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sent = [], events = [], gitCalls = [];
  const w = createRulesWatch({
    stateDir: dir, mode: () => mode, log: { error() {} },
    git: async (cwd, args) => {
      gitCalls.push(args[0]);
      if (args[0] === 'rev-parse') return '/r/.git\n';
      if (args[0] === 'log') return `${H}\t${T / 1000}\tdocs: autonomy\n`;
      return '';
    },
    listTargets: async () => targets(),
    send: async (n, text) => { sent.push([n, text]); },
    record: async (e) => { events.push(e.key); },
  });
  return { w, dir, sent, events, gitCalls };
}

test('tick: tells a stale idle session once, fetches each repo once, records one feed line, forgets ended sessions', async (t) => {
  let targets = [{ name: 'old', cwd: '/w/a', startedAt: T - 1e6, working: false }, { name: 'old2', cwd: '/w/b', startedAt: T - 1e6, working: false }];
  const h = harness(t, { targets: () => targets });
  await h.w.tick();
  assert.deepEqual(h.sent.map((s) => s[0]), ['old', 'old2']);
  assert.equal(h.gitCalls.filter((c) => c === 'fetch').length, 1);
  assert.deepEqual(h.events, ['rules-watch:told']);
  await h.w.tick();
  assert.equal(h.sent.length, 2, 'not told twice');
  targets = [targets[0]];
  await h.w.tick();
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(h.dir, 'rules-watch.json'), 'utf8')).told), ['old']);
});

test('tick: a working session waits for a later tick; dry mode only journals; off does nothing', async (t) => {
  let working = true;
  const h = harness(t, { targets: () => [{ name: 'busy', cwd: '/w', startedAt: T - 1, working }] });
  await h.w.tick(); assert.equal(h.sent.length, 0);
  working = false; await h.w.tick(); assert.equal(h.sent.length, 1);
  const dry = harness(t, { targets: () => [{ name: 's', cwd: '/w', startedAt: T - 1, working: false }], mode: 'dry' });
  await dry.w.tick();
  assert.equal(dry.sent.length, 0); assert.deepEqual(dry.events, []);
  assert.match(readFileSync(join(dry.dir, 'rules-watch.jsonl'), 'utf8'), /"dry":true.*"session":"s"/);
  const off = harness(t, { targets: () => { throw new Error('must not list'); }, mode: 'off' });
  assert.equal((await off.w.tick()).mode, 'off');
});

test('tick: a busy host holds every message; the message tells an idle session to start nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rules-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let pr = { loadPerCore: 5, ramAvailPct: 50 };
  const sent = [];
  const w = createRulesWatch({ stateDir: dir, pressure: () => pr, log: { error() {} },
    git: async (c, a) => (a[0] === 'rev-parse' ? '/r/.git\n' : a[0] === 'log' ? `${H}\t${T / 1000}\ts\n` : ''),
    listTargets: async () => Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, cwd: '/w', startedAt: T - 1, working: false })),
    send: async (n) => { sent.push(n); } });
  assert.match((await w.tick()).held, /host busy/); assert.equal(sent.length, 0);
  pr = { loadPerCore: 0.5, ramAvailPct: 10 }; await w.tick(); assert.equal(sent.length, 0);
  pr = { loadPerCore: 0.5, ramAvailPct: 50 }; await w.tick(); assert.equal(sent.length, 2, 'two per check');
  assert.match(message({ hash: H, at: T, subject: 's' }), /idle with nothing pending, start nothing new/);
});

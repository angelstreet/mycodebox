import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { problemsOf, signatureOf, message, expandHome, createSharedCheckoutGuard } from '../shared-checkout-guard.js';
import { classifyKey } from '../manager-events.js';
import { WORKTREE_NOTE } from '../orchestration/roles.js';

const clean = { branch: 'main', ahead: 0, status: new Map() };

test('problemsOf: clean, dirty, off-main and ahead', () => {
  assert.deepEqual(problemsOf(clean), []);
  assert.equal(problemsOf({ ...clean, status: new Map([['a', 'M']]) }).length, 1);
  assert.match(problemsOf({ ...clean, branch: 'fix/x' })[0], /fix\/x/);
  assert.match(problemsOf({ ...clean, ahead: 2 })[0], /2 commit/);
  assert.notEqual(signatureOf(clean), signatureOf({ ...clean, ahead: 1 }));
  assert.equal(expandHome('~/a', '/h'), '/h/a');
  assert.match(message({ checkout: '/h/a', reasons: ['x'], paths: ['p'] }), /^\[shared-checkout-guard: no reply needed\].*git worktree list/);
  assert.deepEqual(classifyKey('virtualpytest:shared-checkout-dirty'), { kind: 'shared-checkout-dirty', session: 'virtualpytest' });
  assert.match(WORKTREE_NOTE, /git worktree list/);
});

function setup(facts, over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scg-'));
  const events = [], sent = [];
  const git = async (cwd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return cwd + '\n';
    if (args[0] === 'rev-parse') return facts.branch + '\n';
    if (args[0] === 'rev-list') return facts.ahead + '\n';
    return facts.porcelain;
  };
  const g = createSharedCheckoutGuard({ stateDir: dir, git, listCheckouts: async () => ['/fake/shared'], mtimeOf: async () => 5000,
    listTargets: async () => [{ name: 'old', cwd: '/fake/shared', startedAt: 1000, working: false }, { name: 'new', cwd: '/fake/shared', startedAt: 9000 }, { name: 'elsewhere', cwd: '/other', startedAt: 1 }],
    send: async (n, t) => sent.push([n, t]), record: async (e) => events.push(e), ...over });
  return { g, events, sent, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('guard: confirms on the second tick, raises once per change set, tells only sessions started before the mtime', async () => {
  const s = setup({ branch: 'main', ahead: 0, porcelain: ' M docs/a.md\n?? b.txt\n' });
  try {
    await s.g.tick();
    assert.equal(s.events.length, 0);                       // first sighting: wait
    const snap = await s.g.tick();
    assert.equal(s.events.length, 1);
    assert.equal(s.events[0].key, 'shared:shared-checkout-dirty');
    assert.deepEqual(s.events[0].items, ['docs/a.md', 'b.txt']);
    assert.deepEqual(s.events[0].sharedCheckout.sessions, ['old']);
    assert.deepEqual(s.sent.map((x) => x[0]), ['old']);
    assert.equal(snap.checkouts[0].clean, false);
    await s.g.tick();
    assert.equal(s.events.length, 1);                       // same change set: no repeat
    assert.equal(s.sent.length, 1);
  } finally { s.done(); }
});

test('guard: clean checkout, dry mode and a busy host raise and send nothing', async () => {
  const c = setup({ branch: 'main', ahead: 0, porcelain: '' });
  const d = setup({ branch: 'fix/x', ahead: 1, porcelain: '' }, { mode: () => 'dry' });
  const b = setup({ branch: 'fix/x', ahead: 1, porcelain: '' }, { pressure: () => ({ loadPerCore: 9, ramAvailPct: 90 }) });
  try {
    for (const s of [c, d, b]) { await s.g.tick(); await s.g.tick(); assert.equal(s.events.length, 0); assert.equal(s.sent.length, 0); }
    assert.equal(c.g.snapshot().checkouts[0].clean, true);
    assert.equal(b.g.snapshot().held, 'host busy');
  } finally { c.done(); d.done(); b.done(); }
});

// The Opus one-shots (suggestion triage, ask-opus) run on a Claude account with headroom (2026-11-27: the default account was used up all
// evening, Team joachim had room). A fake claude binary prints the limit text when CLAUDE_CONFIG_DIR is the used-up account's dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmp } from './helpers-tmp.js';
import { usableAccounts } from '../claude-accounts.js';
import { askOpusOnAccounts, createSuggestionTriage } from '../suggestion-triage.js';
import { createSuggestions } from '../suggestions.js';

const NOW = 1_800_000_000_000, sec = (ms) => Math.round(ms / 1000);
function rig({ marks = {}, active = 'default', rates = {} } = {}) {
  const home = tmp('opus-acc-'), state = join(home, 'state');
  mkdirSync(state, { recursive: true });
  const dirs = {};
  for (const id of ['team1', 'team2']) { dirs[id] = join(home, '.claude-accounts', id); mkdirSync(dirs[id], { recursive: true }); writeFileSync(join(dirs[id], '.credentials.json'), '{}'); }
  writeFileSync(join(state, 'claude-accounts.json'), JSON.stringify({ auto: true, active, marks, accounts: [{ id: 'default', label: 'd' }, { id: 'team1', label: 't1', configDir: dirs.team1 }, { id: 'team2', label: 't2', configDir: dirs.team2 }] }));
  for (const [id, pct] of Object.entries(rates)) writeFileSync(join(state, id === 'default' ? 'claude-rate-limits.json' : `claude-rate-limits.${id}.json`),
    JSON.stringify({ at: NOW, rate_limits: { seven_day: { used_percentage: pct, resets_at: sec(NOW) + 3600 } } }));
  // fake claude: the used-up dir (file "limit" inside CLAUDE_CONFIG_DIR, or none for default when LIMIT_DEFAULT is set) prints the limit text
  const bin = join(home, 'claude');
  writeFileSync(bin, `#!/bin/sh\necho "cfg=$CLAUDE_CONFIG_DIR" >> "${home}/calls"\ncat >/dev/null\nif [ -z "$CLAUDE_CONFIG_DIR" ] || [ -e "$CLAUDE_CONFIG_DIR/limit" ]; then echo "You've hit your weekly limit · resets 2pm (UTC) · out of usage credits" >&2; exit 1; fi\necho "1: NO - fake"\n`);
  chmodSync(bin, 0o755);
  return { home, state, dirs, bin, calls: () => { try { return readFileSync(join(home, 'calls'), 'utf8').replace(/\n$/, '').split('\n').map((l) => l.slice(4)); } catch { return []; } } };
}

test('usableAccounts skips an account marked used up, one over its limit, and one without a login', () => {
  const r = rig({ active: 'default', marks: { default: { until: NOW + 3600e3 } }, rates: { team1: 99 } });
  assert.deepEqual(usableAccounts(r.state, { home: r.home, now: () => NOW }).map((a) => a.id), ['team2']);
  const r2 = rig({ active: 'team1' });
  assert.deepEqual(usableAccounts(r2.state, { home: r2.home, now: () => NOW }).map((a) => a.id), ['team1', 'default', 'team2']);   // active first
  assert.deepEqual(usableAccounts(join(r2.home, 'none'), { home: r2.home }), []);
});

test('the used-up account is skipped: the call runs on the account with room, once', async () => {
  const r = rig({ active: 'default', marks: { default: { until: NOW + 3600e3 } } });
  const res = await askOpusOnAccounts('p', { bin: r.bin, accounts: () => usableAccounts(r.state, { home: r.home, now: () => NOW }) });
  assert.equal(res.ok, true); assert.equal(res.account, 'team1');
  assert.deepEqual(r.calls(), [r.dirs.team1]);
});

test('a limit error retries once on the next account and marks the first used up', async () => {
  const r = rig({ active: 'team1' });
  writeFileSync(join(r.dirs.team1, 'limit'), '');
  const marked = [];
  const res = await askOpusOnAccounts('p', { bin: r.bin, accounts: () => usableAccounts(r.state, { home: r.home, now: () => NOW }), onLimit: (a) => marked.push(a.id) });
  assert.equal(res.ok, false);   // the fake's default account is limited too: two tries, no third
  assert.deepEqual(marked, ['team1', 'default']);
  assert.deepEqual(r.calls(), [r.dirs.team1, '']);   // team1 limited, then the next usable one: default (no CLAUDE_CONFIG_DIR)
});

test('limit on the first, success on the second', async () => {
  const r = rig({ active: 'team1' });
  writeFileSync(join(r.dirs.team1, 'limit'), '');
  // make the fake succeed for team2 only: order team1, team2
  const marked = [];
  const res = await askOpusOnAccounts('p', { bin: r.bin, accounts: () => [{ id: 'team1', configDir: r.dirs.team1 }, { id: 'team2', configDir: r.dirs.team2 }], onLimit: (a) => marked.push(a.id) });
  assert.equal(res.ok, true); assert.equal(res.account, 'team2');
  assert.deepEqual(marked, ['team1']);
  assert.deepEqual(r.calls(), [r.dirs.team1, r.dirs.team2]);
});

test('both accounts limited: one retry only, the error comes back', async () => {
  const r = rig();
  for (const d of Object.values(r.dirs)) writeFileSync(join(d, 'limit'), '');
  const res = await askOpusOnAccounts('p', { bin: r.bin, accounts: () => [{ id: 'team1', configDir: r.dirs.team1 }, { id: 'team2', configDir: r.dirs.team2 }, { id: 'x', configDir: r.dirs.team2 }] });
  assert.equal(res.ok, false); assert.match(res.error, /weekly limit/);
  assert.equal(r.calls().length, 2);
});

test('ask-opus.js takes the same path: skips the used-up default, runs on team1', () => {
  const r = rig({ active: 'default', marks: { default: { until: Date.now() + 3600e3 } } });
  const out = spawnSync(process.execPath, ['scripts/ask-opus.js', '--session', 's', '--question', 'which is better?'], { encoding: 'utf8', env: { ...process.env, HOME: r.home, GHOSTY_STATE_DIR: r.state, CLAUDE_BIN: r.bin } });
  assert.match(out.stdout, /"verdict":"error"/, out.stderr);   // the fake answers "1: NO", not ANSWER:, so unreadable, but it ran
  assert.deepEqual(r.calls(), [r.dirs.team1]);
});

test('sweep retries a triage that errored once retryMs has passed, and starts lists nobody triggered', async () => {
  const dir = tmp('sweep-'); let t = NOW;
  const ledger = createSuggestions({ stateDir: dir, now: () => t });
  ledger.observe('s1', ['Suggestions:', '1. add a unit test for the race', '', 'STATUS: needs-manager: improvement suggestions above, nothing built — should I do 1?'].join('\n'));
  let ok = false, n = 0;
  const tri = createSuggestionTriage({ stateDir: dir, ledger, now: () => t, retryMs: 1000, apply: async (name, ds) => { ledger.triaged(name, ds); }, send: async () => {},
    ask: async () => { n++; return ok ? { ok: true, text: '1: NO - x' } : { ok: false, error: "You've hit your weekly limit" }; } });
  assert.deepEqual(tri.sweep(), ['s1']); await tri.triage('s1');
  assert.deepEqual(tri.sweep(), []);   // failed just now: not before retryMs
  t += 2000; ok = true;
  assert.deepEqual(tri.sweep(), ['s1']); await tri.triage('s1');
  assert.equal(n, 2); assert.equal(ledger.openOf('s1').length, 0);
});

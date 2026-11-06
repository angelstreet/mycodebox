import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize, scanClaudeLimit, pickAccount, accountState, launchPrefix, accountOfPid, setupConfigDir, windowsOf, rateFile, createClaudeAccounts, LIMIT_PCT } from '../claude-accounts.js';
import { readClaude } from '../quota.js';

const NOW = 1_800_000_000_000;
const sec = (ms) => Math.round(ms / 1000);
const rl = (five, week, reset5 = sec(NOW) + 3600, resetW = sec(NOW) + 86400) => ({ at: NOW, rate_limits: { five_hour: { used_percentage: five, resets_at: reset5 }, seven_day: { used_percentage: week, resets_at: resetW } } });

test('normalize: default account first, bad and duplicate ids dropped, dirs absolute', () => {
  const c = normalize({ accounts: [{ id: 'team1', label: 'Team 1', configDir: '~/.c1' }, { id: 'Bad id!' }, { id: 'team1' }, { id: 'team2' }], active: 'nope' }, '/h');
  assert.deepEqual(c.accounts.map((a) => a.id), ['default', 'team1', 'team2']);
  assert.equal(c.accounts[1].configDir, '/h/.c1');
  assert.equal(c.accounts[2].configDir, '/h/.claude-accounts/team2');
  assert.equal(c.accounts[0].configDir, null);
  assert.equal(c.active, 'default');
  assert.equal(c.auto, true);
  assert.equal(c.autoSwapSessions, true);
});

test('scanClaudeLimit: the limit stop forms Claude Code prints, not ordinary text', () => {
  assert.ok(scanClaudeLimit(['work', 'Claude usage limit reached. Your limit will reset at 5pm (Europe/Paris).']));
  assert.ok(scanClaudeLimit(['  5-hour limit reached ∙ resets 3pm', '> ']));
  assert.ok(scanClaudeLimit(['Weekly limit reached ∙ resets Mon 9am']));
  assert.ok(scanClaudeLimit(["You've hit your limit · resets 4pm"]));
  assert.ok(!scanClaudeLimit(['the limit is fine', 'we reached the end']));
  // an old stop scrolled out of the tail does not count
  assert.ok(!scanClaudeLimit(['Claude usage limit reached', ...Array.from({ length: 20 }, (_, i) => `line ${i}`)]));
});

test('accountState: full window or a live mark = used up; expired window and no reading = usable', () => {
  assert.equal(accountState({ windows: windowsOf(rl(LIMIT_PCT, 10), NOW), now: NOW }).exhausted, true);
  assert.equal(accountState({ windows: windowsOf(rl(50, 99), NOW), now: NOW }).exhausted, true);
  assert.equal(accountState({ windows: windowsOf(rl(100, 10, sec(NOW) - 5), NOW), now: NOW }).exhausted, false);   // window already reset
  assert.equal(accountState({ windows: [], now: NOW }).exhausted, false);
  const m = accountState({ windows: [], mark: { until: NOW + 1000, reason: 'stop' }, now: NOW });
  assert.equal(m.exhausted, true); assert.equal(m.reset, NOW + 1000);
  assert.equal(accountState({ windows: [], mark: { until: NOW - 1 }, now: NOW }).exhausted, false);
});

test('pickAccount: first with headroom in list order, back to the first once it resets; auto off keeps the choice', () => {
  const cfg = normalize({ accounts: [{ id: 'default' }, { id: 'team1' }, { id: 'team2' }] }, '/h');
  assert.equal(pickAccount(cfg, { default: { exhausted: true }, team1: { exhausted: false } }), 'team1');
  assert.equal(pickAccount(cfg, { default: { exhausted: true }, team1: { exhausted: true }, team2: { exhausted: false } }), 'team2');
  assert.equal(pickAccount(cfg, {}), 'default');
  assert.equal(pickAccount(cfg, { default: { exhausted: true, reset: 5 }, team1: { exhausted: true, reset: 2 }, team2: { exhausted: true, reset: null } }), 'team1');
  assert.equal(pickAccount(cfg, { team1: { exhausted: true } }, { exclude: ['default'] }), 'team2');
  assert.equal(pickAccount(cfg, { team1: { exhausted: true }, team2: { exhausted: true } }, { exclude: ['default'] }), null);
  assert.equal(pickAccount({ ...cfg, auto: false, active: 'team2' }, {}), 'team2');
});

test('launchPrefix / accountOfPid', () => {
  assert.equal(launchPrefix({ id: 'default', configDir: null }), '');
  assert.equal(launchPrefix({ id: 'team1', configDir: "/h/it's" }), `CLAUDE_CONFIG_DIR='/h/it'\\''s' GHOSTY_CLAUDE_ACCOUNT=team1 `);
  assert.equal(accountOfPid(42, () => 'A=1\0GHOSTY_CLAUDE_ACCOUNT=team2\0'), 'team2');
  assert.equal(accountOfPid(42, () => 'A=1\0'), 'default');
  assert.equal(accountOfPid(42, () => { throw new Error('gone'); }), null);
});

test('setupConfigDir links the shared parts of ~/.claude, never the login', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cacct-'));
  try {
    await mkdir(join(home, '.claude', 'projects'), { recursive: true });
    await mkdir(join(home, '.claude', 'sessions'), { recursive: true });
    await writeFile(join(home, '.claude', 'settings.json'), '{}');
    await writeFile(join(home, '.claude', '.credentials.json'), '{"fake":true}');
    const dir = join(home, '.claude-accounts', 'team1');
    const linked = await setupConfigDir(dir, { home });
    assert.deepEqual(linked.sort(), ['projects', 'sessions', 'settings.json']);
    assert.equal(await readlink(join(dir, 'projects')), join(home, '.claude', 'projects'));
    await assert.rejects(readFile(join(dir, '.credentials.json')));
    assert.deepEqual(await setupConfigDir(dir, { home }), []);   // idempotent
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('manager: add, rotate on a full window, mark a limit stop, go back after the reset', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cacct-'));
  const state = join(home, 'state');
  let now = NOW;
  try {
    await mkdir(state, { recursive: true });
    const m = createClaudeAccounts({ file: join(state, 'claude-accounts.json'), stateDir: state, home, now: () => now });
    await m.add({ id: 'team1', label: 'Team 1' });
    await m.add({ id: 'team2', label: 'Team 2' });
    await assert.rejects(m.add({ id: 'team1' }), /exists/);
    await assert.rejects(m.add({ id: 'default' }), /not "default"/);
    assert.equal(m.active().id, 'default');
    assert.equal(m.commandFor('claude'), 'claude');

    await writeFile(rateFile(state, 'default'), JSON.stringify(rl(97, 40)));
    let r = await m.refresh();
    assert.deepEqual([r.changed, r.from, r.to], [true, 'default', 'team1']);
    assert.match(m.commandFor('claude'), /^CLAUDE_CONFIG_DIR='.*\/\.claude-accounts\/team1' GHOSTY_CLAUDE_ACCOUNT=team1 claude$/);
    assert.equal(m.claudeJsonFor(), join(home, '.claude-accounts', 'team1', '.claude.json'));

    // team1 stops on its limit with no reading: marked for MARK_DEFAULT_MS, team2 takes over
    r = await m.markExhausted('team1', { reason: 'stop in s1' });
    assert.equal(r.to, 'team2');
    assert.equal(m.nextFor('team2'), null);   // default and team1 are both used up
    assert.equal(m.nextFor('team1'), 'team2');

    // persisted, and read back by a fresh instance
    const again = createClaudeAccounts({ file: join(state, 'claude-accounts.json'), stateDir: state, home, now: () => now });
    await again.refresh();
    assert.equal(again.active().id, 'team2');

    // the default window resets: new sessions go back to it
    now = NOW + 2 * 3600e3;
    r = await m.refresh();
    assert.equal(r.to, 'default');

    // owner pins an account: auto off, no rotation
    const v = await m.set({ active: 'team2' });
    assert.equal(v.auto, false); assert.equal(v.active, 'team2');
    await m.set({ auto: true });
    assert.equal(m.active().id, 'default');
    await m.remove('team2');
    assert.deepEqual(m.view().accounts.map((a) => a.id), ['default', 'team1']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('quota: the claude plan follows the active account and lists every account', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cacct-q-'));
  try {
    await writeFile(join(dir, 'claude-rate-limits.team1.json'), JSON.stringify(rl(12, 30)));
    const view = { accounts: [{ id: 'default', label: 'Max', active: false }, { id: 'team1', label: 'Team 1', active: true }] };
    const p = await readClaude({ claudeFile: () => join(dir, 'claude-rate-limits.team1.json'), claudeAccounts: () => view }, NOW);
    assert.equal(p.label, 'Claude (Team 1)');
    assert.equal(p.account, 'team1');
    assert.equal(p.accounts.length, 2);
    assert.equal(p.windows[0].usedPercent, 12);
    const single = await readClaude({ claudeFile: join(dir, 'missing.json') }, NOW);
    assert.equal(single.label, 'Claude Max');
    assert.equal(single.accounts, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

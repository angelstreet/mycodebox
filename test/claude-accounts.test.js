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

test('scanClaudeLimit: the weekly stop of Claude Code 2.x, with the window or the model named', () => {
  // the stop that kept sessions parked for days (owner, 2026-11-19): the pane said this, the swap never fired
  assert.ok(scanClaudeLimit(["  ⎿  You've hit your weekly limit · resets Nov 21, 2pm (UTC)"]));
  assert.ok(scanClaudeLimit(['You’ve hit your weekly limit · resets Nov 21, 2pm (UTC)']));   // the curly apostrophe
  assert.ok(scanClaudeLimit(["You've hit your Opus limit"]));
  assert.ok(scanClaudeLimit(["You've hit your usage limit"]));
  assert.ok(scanClaudeLimit(["You've hit your 5-hour limit"]));
  // the stop is still seen when the pane has moved on a few lines
  assert.ok(scanClaudeLimit(['✻ Brewed for 6s · done 8:04 AM', "  ⎿  You've hit your weekly limit · resets Nov 21, 2pm (UTC)", '❯ ']));
  // ordinary text that mentions a limit is not a stop
  assert.ok(!scanClaudeLimit(['we set the rate limit to 40 requests per minute', 'the limit is fine']));
  assert.ok(!scanClaudeLimit(['the weekly plan has a usage limit of 500 messages', 'nothing is stopped']));
});

test('scanClaudeLimit: a resumed pane replays the old stop, and that replay is not a new stop', () => {
  // after a swap the pane shows the whole conversation again: the old stop sits above the park's farewell
  // (owner, 2026-11-19: the replay fired a second swap, marked the fresh account used up and killed the session)
  assert.ok(!scanClaudeLimit([
    '✻ Cogitated for 20s · done 2:40 PM',
    "  ⎿  You've hit your weekly limit · resets Nov 21, 2pm (UTC)",
    '     /usage-credits to finish what you’re working on.',
    '❯ /exit',
    '  ⎿  Catch you later!',
    '  /remote-control is active · Continue here, on your phone, or at',
    '  https://claude.ai/code/session_0123456789abcdef',
  ]));
  // the agent's own output after the stop means it moved on: it is not stopped
  assert.ok(!scanClaudeLimit([
    "  ⎿  You've hit your weekly limit · resets Nov 21, 2pm (UTC)",
    '❯ Try again',
    '● Bash(curl -s http://127.0.0.1:7777/api/bugs)',
    '  ⎿  Error: Exit code 1',
  ]));
  // the stop is still the stop when the user opened the rate-limit menu below it
  assert.ok(scanClaudeLimit([
    '✻ Cogitated for 20s · done 2:40 PM',
    '❯ Time box reached (120 min): write Verification: as it stands',
    "  ⎿  You've hit your weekly limit · resets Nov 21, 2pm (UTC)",
    '     /usage-credits to finish what you’re working on.',
    '❯ /rate-limit-options',
    '  What do you want to do?',
    '  ❯ 1. Stop and wait for limit to reset',
    '    2. Wait here, then continue automatically at Nov 21, 2pm',
    '  Enter to confirm · Esc to cancel',
  ]));
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

test('scanClaudeLimit: "You hit your weekly limit" (no apostrophe) and the out-of-credits wording are stops (artifact, 2026-11-26)', () => {
  assert.ok(scanClaudeLimit(['  ⎿  You hit your weekly limit · resets Nov 27, 2pm (UTC)', '❯ ']));
  assert.ok(scanClaudeLimit(['You have hit your weekly limit']));
  assert.ok(scanClaudeLimit(["You're out of usage credits"]));
  assert.ok(!scanClaudeLimit(['we hit your server limit of 5 requests today?']));
});

test('resumeCommand: a model override replaces the recorded --model (fable swap resumes on opus)', async () => {
  const { resumeCommand } = await import('../parking.js');
  const a = { base: 'claude', args: 'claude --model fable', name: 'artifact', sessionId: 'abc' };
  assert.match(resumeCommand(a), /--model fable/);
  assert.match(resumeCommand({ ...a, model: 'opus' }), /--model opus/);
  assert.doesNotMatch(resumeCommand({ ...a, model: 'opus' }), /fable/);
});

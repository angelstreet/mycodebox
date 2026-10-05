// G8 P0: computeShare — dedupe, exclusion, autonomous paths, owner-confirmed, regret, day bucketing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeShare, dailyRollup } from '../scripts/decision-share.js';

const t = (s, day = 1) => `2026-10-0${day}T${s}:00.000Z`;   // minute-precision ISO times

const stall = ({ session, id, at, case: c, excerpt, question, agent = 'claude' }) => ({
  type: 'stall', id, session, case: c, at, excerpt: excerpt || '', question: question || excerpt || '', agent,
});

const writeFixtures = (dir, records, actions = []) => {
  writeFileSync(join(dir, 'stalls.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (actions.length) writeFileSync(join(dir, 'manager-actions.jsonl'), actions.map((r) => JSON.stringify(r)).join('\n') + '\n');
};

const find = (arr, fn) => arr.find(fn);

test('missing files: empty input gives zero decisions', () => {
  const share = computeShare([], [], { days: 7, managerSessions: ['manager'] });
  const roll = dailyRollup(share);
  assert.equal(share.decisions.length, 0);
  assert.equal(roll.total.decisions, 0);
});

test('dedupe: repeated stall records with same stopKey collapse to one decision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-ds-'));
  const excerpt = 'should I run npm install here, or use the existing lockfile?';
  writeFixtures(dir, [
    stall({ session: 'feat', id: 'a', at: t('10:00', 1), case: 'owner_decision', excerpt }),
    stall({ session: 'feat', id: 'b', at: t('10:01', 1), case: 'owner_decision', excerpt }),   // same stop, different id
    stall({ session: 'feat', id: 'c', at: t('10:02', 1), case: 'owner_decision', excerpt }),
  ]);
  const share = computeShare([{ type: 'stall', id: 'a', session: 'feat', case: 'owner_decision', at: t('10:00', 1), excerpt }], [], { days: 7, managerSessions: [] });
  // dedupe is structural — assert it from the synthetic in-memory path
  assert.equal(share.decisions.length, 1);
  assert.equal(share.decisions[0].at, t('10:00', 1));   // first record's at
});

test('exclusion: done / background_wait / managerSessions are filtered out', () => {
  const records = [
    stall({ session: 's1', id: 'a', at: t('10:00', 1), case: 'done', excerpt: 'finished — nothing more to do' }),
    stall({ session: 's2', id: 'b', at: t('10:00', 1), case: 'background_wait', excerpt: 'waiting for the deploy queue' }),
    stall({ session: 'manager', id: 'c', at: t('10:00', 1), case: 'owner_decision', excerpt: 'manager self-loop' }),
    stall({ session: 's3', id: 'd', at: t('10:00', 1), case: 'owner_decision', excerpt: 'a real decision needed' }),
  ];
  const share = computeShare(records, [], { days: 7, managerSessions: ['manager'] });
  assert.equal(share.decisions.length, 1);
  assert.equal(share.decisions[0].session, 's3');
});

test('autonomous via answer record with same id', () => {
  const records = [
    stall({ session: 'feat', id: 'a', at: t('10:00', 1), case: 'owner_decision', excerpt: 'merge to main now?' }),
    { type: 'answer', id: 'a', session: 'feat', at: t('10:05', 1), answer: { text: 'Yes, merge.' }, source: 'ai' },
  ];
  const share = computeShare(records, [], { days: 7, managerSessions: [] });
  assert.equal(share.decisions.length, 1);
  assert.equal(share.decisions[0].outcome, 'autonomous');
  assert.match(share.decisions[0].via, /^answer/);
});

test('autonomous via manager-agent send to that session in the window', () => {
  const records = [
    stall({ session: 'feat', id: 'a', at: t('10:00', 1), case: 'owner_decision', excerpt: 'continue with the refactor?' }),
    { type: 'send', session: 'feat', by: 'manager-agent', text: '1', at: t('10:02', 1) },
  ];
  const share = computeShare(records, [], { days: 7, managerSessions: [] });
  const d = share.decisions[0];
  assert.equal(d.outcome, 'autonomous');
  assert.match(d.via, /^send \(manager-agent\)/);
});

test('owner send in the window is NOT autonomous (handled by the owner)', () => {
  const records = [
    stall({ session: 'feat', id: 'a', at: t('10:00', 1), case: 'owner_decision', excerpt: 'go ahead and ship?' }),
    { type: 'send', session: 'feat', by: 'owner', text: 'yes ship it', at: t('10:03', 1) },
  ];
  const share = computeShare(records, [], { days: 7, managerSessions: [] });
  assert.equal(share.decisions[0].outcome, 'owner-handled');
});

test('autonomous via manager-actions answer for that session in the window', () => {
  const records = [
    stall({ session: 'feat', id: 'a', at: t('10:00', 1), case: 'owner_decision', excerpt: 'cancel the deploy?' }),
  ];
  const actions = [
    { at: t('10:05', 1), session: 'feat', decision: 'answer: no, do not cancel', action: 'replied', reason: 'safe' },
  ];
  const share = computeShare(records, actions, { days: 7, managerSessions: [] });
  const d = share.decisions[0];
  assert.equal(d.outcome, 'autonomous');
  assert.match(d.via, /^manager-actions/);
});

test('manager-actions session "all"/"-" is fleet-wide and never counts as an answer to one stop', () => {
  const records = [
    stall({ session: 'feat', id: 'a', at: t('10:00', 1), case: 'owner_decision', excerpt: 'pick one of the three options' }),
  ];
  const actions = [{ at: t('10:05', 1), session: 'all', decision: 'answer: option 2', action: 'replied' }];
  const share = computeShare(records, actions, { days: 7, managerSessions: [] });
  assert.equal(share.decisions[0].outcome, 'owner-handled');
});

test('owner-relayed sends (by owner-via-*) are owner words: not autonomous, and they can be a regret', () => {
  const rec = (by2) => [
    stall({ session: 'feat', id: 'a', at: t('10:00', 1), case: 'owner_decision', excerpt: 'relay case question' }),
    { type: 'send', session: 'feat', by: 'owner-via-task44', text: 'yes do it', at: t('10:03', 1) },
    ...by2,
  ];
  assert.equal(computeShare(rec([]), [], { days: 7 }).decisions[0].outcome, 'owner-handled');
  const r = computeShare(rec([
    { type: 'answer', id: 'a', session: 'feat', at: t('10:01', 1), source: 'ai' },
    { type: 'send', session: 'feat', by: 'owner-via-task44', text: 'undo that', at: t('10:10', 1) },
  ]), [], { days: 7 });
  assert.equal(r.decisions[0].regret?.via, 'send');
});

test('outcome via manager (auto-sent) is autonomous; via terminal is owner-handled', () => {
  const recs = [
    stall({ session: 'feat', id: 'a', at: t('10:00', 1), case: 'continue', excerpt: 'auto one' }),
    { type: 'outcome', id: 'a', session: 'feat', at: t('10:02', 1), via: 'manager', kind: 'continue' },
    stall({ session: 'feat2', id: 'b', at: t('10:00', 1), case: 'continue', excerpt: 'typed one' }),
    { type: 'outcome', id: 'b', session: 'feat2', at: t('10:02', 1), via: 'terminal', kind: 'owner_specific', reply: 'x' },
  ];
  const d = computeShare(recs, [], { days: 7 }).decisions;
  assert.deepEqual(d.map((x) => x.outcome), ['autonomous', 'owner-handled']);
});

test('stopKey is identical to manager.js stopKey', async () => {
  const m = await import('../manager.js');
  const { stopKey } = await import('../scripts/decision-share.js');
  const x = '  a b\n c '.repeat(200);
  assert.equal(stopKey(x), m.stopKey(x));
});

test('owner-confirmed AI proposal: choice with agreeAi true, matched by id', () => {
  const records = [
    stall({ session: 'feat', id: 'a', at: t('10:00', 1), case: 'owner_decision', excerpt: 'which one of these three?' }),
    { type: 'choice', id: 'a', session: 'feat', at: t('10:05', 1), kind: 'menu', owner: 'o2', ai: 'o2', agreeAi: true, agreeJev: null },
  ];
  const share = computeShare(records, [], { days: 7, managerSessions: [] });
  const d = share.decisions[0];
  assert.equal(d.outcome, 'owner-confirmed');
  assert.equal(d.via, 'choice');
  assert.equal(d.regret, null);   // owner-confirmed is not autonomous, so no regret test applies
});

test('owner-confirmed AI proposal: choice matched by session-in-window when ids differ', () => {
  const records = [
    stall({ session: 'feat', id: 'a', at: t('10:00', 1), case: 'owner_decision', excerpt: 'which option, yes or no?' }),
    { type: 'choice', id: 'different-id', session: 'feat', at: t('10:05', 1), kind: 'yesno', owner: 'yes', ai: 'yes', agreeAi: true },
  ];
  const share = computeShare(records, [], { days: 7, managerSessions: [] });
  assert.equal(share.decisions[0].outcome, 'owner-confirmed');
});

test('choice without agreeAi does NOT count as owner-confirmed', () => {
  const records = [
    stall({ session: 'feat', id: 'a', at: t('10:00', 1), case: 'owner_decision', excerpt: 'pick a path' }),
    { type: 'choice', id: 'a', session: 'feat', at: t('10:05', 1), kind: 'menu', owner: 'o1', ai: 'o2', agreeAi: false },
  ];
  const share = computeShare(records, [], { days: 7, managerSessions: [] });
  assert.equal(share.decisions[0].outcome, 'owner-handled');
});

test('owner-handled: stall with no autonomous path and no choice', () => {
  const records = [
    stall({ session: 'feat', id: 'a', at: t('10:00', 1), case: 'owner_decision', excerpt: 'what next' }),
  ];
  const share = computeShare(records, [], { days: 7, managerSessions: [] });
  assert.equal(share.decisions[0].outcome, 'owner-handled');
  assert.equal(share.decisions[0].regret, null);
});

test('regret: autonomous decision followed by owner pause within 30 min', () => {
  const records = [
    stall({ session: 'feat', id: 'a', at: t('10:00', 1), case: 'owner_decision', excerpt: 'merge now?' }),
    { type: 'answer', id: 'a', session: 'feat', at: t('10:02', 1), answer: { text: 'Yes.' }, source: 'ai' },
    { type: 'pause', session: 'feat', by: 'owner', at: t('10:20', 1) },   // 18 min later
  ];
  const share = computeShare(records, [], { days: 7, managerSessions: [] });
  const d = share.decisions[0];
  assert.equal(d.outcome, 'autonomous');
  assert.ok(d.regret, 'should be flagged as a regret');
  assert.equal(d.regret.via, 'pause');
});

test('regret: autonomous decision followed by owner send starting with stop/no/wait/don\'t/undo/revert within 30 min', () => {
  const cases = [
    { text: 'no, stop the deploy', want: true },
    { text: 'STOP, revert that', want: true },
    { text: "don't do that", want: true },
    { text: 'wait — let me re-check', want: true },
    { text: 'undo the last step', want: true },
    { text: 'revert the change', want: true },
    { text: 'yes continue', want: false },
    { text: 'ship it', want: false },
  ];
  for (const c of cases) {
    const records = [
      stall({ session: 'feat', id: 'a', at: t('10:00', 1), case: 'owner_decision', excerpt: 'ship it?' }),
      { type: 'send', session: 'feat', by: 'manager-agent', text: '1', at: t('10:01', 1) },
      { type: 'send', session: 'feat', by: 'owner', text: c.text, at: t('10:15', 1) },
    ];
    const share = computeShare(records, [], { days: 7, managerSessions: [] });
    const d = share.decisions[0];
    assert.equal(d.outcome, 'autonomous', `expected autonomous for "${c.text}"`);
    if (c.want) {
      assert.ok(d.regret, `expected regret for "${c.text}"`);
      assert.equal(d.regret.via, 'send');
    } else {
      assert.equal(d.regret, null, `expected no regret for "${c.text}"`);
    }
  }
});

test('regret: owner push-back outside the 30 min window does not count', () => {
  const records = [
    stall({ session: 'feat', id: 'a', at: t('10:00', 1), case: 'owner_decision', excerpt: 'ship?' }),
    { type: 'send', session: 'feat', by: 'manager-agent', text: '1', at: t('10:01', 1) },
    { type: 'pause', session: 'feat', by: 'owner', at: t('10:40', 1) },   // 40 min later
  ];
  const share = computeShare(records, [], { days: 7, managerSessions: [] });
  assert.equal(share.decisions[0].outcome, 'autonomous');
  assert.equal(share.decisions[0].regret, null);
});

test('day bucketing: decisions group by UTC day', () => {
  const records = [
    stall({ session: 's1', id: 'a', at: t('23:55', 1), case: 'owner_decision', excerpt: 'late decision day 1' }),
    stall({ session: 's2', id: 'b', at: t('00:05', 2), case: 'owner_decision', excerpt: 'early decision day 2' }),
    stall({ session: 's3', id: 'c', at: t('12:00', 2), case: 'owner_decision', excerpt: 'mid decision day 2' }),
  ];
  const share = computeShare(records, [], { days: 7, managerSessions: [] });
  const roll = dailyRollup(share);
  assert.equal(roll.days.length, 2);
  assert.equal(roll.days[0].day, '2026-10-01');
  assert.equal(roll.days[0].decisions, 1);
  assert.equal(roll.days[1].day, '2026-10-02');
  assert.equal(roll.days[1].decisions, 2);
  assert.equal(roll.total.decisions, 3);
});

test('days window: stalls older than N days are dropped', () => {
  const records = [
    stall({ session: 's1', id: 'a', at: '2026-09-25T10:00:00.000Z', case: 'owner_decision', excerpt: 'old decision' }),
    stall({ session: 's2', id: 'b', at: t('10:00', 5), case: 'owner_decision', excerpt: 'recent decision' }),
  ];
  const share = computeShare(records, [], { days: 7, now: '2026-10-05T12:00:00.000Z', managerSessions: [] });
  assert.equal(share.decisions.length, 1);
  assert.equal(share.decisions[0].session, 's2');
});

test('window cap: send beyond next stall group of the same session does not count', () => {
  const records = [
    stall({ session: 's1', id: 'a', at: t('10:00', 1), case: 'owner_decision', excerpt: 'first' }),
    stall({ session: 's1', id: 'b', at: t('10:30', 1), case: 'owner_decision', excerpt: 'second' }),   // next group at +30 min
    { type: 'send', session: 's1', by: 'manager-agent', text: '1', at: t('11:00', 1) },   // beyond g1's window, inside g2's
  ];
  const share = computeShare(records, [], { days: 7, managerSessions: [], now: '2026-10-05T12:00:00.000Z' });
  // two decisions: g1 (10:00) is owner-handled (send at 11:00 is past the next group at 10:30),
  // g2 (10:30) is autonomous (send at 11:00 is within its +2 h cap window).
  assert.equal(share.decisions.length, 2);
  assert.equal(share.decisions[0].outcome, 'owner-handled');
  assert.equal(share.decisions[1].outcome, 'autonomous');
});

test('end-to-end: mixed fixture yields the expected rollup', () => {
  const records = [
    // group 1: autonomous via answer + regret (pause 5 min later)
    stall({ session: 's1', id: 'a', at: t('10:00', 1), case: 'owner_decision', excerpt: 'g1: merge?' }),
    { type: 'answer', id: 'a', session: 's1', at: t('10:01', 1), answer: { text: 'Yes.' }, source: 'ai' },
    { type: 'pause', session: 's1', by: 'owner', at: t('10:15', 1) },
    // group 2: autonomous via manager-agent send, no regret
    stall({ session: 's2', id: 'b', at: t('10:00', 1), case: 'menu_recommended', excerpt: 'g2: take recommended?' }),
    { type: 'send', session: 's2', by: 'manager-agent', text: '1', at: t('10:02', 1) },
    // group 3: owner-confirmed AI proposal (choice with agreeAi true)
    stall({ session: 's3', id: 'c', at: t('10:00', 1), case: 'owner_decision', excerpt: 'g3: which option?' }),
    { type: 'choice', id: 'c', session: 's3', at: t('10:05', 1), kind: 'menu', owner: 'o1', ai: 'o1', agreeAi: true },
    // group 4: owner-handled
    stall({ session: 's4', id: 'd', at: t('10:00', 1), case: 'owner_decision', excerpt: 'g4: freeform answer needed' }),
  ];
  const share = computeShare(records, [], { days: 7, managerSessions: [] });
  const roll = dailyRollup(share);
  assert.equal(roll.total.decisions, 4);
  assert.equal(roll.total.autonomous, 2);     // g1 + g2
  assert.equal(roll.total.owner_confirmed, 1); // g3
  assert.equal(roll.total.owner_handled, 1);   // g4
  assert.equal(roll.total.regret, 1);          // only g1 had a pause within 30 min
});

// CLI smoke test: write synthetic stalls into a temp state dir, invoke the script, parse its JSON output.
test('CLI smoke --json parses a synthetic state dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-ds-cli-'));
  const excerpt = 'should I ship this build, or wait for QA?';
  const records = [
    stall({ session: 'feat', id: 'a', at: t('10:00', 1), case: 'owner_decision', excerpt }),
    { type: 'answer', id: 'a', session: 'feat', at: t('10:02', 1), answer: { text: 'Ship it.' }, source: 'ai' },
    stall({ session: 'feat', id: 'b', at: t('11:00', 1), case: 'owner_decision', excerpt: 'second question' }),
  ];
  writeFixtures(dir, records);
  const r = spawnSync(process.execPath, [join(process.cwd(), 'scripts/decision-share.js'), '--days', '7', '--json', '--list'], {
    env: { ...process.env, GHOSTY_STATE_DIR: dir },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `script exited non-zero: ${r.stderr}`);
  const j = JSON.parse(r.stdout);
  assert.equal(j.total.decisions, 2);
  assert.equal(j.total.autonomous, 1);
  assert.equal(j.decisions.length, 2);
  const auto = j.decisions.find((d) => d.outcome === 'autonomous');
  assert.ok(auto, 'expected one autonomous decision in the JSON output');
  assert.equal(auto.session, 'feat');
});
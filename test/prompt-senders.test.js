import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promptSig, aiSenderOf, senderLabel } from '../public/prompt-sig.js';
import { tintOwnerPrompts, OWNER_BG } from '../public/pane-hints.js';
import { createPromptSenders } from '../prompt-senders.js';

const GOAL = 'Goal check: No goal was recorded for this session: state it from your first prompt or task doc.';
test('promptSig / aiSenderOf: an AI prompt is matched by the start of its text, the owner\'s is not', () => {
  assert.equal(promptSig('❯  Goal   check: No goal'), 'goal check: no goal');
  const ai = [{ sig: promptSig(GOAL), by: 'harness' }];
  assert.equal(aiSenderOf(GOAL + ' Did you reach it?', ai), 'harness');
  assert.equal(aiSenderOf('i need to differentiate AI manager answering from my own', ai), null);
  assert.equal(aiSenderOf('ok', ai), null, 'too short to match');
  assert.equal(senderLabel('manager-agent'), 'manager');
  assert.equal(senderLabel('integration'), 'integration lane');
});

test('tintOwnerPrompts: the owner\'s past prompt turns blue, the AI\'s stays gray, other rows untouched', () => {
  const G = '\x1b[48;5;237m';
  const pane = [
    `${G}❯ \x1b[38;5;231m${GOAL.slice(0, 60)}\x1b[39m`, `  \x1b[38;5;231m${GOAL.slice(60)}\x1b[39m\x1b[49m`, '',
    '● answer text', '',
    `${G}❯ \x1b[38;5;231mremove the purple fork icon also\x1b[39m\x1b[49m`, '',
    `\x1b[38;5;246m${G}❯ \x1b[38;5;231mfg code first, still mine\x1b[39m\x1b[49m`,
    '❯ ',
  ].join('\n');
  const ai = [{ sig: promptSig(GOAL), by: 'harness' }];
  const out = tintOwnerPrompts(pane, (t) => !!aiSenderOf(t, ai)).split('\n');
  assert.ok(out[0].startsWith(G), 'AI prompt keeps the gray');
  assert.ok(out[5].startsWith(OWNER_BG), 'owner prompt is blue');
  assert.equal(out[3], '● answer text');
  assert.ok(out[7].startsWith('\x1b[38;5;246m' + OWNER_BG), 'a foreground code before the gray: still tinted');
  assert.equal(out[8], '❯ ');
  assert.equal(tintOwnerPrompts('plain\ntext', () => false), 'plain\ntext');
});

test('createPromptSenders: the owner\'s sends are not recorded; the log tail seeds the AI side\'s', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'senders-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = join(dir, 'stalls.jsonl');
  writeFileSync(f, [
    JSON.stringify({ type: 'send', session: 's1', by: 'owner', text: 'my own words, please do this' }),
    JSON.stringify({ type: 'send', session: 's1', by: 'harness', text: GOAL }),
    JSON.stringify({ type: 'send', session: 's1', by: 'integration', key: 'Enter' }),
    JSON.stringify({ type: 'stall', session: 's1' }),
  ].join('\n') + '\n');
  const s = createPromptSenders({ max: 2 });
  await s.seed(f);
  assert.deepEqual(s.of('s1'), [{ sig: promptSig(GOAL), by: 'harness' }]);
  s.note('s1', 'owner', 'another owner message here');
  s.note('s1', 'manager-agent', 'Manager: stop polling ReadNotifications now');
  s.note('s1', 'integration', 'Integration int-1 merged into main');
  assert.deepEqual(s.of('s1').map((x) => x.by), ['manager-agent', 'integration'], 'capped to max, newest kept');
  assert.deepEqual(s.of('nope'), []);
});

test('the dashboard\'s checks count as the AI side: by their opening phrase, and every check send is recorded as harness', async () => {
  assert.equal(aiSenderOf('Goal check: No goal was recorded for this session', []), 'harness');
  assert.equal(aiSenderOf('Done check: your STATUS is not an end state', []), 'harness');
  assert.equal(aiSenderOf('goal: make the check pass please', []), null);
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /send(?:ToSession)?: \(name, text\) => sendKeys\(/, 'a check send that bypasses harnessSend is shown as the owner\'s');
  assert.match(src, /async function harnessSend[\s\S]{0,200}by: 'harness'[\s\S]{0,120}promptSenders\.note\(name, 'harness'/);
});

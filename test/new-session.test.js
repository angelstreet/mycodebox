import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickableProject, launchArgs, codexModels, projectFromCwd } from '../new-session.js';

const H = '/home/u';

test('picker keeps repos under home and drops tmp, scratchpad, lane and hidden-folder ones', () => {
  for (const p of ['/home/u/voicebox', '/home/u/voicebox-core', '/home/u/src/app', '/home/u/template']) assert.equal(pickableProject(p, H), true, p);
  for (const p of ['/home/u', '/tmp/claude-1000/x/scratchpad/wt', '/home/u/tmp-tests/lane-1/dev', '/home/u/tmp/x', '/home/u/temp',
    '/home/u/.local/state/ghosty/integration/wt/int-1', '/home/u/.local/share/game-dispatch/repo', '/home/u/.claude/worktrees/a', '/home/uv/x'])
    assert.equal(pickableProject(p, H), false, p);
});

test('launch args carry the model per CLI and read the prompt from a file', () => {
  assert.equal(launchArgs('claude', { model: 'sonnet' }), " --model 'sonnet'");
  assert.equal(launchArgs('codex', { model: 'gpt-6.2-sol' }), " -m 'gpt-6.2-sol'");
  assert.equal(launchArgs('minimax', { model: 'MiniMax-M3' }), " -m 'minimax/MiniMax-M3'");
  assert.equal(launchArgs('claude', { model: 'opus', promptFile: "/s/p/a'b.txt" }), ` --model 'opus' "$(cat '/s/p/a'\\''b.txt')"`);
  assert.equal(launchArgs('bash', { promptFile: '/s/p.txt' }), '');
  assert.equal(launchArgs('claude', {}), '');
  assert.throws(() => launchArgs('claude', { model: 'opus; rm -rf ~' }), /invalid model/);
});

test('codex models: listed ones only, configured default first', () => {
  const cache = { models: [{ slug: 'gpt-6.2-sol', visibility: 'list' }, { slug: 'gpt-reserve', visibility: 'hide' }, { slug: 'gpt-5.6-luna', visibility: 'list' }] };
  assert.deepEqual(codexModels(cache, 'model = "gpt-5.6-luna"\n'), { models: ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-5.6-luna'], default: 'gpt-6.2-sol' });
  // gpt-6.2-sol is the preselected one when the CLI lists it, and at most 4 models are offered
  const many = { models: ['gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6.2-sol', 'gpt-5.6-sol', 'gpt-reserve'].map((slug) => ({ slug, visibility: 'list' })) };
  assert.deepEqual(codexModels(many, 'model = "gpt-5.6-luna"\n'), { models: ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-5.6-sol'], default: 'gpt-6.2-sol' });
  assert.deepEqual(codexModels(null, ''), { models: ['gpt-6.2-sol', 'gpt-6.2-astra'], default: 'gpt-6.2-sol' });
  const stale = { models: ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6.1-sol'].map((slug) => ({ slug, visibility: 'list' })) };
  assert.deepEqual(codexModels(stale, ''), { models: ['gpt-6.2-sol', 'gpt-6.2-astra'], default: 'gpt-6.2-sol' });
});

test('a Mac Claude worktree reports its repo as the project', () => {
  assert.equal(projectFromCwd('/Users/x/virtualpytest/.claude/worktrees/vpt-mf1-agent-investigation-1ebf0f'), 'virtualpytest');
  assert.equal(projectFromCwd('/Users/x/virtualpytest/.claude/worktrees/a/sub'), 'virtualpytest');
  assert.equal(projectFromCwd('/Users/x/virtualpytest'), null);
});

import { aiNamePrompt, cleanAiName, nameFromWords } from '../new-session.js';
test('session name from the prompt: a model answer is cleaned, a sentence is refused, the words are the fallback', () => {
  assert.equal(cleanAiName('vpt-stream-device-quality\n\nSTATUS: done — x'), 'vpt-stream-device-quality');
  assert.equal(cleanAiName('`Default Stream Quality`'), '');
  assert.equal(cleanAiName('"stream-quality."'), 'stream-quality');
  assert.equal(cleanAiName("I haven't started on this yet."), '');
  assert.equal(cleanAiName('a-very-long-name-that-keeps-going-and-going'), '');
  assert.ok(cleanAiName('alpha-bravo-charlie-delta-echo').length <= 28);
  assert.equal(nameFromWords('i need a new .env optionnal argument in host so that we can for vpt-stream define a stream quality'), 'env-optionnal-argument-host');
  assert.equal(nameFromWords('@/home/u/.ghosty/uploads/x.png https://x.example/a'), '');
  assert.match(aiNamePrompt('x'.repeat(5000)), /<request>\nx{1500}\n<\/request>/);
});

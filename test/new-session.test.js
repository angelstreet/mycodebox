import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickableProject, launchArgs, codexModels } from '../new-session.js';

const H = '/home/u';

test('picker keeps repos under home and drops tmp, scratchpad, lane and hidden-folder ones', () => {
  for (const p of ['/home/u/voicebox', '/home/u/voicebox-core', '/home/u/src/app', '/home/u/template']) assert.equal(pickableProject(p, H), true, p);
  for (const p of ['/home/u', '/tmp/claude-1000/x/scratchpad/wt', '/home/u/tmp-tests/lane-1/dev', '/home/u/tmp/x', '/home/u/temp',
    '/home/u/.local/state/ghosty/integration/wt/int-1', '/home/u/.local/share/game-dispatch/repo', '/home/u/.claude/worktrees/a', '/home/uv/x'])
    assert.equal(pickableProject(p, H), false, p);
});

test('launch args carry the model per CLI and read the prompt from a file', () => {
  assert.equal(launchArgs('claude', { model: 'sonnet' }), " --model 'sonnet'");
  assert.equal(launchArgs('codex', { model: 'gpt-6-sol' }), " -m 'gpt-6-sol'");
  assert.equal(launchArgs('minimax', { model: 'MiniMax-M3' }), " -m 'minimax/MiniMax-M3'");
  assert.equal(launchArgs('claude', { model: 'opus', promptFile: "/s/p/a'b.txt" }), ` --model 'opus' "$(cat '/s/p/a'\\''b.txt')"`);
  assert.equal(launchArgs('bash', { promptFile: '/s/p.txt' }), '');
  assert.equal(launchArgs('claude', {}), '');
  assert.throws(() => launchArgs('claude', { model: 'opus; rm -rf ~' }), /invalid model/);
});

test('codex models: listed ones only, configured default first', () => {
  const cache = { models: [{ slug: 'gpt-6-sol', visibility: 'list' }, { slug: 'gpt-reserve', visibility: 'hide' }, { slug: 'gpt-5.6-luna', visibility: 'list' }] };
  assert.deepEqual(codexModels(cache, 'model = "gpt-5.6-luna"\n'), { models: ['gpt-5.6-luna', 'gpt-6-sol'], default: 'gpt-5.6-luna' });
  assert.deepEqual(codexModels(null, ''), { models: [], default: null });
});

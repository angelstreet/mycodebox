import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOpenRouterModel, isAllowedOpenRouterModel, rejectedCounts, resetRejected, OpenRouterModelNotAllowed } from '../openrouter-guard.js';
import { JUDGE_MODEL, ensureJudge } from '../scripts/lf-setup.js';

const quiet = { log: () => {} };

test('allowed: Qwen3 VL 8B Instruct, Jev', () => {
  for (const m of ['qwen/qwen3-vl-8b-instruct', 'typesafe/jev-1.13', 'typesafe/jev-router']) {
    checkOpenRouterModel(m, quiet);
  }
});

test('rejected and counted: Claude, MiniMax, GPT-4.1 Mini, GLM, Grok, empty', () => {
  resetRejected();
  const bad = ['openai/o4-mini', 'openai/o4-mini-high', 'o4-mini', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5', 'minimax/minimax-m3', 'openai/gpt-4.1-mini', 'z-ai/glm-5.3', 'x-ai/grok-4.7', '', undefined];
  for (const m of bad) assert.throws(() => checkOpenRouterModel(m, quiet), OpenRouterModelNotAllowed);
  assert.equal(Object.values(rejectedCounts()).reduce((a, b) => a + b, 0), bad.length);
});

test('the Langfuse judge model is allowlisted and its setup request is attempted', async () => {
  assert.equal(isAllowedOpenRouterModel(JUDGE_MODEL), true);
  let sent = 0;
  await ensureJudge({}, { apiKey: 'k', fetchFn: async () => { sent++; throw new Error('stop'); } }).catch(() => {});
  assert.ok(sent >= 1);   // allowed model: the request is attempted
});

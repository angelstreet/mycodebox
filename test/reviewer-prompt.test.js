import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One mock server plays the VPT server (/server/ai/complete) and Langfuse (/api/public/v2/prompts/...).
const reviewerCalls = [];
let promptAnswer = { status: 200, body: { type: 'text', version: 4, prompt: 'SYSTEM FROM LANGFUSE', name: 'ghosty-ai-reviewer' } };
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/public/v2/prompts/ghosty-ai-reviewer')) { res.statusCode = promptAnswer.status; return res.end(JSON.stringify(promptAnswer.body)); }
    if (req.url === '/server/ai/complete') {
      reviewerCalls.push(JSON.parse(b));
      return res.end(JSON.stringify({ success: true, content: JSON.stringify({ proposed_reply: 'Yes, continue.', reasoning: 'ok', confidence: 0.9, owner_needed: false, owner_needed_why: '' }), usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, model: 'mock' }));
    }
    res.end('{}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
after(() => { srv.closeAllConnections(); srv.close(); });

const base = `http://127.0.0.1:${srv.address().port}`;
const dir = mkdtempSync(join(tmpdir(), 'ghosty-rprompt-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, JEV_URL: `${base}/server/ai/decide`, JEV_API_KEY: 'k', LANGFUSE_URL: base, LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk', LANGFUSE_PROJECT: 'proj1' });
const m = await import('../manager.js');
const { REVIEWER_SYSTEM } = await import('../triage.js');
await m.initManager({ onOwnerNeeded: () => {}, sendKey: async () => {}, sendKeys: async () => {}, context: () => ({}) });
await m.setManagerConfig({ aiTriage: 'simulate', autoSend: false });

const ask = (id) => m.triageStop({ name: 's', id, final: { case: 'owner_decision', question: 'x?', source: 'rule' }, stall: { excerpt: 'x' }, state: 'done', agent: 'claude', project: 'p' });

test('the reviewer uses the Langfuse prompt and its record carries name + version + the facts\' flags', async () => {
  const rec = await ask('p1');
  assert.equal(reviewerCalls.at(-1).system, 'SYSTEM FROM LANGFUSE');
  assert.deepEqual(rec.prompt, { name: 'ghosty-ai-reviewer', version: 4 });
  assert.equal(rec.src, 'rule');
  assert.deepEqual(rec.flags, []);
});

test('the prompt is cached: a second stop does not fetch again, and a Langfuse outage later keeps the cached prompt', async () => {
  promptAnswer = { status: 500, body: {} };
  const rec = await ask('p2');
  assert.equal(reviewerCalls.at(-1).system, 'SYSTEM FROM LANGFUSE');
  assert.equal(rec.prompt.version, 4);
});

test('langfuse links for the manager panel are built from LANGFUSE_URL and the project', () => {
  const l = m.langfuseLinks({ LANGFUSE_URL: `${base}/`, LANGFUSE_PROJECT: 'proj1' });
  assert.equal(l.scores, `${base}/project/proj1/scores`);
  assert.equal(l.prompt, `${base}/project/proj1/prompts/ghosty-ai-reviewer`);
  assert.equal(l.evaluator, `${base}/project/proj1/evals`);
  assert.equal(m.langfuseLinks({ LANGFUSE_URL: '' }), null);
  assert.equal(m.managerConfig().langfuse.dataset, `${base}/project/proj1/datasets`);
});

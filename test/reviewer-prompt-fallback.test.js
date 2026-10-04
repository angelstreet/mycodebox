import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Langfuse has no such prompt (404): the hard-coded REVIEWER_SYSTEM is used and no prompt version is recorded.
const reviewerCalls = [];
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/public/v2/prompts/')) { res.statusCode = 404; return res.end('{}'); }
    if (req.url === '/server/ai/complete') { reviewerCalls.push(JSON.parse(b)); return res.end(JSON.stringify({ success: true, content: JSON.stringify({ proposed_reply: '', reasoning: 'ok', confidence: 0.5, owner_needed: true, owner_needed_why: 'x' }), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, model: 'mock' })); }
    res.end('{}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
after(() => { srv.closeAllConnections(); srv.close(); });
const base = `http://127.0.0.1:${srv.address().port}`;
Object.assign(process.env, { GHOSTY_STATE_DIR: mkdtempSync(join(tmpdir(), 'ghosty-rpf-')), JEV_URL: `${base}/server/ai/decide`, JEV_API_KEY: 'k', LANGFUSE_URL: base, LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' });
const m = await import('../manager.js');
const { REVIEWER_SYSTEM } = await import('../triage.js');
await m.initManager({ onOwnerNeeded: () => {}, sendKey: async () => {}, sendKeys: async () => {}, context: () => ({}) });
await m.setManagerConfig({ aiTriage: 'simulate', autoSend: false });

test('no Langfuse prompt: the hard-coded system prompt, no prompt version on the record', async () => {
  const rec = await m.triageStop({ name: 's', id: 'f1', final: { case: 'owner_decision', question: 'x?', source: 'rule' }, stall: { excerpt: 'x' }, state: 'done', agent: 'claude' });
  assert.equal(reviewerCalls.at(-1).system, REVIEWER_SYSTEM);
  assert.equal(rec.prompt, undefined);
  assert.ok(rec.ai);
});

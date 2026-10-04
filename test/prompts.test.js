import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptSource, PROMPT_NAME, PROMPT_LABEL } from '../prompts.js';
import { reviewerRequest, REVIEWER_SYSTEM } from '../triage.js';

const cfg = { langfuseUrl: 'http://lf.test', publicKey: 'pk', secretKey: 'sk' };
const okRes = (version, prompt = `prompt v${version}`) => new Response(JSON.stringify({ name: PROMPT_NAME, type: 'text', version, prompt, labels: [PROMPT_LABEL] }), { status: 200 });

function setup(responses, o = {}) {
  const calls = []; let t = 1_000_000;
  const fetchFn = async (url, init) => { calls.push({ url, auth: init.headers.authorization }); const r = responses.shift(); if (r instanceof Error) throw r; return r; };
  const src = createPromptSource({ cfg: o.cfg || cfg, fallback: 'FALLBACK', fetchFn, now: () => t });
  return { src, calls, tick: (ms) => { t += ms; } };
}

test('prompt: fetched by name + production label, cached 10 minutes, refetched after', async () => {
  const { src, calls, tick } = setup([okRes(3), okRes(4)]);
  const a = await src.get();
  assert.deepEqual(a, { text: 'prompt v3', name: PROMPT_NAME, version: 3, source: 'langfuse' });
  assert.equal(calls[0].url, `http://lf.test/api/public/v2/prompts/${PROMPT_NAME}?label=${PROMPT_LABEL}`);
  assert.equal(calls[0].auth, 'Basic ' + Buffer.from('pk:sk').toString('base64'));
  tick(9 * 60000); assert.equal((await src.get()).version, 3); assert.equal(calls.length, 1, 'cached');
  tick(2 * 60000); assert.equal((await src.get()).version, 4); assert.equal(calls.length, 2, 'refetched after the ttl');
});

test('prompt: fallback when not configured, missing, down or malformed; stale good prompt beats the fallback', async () => {
  const none = setup([], { cfg: { langfuseUrl: '', publicKey: '', secretKey: '' } });
  assert.deepEqual(await none.src.get(), { text: 'FALLBACK', name: null, version: null, source: 'fallback' });
  assert.equal(none.calls.length, 0);

  const miss = setup([new Response('{}', { status: 404 }), okRes(1)]);
  assert.equal((await miss.src.get()).source, 'fallback');
  assert.equal((await miss.src.get()).source, 'fallback'); assert.equal(miss.calls.length, 1, 'no retry within a minute');
  miss.tick(61000);
  assert.equal((await miss.src.get()).version, 1, 'recovers once Langfuse has it');

  const bad = setup([new Response(JSON.stringify({ type: 'chat', prompt: [], version: 1 }), { status: 200 })]);
  assert.equal((await bad.src.get()).source, 'fallback');
  const down = setup([new Error('ECONNREFUSED')]);
  assert.equal((await down.src.get()).text, 'FALLBACK');

  const stale = setup([okRes(2), new Error('down'), okRes(5)]);
  await stale.src.get();
  stale.tick(11 * 60000);
  assert.equal((await stale.src.get()).version, 2, 'refresh failed: keep the last good prompt');
  assert.equal(stale.calls.length, 2);
  stale.tick(61000);
  assert.equal((await stale.src.get()).version, 5);
});

test('reviewer request uses the given system prompt, the hard-coded one by default', () => {
  const f = { session: 's', case: 'continue', text: 't' };
  assert.equal(reviewerRequest(f).system, REVIEWER_SYSTEM);
  assert.equal(reviewerRequest(f, { system: 'from langfuse' }).system, 'from langfuse');
});

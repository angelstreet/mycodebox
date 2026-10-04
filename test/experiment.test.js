import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runExperiment, expectedCase } from '../usage/experiment.js';

// Synthetic dataset only: no real stop content.
const item = (id, text, expected, extra = {}) => ({ id, status: 'ACTIVE', input: { closing_text: text, case_by_rules: 'continue', agent: 'claude', state: 'done', ...extra }, expectedOutput: expected });
const ITEMS = [
  item('i1', 'Phase 1 is done and tested.\nShall I continue with phase 2?', { verdict: 'no_reason' }),
  item('i2', 'Two options.\n1. Use A (recommended)\n2. Use B\nWhich one?', { verdict: 'legit' }, { case_by_rules: 'menu_recommended' }),
  item('i3', 'Done. Everything is tested.', { verdict: 'wrong_case', correct_case: 'done' }),
  item('i4', 'Done. Everything is tested.', { verdict: 'wrong_case' }),                       // wrong case, right case unknown: no case score
  { ...item('i5', 'archived', { verdict: 'legit' }), status: 'ARCHIVED' },
];

const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections(); s.close(); }));
function mock(items = ITEMS) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = b ? JSON.parse(b) : null;
      calls.push({ method: req.method, url: req.url, body });
      const send = (j, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (req.url.startsWith('/api/public/dataset-items')) return send({ data: items, meta: { page: 1, totalPages: 1 } });
      if (req.url === '/api/public/dataset-run-items') return send({ id: 'ri', datasetRunId: 'run-123' });
      if (req.url === '/api/public/ingestion') return send({ errors: [] }, 207);
      send({});
    });
  });
  servers.push(srv);
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ calls, url: `http://127.0.0.1:${srv.address().port}` })));
}
const evs = (calls, type) => calls.filter((c) => c.url === '/api/public/ingestion').flatMap((c) => c.body.batch).filter((e) => e.type === type).map((e) => e.body);

test('expectedCase: the owner\'s correct case, else the logged one, null when wrong and unknown', () => {
  assert.equal(expectedCase(ITEMS[0]), 'continue');
  assert.equal(expectedCase(ITEMS[2]), 'done');
  assert.equal(expectedCase(ITEMS[3]), null);
});

test('experiment (rules): one trace + run item per active item, case / verdict scores, run-level accuracy', async () => {
  const lf = await mock();
  const cfg = { langfuseUrl: lf.url, publicKey: 'pk', secretKey: 'sk' };
  const s = await runExperiment({ cfg, runName: 'rules-v1', classifier: 'rules' });
  assert.equal(s.items, 4, 'the archived item is skipped');
  assert.equal(s.datasetRunId, 'run-123');
  const traces = evs(lf.calls, 'trace-create');
  assert.equal(traces.length, 4);
  assert.ok(traces.every((t) => t.name === 'stops-experiment:rules-v1' && t.tags.includes('classifier:rules')));
  const runItems = lf.calls.filter((c) => c.url === '/api/public/dataset-run-items').map((c) => c.body);
  assert.deepEqual(runItems.map((r) => r.datasetItemId), ['i1', 'i2', 'i3', 'i4']);
  assert.ok(runItems.every((r) => r.runName === 'rules-v1' && traces.some((t) => t.id === r.traceId)));
  const scores = evs(lf.calls, 'score-create');
  const per = (name) => scores.filter((x) => x.name === name && x.traceId);
  assert.equal(per('verdict_match').length, 2, 'verdict only where the label is legit / no_reason');
  assert.equal(per('case_match').length, 3, 'case where the right case is known');
  const run = scores.filter((x) => x.datasetRunId === 'run-123').map((x) => x.name).sort();
  assert.deepEqual(run, ['case_accuracy', 'verdict_accuracy']);
  assert.ok(scores.every((x) => x.id && x.id.length === 32), 'deterministic ids');
  // same run again: same trace and score ids (upsert)
  const lf2 = await mock();
  await runExperiment({ cfg: { ...cfg, langfuseUrl: lf2.url }, runName: 'rules-v1', classifier: 'rules' });
  assert.deepEqual(evs(lf2.calls, 'score-create').map((x) => x.id), scores.map((x) => x.id));
});

test('experiment (jev): calls the endpoint once per item, maps the pick to case + verdict; errors score nothing', async () => {
  const lf = await mock([ITEMS[0], ITEMS[1]]);
  const cfg = { langfuseUrl: lf.url, publicKey: 'pk', secretKey: 'sk' };
  const asked = [];
  const fetchFn = async (url, init) => {
    if (url.startsWith(lf.url)) return fetch(url, init);
    asked.push(JSON.parse(init.body));
    const n = asked.length;
    return new Response(JSON.stringify(n === 1 ? { success: true, cost: 0.00002, answers: { choice: { choice: 'continue' } } } : { success: false, error: 'boom' }), { status: 200 });
  };
  const s = await runExperiment({ cfg, runName: 'jev-1', classifier: 'jev', env: { jevUrl: 'http://jev.test/server/ai/decide', apiKey: 'k' }, fetchFn });
  assert.equal(asked.length, 2);
  assert.equal(asked[0].profile, 'jev');
  assert.match(asked[0].state, /Shall I continue with phase 2/);
  assert.equal(s.errors, 1);
  assert.equal(s.verdict_accuracy.n, 1);
  assert.equal(s.verdict_accuracy.value, 1, 'continue -> no_reason, as the owner labelled');
  assert.ok(s.cost > 0);
  const out = evs(lf.calls, 'trace-create').map((t) => t.output);
  assert.equal(out[0].verdict, 'no_reason');
  assert.ok(out[1].error);
});

test('experiment: needs a run name and a known classifier', async () => {
  await assert.rejects(runExperiment({ cfg: {}, classifier: 'rules' }), /run-name/);
  await assert.rejects(runExperiment({ cfg: {}, runName: 'x', classifier: 'magic' }), /classifier must be/);
});

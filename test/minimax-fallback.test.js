// Round 9 item 10: with no OpenRouter credit (or Jev down) the manager's AI triage and Jev-style choices go to MiniMax M3 via headless mcode.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs, { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFallbackDecider, parseChoice, parseExecOutput, resetNoLightweightWarning } from '../minimax-fallback.js';

const work = mkdtempSync(join(tmpdir(), 'fallback-'));
const LOG = join(work, 'calls.jsonl');
const FAKE = join(work, 'mcode');
// A fake `mcode`: logs its argv, then prints 0.6.5-shaped JSONL according to MCODE_FAKE_MODE.
writeFileSync(FAKE, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'exec' && args[1] === '--help') { fs.appendFileSync(process.env.MCODE_FAKE_LOG, JSON.stringify({ args }) + '\\n'); console.log(!process.env.MCODE_FAKE_NOLIGHT ? '  --mode <mode>  lightweight or full\\n  --permission <p>' : '  --permission <p>'); process.exit(0); }
const mode = process.env.MCODE_FAKE_MODE || 'ok';
fs.appendFileSync(process.env.MCODE_FAKE_LOG, JSON.stringify({ args, cwd: process.cwd(), cwdFiles: fs.readdirSync(process.cwd()), mode, leaked: Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET/.test(k)) }) + '\\n');
const prompt = args[args.length - 1];
const out = (o) => console.log(JSON.stringify(o));
if (mode === 'hang') { fs.appendFileSync(process.env.MCODE_FAKE_LOG + '.pids', process.pid + '\\n'); require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }).on('spawn', function () { fs.appendFileSync(process.env.MCODE_FAKE_LOG + '.pids', this.pid + '\\n'); }); setInterval(() => {}, 1000); }
else if (mode === 'slow') setTimeout(() => { out({ type: 'item.completed', item: { type: 'agent_message', content: '{}' } }); }, 600);
else if (mode === 'tool') { out({ type: 'item.started', item: { type: 'tool_call', name: 'bash' } }); out({ type: 'item.completed', item: { type: 'agent_message', content: JSON.stringify({ choice: 'continue', confidence: 0.9 }) } }); out({ type: 'exec.completed', result: { status: 'succeeded', output: JSON.stringify({ proposed_reply: 'rm -rf', reasoning: 'x', confidence: 1, owner_needed: false }) } }); }
else if (mode === 'fail') { out({ type: 'exec.failed', error: { message: 'plan usage limit reached' } }); process.exit(1); }
else {
  let text;
  if (mode === 'junk') text = 'I think you should continue.';
  else if (prompt.includes('Choices:')) text = JSON.stringify({ choice: mode === 'badchoice' ? 'nope' : 'ask_owner', confidence: 0.99, probabilities: { continue: 0.1, take_recommended: 0.1, ask_owner: 0.8 } });
  else text = JSON.stringify({ proposed_reply: 'Use Postgres.', reasoning: 'Already in the stack.', confidence: 0.9, owner_needed: false, owner_needed_why: '', options: [] });
  out({ type: 'exec.started', sessionId: 's1' });
  out({ type: 'item.completed', item: { type: 'agent_message', content: text } });
  out({ type: 'exec.completed', result: { type: 'exec.result', status: 'succeeded', output: text } });
}
`);
chmodSync(FAKE, 0o755);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const calls = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const decider = (mode, o = {}) => createFallbackDecider({ bin: FAKE, env: { PATH: process.env.PATH, HOME: work, MCODE_FAKE_MODE: mode, MCODE_FAKE_LOG: LOG, ...(o.nolight ? { MCODE_FAKE_NOLIGHT: '1' } : {}), JEV_API_KEY: 'must-not-leak', OPENROUTER_TOKEN: 'x' }, ...(({ nolight, ...rest }) => rest)(o) });   // leak-scan: allow (fake values)
const BODY = { state: '{"x":1}', questions: { choice: { type: 'choice', instructions: 'What next?', criteria: { continue: 'carry on', take_recommended: 'take it', ask_owner: 'owner decides' } } } };
const FACTS = { session: 's', agent: 'claude', project: 'p', priority: 'P2', state: 'done', case: 'owner_decision', source: 'rule', flags: [], text: 'Redis or Postgres for the cache?' };

test('parseExecOutput: 0.6.3 and 0.6.5 shapes, failures', () => {
  assert.equal(parseExecOutput('{"type":"item.completed","item":{"type":"agent_message","content":"hi"}}\n').text, 'hi');
  assert.equal(parseExecOutput('{"type":"exec.completed","result":"old"}\n').text, 'old');
  assert.equal(parseExecOutput('{"type":"exec.completed","result":{"status":"succeeded","output":"new"}}\n').text, 'new');
  assert.match(parseExecOutput('{"type":"exec.failed","error":{"message":"quota"}}\n').error, /quota/);
  assert.match(parseExecOutput('garbage\n').error, /no answer/);
});

test('parseChoice: only listed choices, probabilities normalised, confidence capped', () => {
  const keys = ['continue', 'take_recommended', 'ask_owner'];
  assert.equal(parseChoice('{"choice":"merge"}', keys), null);
  assert.equal(parseChoice('not json', keys), null);
  const a = parseChoice('```json\n{"choice":"continue","confidence":1,"probabilities":{"continue":3,"take_recommended":1,"ask_owner":0}}\n```', keys);
  assert.equal(a.choice, 'continue'); assert.ok(a.confidence <= 0.95); assert.ok(Math.abs(Object.values(a.probabilities).reduce((x, y) => x + y, 0) - 1) < 0.2);
  const b = parseChoice('{"choice":"ask_owner","confidence":0.6}', keys);
  assert.equal(b.confidence, 0.6); assert.equal(b.probabilities.ask_owner, 0.6);
});

test('reviewer(): same prompt and parser, headless and sandboxed: smart permission, empty temp cwd, one step, 20 s, no secrets in the environment', async () => {
  const d = decider('ok');
  const r = await d.reviewer({ facts: FACTS });
  assert.equal(r.source, 'minimax-fallback'); assert.equal(r.cost, 0);
  assert.equal(r.ai.proposed_reply, 'Use Postgres.'); assert.equal(r.ai.owner_needed, false);
  const c = calls().at(-1);
  assert.ok(c.args.includes('exec'));
  assert.equal(c.args[c.args.indexOf('--permission') + 1], 'smart'); assert.ok(!c.args.includes('full'));
  assert.equal(c.args[c.args.indexOf('--max-steps') + 1], '1');
  assert.equal(c.args[c.args.indexOf('--model') + 1], 'minimax/MiniMax-M3');
  assert.equal(c.args[c.args.indexOf('--timeout') + 1], '20s');
  assert.match(c.args.at(-1), /Redis or Postgres/);
  assert.match(c.args[c.args.indexOf('--system-prompt') + 1], /operations supervisor/);
  assert.deepEqual(c.cwdFiles, [], 'an empty directory');
  assert.ok(c.cwd.startsWith(tmpdir()) || c.cwd.startsWith('/tmp'), 'not the repo');
  assert.ok(!existsSync(c.args[c.args.indexOf('--cwd') + 1]), 'removed afterwards');
  assert.deepEqual(c.leaked, [], 'no key / token variables reach mcode');
  const bad = await decider('junk').reviewer({ facts: FACTS });
  assert.ok(bad.error && !bad.ai, 'an answer that is not JSON never becomes a proposal');
});

test('choice(): a Jev-shaped reply; an invalid choice, a failure and a hang are errors (the hang is killed at the timeout)', async () => {
  const ok = await decider('ok').choice(BODY);
  assert.equal(ok.success, true); assert.equal(ok.answers.choice.choice, 'ask_owner'); assert.ok(ok.answers.choice.confidence <= 0.95); assert.equal(ok.cost, 0); assert.equal(ok.source, 'minimax-fallback');
  assert.match((await decider('badchoice').choice(BODY)).error, /not a valid choice/);
  assert.match((await decider('fail').choice(BODY)).error, /plan usage limit/);
  assert.match((await decider('ok').choice({ state: 'x' })).error, /no choice/);
  const t0 = Date.now();
  const h = await decider('hang', { timeoutMs: 400 }).choice(BODY);
  assert.match(h.error, /timeout/); assert.ok(Date.now() - t0 < 3000);
  const leftover = readdirSync(tmpdir()).filter((f) => f.startsWith('mcode-fallback-'));
  assert.deepEqual(leftover, [], 'temp dirs are cleaned up, also after a kill');
});

test('three failures in a row pause the fallback; a missing binary is an error, not a throw', async () => {
  const d = decider('fail');
  for (let i = 0; i < 3; i++) await d.choice(BODY);
  const n = calls().length;
  assert.match((await d.choice(BODY)).error, /paused/);
  assert.equal(calls().length, n, 'no process started while paused');
  const none = await createFallbackDecider({ bin: join(work, 'no-such-mcode'), env: { PATH: process.env.PATH } }).choice(BODY);
  assert.equal(none.skipped, 'mcode without lightweight mode', 'a binary that cannot be probed is refused');
});

// ---- the manager: credits down -> fallback; switch off; cap; a 402 found by the call itself ----
let primary = 0, primaryMode = 'ok';
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => {
    primary += 1;
    res.setHeader('content-type', 'application/json');
    if (primaryMode === '402') return res.end(JSON.stringify({ success: false, error: 'OpenRouter 402: insufficient credits' }));
    if (req.url === '/server/ai/complete') return res.end(JSON.stringify({ success: true, content: JSON.stringify({ proposed_reply: 'primary', reasoning: 'r', confidence: 0.9, owner_needed: false }), usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    res.end(JSON.stringify({ success: true, cost: 0, ms: 1, answers: { choice: { choice: 'continue', confidence: 0.9, probabilities: { continue: 0.9, take_recommended: 0.05, ask_owner: 0.05 } } } }));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const dir = mkdtempSync(join(tmpdir(), 'ghosty-fb-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000', JEV_URL: `http://127.0.0.1:${srv.address().port}/server/ai/decide`, JEV_API_KEY: 'test-key' });
const m = await import('../manager.js');
let balance = 0;
await m.initManager({ onOwnerNeeded: () => {}, credits: () => ({ ok: true, balance }) });
m.setFallbackDecider(decider('ok'));
await m.setManagerConfig({ aiTriage: 'simulate', autoSend: false, routerShadow: false, wakeShadow: false });
test.after(() => srv.close());

const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const records = () => (existsSync(m.LOG_FILE) ? readFileSync(m.LOG_FILE, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = (name, state, plain, now) => m.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, realWork: state === 'working', project: 'p', now });
async function stall(name, text, type = null) {
  tick(name, 'working', ['busy'], 0); tick(name, 'done', pane(text), 1000); tick(name, 'done', pane(text), 2500);
  for (let i = 0; i < 120 && !records().some((r) => r.session === name && (type ? r.type === type : r.type === 'triage' || r.type === 'escalated')); i++) await sleep(25);
  await sleep(40);
}
const ASK = 'Design is ready.\nDo you want Redis or Postgres for the cache?';
const AMBIG = 'All good.\nNext is the cleanup of the cache code.';

test('no OpenRouter credit: the AI triage is read by MiniMax (source minimax-fallback), nothing is sent to the primary, and it is journalled', async () => {
  const before = primary, c0 = calls().filter((c) => c.args[1] !== '--help').length;
  await stall('fb1', ASK);
  const t = records().find((r) => r.type === 'triage' && r.session === 'fb1');
  assert.ok(t, 'a triage record'); assert.equal(t.source, 'minimax-fallback'); assert.equal(t.ai.proposed_reply, 'Use Postgres.'); assert.equal(t.cost, 0);
  assert.equal(primary, before, 'the primary was not called');
  assert.equal(calls().filter((c) => c.args[1] !== '--help').length, c0 + 1);
  const f = records().find((r) => r.type === 'fallback' && r.session === 'fb1');
  assert.equal(f.source, 'minimax-fallback'); assert.equal(f.for, 'triage'); assert.equal(f.ok, true); assert.equal(f.cap, 300);
});

test('no OpenRouter credit: an ambiguous stop is decided by the fallback (Jev-style choice) instead of skipped', async () => {
  await stall('fb2', AMBIG, 'stall');
  const s = records().find((r) => r.type === 'stall' && r.session === 'fb2');
  assert.equal(s.jev.choice, 'ask_owner'); assert.equal(s.jev.source, 'minimax-fallback');
  assert.ok(records().some((r) => r.type === 'fallback' && r.for === 'jev' && r.session === 'fb2'));
});

test('aiFallback "off" restores the old behaviour: skipped, no mcode process', async () => {
  await m.setManagerConfig({ aiFallback: 'off' });
  const c0 = calls().length;
  await stall('fb3', AMBIG, 'stall');
  const s = records().find((r) => r.type === 'stall' && r.session === 'fb3');
  assert.match(s.jev.skipped, /credit used up/);
  assert.equal(calls().length, c0);
  await assert.rejects(() => m.setManagerConfig({ aiFallback: 'gpt' }), /aiFallback must be/);
  await m.setManagerConfig({ aiFallback: 'minimax' });
});

test('the daily cap stops fallback calls', async () => {
  await m.setManagerConfig({ aiFallbackDailyCalls: 0 });
  const c0 = calls().length;
  await stall('fb4', ASK);
  const t = records().find((r) => r.type === 'triage' && r.session === 'fb4');
  assert.match(t.skipped, /daily cap/);
  assert.equal(calls().length, c0);
  await m.setManagerConfig({ aiFallbackDailyCalls: 300 });
});

test('credit is back: the primary is used again; a 402 found by the reviewer call itself still gets the stop read by the fallback', async () => {
  balance = 5; m.resetJevCooldown();
  const before = primary;
  await stall('fb5', ASK);
  assert.ok(primary > before, 'primary called');
  assert.equal(records().find((r) => r.type === 'triage' && r.session === 'fb5').ai.proposed_reply, 'primary');
  primaryMode = '402';
  await stall('fb6', ASK);
  const t = records().find((r) => r.type === 'triage' && r.session === 'fb6');
  assert.equal(t.source, 'minimax-fallback'); assert.equal(t.ai.proposed_reply, 'Use Postgres.');
  primaryMode = 'ok'; m.resetJevCooldown();
});

test('a tool call anywhere in the output is an error, never an answer', async () => {
  assert.match(parseExecOutput('{"type":"item.started","item":{"type":"tool_call","name":"bash"}}\n{"type":"item.completed","item":{"type":"agent_message","content":"{}"}}\n').error, /tool call/);
  assert.match(parseExecOutput('{"type":"item.completed","item":{"type":"agent_message","content":"x"},"tool_use":{"name":"Read"}}\n').error, /tool call/);
  const d = decider('tool');
  assert.match((await d.reviewer({ facts: FACTS })).error, /tool call/);
  assert.match((await d.choice(BODY)).error, /tool call/);
});

test('lightweight mode is required: probed once, passed on every run; an mcode without --mode (0.6.3) is refused and the refusal is logged once', async () => {
  const n0 = calls().length;
  const light = decider('ok');
  await light.choice(BODY); await light.choice(BODY);
  const withProbe = calls().slice(n0);
  assert.equal(withProbe.filter((c) => c.args[1] === '--help').length, 1, 'probed once');
  const runs = withProbe.filter((c) => c.args[1] !== '--help');
  assert.equal(runs.length, 2);
  assert.ok(runs.every((c) => c.args[c.args.indexOf('--mode') + 1] === 'lightweight' && c.args.includes('smart') && c.args.includes('--max-steps')));
  // an mcode whose --help lacks --mode: nothing runs
  resetNoLightweightWarning();
  const errs = []; const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    const old = decider('ok', { nolight: true });
    const n1 = calls().length;
    const r1 = await old.choice(BODY), r2 = await old.reviewer({ facts: FACTS });
    assert.equal(r1.skipped, 'mcode without lightweight mode'); assert.equal(r2.skipped, 'mcode without lightweight mode');
    assert.deepEqual(calls().slice(n1).filter((c) => c.args[1] !== '--help'), [], 'no run on the old mcode');
    await decider('ok', { nolight: true }).choice(BODY);
    assert.equal(errs.filter((e) => /without lightweight mode/.test(e)).length, 1, 'logged once per process');
  } finally { console.error = orig; }
});

test('MCODE_NODE_DIR\'s mcode is preferred when it supports lightweight mode; the PATH one is used when only it does', async () => {
  const nd = mkdtempSync(join(tmpdir(), 'fallback-node-'));
  fs.copyFileSync(FAKE, join(nd, 'mcode')); chmodSync(join(nd, 'mcode'), 0o755);
  const mk = (envExtra) => createFallbackDecider({ bin: undefined, nodeDir: nd, env: { PATH: `${work}:${process.env.PATH}`, HOME: work, MCODE_FAKE_MODE: 'ok', MCODE_FAKE_LOG: LOG, ...envExtra } });
  const n0 = calls().length;
  const r = await mk({}).choice(BODY);
  assert.equal(r.success, true);
  assert.ok(calls().slice(n0).some((c) => c.args[1] !== '--help'));
  // both lack --mode: refused
  const r2 = await mk({ MCODE_FAKE_NOLIGHT: '1' }).choice(BODY);
  assert.equal(r2.skipped, 'mcode without lightweight mode');
});

test('one fallback process at a time: a second call is skipped as "fallback busy"', async () => {
  const d = decider('slow');
  const first = d.choice(BODY);
  await new Promise((r) => setTimeout(r, 150));
  const second = await d.choice(BODY);
  assert.equal(second.skipped, 'fallback busy');
  assert.ok((await first).error, 'the first one still ran (its answer is not a valid choice)');
  assert.notEqual((await d.reviewer({ facts: FACTS })).skipped, 'fallback busy', 'free again');
});

test('a timeout kills the whole process group, children included', async () => {
  fs.rmSync(LOG + '.pids', { force: true });
  const r = await decider('hang', { timeoutMs: 500 }).choice(BODY);
  assert.match(r.error, /timeout/);
  await new Promise((x) => setTimeout(x, 300));
  const pids = fs.readFileSync(LOG + '.pids', 'utf8').split('\n').filter(Boolean).map(Number);
  assert.ok(pids.length >= 1);
  for (const pid of pids) assert.equal(alive(pid), false, `pid ${pid} is gone`);
});

test('merge / push / deploy evaluations never use the fallback: with Jev unavailable they keep the round-7 path (the manager\'s own reasoning)', async () => {
  const { makeRepo } = await import('./helpers-git.js');
  const typed = [];
  await m.initManager({ onOwnerNeeded: () => {}, credits: () => ({ ok: true, balance }), sendKeys: async (s, t) => { typed.push([s, t]); }, sendKey: async () => {} });
  await m.setManagerConfig({ autoSend: true, delayMs: 30, aiTriage: 'off', mergeDecisions: true, aiFallback: 'minimax', aiFallbackDailyCalls: 300 });
  balance = 0;
  const n0 = calls().length, f0 = records().filter((r) => r.type === 'fallback').length;
  const repo = makeRepo();
  const t = (st, p, now) => m.observe({ name: 'mg1', state: st, agent: 'claude', plain: p, raw: p, changed: true, realWork: false, project: 'p', cwd: repo, now });
  const p = pane('Tests: 1826/1826 pass on feat.\n\nShould I merge feat into main?');
  t('working', ['busy'], 0); t('done', p, 1000); t('done', p, 2500);
  for (let i = 0; i < 200 && !typed.length; i++) await sleep(25);
  assert.equal(typed.length, 1, 'the manager decided on its own reasoning');
  assert.match(typed[0][1], /Merge: yes/);
  // the ambiguous-stop choice may use the fallback (jev); the merge evaluation itself never does
  assert.equal(records().filter((r) => r.type === 'fallback' && r.for === 'decision').length, 0, 'no fallback record for a decision');
  assert.ok(calls().length - n0 <= 1 && records().filter((r) => r.type === 'fallback').length - f0 <= 1, 'at most the stop\'s own choice');
  const j = readFileSync(join(dir, 'manager-decisions.jsonl'), 'utf8');
  assert.doesNotMatch(j, /minimax-fallback/);
});

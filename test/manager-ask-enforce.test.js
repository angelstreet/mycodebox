// manager-ask (owner, 2026-10-23): a question is real only when the ledger line, the alert and the served list agree.
// Since 2026-10-25 every ask passes the same gate as scripts/owner-ask.js: a question without a valid floor is a
// defect for the manager and is never served to the owner.
// Temp GHOSTY_STATE_DIR and a stub HTTP server; never the live ledger or service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { tmp } from './helpers-tmp.js';
import { dirname, join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseWaiting, createAskGuard } from '../ask-guard.js';
import { readOpenAsks, readOpenAsksReport } from '../owner-asks.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'manager-ask.js');

// a question that passes the gate: a floor, two options, a recommendation and a "why you" that names the risk
const ASK = [
  '--question', 'Pay the overdue hosting invoice now, or let the subscription lapse?',
  '--what', 'The hosting invoice is overdue and the account is suspended in 3 days.',
  '--options', '1 pay the invoice now|2 let it lapse and lose the account',
  '--recommendation', '1',
  '--floor', 'money',
  '--why', "Paying spends the owner's money, so it is the owner's decision.",
];

// stub of the two routes the CLI uses; alerts are collected, asks are served from the real ledger
async function stub(dir, { acceptAlert = true, serve = true } = {}) {
  const alerts = [];
  const srv = http.createServer(async (req, res) => {
    const send = (c, b) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.method === 'POST' && req.url === '/api/alert') {
      let body = ''; for await (const c of req) body += c;
      if (req.headers['x-ghosty-reporter-token'] !== 'tok' || !acceptAlert) return send(401, { ok: false, error: 'bad token' });
      alerts.push(JSON.parse(body)); return send(200, { ok: true, sent: true });
    }
    if (req.url === '/api/owner-asks') return send(200, { asks: serve ? await readOpenAsks(join(dir, 'manager-owner-asks.jsonl')) : [] });
    send(404, {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { alerts, url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}
const run = (args, dir, url) => new Promise((res) => execFile(process.execPath, [CLI, ...args], { env: { ...process.env, GHOSTY_STATE_DIR: dir, GHOSTY_URL: url } },
  (e, so, se) => res({ code: e ? e.code ?? 1 : 0, stdout: so.trim(), stderr: se.trim() })));
const fresh = async () => { const d = tmp('mask-'); await writeFile(join(d, 'reporter.token'), 'tok\n'); return d; };

test('ask: ledger line, alert and served list; same question is idempotent', async (t) => {
  const dir = await fresh(); const s = await stub(dir); t.after(() => s.close());
  const a = await run(['--session', 'w1', ...ASK], dir, s.url);
  assert.equal(a.code, 0, a.stderr); assert.equal(a.stdout, 'Q1');
  const b = await run(['--session', 'w1', '--question', 'Pay the overdue hosting invoice now, or let the subscription lapse?', ...ASK.slice(2)], dir, s.url);
  assert.equal(b.stdout, 'Q1');
  assert.equal(s.alerts.length, 1); assert.equal(s.alerts[0].tag, 'ask-Q1');
  const c = await run(['--session', 'w2', '--question', 'Another question?', ...ASK.slice(2)], dir, s.url);
  assert.equal(c.stdout, 'Q2');
});

test('ask: the gate refuses an ask with no floor, and nothing is written', async (t) => {
  const dir = await fresh(); const s = await stub(dir); t.after(() => s.close());
  const r = await run(['--session', 'w1', ...ASK.filter((a) => a !== '--floor' && a !== 'money')], dir, s.url);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /--floor is required/);
  assert.equal(r.stdout, '');
  assert.deepEqual(await readOpenAsks(join(dir, 'manager-owner-asks.jsonl')), [], 'no ask was written');
  assert.equal(s.alerts.length, 0, 'and the owner was never told');
});

test('ask: the gate refuses a recommendation that changes nothing', async (t) => {
  const dir = await fresh(); const s = await stub(dir); t.after(() => s.close());
  const noop = [...ASK];
  noop[noop.indexOf('--options') + 1] = '1 keep it as it is|2 pay the invoice now';
  noop[noop.indexOf('--recommendation') + 1] = '1';
  const r = await run(['--session', 'w1', ...noop], dir, s.url);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /changes nothing/);
  assert.deepEqual(await readOpenAsks(join(dir, 'manager-owner-asks.jsonl')), []);
});

test('ask: alert refused -> non-zero', async (t) => {
  const dir = await fresh(); const s = await stub(dir, { acceptAlert: false }); t.after(() => s.close());
  const r = await run(['--session', 'w1', ...ASK], dir, s.url);
  assert.equal(r.code, 1); assert.match(r.stderr, /alert/);
});

test('ask: not served -> non-zero; service down -> non-zero', async (t) => {
  const dir = await fresh(); const s = await stub(dir, { serve: false }); t.after(() => s.close());
  assert.equal((await run(['--session', 'w1', ...ASK], dir, s.url)).code, 1);
  const dir2 = await fresh();
  assert.equal((await run(['--session', 'w1', ...ASK], dir2, 'http://127.0.0.1:1')).code, 1);
});

test('resolve closes the ask', async (t) => {
  const dir = await fresh(); const s = await stub(dir); t.after(() => s.close());
  await run(['--session', 'w1', ...ASK], dir, s.url);
  const r = await run(['--resolve', 'Q1', '--answer', 'yes'], dir, s.url);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(await readOpenAsks(join(dir, 'manager-owner-asks.jsonl')), []);
  assert.equal((await run(['--resolve', 'Q1'], dir, s.url)).code, 1);
});

// a record that never passed the gate (a hand-written line, an older writer) is never shown to the owner
test('a record with no valid floor is a defect, never an ask for the owner', async () => {
  const dir = await fresh();
  const file = join(dir, 'manager-owner-asks.jsonl');
  await writeFile(file, [
    JSON.stringify({ at: new Date().toISOString(), id: 'Q1', session: 'w', question: 'A question with a floor?', options: ['a', 'b'], recommendation: '1', floor: 'money', what: 'What it is.', why: 'Why you.', state: 'open' }),
    JSON.stringify({ at: new Date().toISOString(), id: 'Q2', session: 'w', question: 'A question without a floor?', options: ['a', 'b'], recommendation: '1', state: 'open' }),
  ].join('\n') + '\n');
  const rep = await readOpenAsksReport(file);
  assert.deepEqual(rep.asks.map((a) => a.id), ['Q1'], 'only the ask that passed the gate is shown');
  assert.deepEqual(rep.defects.map((d) => d.id), ['Q2'], 'the other one is a defect for the manager');
  assert.match(rep.defects[0].why, /no valid floor/);
});

test('parseWaiting: block lines, unchanged ids, nothing', () => {
  const p = parseWaiting('done\n---\nWaiting for you\n\nQ216 · w1 · Merge the thing?\n  What it is: x\n');
  assert.deepEqual(p.items, [{ id: 'Q216', session: 'w1', question: 'Merge the thing?', what: 'x' }]);
  assert.deepEqual(parseWaiting('Waiting for you: unchanged (Q3, Q4)').unchanged, ['Q3', 'Q4']);
  assert.equal(parseWaiting('Waiting for you: nothing').none, true);
  assert.deepEqual(parseWaiting('no block').items, []);
});

// the manager's report is a table (owner, 2026-10-25): Ask | What it is | Why it reached you | My view/recommendation
test('parseWaiting: the report table is parsed into the four fields', () => {
  const table = [
    'Waiting for you', '',
    '| Ask | What it is | Why it reached you | My view/recommendation |',
    '|---|---|---|---|',
    '| Q231 · mm-manager | Pay the hosting invoice now or let it lapse | Paying spends the owner\'s money | 1 - pay it now |',
  ].join('\n');
  const p = parseWaiting(table);
  assert.equal(p.items.length, 1);
  assert.deepEqual(p.items[0], {
    id: 'Q231', session: 'mm-manager', question: 'Pay the hosting invoice now or let it lapse',
    what: 'Pay the hosting invoice now or let it lapse', why: "Paying spends the owner's money", rec: '1 - pay it now',
  });
});

function guard(dir, t = { v: 1e12 }) {
  const alerts = [], events = [], defects = [];
  const g = createAskGuard({
    ledgerFile: join(dir, 'l.jsonl'), alertsFile: join(dir, 'a.jsonl'),
    alert: (a) => (alerts.push(a), true), log: (e) => events.push(e), now: () => t.v, onDefect: (d) => defects.push(d),
  });
  return { g, alerts, events, defects, t };
}

test('guard: an unfiled question that never passed the gate is a defect, not an owner alert', async () => {
  const dir = tmp('guard-defect-');
  const { g, alerts, events, defects } = guard(dir);
  const reply = 'Waiting for you\n\nQ216 · w1 · Merge the thing?\n';
  const done = await g.checkReply('manager', reply);
  assert.deepEqual(done.map((d) => d.type), ['ask-defect']);
  assert.equal((await readOpenAsks(join(dir, 'l.jsonl'))).length, 0, 'the owner sees nothing');
  assert.equal(alerts.length, 0, 'and the owner was never pushed');
  assert.equal(events[0].type, 'ask-defect');
  assert.equal(defects.length, 1, 'the manager gets the defect');
  assert.equal(defects[0].id, 'Q216');
  assert.match(defects[0].why, /never filed through the ask gate/);
  // the same reply again: the id is known now, nothing more happens
  assert.equal((await g.checkReply('manager', reply)).length, 0);
});

test('guard sweep: a floorless open record is a defect for the manager, never an owner alert', async () => {
  const dir = tmp('guard-sweep-defect-');
  const t = { v: Date.now() };
  await writeFile(join(dir, 'l.jsonl'), JSON.stringify({ at: new Date(t.v).toISOString(), id: 'Q5', session: 'w', question: 'c?', state: 'open' }) + '\n');
  const { g, alerts, events, defects } = guard(dir, t);
  t.v += 121000;
  const done = await g.sweep();
  assert.deepEqual(done.map((d) => d.type), ['ask-defect']);
  assert.equal(alerts.length, 0, 'the owner is never pushed a question that never passed the gate');
  assert.equal(events[0].type, 'ask-defect');
  assert.equal(defects.length, 1);
  // the next sweep does not repeat it
  assert.deepEqual(await g.sweep(), []);
});

const scan = (dir) => execFileSync('bash', [join(ROOT, 'scripts', 'manager-ask-scan.sh')], { env: { ...process.env, GHOSTY_STATE_DIR: dir } }).toString().trim();

test('ask-scan: an open ask alerted in the shared record is not reported, even when the feed scrolled past it', async () => {
  const dir = tmp('scan-');
  await writeFile(join(dir, 'manager-owner-asks.jsonl'), JSON.stringify({ id: 'Q219', session: 'w', question: 'x?', floor: 'money', state: 'open' }) + '\n');
  await writeFile(join(dir, 'manager-ask-alerts.jsonl'), JSON.stringify({ id: 'Q219', at: Date.now(), via: 'manager-ask' }) + '\n');
  await writeFile(join(dir, 'push-feed.json'), JSON.stringify([{ id: 1, tag: 'integration-int-1' }]));   // the feed no longer holds the ask
  assert.equal(scan(dir), '');
});

test('ask-scan: an open ask with no alert at all is reported', async () => {
  const dir = tmp('scan-');
  await writeFile(join(dir, 'manager-owner-asks.jsonl'), JSON.stringify({ id: 'Q7', session: 'w', question: 'x?', floor: 'money', state: 'open' }) + '\n');
  assert.equal(scan(dir), '!! ask-not-alerted Q7');
});

test('ask-scan: a record with no floor is reported as a defect, not as an unalerted ask', async () => {
  const dir = tmp('scan-defect-');
  await writeFile(join(dir, 'manager-owner-asks.jsonl'), JSON.stringify({ id: 'Q8', session: 'w', question: 'x?', state: 'open' }) + '\n');
  assert.match(scan(dir), /^!! ask-defect Q8 w \(no valid floor/);
});

test('ask-scan: the feed tag is a second source; an answered ask is never reported', async () => {
  const dir = tmp('scan-');
  await writeFile(join(dir, 'manager-owner-asks.jsonl'), [
    JSON.stringify({ id: 'Q1', session: 'w', question: 'x?', floor: 'money', state: 'open' }),
    JSON.stringify({ id: 'Q2', session: 'w', question: 'x?', floor: 'money', state: 'open' }),
    JSON.stringify({ id: 'Q3', session: 'w', question: 'x?', floor: 'money', state: 'open' }),
    JSON.stringify({ id: 'Q3', state: 'answered', answer: 'yes' }),
  ].join('\n') + '\n');
  await writeFile(join(dir, 'push-feed.json'), JSON.stringify([{ id: 1, tag: 'ask-Q1' }]));   // Q1 alerted in the feed only
  assert.equal(scan(dir), '!! ask-not-alerted Q2', 'Q1 is alerted, Q3 is answered');
});

// manager-ask (owner, 2026-10-23): a question is real only when the ledger line, the alert and the served list agree.
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
import { readOpenAsks } from '../owner-asks.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'manager-ask.js');

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

test('ask: ledger line, alert and served list; same question is idempotent', async () => {
  const dir = await fresh(); const s = await stub(dir);
  const a = await run(['--session', 'w1', '--question', 'Pay it?', '--options', '1 yes|2 no', '--recommendation', '1'], dir, s.url);
  assert.equal(a.code, 0, a.stderr); assert.equal(a.stdout, 'Q1');
  const b = await run(['--session', 'w1', '--question', 'Pay it?'], dir, s.url);
  assert.equal(b.stdout, 'Q1');
  assert.equal(s.alerts.length, 1); assert.equal(s.alerts[0].tag, 'ask-Q1');
  const c = await run(['--session', 'w2', '--question', 'Other?'], dir, s.url);
  assert.equal(c.stdout, 'Q2');
  s.close();
});

test('ask: alert refused -> non-zero', async () => {
  const dir = await fresh(); const s = await stub(dir, { acceptAlert: false });
  const r = await run(['--session', 'w1', '--question', 'Pay it?'], dir, s.url);
  assert.equal(r.code, 1); assert.match(r.stderr, /alert/);
  s.close();
});

test('ask: not served -> non-zero; service down -> non-zero', async () => {
  const dir = await fresh(); const s = await stub(dir, { serve: false });
  assert.equal((await run(['--session', 'w1', '--question', 'Pay it?'], dir, s.url)).code, 1);
  s.close();
  const dir2 = await fresh();
  assert.equal((await run(['--session', 'w1', '--question', 'Pay it?'], dir2, 'http://127.0.0.1:1')).code, 1);
});

test('resolve closes the ask', async () => {
  const dir = await fresh(); const s = await stub(dir);
  await run(['--session', 'w1', '--question', 'Pay it?'], dir, s.url);
  const r = await run(['--resolve', 'Q1', '--answer', 'yes'], dir, s.url);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(await readOpenAsks(join(dir, 'manager-owner-asks.jsonl')), []);
  assert.equal((await run(['--resolve', 'Q1'], dir, s.url)).code, 1);
  s.close();
});

test('parseWaiting: block lines, unchanged ids, nothing', () => {
  const p = parseWaiting('done\n---\nWaiting for you\n\nQ216 · w1 · Merge the thing?\n  What it is: x\n');
  assert.deepEqual(p.items, [{ id: 'Q216', session: 'w1', question: 'Merge the thing?' }]);
  assert.deepEqual(parseWaiting('Waiting for you: unchanged (Q3, Q4)').unchanged, ['Q3', 'Q4']);
  assert.equal(parseWaiting('Waiting for you: nothing').none, true);
  assert.deepEqual(parseWaiting('no block').items, []);
});

function guard(dir, t = { v: 1e12 }) {
  const alerts = [], events = [];
  const g = createAskGuard({ ledgerFile: join(dir, 'l.jsonl'), alertsFile: join(dir, 'a.jsonl'), alert: (a) => (alerts.push(a), true), log: (e) => events.push(e), now: () => t.v });
  return { g, alerts, events, t };
}

test('guard: unfiled Q in the reply is registered and alerted once', async () => {
  const dir = tmp('guard-');
  const { g, alerts, events } = guard(dir);
  const reply = 'Waiting for you\n\nQ216 · w1 · Merge the thing?\n';
  assert.equal((await g.checkReply('manager', reply)).length, 1);
  assert.equal((await readOpenAsks(join(dir, 'l.jsonl')))[0].id, 'Q216');
  assert.equal(alerts[0].tag, 'ask-Q216'); assert.equal(events[0].type, 'ask-autoregistered');
  assert.equal((await g.checkReply('manager', reply)).length, 0);
  assert.equal(alerts.length, 1);
});

test('guard: answered Q is not reopened; open Q is left alone; unbacked unchanged id alerts once', async () => {
  const dir = tmp('guard-');
  await writeFile(join(dir, 'l.jsonl'), [{ id: 'Q1', session: 'w', question: 'a?', state: 'open' }, { id: 'Q1', state: 'answered' }, { id: 'Q2', session: 'w', question: 'b?', state: 'open' }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const { g, alerts } = guard(dir);
  assert.equal((await g.checkReply('manager', 'Waiting for you\nQ1 · w · a?\nQ2 · w · b?\n')).length, 0);
  assert.equal((await g.checkReply('manager', 'Waiting for you: unchanged (Q2, Q9)')).length, 1);
  assert.equal((await g.checkReply('manager', 'Waiting for you: unchanged (Q2, Q9)')).length, 0);
  assert.equal(alerts.length, 1); assert.match(alerts[0].title, /Q9/);
});

test('guard sweep: open ask without alert is alerted after 2 min; alerted ones are not', async () => {
  const dir = tmp('guard-');
  const t = { v: Date.now() };
  await writeFile(join(dir, 'l.jsonl'), JSON.stringify({ at: new Date(t.v).toISOString(), id: 'Q5', session: 'w', question: 'c?', state: 'open' }) + '\n');
  const { g, alerts } = guard(dir, t);
  assert.equal((await g.sweep()).length, 0);
  t.v += 121000;
  assert.equal((await g.sweep()).length, 1);
  assert.equal((await g.sweep()).length, 0);
  assert.equal(alerts.length, 1);
});

test('guard sweep: an ask the other writer already alerted is not alerted a second time', async () => {
  const dir = tmp('guard-');
  const t = { v: Date.now() };
  await writeFile(join(dir, 'l.jsonl'), JSON.stringify({ at: new Date(t.v).toISOString(), id: 'Q9', session: 'w', question: 'c?', state: 'open' }) + '\n');
  await writeFile(join(dir, 'a.jsonl'), JSON.stringify({ id: 'Q9', at: t.v, via: 'manager-ask' }) + '\n');
  const { g, alerts } = guard(dir, t);
  t.v += 121000;
  assert.equal((await g.sweep()).length, 0, 'the shared record already holds the alert');
  assert.equal(alerts.length, 0);
});

const scan = (dir) => execFileSync('bash', [join(ROOT, 'scripts', 'manager-ask-scan.sh')], { env: { ...process.env, GHOSTY_STATE_DIR: dir } }).toString().trim();

test('ask-scan: an open ask alerted in the shared record is not reported, even when the feed scrolled past it', async () => {
  const dir = tmp('scan-');
  await writeFile(join(dir, 'manager-owner-asks.jsonl'), JSON.stringify({ id: 'Q219', session: 'w', question: 'x?', state: 'open' }) + '\n');
  await writeFile(join(dir, 'manager-ask-alerts.jsonl'), JSON.stringify({ id: 'Q219', at: Date.now(), via: 'manager-ask' }) + '\n');
  await writeFile(join(dir, 'push-feed.json'), JSON.stringify([{ id: 1, tag: 'integration-int-1' }]));   // the feed no longer holds the ask
  assert.equal(scan(dir), '');
});

test('ask-scan: an open ask with no alert at all is reported', async () => {
  const dir = tmp('scan-');
  await writeFile(join(dir, 'manager-owner-asks.jsonl'), JSON.stringify({ id: 'Q7', session: 'w', question: 'x?', state: 'open' }) + '\n');
  assert.equal(scan(dir), '!! ask-not-alerted Q7');
});

test('ask-scan: the feed tag is a second source; an answered ask is never reported', async () => {
  const dir = tmp('scan-');
  await writeFile(join(dir, 'manager-owner-asks.jsonl'), [
    JSON.stringify({ id: 'Q1', session: 'w', question: 'x?', state: 'open' }),
    JSON.stringify({ id: 'Q2', session: 'w', question: 'x?', state: 'open' }),
    JSON.stringify({ id: 'Q3', session: 'w', question: 'x?', state: 'open' }),
    JSON.stringify({ id: 'Q3', state: 'answered', answer: 'yes' }),
  ].join('\n') + '\n');
  await writeFile(join(dir, 'push-feed.json'), JSON.stringify([{ id: 1, tag: 'ask-Q1' }]));   // Q1 alerted in the feed only
  assert.equal(scan(dir), '!! ask-not-alerted Q2', 'Q1 is alerted, Q3 is answered');
});

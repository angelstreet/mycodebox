// E22: an owner question must never disappear. A stop is not a question: a stop id may not close the session's
// open questions, and the safety net must report a question that was closed without a replacement (E24).
// Temp GHOSTY_STATE_DIR and synthetic wording only; the live ledger is never read or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFile, readFile } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers-tmp.js';
import { fileAsk, newestPerSession, readOpenAsks, supersedeOlder } from '../owner-asks.js';
import { createAskGuard } from '../ask-guard.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = join(ROOT, 'scripts', 'manager-ask-scan.sh');
const CLI = join(ROOT, 'scripts', 'manager-ask.js');
// a stall id: the shape the manager used to write as the replacement of a question (E22)
const STOP_ID = 'deadbeef-dead-beef-dead-beefdeadbeef';

const ask = (n, { at = `2026-10-2${n}T10:00:00.000Z`, session = 'S', state = 'open' } = {}) => ({
  at, id: `Q${n}`, session, question: `Synthetic question ${n}?`, options: ['first thing', 'second thing'],
  recommendation: '1', floor: 'money', what: 'Synthetic what.', why: 'Synthetic why.', state,
});
const ledgerIn = async (tag, lines) => {
  const file = join(tmp(`e22-${tag}-`), 'manager-owner-asks.jsonl');
  await writeFile(file, lines.join('\n') + '\n');
  return file;
};
const recordsOf = async (file) => (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

// 1: the incident. A stop id escalated for a session closes nothing: the question is still open and the
// ledger holds no supersede record for it.
test('a stop id closes nothing: the question stays open and no supersede record is written', async () => {
  const file = await ledgerIn('stop', [JSON.stringify(ask(1, { session: 'S' }))]);
  const logged = [];
  const real = console.error; console.error = (m) => logged.push(String(m));
  let ids;
  try { ids = await supersedeOlder(file, 'S', STOP_ID); } finally { console.error = real; }
  assert.deepEqual(ids, [], 'a stop id is not a question: nothing is superseded');
  assert.deepEqual((await recordsOf(file)).filter((r) => r.state === 'superseded'), [], 'no supersede record was written');
  assert.deepEqual((await readOpenAsks(file)).map((a) => a.id), ['Q1'], 'the question is still open');
  assert.equal(logged.length, 1, 'the refusal is reported');
  assert.match(logged[0], /nothing superseded/);
  assert.ok(logged[0].includes(STOP_ID), 'the report names the id that was refused');
  assert.ok(!logged[0].includes('Synthetic question'), 'no owner wording in the report');
});

// 2: the case that really means "replaced": a second question for the session closes the older one and the
// ledger names that question as the replacement.
test('a second question for the session replaces the older one and names it', async () => {
  const file = await ledgerIn('replace', [JSON.stringify(ask(1, { session: 'S' }))]);
  const filed = await fileAsk(file, {
    session: 'S', question: 'Synthetic second question?', what: 'Synthetic what.',
    options: ['1 do it', '2 do not'], recommend: '1', floor: 'money', why: 'It spends the owner money.',
  });
  assert.equal(filed.ok, true, JSON.stringify(filed));
  const sup = (await recordsOf(file)).filter((r) => r.state === 'superseded');
  assert.deepEqual(sup.map((r) => [r.id, r.by]), [['Q1', filed.id]], 'the older ask is closed by the new question');
  assert.deepEqual((await readOpenAsks(file)).map((a) => a.id), [filed.id], 'only the replacement is open');
});

// 3: the same through the command the manager session uses (scripts/manager-ask.js).
test('the manager-ask command replaces the session\'s older question with the new one', async () => {
  const dir = tmp('e22-cli-');
  await writeFile(join(dir, 'reporter.token'), 'tok\n');
  const ledger = join(dir, 'manager-owner-asks.jsonl');
  await writeFile(ledger, JSON.stringify(ask(1, { session: 'S' })) + '\n');
  const srv = http.createServer(async (req, res) => {
    const send = (c, b) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.method === 'POST' && req.url === '/api/alert') { for await (const _ of req) { /* drain */ } return send(200, { ok: true, sent: true }); }
    if (req.url === '/api/owner-asks') return send(200, { asks: await readOpenAsks(ledger) });
    send(404, {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const run = (args) => new Promise((res) => execFile(process.execPath, [CLI, ...args],
    { env: { ...process.env, GHOSTY_STATE_DIR: dir, GHOSTY_URL: url } }, (e, so, se) => res({ code: e ? e.code ?? 1 : 0, stdout: so.trim(), stderr: se.trim() })));
  try {
    const first = await run(['--session', 'S', '--question', 'Synthetic first question?']);
    assert.equal(first.code, 0, first.stderr);
    const second = await run(['--session', 'S', '--question', 'Synthetic second question?']);
    assert.equal(second.code, 0, second.stderr);
    assert.notEqual(second.stdout, first.stdout, 'a second question gets its own id');
    const sup = (await recordsOf(ledger)).filter((r) => r.state === 'superseded');
    assert.deepEqual(sup.map((r) => [r.id, r.by]), [['Q1', first.stdout], [first.stdout, second.stdout]], 'each question replaces the older one of the session');
  } finally { srv.close(); }
});

// 4: the safety net. The hourly scan and the server-side guard both report the superseded asks: the one whose
// replacement is still open (the older question is still waiting) and the one whose replacement is not a
// question (it was dropped with no replacement: the E22 case).
const NET_ROWS = (now) => [
  JSON.stringify(ask(1, { session: 'S' })),                                    // Q1: open, replaced by Q2
  JSON.stringify(ask(2, { session: 'S' })),                                    // Q2: open, the replacement
  JSON.stringify({ at: '2026-10-22T10:00:00.000Z', id: 'Q1', state: 'superseded', by: 'Q2' }),
  JSON.stringify(ask(3, { session: 'T' })),                                    // Q3: open, replaced by a stop id
  JSON.stringify({ at: '2026-10-22T10:00:00.000Z', id: 'Q3', state: 'superseded', by: STOP_ID }),
  JSON.stringify(ask(4, { session: 'U' })),                                    // Q4: open, dropped just now
  JSON.stringify({ at: now, id: 'Q4', state: 'superseded', by: STOP_ID }),
  JSON.stringify(ask(5, { session: 'V' })),                                    // Q5: replaced by a question the owner answered
  JSON.stringify(ask(6, { session: 'V' })),
  JSON.stringify({ at: '2026-10-22T10:00:00.000Z', id: 'Q5', state: 'superseded', by: 'Q6' }),
  JSON.stringify({ at: '2026-10-22T10:00:00.000Z', id: 'Q6', state: 'answered', answer: 'yes' }),
];

test('the hourly scan reports both superseded cases, one line each', async () => {
  const dir = tmp('e22-scan-');
  await writeFile(join(dir, 'manager-owner-asks.jsonl'), NET_ROWS(new Date().toISOString()).join('\n') + '\n');
  const out = execFileSync('bash', [SCAN], { env: { ...process.env, GHOSTY_STATE_DIR: dir } }).toString().trim().split('\n');
  assert.ok(out.includes('!! ask-superseded-open Q1 Q2'), out.join(' | '));
  assert.ok(out.includes(`!! ask-superseded-dropped Q3 ${STOP_ID}`), out.join(' | '));
  assert.ok(out.includes(`!! ask-superseded-dropped Q4 ${STOP_ID}`), out.join(' | '));
  assert.ok(out.includes('!! ask-not-alerted Q2'), 'the existing line is unchanged');
  assert.ok(!out.some((l) => l.includes('Q5')), 'a question the owner answered is not reported');
});

test('the server-side guard reports both superseded cases', async () => {
  const dir = tmp('e22-guard-');
  const file = join(dir, 'l.jsonl');
  await writeFile(file, NET_ROWS(new Date().toISOString()).join('\n') + '\n');
  const alerts = [], events = [];
  const g = createAskGuard({
    ledgerFile: file, alertsFile: join(dir, 'a.jsonl'), alert: (a) => (alerts.push(a), true),
    log: (e) => events.push(e), now: () => Date.now(),
  });
  const done = await g.sweep();
  assert.deepEqual(done.filter((d) => d.type === 'ask-superseded-open').map((d) => [d.id, d.by]), [['Q1', 'Q2']]);
  assert.deepEqual(done.filter((d) => d.type === 'ask-superseded-dropped').map((d) => [d.id, d.by]), [['Q3', STOP_ID], ['Q4', STOP_ID]]);
  assert.ok(!done.some((d) => d.id === 'Q5'), 'a question the owner answered is not reported');
  assert.ok(events.some((e) => e.type === 'ask-superseded-open' && e.id === 'Q1'), 'the report reaches the manager log');
  // a dropped question is pushed to the owner: it is closed, so no list of the owner shows it any more
  assert.ok(alerts.some((a) => a.tag === 'ask-Q4'), 'the fresh drop is pushed');
  assert.ok(!alerts.some((a) => a.tag === 'ask-Q3'), 'an old drop is reported, not pushed');
  // and it is reported once, not on every sweep
  assert.deepEqual((await g.sweep()).filter((d) => d.type.startsWith('ask-superseded')), [], 'nothing is reported twice');
});

// 5: the display rule. An open ask is hidden only when its replacement is itself listed.
test('an open ask is hidden only when its replacement is visible', () => {
  const older = { id: 'Q1', session: 'S', question: 'older?' };
  const newer = { id: 'Q2', session: 'S', question: 'newer?' };
  // replaced by a question that is still open: the owner's rule, the older one stands hidden
  assert.deepEqual(newestPerSession([newer, older], new Map([['Q1', 'Q2']])).map((a) => a.id), ['Q2']);
  // not replaced at all: the question is still waiting and stays visible
  assert.deepEqual(newestPerSession([newer, older]).map((a) => a.id), ['Q2', 'Q1']);
  // replaced by a question that is not open: the replacement is gone, so the older one stays visible
  assert.deepEqual(newestPerSession([newer, older], new Map([['Q1', 'Q3']])).map((a) => a.id), ['Q2', 'Q1']);
});

test('the ledger hides an open ask only while its replacement is listed', async () => {
  const file = await ledgerIn('display', [
    JSON.stringify(ask(1, { session: 'S', at: '2026-10-21T10:00:00.000Z' })),
    JSON.stringify(ask(2, { session: 'S', at: '2026-10-21T11:00:00.000Z' })),
    JSON.stringify({ at: '2026-10-22T10:00:00.000Z', id: 'Q1', state: 'superseded', by: 'Q2' }),
    JSON.stringify({ at: '2026-10-21T10:00:00.000Z', id: 'Q1', state: 'open' }),   // asked again
  ]);
  assert.deepEqual((await readOpenAsks(file)).map((a) => a.id), ['Q2'], 'the replaced ask is hidden while its replacement is listed');
  const gone = await ledgerIn('display-gone', [
    JSON.stringify(ask(1, { session: 'S', at: '2026-10-21T10:00:00.000Z' })),
    JSON.stringify(ask(2, { session: 'S', at: '2026-10-21T11:00:00.000Z' })),
    JSON.stringify({ at: '2026-10-22T10:00:00.000Z', id: 'Q1', state: 'superseded', by: STOP_ID }),
    JSON.stringify({ at: '2026-10-21T10:00:00.000Z', id: 'Q1', state: 'open' }),   // asked again
  ]);
  assert.deepEqual((await readOpenAsks(gone)).map((a) => a.id), ['Q2', 'Q1'], 'a question whose replacement is gone stays visible');
});

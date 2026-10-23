// The owner-ask gate (owner rule 2026-10-20): a question reaches the owner only when it touches the hard floor.
// Runs the real CLI in a child process with GHOSTY_STATE_DIR in a temp dir: the live state dir is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decidedItems } from '../decided.js';
import { appendRecord, openAsks, readOpenAsks, readOpenAsksReport, supersedeOlder } from '../owner-asks.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'owner-ask.js');

const GOOD = {
  '--question': 'Pay the 40 EUR overdue invoice for the build runner, or let the subscription lapse?',
  '--what': "The build runner's hosting invoice is overdue and unpaid; the account is suspended in 3 days.\nOption 1 pays it now and the subscription continues. Option 2 does nothing and the account is suspended.",
  '--options': '1 pay the 40 EUR invoice now|2 let it lapse and lose the account',
  '--recommend': '1',
  '--floor': 'money',
  '--why': "It spends the owner's money, a hard-floor item the manager never answers itself.",
};

// run: the CLI with a temp state dir -> { code, stdout, stderr }
async function run(args, stateDir) {
  const dir = stateDir || await mkdtemp(join(tmpdir(), 'owner-ask-'));
  const { stdout, stderr, code } = await new Promise((res) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, GHOSTY_STATE_DIR: dir } },
      (e, so, se) => res({ stdout: so, stderr: se, code: e ? e.code ?? 1 : 0 }));
  });
  return { dir, code, stdout: stdout.trim(), stderr: stderr.trim() };
}

const ledgerOf = async (dir) => (await readFile(join(dir, 'manager-owner-asks.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('no floor -> refused, nothing written', async () => {
  const args = ['ask', '--session', 'manager:test', ...Object.entries(GOOD).filter(([k]) => k !== '--floor').flat()];
  const r = await run(args);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /--floor is required/);
  assert.equal(r.stdout, '');
});

test('floor not in the list -> refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'owner-ask-badfloor-'));
  const bad = await run(['ask', '--session', 'manager:test', ...Object.entries({ ...GOOD, '--floor': 'merge' }).flat()], dir);
  assert.equal(bad.code, 2, bad.stderr);
  assert.match(bad.stderr, /--floor must be one of/);
  assert.equal(bad.stdout, '');
  // nothing was filed: no ledger in the state dir
  await assert.rejects(readFile(join(dir, 'manager-owner-asks.jsonl'), 'utf8'), 'a refused ask writes no ledger');
});

test('empty --what -> refused', async () => {
  const r = await run(['ask', '--session', 'manager:test', ...Object.entries({ ...GOOD, '--what': '   ' }).flat()]);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /--what is empty/);
  assert.equal(r.stdout, '');
});

test('empty --why -> refused', async () => {
  const r = await run(['ask', '--session', 'manager:test', ...Object.entries({ ...GOOD, '--why': '' }).flat()]);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /--why is empty/);
  assert.equal(r.stdout, '');
});

test('bare internal id in the question -> refused', async () => {
  const r = await run(['ask', '--session', 'manager:test', ...Object.entries({ ...GOOD, '--question': 'Deploy integration int-a1b2c3d4 to production now?' }).flat()]);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /internal id without an explanation/);
  assert.match(r.stderr, /int-a1b2c3d4/);
  assert.equal(r.stdout, '');
});

test('valid ask -> one ledger line with floor, what and why', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'owner-ask-ok-'));
  const r = await run(['ask', '--session', 'manager:runner', ...Object.entries(GOOD).flat()], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Q1$/);
  const lines = await ledgerOf(dir);
  assert.equal(lines.length, 1);
  const rec = lines[0];
  assert.equal(rec.id, r.stdout);
  assert.equal(rec.state, 'open');
  assert.equal(rec.session, 'manager:runner');
  assert.equal(rec.floor, 'money');
  assert.equal(rec.recommendation, '1');
  assert.equal(rec.options.length, 2);
  assert.match(rec.what, /hosting invoice/);
  assert.match(rec.why, /spends the owner/);
  assert.ok(Date.parse(rec.at), 'at is an ISO time');
});

test('a second ask continues the numbering and appends', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'owner-ask-2-'));
  const first = await run(['ask', '--session', 'a', ...Object.entries(GOOD).flat()], dir);
  const second = await run(['ask', '--session', 'b', ...Object.entries(GOOD).flat()], dir);
  assert.equal(first.stdout, 'Q1');
  assert.equal(second.stdout, 'Q2');
  assert.equal((await ledgerOf(dir)).length, 2);
});

test('decide -> a "Decided for you" entry with the why and the undo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'owner-ask-d-'));
  const r = await run(['decide', '--session', 'manager:runner', '--decision', 'Paused the runner deploy until the invoice is paid',
    '--why', 'Paying is a money floor item, so it waits for you rather than being answered by the manager',
    '--undo', 'Say "resume the runner deploy" in the manager session and the deploy queue takes it again'], dir);
  assert.equal(r.code, 0, r.stderr);
  const journal = (await readFile(join(dir, 'manager-decisions.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(journal.length, 1);
  const rec = journal[0];
  assert.equal(rec.source, 'owner-ask');
  assert.match(rec.rationale, /money floor/);
  assert.match(rec.rollback, /resume the runner deploy/);

  // the item the owner's "Decided for you" page shows, through the existing mechanism (decided.js)
  const items = decidedItems({ recs: [], journal });
  assert.equal(items.length, 1);
  assert.equal(items[0].what, 'Paused the runner deploy until the invoice is paid');
  assert.match(items[0].why, /money floor/);
  assert.equal(items[0].revert.label, 'Undo');
  assert.match(items[0].revert.text, /resume the runner deploy/);
});

test('decide without --undo -> refused', async () => {
  const r = await run(['decide', '--session', 'manager:runner', '--decision', 'did a thing', '--why', 'because']);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /--undo is empty/);
});

test('an unknown command -> refused', async () => {
  const r = await run(['escalate', '--session', 'x']);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /unknown command/);
});

test('help lists the floors', async () => {
  const r = await run(['help']);
  assert.equal(r.code, 0);
  for (const f of ['money', 'credentials', 'customers', 'deleting_data', 'host_units', 'production_migration', 'history_rewrite', 'owner_fact']) assert.match(r.stdout, new RegExp(f));
});

// Every run above used a temp GHOSTY_STATE_DIR; the CLI only falls back to the live dir when it is unset.
test('the live state dir is only the fallback', async () => {
  const src = await readFile(CLI, 'utf8');
  assert.match(src, /process\.env\.GHOSTY_STATE_DIR \|\| join\(homedir\(\), '\.local', 'state', 'ghosty'\)/);
});

// ---- resilience of the ledger itself ----
// The ledger is the evidence of which owner questions are still open. A damaged line (a crash mid-write, two
// records appended on one line) must cost at most the damaged record: it may never hide the rest of the file, and
// it may never pass silently. Fixtures here are invented text in temp files; the live ledger is never read.

const askRec = (n, { at = `2026-10-2${n}T10:0${n}:00.000Z`, session = `manager:s${n}`, state = 'open' } = {}) => ({
  at, id: `Q${n}`, session, question: `Synthetic question ${n}?`, options: ['first thing', 'second thing'],
  recommendation: '1', floor: 'money', what: 'Synthetic what.', why: 'Synthetic why.', state,
});

const ledgerIn = async (tag, lines) => {
  const file = join(await mkdtemp(join(tmpdir(), `owner-ask-${tag}-`)), 'manager-owner-asks.jsonl');
  await writeFile(file, lines.join('\n') + '\n');
  return file;
};

const parseable = (text) => text.split('\n').filter(Boolean).filter((l) => { try { JSON.parse(l); return true; } catch { return false; } });

// 1 + 3: the damage found in the live ledger - a truncated line, a line holding two concatenated records and
// short fragments. Every question that can still be read must still come back.
test('a damaged line does not hide the open asks around it', async () => {
  const file = await ledgerIn('damaged', [
    JSON.stringify(askRec(1)),
    JSON.stringify(askRec(2)),
    JSON.stringify(askRec(3)).slice(0, 90),                                    // truncated mid-write
    JSON.stringify(askRec(4)) + JSON.stringify(askRec(5)),                      // two records on one line
    '{"at":"2026-10',                                                           // fragment
    '20T10:06:00.000Z","id":"Q6"',                                              // fragment
    '{"id":"Q7","state":"answered"',
    JSON.stringify(askRec(8)),
  ]);
  const ids = (await readOpenAsks(file)).map((a) => a.id);
  // every record that is whole on the line is returned, including both halves of the concatenated line
  for (const id of ['Q1', 'Q2', 'Q4', 'Q5', 'Q8']) assert.ok(ids.includes(id), `${id} must survive the damage (got ${ids.join(',')})`);
  // only what is genuinely unrecoverable is missing
  assert.ok(!ids.includes('Q3'), 'the truncated record cannot be read');
  assert.ok(!ids.includes('Q6'), 'a fragment is not a record');
});

test('a line holding two concatenated records recovers both, in order', async () => {
  const whole = await ledgerIn('concat-whole', [JSON.stringify(askRec(1)) + JSON.stringify(askRec(2))]);
  assert.deepEqual(openAsks([(await readFile(whole, 'utf8')).trim()]).map((a) => a.id), ['Q2', 'Q1']);

  // a truncated tail on the same line: the complete record is still recovered, the fragment is reported as lost
  const torn = await ledgerIn('concat-torn', [JSON.stringify(askRec(1)) + JSON.stringify(askRec(2)).slice(0, 60)]);
  const rep = await readOpenAsksReport(torn);
  assert.deepEqual(rep.asks.map((a) => a.id), ['Q1']);
  assert.equal(rep.damaged.length, 1);
  assert.equal(rep.damaged[0].recovered, 1, 'the complete object is recovered');
  assert.equal(rep.damaged[0].lost, 1, 'the truncated fragment is reported as lost');

  // a `}` inside a quoted value must not be mistaken for the end of the record
  const braced = await ledgerIn('concat-brace', [JSON.stringify(askRec(1, { session: 'manager:brace{}' }))]);
  assert.deepEqual((await readOpenAsks(braced)).map((a) => a.id), ['Q1']);
});

// 2: damage is counted and located, never swallowed and never echoed. A ledger line is the owner's own wording.
test('damaged lines are surfaced with a count and line numbers, not their content', async () => {
  const file = await ledgerIn('surface', [
    JSON.stringify(askRec(1)),
    '{"at":"2026-10',
    JSON.stringify(askRec(2)),
    'not json at all',
    JSON.stringify(askRec(3)),
  ]);
  // the operator is told once per distinct damage, and never what the owner wrote in it
  const logged = [];
  const real = console.error; console.error = (m) => logged.push(String(m));
  let rep;
  try { rep = await readOpenAsksReport(file); await readOpenAsks(file); await readOpenAsks(file); } finally { console.error = real; }
  assert.equal(logged.length, 1, 'the damage is logged once while it stays the same');
  assert.match(logged[0], /ledger damaged: 2 unusable line\(s\) at line 2,4/);
  assert.ok(!logged[0].includes('Synthetic question'), 'no ledger text in the log line');
  assert.deepEqual(rep.asks.map((a) => a.id).sort(), ['Q1', 'Q2', 'Q3'], 'every whole record is still returned');
  assert.deepEqual(rep.damaged.map((d) => d.line), [2, 4], 'the damaged line numbers are reported');
  assert.equal(rep.readError, null);
  assert.ok(rep.damaged.every((d) => d.why === 'unparseable' && d.recovered === 0 && d.lost >= 1));
  // the report says how damaged the file is, never what the owner wrote in it
  assert.ok(!JSON.stringify(rep.damaged).includes('Synthetic question'), 'no ledger text in the damage report');
});

test('an unreadable ledger is reported, not mistaken for an empty one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'owner-ask-unreadable-'));
  const file = join(dir, 'manager-owner-asks.jsonl');
  await writeFile(file, JSON.stringify(askRec(1)) + '\n');
  const { chmod } = await import('node:fs/promises');
  await chmod(file, 0o000);
  const rep = await readOpenAsksReport(file);
  await chmod(file, 0o600);
  assert.deepEqual(rep.asks, [], 'nothing is readable');
  assert.match(String(rep.readError), /EACCES/, 'the failure is surfaced instead of passing for "no open questions"');
});

// 4: several records written back to back each land on their own line, and the file stays parseable.
test('supersedeOlder writes one record per line and the file stays parseable', async () => {
  const file = await ledgerIn('supersede', [1, 2, 3].map((n) => JSON.stringify(askRec(n, { session: 'manager:busy' }))));
  const ids = await supersedeOlder(file, 'manager:busy', 'Q9', { now: new Date('2026-10-22T11:00:00.000Z') });
  assert.deepEqual(ids.sort(), ['Q1', 'Q2', 'Q3']);

  const text = await readFile(file, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  assert.equal(lines.length, 6, '3 asks + 3 supersede records, one record per line');
  assert.equal(parseable(text).length, 6, 'every line parses');
  assert.ok(!lines.some((l) => l.includes('}{')), 'no two records share a line');
  for (const l of lines.slice(3)) assert.deepEqual(Object.keys(JSON.parse(l)).sort(), ['at', 'by', 'id', 'state']);

  // and the ledger still reads correctly after the supersede
  assert.deepEqual((await readOpenAsks(file)).map((a) => a.id), [], 'all three asks of that session are now superseded');
});

// 5: two writers in flight at once still leave a file where every line parses. Serialised per file path, so one
// record cannot be cut in half by another record's write.
test('concurrent writes leave a file where every line parses', async () => {
  const file = await ledgerIn('concurrent', []);
  await Promise.all(Array.from({ length: 40 }, (_, i) => appendRecord(file, { at: new Date().toISOString(), id: `d${i}`, kind: 'decision' })));
  const text = await readFile(file, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  assert.equal(lines.length, 40);
  assert.equal(parseable(text).length, 40, 'no torn or joined line');
  const ids = lines.map((l) => JSON.parse(l).id);
  assert.equal(new Set(ids).size, 40, 'every record is whole');

  // the same through the public writer, two asks in flight at once
  const two = join(await mkdtemp(join(tmpdir(), 'owner-ask-pair-')), 'manager-owner-asks.jsonl');
  const { fileAsk } = await import('../owner-asks.js');
  const ask = { question: 'Pay the synthetic invoice or cancel the synthetic subscription?', what: 'Synthetic what.', options: ['1 pay it now', '2 cancel it'], recommend: '1', floor: 'money', why: 'It spends the owner money.' };
  await Promise.all([fileAsk(two, { ...ask, session: 'manager:a' }), fileAsk(two, { ...ask, session: 'manager:b' })]);
  const pair = await readFile(two, 'utf8');
  assert.equal(parseable(pair).length, 2, 'both records are whole');
  assert.deepEqual((await readOpenAsks(two)).map((a) => a.session).sort(), ['manager:a', 'manager:b'], 'and both asks read back');
});

// 6: unchanged happy path and unchanged missing-file behaviour.
test('happy path: newest open ask per session, newest first', async () => {
  const file = await ledgerIn('happy', [
    JSON.stringify(askRec(1, { session: 'manager:a', at: '2026-10-20T10:00:00.000Z' })),
    JSON.stringify(askRec(2, { session: 'manager:a', at: '2026-10-20T11:00:00.000Z' })),   // same session, newer
    JSON.stringify(askRec(3, { session: 'manager:b', at: '2026-10-20T09:00:00.000Z' })),
    JSON.stringify({ at: '2026-10-20T12:00:00.000Z', id: 'Q3', state: 'answered' }),        // closes Q3
  ]);
  const asks = await readOpenAsks(file);
  assert.deepEqual(asks.map((a) => a.id), ['Q2'], 'only the newest open ask per session, answered ones gone');
  assert.equal(asks[0].session, 'manager:a');
  assert.deepEqual(asks[0].options, ['first thing', 'second thing']);
});

test('a missing ledger returns no asks instead of throwing', async () => {
  const missing = join(await mkdtemp(join(tmpdir(), 'owner-ask-missing-')), 'manager-owner-asks.jsonl');
  assert.deepEqual(await readOpenAsks(missing), []);
  const rep = await readOpenAsksReport(missing);
  assert.deepEqual(rep.asks, []);
  assert.deepEqual(rep.damaged, [], 'a ledger that was never written is not damaged');
  assert.equal(rep.readError, null, 'and its absence is not a read error');
});
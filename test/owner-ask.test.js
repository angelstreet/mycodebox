// The owner-ask gate (owner rule 2026-10-20): a question reaches the owner only when it touches the hard floor.
// Runs the real CLI in a child process with GHOSTY_STATE_DIR in a temp dir: the live state dir is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decidedItems } from '../decided.js';

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
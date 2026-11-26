import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { jevDoubt, eventDoubt, ownerOnly, shellQuote } from '../doubt.js';
import { createManagerEvents } from '../manager-events.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const UNSURE = { session: 's1', case: 'owner_decision', closing_text: "Should the new filter sit left or right? I can't tell." };
const FLOORED = [
  { session: 's1', case: 'owner_decision', touches: ['money'] },
  { session: 's1', case: 'permission' },
  { session: 's1', case: 'owner_decision', closing_text: 'May I delete the old rows of the shared database?' },
  { session: 's1', case: 'owner_decision', proposed_reply: 'Yes, force-push main.' },
];
const jev = (facts, source = 'rule', point = 'stop') => jevDoubt({ point, source, facts, script: '/x/ask-opus.js' });

test('jev-ask doubt: stop with source rule or error says ask Opus, with the command', () => {
  for (const s of ['rule', 'error']) {
    const d = jev(UNSURE, s);
    assert.match(d.in_doubt, /ask Opus to answer/);
    assert.ok(d.ask_opus.startsWith("node '/x/ask-opus.js' --facts '"));
  }
});

test('jev-ask doubt: none when Jev or a floor decided, or on another point', () => {
  assert.deepEqual(jev(UNSURE, 'jev'), {});
  assert.deepEqual(jev(UNSURE, 'forced'), {});
  assert.deepEqual(jev(UNSURE, 'rule', 'wake'), {});
});

test('owner floor: never sent to Opus', () => {
  for (const facts of FLOORED) {
    const d = jev(facts);
    assert.equal(d.ask_opus, undefined, JSON.stringify(facts));
    assert.ok(d.owner_only, JSON.stringify(facts));
  }
  assert.equal(ownerOnly({ facts: UNSURE }), null);
});

test('the ready command survives quotes and newlines in the facts', () => {
  const text = `it's "quoted" $(x)\n\`y\``;
  const r = spawnSync('sh', ['-c', `printf %s ${shellQuote(text)}`], { encoding: 'utf8' });
  assert.equal(r.stdout, text);
});

test('event doubt: a session question carries the hint, other events and owner-floor asks do not', () => {
  for (const key of ['web:asks', 'web:needs-manager', 'lease:manager-item']) {
    assert.match(eventDoubt({ key, session: 'web', body: 'web asks: tabs or a dropdown?' }), /ask Opus.*ask-opus\.js --session 'web'/);
  }
  assert.equal(eventDoubt({ key: 'web:hold', session: 'web', body: 'tabs?' }), null);
  assert.equal(eventDoubt({ key: 'lease:system-wait', session: 'web', body: 'waits' }), null);
  assert.equal(eventDoubt({ key: 'web:asks', session: 'web', body: 'May I rotate the Stripe API key?' }), null);
  assert.equal(eventDoubt({ key: 'web:needs-manager', session: 'web', body: 'approve the payment of the invoice' }), null);
});

test('the manager feed line carries askOpus, with the right session', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'doubt-ev-'));
  const feed = createManagerEvents({ stateDir });
  await feed.record({ key: 'web:asks', title: 'web asks you', body: 'tabs or a dropdown?' });
  await feed.record({ key: 'lease:manager-item', session: 'api', title: 'api: lease stop', body: 'api asks: which free box?' });
  await feed.record({ key: 'mac:air:asks', title: 'mac:air asks you', body: 'one page or two?' });
  await feed.record({ key: 'pay:asks', title: 'pay asks you', body: 'May I buy the paid plan?' });
  const got = (await feed.tail({})).map((r) => r.askOpus?.match(/--session '([^']+)'/)[1] ?? null);
  assert.deepEqual(got, ['web', 'api', 'mac:air', null]);
});

async function askOpus(args, reply) {
  const stateDir = await mkdtemp(join(tmpdir(), 'doubt-cli-'));
  const bin = join(stateDir, 'claude'), called = join(stateDir, 'called');
  await writeFile(bin, `#!/bin/sh\necho "$@" > '${called}'\ncat >/dev/null\nprintf '%s\\n' ${shellQuote(reply)}\n`);
  await chmod(bin, 0o755);
  const r = spawnSync('node', [join(root, 'scripts', 'ask-opus.js'), ...args], { encoding: 'utf8', env: { ...process.env, GHOSTY_STATE_DIR: stateDir, CLAUDE_BIN: bin } });
  const log = await readFile(join(stateDir, 'manager-asks.jsonl'), 'utf8').catch(() => '');
  return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, records: log.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    argv: existsSync(called) ? await readFile(called, 'utf8') : null };
}

test('ask-opus: calls claude -p --model opus and records that Opus answered', async () => {
  const r = await askOpus(['--facts', JSON.stringify(UNSURE)], 'ANSWER: put it on the left.\nIt matches the other pages.\n\nSTATUS: done - advised');
  assert.doesNotMatch(r.out.text, /STATUS/);
  assert.equal(r.status, 0);
  assert.match(r.argv, /^-p --model opus /);
  assert.equal(r.out.verdict, 'answer');
  assert.match(r.out.text, /^put it on the left/);
  assert.deepEqual([r.records[0].point, r.records[0].model, r.records[0].session, r.records[0].verdict], ['opus', 'opus', 's1', 'answer']);
});

test('ask-opus: an owner-floor question makes no call', async () => {
  const r = await askOpus(['--session', 's1', '--question', 'May I buy the paid plan?'], 'ANSWER: yes');
  assert.equal(r.argv, null);
  assert.deepEqual([r.out.verdict, r.out.source, r.records[0].model], ['owner', 'floor', null]);
});

test('ask-opus: OWNER stays owner, and an answer that takes a floor action is turned into owner', async () => {
  assert.equal((await askOpus(['--question', 'tabs or dropdown?'], 'OWNER: a product choice')).out.verdict, 'owner');
  const r = await askOpus(['--question', 'the branch looks odd, what now?'], 'ANSWER: force-push main.');
  assert.deepEqual([r.out.verdict, r.out.source], ['owner', 'floor']);
});

test('ask-opus: an unreadable reply is an error, bad usage exits 2', async () => {
  const r = await askOpus(['--question', 'tabs or dropdown?'], 'maybe');
  assert.deepEqual([r.status, r.out.verdict], [1, 'error']);
  assert.equal((await askOpus([], 'x')).status, 2);
});

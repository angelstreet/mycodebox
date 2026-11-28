import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { loopsOf, itemsOfLine, normalise, createLoopScanner } from '../usage/loops.js';
import { tmp } from './helpers-tmp.js';

const bash = (command, ts = '2026-11-28T00:00:00Z') => JSON.stringify({ timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
const prompt = (text, ts = '2026-11-28T00:00:00Z') => JSON.stringify({ timestamp: ts, message: { role: 'user', content: text } });

test('normalise collapses numbers and ids so reruns of one command match', () => {
  assert.equal(normalise('node  --test   t/a.js  #12'), normalise('node --test t/a.js #99'));
  assert.equal(normalise('gh run view 4602045593 --log'), normalise('gh run view 1111111111 --log'));
});

test('loopsOf: repeated test command = test-loop, wait command = wait-loop, other = command-loop, repeated prompt = prompt-repeat', () => {
  const items = [];
  for (let i = 0; i < 9; i++) items.push({ kind: 'command', text: `node --test test/a.test.js # run ${i}` });
  for (let i = 0; i < 9; i++) items.push({ kind: 'command', text: 'scripts/manager-wait.sh --max 600' });
  for (let i = 0; i < 9; i++) items.push({ kind: 'command', text: `cat results/output-file-${i}.log | head` });
  for (let i = 0; i < 5; i++) items.push({ kind: 'prompt', text: 'Night check: do the 10-minute check now' });
  items.push({ kind: 'command', text: 'ls' }, { kind: 'command', text: 'git status --short' });
  const kinds = loopsOf(items, { top: 10 }).map((l) => l.kind).sort();
  assert.deepEqual(kinds, ['command-loop', 'prompt-repeat', 'test-loop', 'wait-loop']);
  assert.deepEqual(loopsOf([{ kind: 'command', text: 'node --test x.js' }, { kind: 'command', text: 'node --test x.js' }]), []);
});

test('itemsOfLine: Bash commands and typed prompts only; tool results, meta and system notes are skipped', () => {
  assert.deepEqual(itemsOfLine(bash('npm test')), [{ kind: 'command', text: 'npm test' }]);
  assert.deepEqual(itemsOfLine(prompt('please fix the thing')), [{ kind: 'prompt', text: 'please fix the thing' }]);
  assert.deepEqual(itemsOfLine(prompt('<system-reminder>x</system-reminder>')), []);
  assert.deepEqual(itemsOfLine(JSON.stringify({ message: { role: 'user', content: 'hello there friend' }, isMeta: true })), []);
  assert.deepEqual(itemsOfLine(bash('npm test', '2020-01-01T00:00:00Z'), Date.parse('2026-01-01')), []);
  assert.deepEqual(itemsOfLine('not json "role":"user"'), []);
});

test('scanner: per session from transcript files, subagent files roll up to the parent, cached rescan', async () => {
  const dir = await tmp('loops');
  await fs.mkdir(join(dir, 'proj', 'sess1', 'subagents'), { recursive: true });
  const lines = (n) => Array.from({ length: n }, () => bash('npm test -- --grep retest-me')).join('\n') + '\n';
  await fs.writeFile(join(dir, 'proj', 'sess1.jsonl'), lines(5));
  await fs.writeFile(join(dir, 'proj', 'sess1', 'subagents', 'agent-a.jsonl'), lines(5));
  const scan = createLoopScanner({ claudeDir: dir, now: () => Date.parse('2026-11-28T01:00:00Z') });
  const r = await scan();
  assert.equal(r.length, 1);
  assert.equal(r[0].session, 'sess1');
  assert.equal(r[0].kind, 'test-loop');
  assert.equal(r[0].count, 10);
  assert.deepEqual(await scan(), r);
});

test('scanner: a cached file that stopped growing is re-cut to the moving window (no stale loop counts)', async () => {
  const dir = await tmp('loops-window');
  await fs.mkdir(join(dir, 'proj'), { recursive: true });
  const old = Array.from({ length: 6 }, () => bash('scripts/manager-wait.sh', '2026-11-26T02:00:00Z'));
  const recent = Array.from({ length: 4 }, () => bash('scripts/manager-wait.sh', '2026-11-27T20:00:00Z'));
  await fs.writeFile(join(dir, 'proj', 'mgr.jsonl'), [...old, ...recent].join('\n') + '\n');
  let t = Date.parse('2026-11-28T01:00:00Z');                  // window from 26 Nov 01:00: all 10 count
  const scan = createLoopScanner({ claudeDir: dir, now: () => t, opts: { windowH: 48, minCommand: 8 } });
  assert.equal((await scan())[0]?.count, 10);
  t = Date.parse('2026-11-28T12:00:00Z');                      // window from 26 Nov 12:00: the 6 old waits fall out, file unchanged
  assert.deepEqual(await scan(), []);
  assert.equal((await createLoopScanner({ claudeDir: dir, now: () => t, opts: { windowH: 48, minCommand: 4 } })())[0]?.count, 4);
});

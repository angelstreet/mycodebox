import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { renderConversation, findSessionFile, readConversation } from '../conversation.js';

const L = (o) => JSON.stringify(o);
const sample = [
  L({ type: 'user', message: { content: 'fix the bug\nplease' } }),
  L({ type: 'user', isMeta: true, message: { content: 'meta' } }),
  L({ type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>hidden</system-reminder>' }] } }),
  L({ type: 'user', message: { content: '<task-notification>\n<task-id>b1</task-id>\n</task-notification>' } }),
  L({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
  L({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
  L({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'side' }] } }),
  L({ type: 'attachment' }), 'not json',
  L({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private reasoning' }] } }),
  L({ type: 'assistant', thinkingDisplay: 'updates', message: { content: [{ type: 'thinking', thinking: 'Wave 1 holds.' }] } }),
  L({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }),
].join('\n');

test('renderConversation: prompts quoted, replies and tool lines kept, terminal progress updates kept; meta / sidechain / reminders / results / other thinking dropped', () => {
  assert.equal(renderConversation(sample), '> fix the bug\n> please\n\nLooking.\n\n`Bash npm test`\n\nWave 1 holds. · summary\n\nDone.');
});
test('findSessionFile finds <id>.jsonl under any project dir, refuses a bad id', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'convo-')));
  fs.mkdirSync(path.join(root, '-proj-a')); fs.writeFileSync(path.join(root, '-proj-a', 'abcdef12-3456.jsonl'), sample);
  assert.equal(await findSessionFile('abcdef12-3456', [root]), path.join(root, '-proj-a', 'abcdef12-3456.jsonl'));
  assert.equal(await findSessionFile('../etc/passwd', [root]), null);
  assert.equal(await findSessionFile('00000000-0000', [root]), null);
  assert.match(await readConversation(path.join(root, '-proj-a', 'abcdef12-3456.jsonl')), /Done\.$/);
  assert.equal(await readConversation(path.join(root, '-proj-a', 'abcdef12-3456.jsonl'), { maxChars: 3 }), 'Done.');   // newest first, stops once enough text
  fs.rmSync(root, { recursive: true });
});

test('a prompt sent while the agent worked (queued_command) is the owner\'s; big tool results are skipped unparsed', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'convo-')));
  const f = path.join(root, 's.jsonl');
  const big = 'x'.repeat(5 * 1024 * 1024);   // bigger than one read chunk: the backwards reader must carry it across chunks
  fs.writeFileSync(f, [
    L({ type: 'assistant', message: { content: [{ type: 'text', text: 'First.' }] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', content: big }] } }),
    L({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'and the reader?' } }),
    L({ type: 'queue-operation', operation: 'enqueue', content: 'and the reader?' }),
    L({ type: 'assistant', message: { content: [{ type: 'text', text: 'Last.' }] } }),
  ].join('\n') + '\n');
  assert.equal(await readConversation(f), 'First.\n\n> and the reader?\n\nLast.');
  fs.rmSync(root, { recursive: true });
});

import { tailChars, MAX_CHARS as MAXC } from '../conversation.js';
test('tailChars: absent or junk = everything (0); else clamped between 5000 and MAX_CHARS', () => {
  assert.equal(tailChars(undefined), 0); assert.equal(tailChars(null), 0); assert.equal(tailChars('abc'), 0); assert.equal(tailChars('-5'), 0); assert.equal(tailChars('0'), 0);
  assert.equal(tailChars('40000'), 40000); assert.equal(tailChars('100'), 5000); assert.equal(tailChars('99999999'), MAXC);
});

test('lastReplyOf: the assistant text since the last owner prompt; tool results, sidechains and notices skipped', async () => {
  const { lastReplyOf } = await import('../conversation.js');
  const rec = (o) => JSON.stringify(o);
  const jsonl = [
    rec({ type: 'user', message: { content: 'first prompt' } }),
    rec({ type: 'assistant', message: { content: [{ type: 'text', text: 'old reply\nSummary:\n- old' }] } }),
    rec({ type: 'user', message: { content: 'second prompt' } }),
    rec({ type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
    rec({ type: 'user', message: { content: [{ type: 'tool_result', content: 'a\nb' }] } }),
    rec({ type: 'user', message: { content: '<system-reminder>note</system-reminder>' } }),
    rec({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent text' }] } }),
    rec({ type: 'assistant', message: { content: [{ type: 'text', text: 'Summary:\n- new\n\nSTATUS: done — x' }] } }),
  ].join('\n');
  assert.equal(lastReplyOf(jsonl), 'working on it\n\nSummary:\n- new\n\nSTATUS: done — x');
  assert.equal(lastReplyOf(''), '');
});

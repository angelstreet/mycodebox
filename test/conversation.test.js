import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { renderConversation, findSessionFile, readConversation } from '../conversation.js';

const L = (o) => JSON.stringify(o);
const sample = [
  L({ type: 'user', message: { content: 'fix the bug\nplease' } }),
  L({ type: 'user', isMeta: true, message: { content: 'meta' } }),
  L({ type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>hidden</system-reminder>' }] } }),
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
  assert.match(await readConversation(path.join(root, '-proj-a', 'abcdef12-3456.jsonl'), 120), /Done\./);   // a tail: cut line skipped
  fs.rmSync(root, { recursive: true });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyPayloads, readerCopyButtonHtml } from '../public/reader-copy.js';

test('copy sources stay distinct: latest reply, untruncated full session, and summary lines only', () => {
  const full = 'FIRST MESSAGE\n' + 'Earlier conversation. '.repeat(3000) + '\nLAST MESSAGE';
  const p = copyPayloads({ reply: '  Latest reply\nSTATUS: done  ', full, summary: ['One short line.', 'Another line.'] });
  assert.equal(p.reply, 'Latest reply\nSTATUS: done');
  assert.equal(p.full, full);
  assert.ok(p.full.length > 40000);
  assert.equal(p.summary, 'One short line.\nAnother line.');
  assert.equal(copyPayloads({ reply: 'reply', summary: null }).summary, '');
});

test('clipboard trigger keeps the shared icon and stable unique per-session targets', () => {
  const html = readerCopyButtonHtml('mac:a');
  assert.match(html, /aria-label="Copy options"/);
  assert.match(html, /class="rd-copy-icon" aria-hidden="true"/);
  assert.match(html, /Copy reply/); assert.match(html, /Copy full session/); assert.match(html, /Copy summary/);
  assert.equal(readerCopyButtonHtml('mac:a'), html);
  const id = (s) => /commandfor="([^"]+)"/.exec(readerCopyButtonHtml(s))[1];
  assert.notEqual(id('mac:a'), id('mac_3Aa'));
  assert.ok(!readerCopyButtonHtml('\"><script>bad</script>').includes('<script>'));
});

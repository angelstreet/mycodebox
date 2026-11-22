import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kindOf, fileUrl, mediaPathsIn, mediaHtml, mediaRowHtml, MEDIA_LINE } from '../public/media-links.js';
import { resolveServedFile } from '../files-route.js';
import { renderRecord } from '../conversation.js';

test('media-links: kinds, urls, paths named in text, html', () => {
  assert.equal(kindOf('/a/b.PNG'), 'image'); assert.equal(kindOf('/a/m.html'), 'page'); assert.equal(kindOf('/a/r.pdf'), 'pdf'); assert.equal(kindOf('/a/x.txt'), null);
  assert.equal(fileUrl('/home/u/my shot.png'), '/files/home/u/my%20shot.png');
  assert.equal(fileUrl('~/m/x.html'), '/files/~/m/x.html');
  assert.deepEqual(mediaPathsIn('see `/home/u/out/why.png` and @/home/u/.ghosty/uploads/1.png, then /tmp/claude-1/s/m.html.'), ['/home/u/out/why.png', '/home/u/.ghosty/uploads/1.png', '/tmp/claude-1/s/m.html']);
  assert.deepEqual(mediaPathsIn('server.js:12 and /etc/passwd.png and docs/a.png'), [], 'only home / tmp absolute paths');
  assert.match(mediaHtml('/home/u/a.png'), /<img src="\/files\/home\/u\/a\.png"[^>]*loading="lazy"/);
  assert.match(mediaHtml('/home/u/m.html'), /target="_blank".*open page/);
  const seen = new Set();
  assert.equal((mediaRowHtml(['/h/a.png', '/h/a.png'], seen).match(/<img/g) || []).length, 1);
  assert.equal(mediaRowHtml(['/h/a.png'], seen), '', 'shown once per reply');
  assert.ok(MEDIA_LINE.test('![](/home/u/a.png)'));
});

test('conversation: a SendUserFile call adds one ![](path) line per file', () => {
  const out = renderRecord({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SendUserFile', input: { files: ['/home/u/a b.png', '/tmp/claude-1/x.html'], caption: 'c' } }] } });
  assert.equal(out[1], '![](/home/u/a%20b.png)\n![](/tmp/claude-1/x.html)');
  assert.equal(fileUrl('/home/u/a%20b.png'), '/files/home/u/a%20b.png');
});

test('files route: media under home or the scratchpad only, never a dot folder, HTML sandboxed', () => {
  const root = mkdtempSync(join(tmpdir(), 'files-route-'));
  const home = join(root, 'home'); mkdirSync(join(home, 'out'), { recursive: true }); mkdirSync(join(home, '.ssh')); mkdirSync(join(home, '.ghosty', 'uploads'), { recursive: true });
  writeFileSync(join(home, 'out', 'a.png'), 'x'); writeFileSync(join(home, 'out', 'm.html'), '<p>'); writeFileSync(join(home, 'out', 'k.txt'), 'x');
  writeFileSync(join(home, '.ssh', 'k.png'), 'x'); writeFileSync(join(home, '.ghosty', 'uploads', 'u.png'), 'x');
  symlinkSync(join(home, '.ssh', 'k.png'), join(home, 'out', 'link.png'));
  writeFileSync(join(root, 'outside.png'), 'x');
  try {
    const r = (p) => resolveServedFile(p, { home, uid: 99999 });
    assert.equal(r(`${home}/out/a.png`).type, 'image/png');
    assert.equal(r(`${home}/out/a.png`).sandbox, false);
    assert.equal(r('/~/out/m.html').sandbox, true);
    assert.equal(r(`${home}/.ghosty/uploads/u.png`).type, 'image/png', 'the dashboard uploads are allowed');
    assert.equal(r(`${home}/out/k.txt`).status, 403);
    assert.equal(r(`${home}/.ssh/k.png`).status, 403);
    assert.equal(r(`${home}/out/link.png`).status, 403, 'a link into a dot folder is refused');
    assert.equal(r(`${home}/out/../../outside.png`).status, 403);
    assert.equal(r(`${home}/out/none.png`).status, 404);
    assert.equal(r('relative.png').status, 400);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

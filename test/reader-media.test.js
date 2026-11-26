import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kindOf, fileUrl, mediaPathsIn, mediaHtml, mediaRowHtml, MEDIA_LINE } from '../public/media-links.js';
import { findInFolder, resolveServedFile } from '../files-route.js';
import { fileLinksOf } from '../public/term-links.js';
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

test('relative media paths: terminal links and reader tiles go through /files-in/<session>/', () => {
  // the phone shows the terminal: "[file] out/ep01.mp4" (owner 2026-11-23)
  const l = fileLinksOf('  › [file] out/ep01_draft1_send.mp4 (18.5MB)', 'docs-x');
  assert.deepEqual(l.map((x) => [x.path, x.start, x.end, x.url]), [['out/ep01_draft1_send.mp4', 11, 35, '/files-in/docs-x/out/ep01_draft1_send.mp4']]);
  assert.deepEqual(fileLinksOf('see https://h.io/a/b.png, ~/m/x.html and bare.png', 's').map((x) => x.url), ['/files/~/m/x.html'], 'URLs and bare names are not file links');
  assert.deepEqual(fileLinksOf('│ out/a.png │ /home/u/b.pdf│', 's').map((x) => x.url), ['/files-in/s/out/a.png', '/files/home/u/b.pdf']);
  assert.deepEqual(mediaPathsIn('the file is scripts/video/out/ep01.mp4. Done'), [], 'the reader keeps absolute-only without a session');
  assert.deepEqual(mediaPathsIn('the file is scripts/video/out/ep01.mp4. Done', { relative: true }), ['scripts/video/out/ep01.mp4']);
  assert.deepEqual(mediaPathsIn('raw/*.webm and footage/{a,b}.mp4 and ~/x/*.png', { relative: true }), [], 'globs are not files');
  assert.equal(fileUrl('out/a.png'), '', 'a relative path needs its session');
  assert.match(mediaRowHtml(['out/a b.png'], new Set(), 's'), /<img src="\/files-in\/s\/out\/a%20b\.png"[^>]*onerror=/);
  assert.equal(mediaRowHtml(['out/a.png'], new Set()), '', 'no session: no tile');
});

test('findInFolder: <cwd>/<rel> first, else a bounded search for a file ending in /<rel>; never up or into dot folders', () => {
  const d = mkdtempSync(join(tmpdir(), 'files-route-'));
  try {
    mkdirSync(join(d, 'scripts', 'video', 'out'), { recursive: true });
    writeFileSync(join(d, 'scripts', 'video', 'out', 'ep.mp4'), 'v');
    mkdirSync(join(d, 'out')); writeFileSync(join(d, 'out', 'top.png'), 'p');
    mkdirSync(join(d, '.hidden', 'out'), { recursive: true }); writeFileSync(join(d, '.hidden', 'out', 'h.png'), 'p');
    assert.equal(findInFolder(d, 'out/top.png'), join(d, 'out', 'top.png'));
    assert.equal(findInFolder(d, './out/ep.mp4'), join(d, 'scripts', 'video', 'out', 'ep.mp4'));
    assert.equal(findInFolder(d, 'scripts/video/out/ep.mp4'), join(d, 'scripts', 'video', 'out', 'ep.mp4'));
    assert.equal(findInFolder(d, 'out/h.png'), null, 'dot folders are not searched');
    assert.equal(findInFolder(d, '../x/top.png'), null);
    assert.equal(findInFolder(d, '/etc/a.png'), null);
    assert.equal(findInFolder(d, 'out/notes.txt'), null, 'media and pages only');
    assert.equal(findInFolder(d, 'out/ep.mp4', { maxDepth: 1 }), null, 'bounded depth');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('files route: a media file this user owns under /tmp is served; a hidden folder, another owner and a non-media type are not', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'reader-media-t-')), home = mkdtempSync(join(tmpdir(), 'reader-media-h-'));
  mkdirSync(join(tmp, 'vpt-shots')); mkdirSync(join(tmp, '.secret'));
  writeFileSync(join(tmp, 'vpt-shots', 'a.jpg'), 'x'); writeFileSync(join(tmp, '.secret', 'b.png'), 'x'); writeFileSync(join(tmp, 'vpt-shots', 'c.txt'), 'x');
  const opt = { home, tmpDir: tmp };
  const ok = resolveServedFile(join(tmp, 'vpt-shots', 'a.jpg'), opt);
  assert.equal(ok.type, 'image/jpeg');
  assert.equal(resolveServedFile(join(tmp, '.secret', 'b.png'), opt).status, 403, 'hidden folder');
  assert.equal(resolveServedFile(join(tmp, 'vpt-shots', 'c.txt'), opt).status, 403, 'not media');
  assert.equal(resolveServedFile(join(tmp, 'vpt-shots', 'a.jpg'), { ...opt, uid: (process.getuid?.() ?? 0) + 1 }).status, 403, 'another owner');
  assert.equal(resolveServedFile(join(tmp, 'vpt-shots', 'a.jpg'), { home, tmpDir: '/nonexistent-tmp' }).status, 403, 'outside the tmp folder and home');
  rmSync(tmp, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});

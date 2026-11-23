import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readViewFile } from '../file-view.js';
import { filePathSpans, linkFilePaths, linkMdFileLinks, viewUrl } from '../public/file-links.js';
import { textLinksOf } from '../public/term-links.js';
import { fileBodyHtml, linkedBodyHtml, shortPath } from '../public/file-panel.js';

test('file-links: paths with a folder anywhere, bare names in code or with a non-word extension, :line kept apart', () => {
  const p = (t, o) => filePathSpans(t, o).map((x) => [x.path, x.line, x.line2]);
  assert.deepEqual(p('1. pass — docs/youtube/INVENTORY.md is on main'), [['docs/youtube/INVENTORY.md', 0, 0]]);
  assert.deepEqual(p('see public/app.js:10-20, docs/REFERENCE.md#goal-check.'), [['public/app.js', 10, 20], ['docs/REFERENCE.md', 0, 0]]);
  assert.deepEqual(p('updated (WORDING-REVIEW-PROMPT-EP01.md, INDEX) with Node.js and Vue.js'), [['WORDING-REVIEW-PROMPT-EP01.md', 0, 0]]);
  assert.deepEqual(p('server.js:12', { bare: true }), [['server.js', 12, 0]], 'a bare .js in a code span');
  assert.deepEqual(p('https://github.com/a/b/README.md, /etc/hosts.txt, ~/n/a.txt, foo/bar.png'), [['~/n/a.txt', 0, 0]], 'no URLs, no system paths, no media');
  assert.deepEqual(p('a/b/Makefile and e.g. 1.2.3.md'), [['a/b/Makefile', 0, 0]]);
});

test('linkFilePaths: wraps paths in text and code, never inside a link; the href is the new-tab view', () => {
  const h = linkFilePaths('<p>see <code>server.js</code> and docs/a.md, <a href="x">docs/b.md</a> &quot;src/c.ts:4&quot;</p>', 's1');
  assert.match(h, /<code><a class="rd-path" href="\/view\.html\?s=s1&amp;p=server\.js"[^>]*data-p="server\.js"/);
  assert.match(h, /data-p="docs\/a\.md"/);
  assert.match(h, /<a href="x">docs\/b\.md<\/a>/, 'an existing link is left alone');
  assert.match(h, /data-p="src\/c\.ts" data-l="4"[^>]*>src\/c\.ts:4<\/a>&quot;/);
  assert.equal(viewUrl('s', 'a b/c.md', 3), '/view.html?s=s&p=a%20b%2Fc.md&l=3');
  assert.deepEqual(textLinksOf('  ⎿ Read docs/X.md (12 lines) and server.js:5').map((x) => [x.path, x.line]), [['docs/X.md', 0], ['server.js', 5]]);
});

test('readViewFile: text under home, relative in the session folder, never a dot folder, a secret name, binary or outside', () => {
  const home = mkdtempSync(join(tmpdir(), 'file-view-'));
  try {
    const repo = join(home, 'repo');
    mkdirSync(join(repo, 'docs', 'sub'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'sub', 'GAPS.md'), '# Gaps\n');
    writeFileSync(join(repo, 'server.js'), 'x'.repeat(50));
    writeFileSync(join(repo, 'bin.json'), Buffer.from([0x7b, 0, 0x7d]));
    writeFileSync(join(repo, 'api-token.txt'), 't');
    mkdirSync(join(home, '.ssh')); writeFileSync(join(home, '.ssh', 'config.txt'), 'k');
    symlinkSync(join(home, '.ssh', 'config.txt'), join(repo, 'link.txt'));
    const o = { home, cwd: repo, uid: 99999 };
    assert.equal(readViewFile('docs/sub/GAPS.md', o).text, '# Gaps\n');
    assert.equal(readViewFile('GAPS.md', o).path, join(repo, 'docs', 'sub', 'GAPS.md'), 'a bare name is searched in the folder');
    assert.equal(readViewFile('~/repo/server.js', o).name, 'server.js');
    const cut = readViewFile(join(repo, 'server.js'), { ...o, maxBytes: 10 });
    assert.equal(cut.text.length, 10); assert.equal(cut.truncated, true); assert.equal(cut.size, 50);
    assert.equal(readViewFile('bin.json', o).status, 415, 'binary');
    assert.equal(readViewFile('api-token.txt', o).status, 403, 'a secret-looking name');
    assert.equal(readViewFile('link.txt', o).status, 403, 'a symlink into a dot folder');
    assert.equal(readViewFile('~/.ssh/config.txt', o).status, 403);
    mkdirSync(join(home, '.claude', 'skills', 'deploy'), { recursive: true }); writeFileSync(join(home, '.claude', 'skills', 'deploy', 'SKILL.md'), 's');
    mkdirSync(join(home, '.claude', 'projects', 'p', 'memory'), { recursive: true }); writeFileSync(join(home, '.claude', 'projects', 'p', 'memory', 'a.md'), 'm');
    writeFileSync(join(home, '.claude', 'projects', 'p', 'x.jsonl'), '{}'); writeFileSync(join(home, '.claude', 'settings.json'), '{}');
    assert.equal(readViewFile('~/.claude/skills/deploy/SKILL.md', o).text, 's', 'Claude skills are readable');
    assert.equal(readViewFile('~/.claude/projects/p/memory/a.md', o).text, 'm', 'memory notes too');
    assert.equal(readViewFile('~/.claude/projects/p/x.jsonl', o).status, 403, 'not a transcript');
    assert.equal(readViewFile('~/.claude/settings.json', o).status, 403, 'not the settings');
    assert.equal(readViewFile('/etc/hostname.txt', o).status, 404);
    assert.equal(readViewFile('a.png', o).status, 415, 'not a text file');
    assert.equal(readViewFile('nope.md', o).status, 404);
    assert.equal(readViewFile('docs/sub/GAPS.md', { home }).status, 404, 'relative without a session');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('fileBodyHtml: markdown rendered, code with line numbers and the asked lines marked', () => {
  assert.match(fileBodyHtml({ name: 'a.md', text: '# T\n\nhi', size: 8 }), /class="mdbody fv-md"><div class="mdh h1">T/);
  const c = fileBodyHtml({ name: 'a.js', text: 'a\n<b>\nc\n', size: 9 }, 2, 3);
  assert.equal((c.match(/fv-row/g) || []).length, 3);
  assert.match(c, /fv-row on" data-n="2"><span class="fv-ln">2<\/span><span class="fv-tx">&lt;b&gt;/);
  assert.match(fileBodyHtml({ name: 'b.md', text: 'x', size: 2e6, truncated: true }), /first 1 B of 1\.9 MB/);
  assert.match(fileBodyHtml({ name: 'a.md', text: '# T', size: 3 }, 1), /fv-code/, 'a line asked for shows markdown as code');
});

test('links inside an open file: markdown links to files and paths, resolved beside the file first', () => {
  const h = linkMdFileLinks('<p>see [GAPS.md](GAPS.md) and [site](https://x.io/a.md), [code](../src/a.py:7)</p>', 's', '/home/u/r/docs');
  assert.match(h, /<a class="rd-path" href="\/view\.html\?s=s&amp;p=GAPS\.md&amp;b=%2Fhome%2Fu%2Fr%2Fdocs"[^>]*data-p="GAPS\.md"[^>]*data-b="\/home\/u\/r\/docs"[^>]*>GAPS\.md<\/a>/);
  assert.match(h, /\[site\]\(https:\/\/x\.io\/a\.md\)/, 'web links are left to md.js');
  assert.match(h, /data-p="\.\.\/src\/a\.py" data-l="7"/);
  const body = linkedBodyHtml({ name: 'INDEX.md', path: '/home/u/r/docs/INDEX.md', text: 'See [GAPS.md](GAPS.md) and `scripts/x.sh`.', size: 9 }, 's');
  assert.equal((body.match(/class="rd-path"/g) || []).length, 2);
  assert.equal(shortPath('/home/u/r/a.md'), '~/r/a.md');
});

test('readViewFile: a link beside the open document wins over the session folder', () => {
  const home = mkdtempSync(join(tmpdir(), 'file-view-'));
  try {
    mkdirSync(join(home, 'r', 'docs'), { recursive: true });
    writeFileSync(join(home, 'r', 'GAPS.md'), 'top'); writeFileSync(join(home, 'r', 'docs', 'GAPS.md'), 'beside');
    assert.equal(readViewFile('GAPS.md', { home, cwd: join(home, 'r'), base: join(home, 'r', 'docs'), uid: 99999 }).text, 'beside');
    assert.equal(readViewFile('GAPS.md', { home, cwd: join(home, 'r'), uid: 99999 }).text, 'top');
    assert.equal(readViewFile('GAPS.md', { home, base: join(home, 'r', 'docs'), uid: 99999 }).text, 'beside', 'no session: the folder alone');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

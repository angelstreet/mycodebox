// Shared pages (owner 2026-11-28): `page publish` writes <state>/pages/<slug>/, the dashboard serves it sandboxed at /p/<slug>/.
// Unit tests of pages.js, the `page` command, and the real server.js routes (booted on a temp state dir, a temp HOME and a private
// tmux socket: no live state is touched).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers-tmp.js';
import { waitServer } from './helpers/wait-server.js';
import { PAGE_CSP, indexHtml, listPages, localRefs, markdownToHtml, publishPage, resolvePageFile, slugify } from '../pages.js';
import { loadMockupHtml } from '../mockups.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('slugify and markdownToHtml', () => {
  assert.equal(slugify('Q4 Report — Été!'), 'q4-report-ete');
  assert.equal(slugify('...'), 'page');
  const h = markdownToHtml('# Title\n\nSome **bold** and `a<b>` [x](https://e.x) ![i](img/a.png)\n\n- [x] done\n- todo\n\n| A | B |\n|---|--:|\n| 1 | 2 |\n\n```js\nlet a = "<x>";\n```\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))');
  assert.match(h, /<h1 id="title">Title<\/h1>/);
  assert.match(h, /<strong>bold<\/strong>/);
  assert.match(h, /<code>a&lt;b&gt;<\/code>/);
  assert.match(h, /<img alt="i" src="img\/a.png">/);
  assert.match(h, /<li class="task"><input type="checkbox" disabled checked> done<\/li>/);
  assert.match(h, /<th>A<\/th><th style="text-align:right">B<\/th>/);
  assert.match(h, /<pre><code class="language-js">let a = &quot;&lt;x&gt;&quot;;<\/code><\/pre>/);
  assert.doesNotMatch(h, /<script>/);
  assert.match(h, /<a href="#">bad<\/a>/);
});

test('localRefs: relative files only, never outside the folder', () => {
  const r = localRefs('<img src="a.png"><link href="css/s.css"><a href="https://x/y">x</a><img src="/etc/x.png"><img src="../up.png"><img src=".env/x.png"><div style="background:url(\'bg.jpg\')"></div> ![m](img/b%20c.png)');
  assert.deepEqual(r.sort(), ['a.png', 'bg.jpg', 'css/s.css', 'img/b c.png']);
});

test('publishPage: html with its files, update keeps the URL, md is rendered, traversal refused', () => {
  const state = tmp('pages-state-'), src = tmp('pages-src-');
  fs.mkdirSync(path.join(src, 'img'));
  fs.writeFileSync(path.join(src, 'img', 'a.png'), 'PNG');
  fs.writeFileSync(path.join(src, 'secret.txt'), 'no');
  fs.writeFileSync(path.join(src, 'Mock Up.html'), '<title>My mockup</title><img src="img/a.png"><a href="secret.txt">s</a><img src="../x.png">');
  const r1 = publishPage(state, path.join(src, 'Mock Up.html'), { session: 's1', now: 1000 });
  assert.equal(r1.slug, 'mock-up'); assert.equal(r1.created, true); assert.equal(r1.meta.title, 'My mockup');
  assert.ok(fs.existsSync(path.join(state, 'pages', 'mock-up', 'site', 'img', 'a.png')));
  assert.ok(fs.existsSync(path.join(state, 'pages', 'mock-up', 'site', 'secret.txt')), 'a linked .txt is a page file type');
  fs.writeFileSync(path.join(src, 'Mock Up.html'), '<title>v2</title>');
  const r2 = publishPage(state, path.join(src, 'Mock Up.html'), { now: 2000 });
  assert.equal(r2.created, false); assert.equal(r2.meta.version, 2); assert.equal(r2.meta.createdAt, 1000); assert.equal(r2.meta.session, 's1');
  assert.ok(!fs.existsSync(path.join(state, 'pages', 'mock-up', 'site', 'img', 'a.png')), 'an update replaces the old files');
  fs.writeFileSync(path.join(src, 'report.md'), '# Weekly report\n\n![chart](img/a.png)\n');
  const r3 = publishPage(state, path.join(src, 'report.md'), { slug: 'wk', now: 3000 });
  assert.equal(r3.meta.title, 'Weekly report');
  assert.match(fs.readFileSync(path.join(state, 'pages', 'wk', 'site', 'index.html'), 'utf8'), /<meta name="viewport"[^>]*>.*<h1 id="weekly-report">/s);
  assert.deepEqual(listPages(state).map((m) => m.slug), ['wk', 'mock-up']);
  assert.throws(() => publishPage(state, path.join(src, 'img', 'a.png')), /publish an \.html or \.md/);
  assert.throws(() => publishPage(state, path.join(src, 'report.md'), { slug: '../x' }), /bad slug/);
  assert.deepEqual(resolvePageFile(state, 'wk'), { redirect: '/p/wk/' });
  assert.equal(resolvePageFile(state, 'wk/').type, 'text/html; charset=utf-8');
  assert.equal(resolvePageFile(state, 'wk/').sandbox, true);
  assert.equal(resolvePageFile(state, 'wk/../mock-up/index.html').status, 403);
  assert.equal(resolvePageFile(state, 'wk/%2e%2e/%2e%2e/meta.json').status, 403);
  assert.equal(resolvePageFile(state, 'nope/').status, 404);
  assert.doesNotMatch(indexHtml([{ slug: 'a', title: '<b>x</b>', updatedAt: 0 }]), /<b>x/);
});

test('publishPage: a folder is copied whole, dot files and symlinks skipped', () => {
  const state = tmp('pages-state-'), src = tmp('pages-dir-');
  fs.mkdirSync(path.join(src, 'assets')); fs.writeFileSync(path.join(src, 'index.html'), '<p>hi</p>');
  fs.writeFileSync(path.join(src, 'assets', 'app.js'), '1'); fs.writeFileSync(path.join(src, '.env'), 'SECRET=1');
  fs.symlinkSync('/etc/hostname', path.join(src, 'assets', 'link.txt'));
  const r = publishPage(state, src, { slug: 'dash' });
  const site = path.join(state, 'pages', 'dash', 'site');
  assert.equal(r.files, 2);
  assert.ok(fs.existsSync(path.join(site, 'assets', 'app.js')));
  assert.ok(!fs.existsSync(path.join(site, '.env')) && !fs.existsSync(path.join(site, 'assets', 'link.txt')));
});

test('loadMockupHtml reads a shared page by path or full URL (mockup lint)', async () => {
  const state = tmp('pages-state-'), src = tmp('pages-src-');
  fs.writeFileSync(path.join(src, 'm.html'), '<h1>mock</h1>');
  publishPage(state, path.join(src, 'm.html'));
  assert.equal(await loadMockupHtml('/p/m/', { stateDir: state }), '<h1>mock</h1>');
  assert.equal(await loadMockupHtml('https://box.example.ts.net/p/m', { stateDir: state }), '<h1>mock</h1>');
});

test('the page command publishes and prints the URL', () => {
  const state = tmp('pages-state-'), src = tmp('pages-src-');
  fs.writeFileSync(path.join(src, 'note.md'), '# Note\n');
  const env = { ...process.env, GHOSTY_STATE_DIR: state, PUBLIC_URL: 'https://box.example.ts.net', TMUX: '' };
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'page'), 'publish', path.join(src, 'note.md')], { env, encoding: 'utf8' });
  assert.equal(out.trim(), 'https://box.example.ts.net/p/note/');
  assert.match(execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'page'), 'list'], { env, encoding: 'utf8' }), /^note\tNote\thttps:\/\/box\.example\.ts\.net\/p\/note\/$/m);
});

// --- the real server ---------------------------------------------------------------------------------------------------------
const TMP = fs.realpathSync(tmp('pages-srv-'));
const SOCK = `pages-${randomBytes(4).toString('hex')}`;
const REAL_TMUX = ['/usr/bin/tmux', '/usr/local/bin/tmux', '/bin/tmux'].find((p) => fs.existsSync(p)) || 'tmux';
const TMUX_WRAPPER = path.join(TMP, 'tmux-wrapper.sh');
fs.writeFileSync(TMUX_WRAPPER, `#!/bin/sh\nexec ${REAL_TMUX} -L ${SOCK} "$@"\n`, { mode: 0o755 });
let child = null;
after(() => {
  try { child?.kill('SIGKILL'); } catch { /* gone */ }
  try { execFileSync(REAL_TMUX, ['-L', SOCK, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server */ }
});
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

test('server: /p/ list, /p/<slug>/ sandboxed with no API access, /api/pages', async () => {
  const port = await freePort(), state = path.join(TMP, 'state'), home = path.join(TMP, 'home');
  fs.mkdirSync(state); fs.mkdirSync(home);
  const src = path.join(TMP, 'src'); fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'r.html'), '<title>Report</title><img src="a.png">'); fs.writeFileSync(path.join(src, 'a.png'), 'PNG');
  publishPage(state, path.join(src, 'r.html'), { slug: 'report', session: 'zz-test' });
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', HOST: '127.0.0.1', PORT: String(port), GHOSTY_STATE_DIR: state, PUBLIC_URL: 'https://box.example.ts.net',
      TMUX_BIN: TMUX_WRAPPER, TLS_KEY: path.join(TMP, 'none.pem'), TLS_CERT: path.join(TMP, 'none.pem') } });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  await waitServer(base, () => log);

  const list = await fetch(`${base}/p/`);
  assert.equal(list.status, 200);
  assert.match(await list.text(), /<a href="\/p\/report\/"><span class="t">Report<\/span>/);
  const api = await (await fetch(`${base}/api/pages`)).json();
  assert.equal(api.base, 'https://box.example.ts.net'); assert.deepEqual(api.pages.map((m) => m.slug), ['report']);
  const red = await fetch(`${base}/p/report`, { redirect: 'manual' });
  assert.equal(red.status, 301); assert.equal(red.headers.get('location'), '/p/report/');
  const page = await fetch(`${base}/p/report/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-security-policy'), PAGE_CSP);
  assert.match(PAGE_CSP, /^sandbox (?!.*allow-same-origin)/); assert.match(PAGE_CSP, /connect-src 'none'/); assert.match(PAGE_CSP, /form-action 'none'/);
  assert.equal((await fetch(`${base}/p/report/a.png`)).status, 200);
  assert.equal((await fetch(`${base}/p/report/../../manager.json`)).status, 404);
  // a sandboxed page has the opaque origin "null": every write to the API is refused even if a request got out
  const post = await fetch(`${base}/api/send/zz-none`, { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json' }, body: '{"keys":"x"}' });
  assert.equal(post.status, 403);
  const plain = await fetch(`${base}/api/send/zz-none`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"keys":"x"}' });
  assert.equal(plain.status, 415);
});

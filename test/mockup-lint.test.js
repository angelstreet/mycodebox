// Mockup lint: the pure rules and the POST /api/mockups behaviour (bounce to the session, nothing in the feed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPush } from '../push.js';
import { TOKEN_HEADER } from '../reporter.js';
import { tmp } from './helpers-tmp.js';
import { lintMockup, formatDefects } from '../mockup-lint.js';
import { createMockups, loadMockupHtml } from '../mockups.js';

const rules = (html) => lintMockup(html).map((d) => d.rule);
const GOOD = '<h1>Sessions</h1><table><tr><th>Name</th><th>Status</th></tr><tr><td>ui-worker</td><td>Running</td></tr></table><button title="Stops the session and keeps its branch for later">Stop</button>';

test('a short, plain mockup passes; titles, scripts, styles and tooltips are ignored', () => {
  assert.deepEqual(lintMockup(GOOD), []);
  const long = 'word '.repeat(40);
  assert.deepEqual(lintMockup(`<style>.a{}</style><script>var s="${long}"</script><!-- ${long} --><span class="tooltip">${long}</span><i role="tooltip">${long}</i><p>OK</p>`), []);
});

test('long sentence, long block, wide header, helper text, repeats and the word budget are flagged', () => {
  assert.deepEqual(rules('<p>This sentence is certainly longer than twelve words, which is far too many for a mockup.</p>'), ['long-sentence']);
  assert.ok(rules(`<p>${'Short one. '.repeat(20)}</p>`).includes('long-block'));
  assert.deepEqual(rules('<table><tr><th>Last activity</th><th>Number of runs today</th><th>A very long header text</th></tr></table>'), ['wide-header', 'wide-header']);
  assert.deepEqual(rules('<p class="help-text">Click a row</p><div role="note">Hi</div><span id="hint">x</span><p>Note: be careful</p><p>This page lists items</p><p>Here you can edit</p><p>Tip: use it</p>'), Array(7).fill('helper-text'));
  assert.deepEqual(rules('<p>Open the settings</p><div>Open the settings</div><p>Go</p><p>Go</p>'), ['repeated']);
  assert.deepEqual(rules(Array.from({ length: 70 }, (_, i) => `<p>a${i} b c d</p>`).join('')), ['too-many-words']);
});

test('formatDefects: one line each, at most max, then a count', () => {
  const d = lintMockup(Array.from({ length: 10 }, (_, i) => `<p class="hint">h${i}</p>`).join(''));
  const f = formatDefects(d, 8).split('\n');
  assert.equal(f.length, 9); assert.equal(f[8], '+2 more'); assert.match(f[0], /^1\. \[helper-text\]/);
});

test('loadMockupHtml reads /files/<path>, a loopback url, and skips anything else', async () => {
  const dir = tmp('mk-lint-files-'); writeFileSync(join(dir, 'a.html'), GOOD);
  assert.equal(await loadMockupHtml('/files' + join(dir, 'a.html') + '?v=1', { home: dir }), GOOD);
  assert.equal(await loadMockupHtml('http://127.0.0.1:1/x', { fetchFn: async () => ({ ok: true, text: async () => 'hi' }) }), 'hi');
  assert.equal(await loadMockupHtml('https://example.com/x', { fetchFn: async () => { throw new Error('no'); } }), null);
  assert.equal(await loadMockupHtml('/mockups/x.html'), null);
});

async function setup(mode, html) {
  const dir = tmp('mk-lint-'); const push = createPush({ stateDir: tmp('mk-lint-push-'), log: { error() {} } });
  const sent = [], logs = [];
  const mk = createMockups({ file: join(dir, 'm.jsonl'), push, tokenOk: (x) => x === 'tok', lintMode: () => mode, load: async () => html, log: (m) => logs.push(m), send: async (s, t, by) => { sent.push({ s, t, by }); } });
  const post = () => mk.post({ remoteAddress: '127.0.0.1', headers: { [TOKEN_HEADER]: 'tok' }, body: { session: 'ui-worker', title: 'Page', url: '/files/x.html' } });
  return { push, sent, logs, post };
}

test('POST: a failing mockup is 422, not in the feed, and the session is told the defects', async () => {
  const { push, sent, post } = await setup('live', '<p class="hint">Click here to do the thing</p><p>Go</p>');
  const r = await post();
  assert.equal(r.status, 422); assert.equal(r.body.error, 'mockup-lint'); assert.equal(r.body.defects[0].rule, 'helper-text');
  assert.equal(push.feedSince(0).length, 0);
  assert.equal(sent.length, 1); assert.equal(sent[0].s, 'ui-worker'); assert.equal(sent[0].by, 'mockup-lint'); assert.match(sent[0].t, /1\. \[helper-text\]/); assert.match(sent[0].t, /POST \/api\/mockups again/);
});

test('POST: a clean mockup, dry mode, off mode and an unreadable url are all posted', async () => {
  for (const [mode, html] of [['live', GOOD], ['dry', '<p class="hint">x</p>'], ['off', '<p class="hint">x</p>'], ['live', null]]) {
    const { push, sent, post, logs } = await setup(mode, html);
    const r = await post();
    assert.equal(r.status, 200, mode); assert.equal(push.feedSince(0).length, 1); assert.equal(sent.length, 0);
    if (html === null) assert.match(logs[0], /skipped/);
    if (mode === 'dry') assert.match(logs[0], /dry/);
  }
});

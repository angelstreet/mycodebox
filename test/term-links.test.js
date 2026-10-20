import test from 'node:test';
import assert from 'node:assert/strict';
import { urlChains } from '../public/term-links.js';

test('a plain URL on one row', () => {
  const [c] = urlChains(['see https://example.test/a?b=1 now'], 0, 100);
  assert.equal(c.url, 'https://example.test/a?b=1');
  assert.deepEqual(c.segs, [{ row: 0, x1: 4, x2: 30 }]);
});
test('trailing punctuation and a closing parenthesis are not part of the URL', () => {
  assert.equal(urlChains(['(https://example.test/x).'], 0, 100)[0].url, 'https://example.test/x');
});
test('a URL wrapped inside a table cell continues in the same column', () => {
  const wrapped = ['│ a │ (https://ex.test/a/re │', '│   │ port.html?X=1&Y=2 │', '│   │ 214b77) — 07d41d76 │'];
  const [c] = urlChains(wrapped, 0, 100);
  assert.equal(c.url, 'https://ex.test/a/report.html?X=1&Y=2214b77');
  assert.deepEqual(c.segs.map((s) => s.row), [0, 1, 2]);
});
test('a URL that ends mid-row does not swallow the next row', () => {
  assert.equal(urlChains(['go to https://example.test/a', 'next line here'], 0, 100)[0].url, 'https://example.test/a');
});
test('a URL wrapped at the terminal edge continues on the next row', () => {
  const [c] = urlChains(['x https://example.test/aaaa', 'bbbb/cc done'], 0, 27);
  assert.equal(c.url, 'https://example.test/aaaabbbb/cc');
});
test('a following URL is not glued on', () => {
  assert.equal(urlChains(['https://a.test/x │', 'https://b.test/y │'], 0, 100)[0].url, 'https://a.test/x');
});
test('a table column far from the left edge still continues', () => {
  const lines = ['| mobile | (https://ex.test/script-reports/ |', '|        | av_check/report.html?X-Amz- |', '|        | Signature=3ae3e9) - 07d41d76 |'];
  assert.equal(urlChains(lines, 0, 80)[0].url, 'https://ex.test/script-reports/av_check/report.html?X-Amz-Signature=3ae3e9');
});

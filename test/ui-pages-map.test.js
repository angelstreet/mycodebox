import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMap, verdict, syntheticSummary } from '../scripts/ui-overflow-check.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every deep-linked view opened at boot (public/app.js) is in the page map the 390 px check walks', () => {
  const app = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
  const boot = app.slice(app.indexOf('(async function boot()'));
  // views opened by a query flag: `get('flag')) openX(` — voice needs a microphone and `s`/`review` are session/flow state, not pages
  const flags = [...boot.matchAll(/get\('([a-z-]+)'\)\) (?:open\w+|startReview)\(/g)].map((m) => m[1]).filter((f) => !['voice', 'review'].includes(f));
  const platforms = ['platforms', 'deploys'];
  const mapped = loadMap().pages.map((p) => p.url);
  for (const f of [...flags, ...platforms]) assert.ok(mapped.some((u) => u.includes(`${f}=`)), `deep link ?${f}= is not in scripts/ui-pages.json`);
  assert.ok(loadMap().viewport.width === 390);
});

test('verdict: the document wider than the viewport, or an unclipped element past the edge, is an overflow', () => {
  assert.equal(verdict({ doc: 390, vw: 390, over: [] }), '');
  assert.match(verdict({ doc: 420, vw: 390, over: [] }), /document 420px > viewport 390px/);
  assert.match(verdict({ doc: 390, vw: 390, over: [{ sel: 'svg.spark', right: 397 }] }), /svg\.spark reaches 397px of 390px/);
});

test('the synthetic summary has what the usage page needs (a Waste finding and a Trending row)', () => {
  const s = syntheticSummary(Date.UTC(2026, 10, 28));
  assert.ok(s.waste.findings.length && s.burn.length && s.loops.length);
  assert.ok(Object.values(s.perDayModel).every((d) => Object.values(d).every((m) => m.total > 0)));
});

// Bug 1792648990963-313079: 'why is the icon page down staying highlighted after a press
// bottom right'. The scroll-to-bottom arrow in the card's .jump control stayed orange
// after being tapped. The highlight came from `.cell .jump button:hover`, and on a touch
// device the browser latches :hover on tap — no mouse-out ever fires, so the rule sticks.
//
// The fix is to only apply hover affordances on devices that actually have a hovering
// pointer (`hover: hover` + `pointer: fine`). These assertions guard that intent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, '..', 'public', 'style.css'), 'utf8');

// Index of the character offset for every top-level rule start, so we can ask
// "is this :hover rule nested inside a hover-capable media query?".
function guardedHover(selector) {
  // walk the css once, tracking whether we are inside a (hover: hover) block
  const mediaGuard = /@media[^{]*\(\s*hover\s*:\s*hover\s*\)[^{]*\{/g;
  const guards = [...css.matchAll(mediaGuard)].map((m) => m.index);
  // every occurrence of this exact selector's :hover rule
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:hover\\s*(,[^{]*)?\\{', 'g');
  const hits = [...css.matchAll(re)];
  assert.ok(hits.length, `expected a :hover rule for ${selector}`);
  for (const h of hits) {
    // the nearest preceding @media (hover:hover) must open after the nearest preceding
    // @media that closes before it — i.e. the hover rule must live inside the guard.
    const insideGuard = guards.some((g) => g < h.index && !unclosedAt(css, g, h.index));
    if (!insideGuard) return false;
  }
  return true;
}

// true when the block opened at `open` has been closed again before `idx`
function unclosedAt(src, open, idx) {
  let depth = 0;
  for (let i = open; i < idx; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  return depth <= 0;
}

test('the .jump scroll buttons only get their hover highlight on a hovering pointer', () => {
  assert.equal(guardedHover('.cell .jump button'), true,
    '.cell .jump button:hover must be gated behind (hover: hover) so it cannot stick after a tap');
});

test('the jump button still has its resting styles outside the guard', () => {
  assert.match(css, /\.cell \.jump button\s*\{[^}]*border-radius:\s*9px/i,
    'the base .jump button style must remain');
});
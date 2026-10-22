// Sticky hover on touch, swept across the dashboard (chat 1792648990963-313079 and the
// follow-up "fix all that you found"). A tap latches :hover on a touch device and no
// mouse-out ever fires, so any control that highlights *itself* on :hover stays lit and
// reads as a stuck/pressed state.
//
// Rule of thumb encoded here: a control's own highlight must live behind
// `@media (hover:hover) and (pointer:fine)`, with an :active twin so touch still gets
// feedback. Reveal-on-hover rules that show *other* things (a row's action buttons, the
// jump cluster) are deliberately left alone - they are how actions are discovered on
// touch, not a false pressed state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, '..', 'public', 'style.css'), 'utf8');

// Controls whose own appearance changes on :hover - the ones that stick.
const SELF_HIGHLIGHT = [
  '.cell .h .mv button',
  '.cell .jump button',
  '.audio-chip > .ac-play',
  '.audio-chip > .ac-download',
  '.copy-prompt',
  '.card-pane .cell .h .lk',
  '.morepop .icon-btn',
  '#askPopup .ap-nav',
  '#askPopup .ap-x',
  '#askPopup .ap-ex',
  '#askPopup .ap-det',
  '#askPopup .ap-meta',
  '.cell .askchip',
  '.rn',
  '#askPopup .ap-b',
  '.pp',
  '.mgr-section > summary',
  '.afc',
  '.afclear',
  '.attention .qask',
  '.uv-lf',
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Returns true when the rule's opening selector contains `feature` and is NOT inside a
// (hover:hover)/(pointer:fine) guard.
function unguardedHover(selector) {
  const re = new RegExp(`^([^\\n{}]*${esc(selector)}[^\\n{}]*:hover[^\\n{}]*)\\{`, 'gm');
  let m;
  while ((m = re.exec(css))) {
    // walk back from the match to find the enclosing @media stack
    if (!inHoverGuard(m.index)) return m[1].trim();
  }
  return null;
}

function inHoverGuard(idx) {
  // find all @media blocks that contain idx
  const mediaRe = /@media([^{]*)\{/g;
  let mm;
  while ((mm = mediaRe.exec(css))) {
    if (mm.index >= idx) break;
    const end = matchingBrace(css, mm.index + mm[0].length - 1);
    if (end > idx && /hover\s*:\s*hover/.test(mm[1])) return true;
  }
  return false;
}

function matchingBrace(src, openIdx) {
  let d = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) return i; }
  }
  return -1;
}

test('no self-highlighting control paints :hover on a touch device', () => {
  const offenders = [];
  for (const sel of SELF_HIGHLIGHT) {
    const bad = unguardedHover(sel);
    if (bad) offenders.push(`${sel}  ->  ${bad}`);
  }
  assert.deepEqual(offenders, [],
    `these :hover highlights must sit inside @media (hover:hover) and (pointer:fine):\n${offenders.join('\n')}`);
});

test('the guard form matches the two blocks that were already in the file', () => {
  assert.match(css, /@media \(hover:hover\) and \(pointer:fine\)\{/,
    'house style for the hover guard');
});

test('touch still gets press feedback: :active exists for the controls we gated', () => {
  for (const sel of ['.cell .jump button', '.copy-prompt', '.afc', '#askPopup .ap-ex', '.pp']) {
    assert.match(css, new RegExp(`^[^\\n{}]*${esc(sel)}:active[^\\n{]*\\{`, 'm'),
      `${sel} needs an :active twin so touch still feels a press`);
  }
});

test('the reveal-on-hover rules are left in place (they show actions on touch)', () => {
  // guards against over-sweeping: these make actions discoverable on a phone
  assert.match(css, /\.cell:hover \.jump/);
  assert.match(css, /\.session-list li:hover \.acts/);
});
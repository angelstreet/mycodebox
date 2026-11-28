// Smooth scroll of a fullscreen terminal card (public/local-scroll.js, docs/SCROLL-DESIGN.md): when the card goes to the local
// conversation, when it returns to the live screen, and the fling after the finger lifts. The wiring in app.js is checked by source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { localScrollEnters, localScrollExits, flingVelocity, flingStep, ENTER_PX, EXIT_IDLE_MS, FLING_TAU_MS } from '../public/local-scroll.js';

const ok = { on: true, reader: false, alt: true, source: 'session-file', text: 'hello', px: ENTER_PX };

test('enters only with the setting on, a fullscreen pane, a loaded conversation file and real travel toward older text', () => {
  assert.equal(localScrollEnters(ok), true);
  assert.equal(localScrollEnters({ ...ok, on: false }), false, 'setting off: the wheel goes to the app as before');
  assert.equal(localScrollEnters({ ...ok, reader: true }), false, 'already the reader');
  assert.equal(localScrollEnters({ ...ok, alt: false }), false, 'a pane with scrollback scrolls in xterm');
  assert.equal(localScrollEnters({ ...ok, source: 'pane' }), false, 'vim / htop: the pane transcript is one screen');
  assert.equal(localScrollEnters({ ...ok, text: '' }), false, 'nothing loaded yet');
  assert.equal(localScrollEnters({ ...ok, px: ENTER_PX - 1 }), false, 'a tap or a jitter');
  assert.equal(localScrollEnters({ ...ok, px: -40 }), false, 'toward newer text at the live end');
  assert.equal(localScrollEnters(), false);
});

test('returns to the live screen at the bottom, finger up, scroll at rest', () => {
  assert.equal(localScrollExits({ fromBottomPx: 0, touching: false, idleMs: EXIT_IDLE_MS }), true);
  assert.equal(localScrollExits({ fromBottomPx: 0.5, touching: false, idleMs: 1000 }), true, 'fractional scroll positions');
  assert.equal(localScrollExits({ fromBottomPx: 0, touching: true, idleMs: 1000 }), false, 'the finger is still down');
  assert.equal(localScrollExits({ fromBottomPx: 0, touching: false, idleMs: EXIT_IDLE_MS - 1 }), false, 'still moving');
  assert.equal(localScrollExits({ fromBottomPx: 40, touching: false, idleMs: 1000 }), false, 'reading older text');
});

test('fling: velocity of the last samples, none when the finger rested, a decay that covers v * tau', () => {
  const s = [{ t: 0, y: 0 }, { t: 16, y: 16 }, { t: 32, y: 32 }, { t: 48, y: 48 }];
  assert.equal(flingVelocity(s, 50), 1);
  assert.equal(flingVelocity(s, 400), 0, 'rested 350 ms before lifting');
  assert.equal(flingVelocity([{ t: 0, y: 0 }], 5), 0);
  assert.equal(flingVelocity([], 5), 0);
  assert.equal(flingVelocity([{ t: 0, y: 0 }, { t: 300, y: 90 }, { t: 366, y: 123 }], 370), 0.5, 'slow frames: the last two samples');
  let v = 1, total = 0, steps = 0;
  for (; steps < 1000; steps++) { const f = flingStep(v, 16); total += f.dy; v = f.v; if (f.done) break; }
  assert.ok(steps < 200, 'the fling ends');
  assert.ok(total > FLING_TAU_MS * 0.9 && total < FLING_TAU_MS, `1 px/ms travels about tau px, got ${total}`);
  assert.ok(flingStep(-1, 16).dy < 0, 'direction kept');
});

test('wiring: behind the setting, per card and never saved, in the settings popover and the offline shell', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /state\.smoothScroll = lsGet\(LS_SMOOTH, '0'\) === '1'/, 'scrolling stays in the terminal unless the owner enables Smooth scroll');
  assert.match(app, /function readerOn\(n\) \{ return state\.reader \|\| state\.scrollRd\.has\(n\)/, 'the card shows the reader without touching the saved view');
  assert.doesNotMatch(app, /lsSet\(LS_READER[^\n]*scrollRd/, 'a smooth scroll never saves the reader / terminal choice');
  const enter = app.slice(app.indexOf('function localScrollEnter('), app.indexOf('function localScrollExit('));
  assert.match(enter, /localScrollEnters\(\{ on: state\.smoothScroll/);
  assert.doesNotMatch(enter, /state\.reader =/, 'the global reader switch is not flipped (2026-11-20: views changed under the owner)');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="smoothToggle"/, 'desktop: the text popover');
  assert.match(html, /id="smoothBtn"/, 'phone: the More menu (the text popover is hidden there)');
  assert.match(fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), /'\/local-scroll\.js'/);
});

// The disk banner's text (public/disk-banner.js): the owner-visible words and when the banner shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diskBannerView, diskDetailNote, DISK_REASON } from '../public/disk-banner.js';

const reading = (over = {}) => ({
  ok: true, reason: DISK_REASON, level: 'warn', hold: false, blocked: false,
  enabled: true, override: false, holdPct: 90, warnPct: 85,
  worst: { path: '/', pct: 86.4, used: 0, free: 0, total: 0, level: 'warn' },
  disks: [], top: [], ...over,
});

test('the banner shows only for the reason code disk_low', () => {
  assert.equal(diskBannerView(reading()).show, true);
  assert.equal(diskBannerView(reading({ level: 'hold', hold: true, blocked: true })).show, true);
  assert.equal(diskBannerView(reading({ reason: null, level: 'ok' })).show, false, 'no reason code, no banner');
  assert.equal(diskBannerView(reading({ level: 'ok' })).show, false, 'a healthy disk has no banner');
  assert.equal(diskBannerView(null).show, false);
  assert.equal(diskBannerView(undefined).show, false);
});

test('the warning banner says what is wrong and what will happen, in plain words', () => {
  const v = diskBannerView(reading());
  assert.equal(v.label, 'DISK LOW');
  assert.equal(v.hold, false);
  assert.match(v.text, /86% full/, 'the real number');
  assert.match(v.text, /New work pauses at 90%/, 'what will happen');
  assert.doesNotMatch(v.text, /threshold|statfs|disk_low/, 'no jargon for the owner');
});

test('the hold banner says what is refused and what still works', () => {
  const v = diskBannerView(reading({ level: 'hold', hold: true, blocked: true, worst: { path: '/', pct: 91.2, level: 'hold' } }));
  assert.equal(v.label, 'DISK FULL');
  assert.equal(v.hold, true);
  assert.match(v.text, /91% full/);
  assert.match(v.text, /New sessions and tasks are paused until it drops below 90%/);
  assert.match(v.text, /already running keep going/, 'the owner knows what still works');
});

test('the banner is repainted only when it changes', () => {
  const a = diskBannerView(reading());
  const b = diskBannerView(reading());
  assert.equal(a.key, b.key, 'the same reading gives the same key');
  assert.notEqual(a.key, diskBannerView(reading({ worst: { path: '/', pct: 91 } })).key, 'a new number repaints it');
  assert.notEqual(a.key, diskBannerView(reading({ level: 'hold', hold: true })).key, 'a new level repaints it');
});

test('the detail sheet says the same thing in one line', () => {
  assert.match(diskDetailNote(reading({ level: 'hold', hold: true })), /paused until the disk has room again/);
  assert.match(diskDetailNote(reading({ level: 'hold', hold: true })), /Running sessions are not affected/);
  assert.match(diskDetailNote(reading()), /getting full/);
  assert.match(diskDetailNote(null), /enough room/);
});

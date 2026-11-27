// A headless browser never resizes a live session's pane (2026-11-27, api-extras.js headlessResizeRefused).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headlessResizeRefused } from '../api-extras.js';

const HEADLESS = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36';
const PHONE = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

test('a headless browser cannot resize a live pane; zz- sessions and a temp test server can', () => {
  assert.equal(headlessResizeRefused(HEADLESS, 'mm-manager', {}), true);
  assert.equal(headlessResizeRefused(HEADLESS, 'manager', {}), true);
  assert.equal(headlessResizeRefused(HEADLESS, 'zz-flash', {}), false);
  assert.equal(headlessResizeRefused(HEADLESS, 'manager', { GHOSTY_HEADLESS_RESIZE: '1' }), false);
  assert.equal(headlessResizeRefused(PHONE, 'manager', {}), false);
  assert.equal(headlessResizeRefused(undefined, 'manager', {}), false);
});

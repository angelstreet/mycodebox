import test from 'node:test';
import assert from 'node:assert/strict';
import { agoText } from '../public/deployed.js';

const NOW = 1_800_000_000_000;
const sec = NOW / 1000;

test('agoText buckets', () => {
  assert.equal(agoText(sec - 10, sec), '10s ago');
  assert.equal(agoText(sec - 600, sec), '10m ago');
  assert.equal(agoText(sec - 7200, sec), '2h ago');
  assert.equal(agoText(sec - 3 * 86400, sec), '3d ago');
  assert.equal(agoText(sec + 50, sec), '0s ago');
});

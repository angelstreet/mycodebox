import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extFor } from '../transcribe.js';

test('extFor maps recorder mime types to extensions ffmpeg knows', () => {
  assert.equal(extFor('audio/webm;codecs=opus'), 'webm');
  assert.equal(extFor('audio/mp4'), 'm4a');          // iOS Safari
  assert.equal(extFor('audio/ogg; codecs=opus'), 'ogg');
  assert.equal(extFor('audio/wav'), 'wav');
  assert.equal(extFor(undefined), 'webm');
});

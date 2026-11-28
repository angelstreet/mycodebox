import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastStatus, headlineOf } from '../public/status-line.js';
import * as honesty from '../status-honesty.js';

test('status-honesty re-exports the shared parser (one implementation)', () => {
  assert.equal(honesty.lastStatus, lastStatus);
  assert.equal(honesty.headlineOf, headlineOf);
});

test('lastStatus joins a pane-wrapped STATUS, the last one wins, none gives null', () => {
  assert.equal(lastStatus('STATUS: waiting: integration\n  int-42').text, 'integration int-42');
  assert.equal(lastStatus('STATUS: running: job\ntext\nSTATUS: needs-manager: pick the cap').kind, 'needs-manager');
  assert.equal(lastStatus('no status here'), null);
});

test('the browser module no longer exports a spoken STATUS (the play button reads the summary only)', async () => {
  assert.equal('spokenStatusOf' in (await import('../public/status-line.js')), false);
});

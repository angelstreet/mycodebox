import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastStatus, headlineOf, spokenStatusOf } from '../public/status-line.js';
import * as honesty from '../status-honesty.js';

test('status-honesty re-exports the shared parser (one implementation)', () => {
  assert.equal(honesty.lastStatus, lastStatus);
  assert.equal(honesty.headlineOf, headlineOf);
});

test('the play button text is the STATUS word and claim only, never the reply', () => {
  const reply = 'A long answer.\n'.repeat(500) + '\nVerification:\n1. pass — x\n\nSTATUS: done — fix merged (int-1) · goal: achieved · evidence: a · closing review: docs none · leftovers none · bugs: none';
  const s = spokenStatusOf(reply);
  assert.equal(s, 'Status: done. fix merged (int-1)');
  assert.ok(!s.includes('A long answer'));
});

test('a pane-wrapped STATUS is joined; the last STATUS wins; none gives empty text', () => {
  assert.equal(spokenStatusOf('STATUS: waiting: integration\n  int-42'), 'Status: waiting. integration int-42');
  assert.equal(spokenStatusOf('STATUS: running: job\ntext\nSTATUS: needs-manager: pick the cap'), 'Status: needs-manager. pick the cap');
  assert.equal(spokenStatusOf('no status here'), '');
  assert.equal(spokenStatusOf(''), '');
});

test('the spoken claim is capped at 300 characters', () => {
  const s = spokenStatusOf('STATUS: failed — ' + 'x'.repeat(1000));
  assert.ok(s.length <= 'Status: failed. '.length + 300);
});

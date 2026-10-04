import test from 'node:test';
import assert from 'node:assert/strict';
import { displayState, displayStateOf, STATE_RANK, STATE_LABEL } from '../public/state.js';

test('displayState: no status -> offline', () => {
  assert.equal(displayState(undefined), 'offline');
  assert.equal(displayState(null), 'offline');
  assert.equal(displayState({}), 'offline');
  assert.equal(displayState({ state: '' }), 'offline');
});

test('displayState: passes the raw state through when there is no deployWait', () => {
  for (const s of ['waiting', 'working', 'done', 'idle', 'offline']) {
    assert.equal(displayState({ state: s }), s, `state: ${s}`);
  }
});

test('displayState: a deployWait turns working/done/idle into deploy; waiting/offline win', () => {
  assert.equal(displayState({ state: 'working', deployWait: { id: 'd1', text: 'queued' } }), 'deploy');
  assert.equal(displayState({ state: 'done',    deployWait: { id: 'd1', text: 'queued' } }), 'deploy');
  assert.equal(displayState({ state: 'idle',    deployWait: { id: 'd1', text: 'queued' } }), 'deploy');
  // a live needs-you prompt is louder than the deploy hint
  assert.equal(displayState({ state: 'waiting', deployWait: { id: 'd1', text: 'queued' } }), 'waiting');
  // offline stays offline (no badge, no card)
  assert.equal(displayState({ state: 'offline', deployWait: { id: 'd1', text: 'queued' } }), 'offline');
});

test('displayState: null / missing deployWait keeps the raw state', () => {
  assert.equal(displayState({ state: 'working', deployWait: null }), 'working');
  assert.equal(displayState({ state: 'working' }), 'working');
});

test('displayStateOf: looks the session up in the status map', () => {
  const m = {
    a: { state: 'working' },
    b: { state: 'working', deployWait: { id: 'd2', text: 'awaiting' } },
    c: { state: 'waiting', deployWait: { id: 'd3', text: 'queued' } },
  };
  assert.equal(displayStateOf('a', m), 'working');
  assert.equal(displayStateOf('b', m), 'deploy');
  assert.equal(displayStateOf('c', m), 'waiting');
  assert.equal(displayStateOf('missing', m), 'offline');
  assert.equal(displayStateOf('missing', undefined), 'offline');
});

test('STATE_RANK: waiting < deploy < done < working < idle < offline', () => {
  // the order is what the urgency sort uses; a deploy-wait session sorts above done/working/idle
  // but below a live needs-you prompt.
  assert.ok(STATE_RANK.waiting < STATE_RANK.deploy);
  assert.ok(STATE_RANK.deploy < STATE_RANK.done);
  assert.ok(STATE_RANK.done < STATE_RANK.working);
  assert.ok(STATE_RANK.working < STATE_RANK.idle);
  assert.ok(STATE_RANK.idle < STATE_RANK.offline);
});

test('STATE_LABEL: every state the UI shows, including a "waiting deploy" for the chip', () => {
  assert.equal(STATE_LABEL.waiting, 'needs you');
  assert.equal(STATE_LABEL.deploy, 'waiting deploy');
  assert.equal(STATE_LABEL.working, 'working');
  assert.equal(STATE_LABEL.done, 'done');
  assert.equal(STATE_LABEL.idle, 'idle');
  assert.equal(STATE_LABEL.offline, 'offline');
});
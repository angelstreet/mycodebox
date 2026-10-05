import test from 'node:test';
import assert from 'node:assert/strict';
import { displayState, displayStateOf, STATE_RANK, STATE_LABEL, isRoutineAlert } from '../public/state.js';

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

test('isRoutineAlert: deploy started/done with a ghosty-deploy- tag is routine', () => {
  assert.equal(isRoutineAlert({ tag: 'ghosty-deploy-d42', title: 'deploy node1-vpt frontend started' }), true);
  assert.equal(isRoutineAlert({ tag: 'ghosty-deploy-d42', title: 'deploy node1-vpt frontend done' }), true);
  assert.equal(isRoutineAlert({ tag: 'ghosty-deploy-d42', title: 'deploy prod api done' }), true);
  assert.equal(isRoutineAlert({ tag: 'ghosty-deploy-d42', title: 'deploy staging backend started' }), true);
});

test('isRoutineAlert: deploy failed / skipped / orphaned / approval still count', () => {
  assert.equal(isRoutineAlert({ tag: 'ghosty-deploy-d42', title: 'deploy node1-vpt frontend failed' }), false);
  assert.equal(isRoutineAlert({ tag: 'ghosty-deploy-d42', title: 'deploy node1-vpt frontend done, 2 host(s) skipped' }), false);
  assert.equal(isRoutineAlert({ tag: 'ghosty-deploy-d42', title: 'deploy node1-vpt frontend orphaned' }), false);
  assert.equal(isRoutineAlert({ tag: 'ghosty-deploy-d42', title: 'deploy needs approval: prod api' }), false);
});

test('isRoutineAlert: non-deploy alerts always count (any tag, any title)', () => {
  assert.equal(isRoutineAlert({ tag: 'ghosty-ask', title: 'codebox asks you to pick a model' }), false);
  assert.equal(isRoutineAlert({ tag: undefined, title: 'codebox needs you' }), false);
  assert.equal(isRoutineAlert({ tag: 'ghosty-quota', title: 'codebox quota at 92%' }), false);
  assert.equal(isRoutineAlert({ tag: 'ghosty-credits', title: 'OpenRouter credit is low ($2.10)' }), false);
  assert.equal(isRoutineAlert({ tag: 'ghosty-disk', title: 'disk almost full on /var' }), false);
  assert.equal(isRoutineAlert({ tag: 'ghosty-held', title: 'session held: waiting for owner' }), false);
});

test('isRoutineAlert: ghosty-deploy-* tag with a non-routine title still counts', () => {
  // belt-and-braces: an unrelated deploy-classified alert must not be silenced by the prefix alone
  assert.equal(isRoutineAlert({ tag: 'ghosty-deploy-d42', title: 'deploy node1-vpt frontend running' }), false);
  assert.equal(isRoutineAlert({ tag: 'ghosty-deploy-d42', title: 'deploy approval expired' }), false);
});

test('isRoutineAlert: missing / wrong-typed tag or title is safe (returns false)', () => {
  assert.equal(isRoutineAlert(undefined), false);
  assert.equal(isRoutineAlert(null), false);
  assert.equal(isRoutineAlert({}), false);
  assert.equal(isRoutineAlert({ tag: null, title: 'deploy x y started' }), false);
  assert.equal(isRoutineAlert({ tag: 'ghosty-deploy-x', title: undefined }), false);
  assert.equal(isRoutineAlert({ tag: 'ghosty-deploy-x', title: '' }), false);
  assert.equal(isRoutineAlert({ tag: 'ghosty-deploy-x', title: 123 }), false);
  // tag without the deploy prefix -> never routine even if the title looks routine
  assert.equal(isRoutineAlert({ tag: 'deploy-x', title: 'deploy x y started' }), false);
  assert.equal(isRoutineAlert({ tag: '', title: 'deploy x y started' }), false);
});
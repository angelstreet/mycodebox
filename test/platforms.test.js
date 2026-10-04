import test from 'node:test';
import assert from 'node:assert/strict';
import { agentSession, machinesOf, blocksDeploy, holdingsOf, chipModel, ttlText, deployWaitOf, platformsView } from '../public/platforms.js';
import { createLeaseStore } from '../leases.js';

const M = machinesOf('Codebox-VM.lan');
const NAMES = ['qualiai-pipeline', 'Task44-AI', 'other'];
const L = (o = {}) => ({ id: 'a1', env: 'node1-vpt', resource: 'vpt-pi1/stb4', agent: 'codebox:qualiai-pipeline', purpose: 'run', ttlLeftMin: 100, ...o });
const D = (o = {}) => ({ id: 'd1', env: 'node1-vpt', scope: 'host', ref: 'main', agent: 'codebox:other', state: 'queued', created: 1, ...o });

test('exact matching: machine prefix, case, hostname, no fuzzy guess', () => {
  assert.equal(agentSession('codebox:qualiai-pipeline', NAMES, M), 'qualiai-pipeline');
  assert.equal(agentSession('CodeBox:QualiAI-Pipeline', NAMES, M), 'qualiai-pipeline');
  assert.equal(agentSession('codebox-vm:task44-ai', NAMES, M), 'Task44-AI');      // hostname prefix, first label
  assert.equal(agentSession('codebox:stb4-anchor-run', NAMES, M), null);          // free-form name: unknown
  assert.equal(agentSession('codebox:qualiai', NAMES, M), null);                  // substring is not a match
  assert.equal(agentSession('mac:other', NAMES, M), null);                        // other machine
  assert.equal(agentSession('other', NAMES, M), null);
  assert.equal(agentSession('', NAMES, M), null);
});

test('blocksDeploy: queued / awaiting overlap by scope, running or other env do not', () => {
  assert.equal(blocksDeploy(L(), [D()]), true);
  assert.equal(blocksDeploy(L(), [D({ state: 'awaiting-approval' })]), true);
  assert.equal(blocksDeploy(L(), [D({ state: 'running' })]), false);
  assert.equal(blocksDeploy(L(), [D({ env: 'node3-qualiai' })]), false);
  assert.equal(blocksDeploy(L({ resource: 'frontend' }), [D({ scope: 'host' })]), false);
  assert.equal(blocksDeploy(L({ resource: 'frontend' }), [D({ scope: 'frontend' })]), true);
  assert.equal(blocksDeploy(L({ resource: '*' }), [D({ scope: 'frontend' })]), true);
  assert.equal(blocksDeploy(L(), []), false);
});

test('holdingsOf: only exact-owned, with blocksDeploy', () => {
  const ls = [L(), L({ id: 'b', resource: 'frontend', agent: 'codebox:other' }), L({ id: 'c', agent: 'codebox:stb4-anchor-run' })];
  const h = holdingsOf('qualiai-pipeline', ls, [D()], NAMES, M);
  assert.deepEqual(h, [{ id: 'a1', env: 'node1-vpt', resource: 'vpt-pi1/stb4', agent: 'codebox:qualiai-pipeline', ttlLeftMin: 100, purpose: 'run', blocksDeploy: true }]);
  assert.deepEqual(holdingsOf('nobody', ls, [], NAMES, M), []);
});

test('chip text', () => {
  assert.equal(ttlText(100), '1h40'); assert.equal(ttlText(45), '45m'); assert.equal(ttlText(120), '2h00'); assert.equal(ttlText(0), '<1m');
  assert.equal(chipModel([]), null);
  assert.equal(chipModel([{ env: 'e', resource: 'vpt-pi1/stb4', ttlLeftMin: 100, blocksDeploy: false }]).text, '\u{1F512} pi1/stb4 · 1h40');
  const two = chipModel([{ env: 'e', resource: 'host-clone-1', ttlLeftMin: 50, blocksDeploy: false }, { env: 'e', resource: 'frontend', ttlLeftMin: 20, blocksDeploy: false }]);
  assert.equal(two.text, '\u{1F512} frontend · 20m +1'); assert.equal(two.blocks, false);
  const b = chipModel([{ env: 'e', resource: '*', ttlLeftMin: 30, blocksDeploy: false }, { env: 'e', resource: 'vpt-pi1', ttlLeftMin: 90, blocksDeploy: true }]);
  assert.equal(b.text, '\u{1F512} pi1 · 1h30 +1 · blocks deploy'); assert.equal(b.blocks, true);
});

test('deployWaitOf: requester, waiter, said, none; priority', () => {
  const ctx = { sessionNames: NAMES, machines: M };
  const q = D({ agent: 'codebox:Qualiai-Pipeline', blocking: [{ resource: 'vpt-pi1/stb4', agent: 'codebox:other' }] });
  const r = deployWaitOf('qualiai-pipeline', { ...ctx, deploys: [q] });
  assert.equal(r.kind, 'requested'); assert.equal(r.id, 'd1');
  assert.equal(r.text, 'requested deploy #d1 (queued, blocked by pi1/stb4 (codebox:other))');
  assert.match(deployWaitOf('qualiai-pipeline', { ...ctx, deploys: [{ ...q, state: 'awaiting-approval', blocking: [] }] }).text, /awaiting your approval\)$/);
  assert.equal(deployWaitOf('qualiai-pipeline', { ...ctx, deploys: [{ ...q, state: 'done' }] }), null);
  const w = deployWaitOf('other', { ...ctx, deploys: [q], waiters: [{ agent: 'codebox:other', deployId: 'd1', env: 'node1-vpt' }] });
  assert.deepEqual([w.kind, w.id, w.text], ['waiter', 'd1', 'waiting on deploy #d1']);
  const we = deployWaitOf('other', { ...ctx, deploys: [q], waiters: [{ agent: 'codebox:other', deployId: '', env: 'node1-vpt' }] });
  assert.equal(we.id, 'd1');
  assert.equal(deployWaitOf('other', { ...ctx, waiters: [{ agent: 'codebox:other', deployId: '', env: 'x' }] }).text, 'waiting on a deploy');
  assert.deepEqual(deployWaitOf('other', { ...ctx, stall: { case: 'waiting_deploy' } }).kind, 'said');
  assert.equal(deployWaitOf('other', { ...ctx, stall: { case: 'done' } }), null);
  assert.equal(deployWaitOf('Task44-AI', { ...ctx, deploys: [q], waiters: [{ agent: 'mac:x', env: 'e' }] }), null);
  assert.equal(deployWaitOf('other', { ...ctx, deploys: [q, { ...q, id: 'd2', agent: 'codebox:other' }], waiters: [{ agent: 'codebox:other', env: 'node1-vpt' }], stall: { case: 'waiting_deploy' } }).kind, 'requested');
});

test('platforms data assembly with injected registry (leases + queue + ledger)', async () => {
  const calls = [];
  const run = async (args) => { calls.push(args.join(' ')); return { code: 0, stdout: JSON.stringify({ now: 1, leases: [L(), L({ id: 'x', resource: 'frontend', agent: 'codebox:stb4-anchor-run', ttlLeftMin: 7 })], deploys: [], waiters: [{ agent: 'codebox:other', env: 'node1-vpt', deployId: '' }] }), stderr: '' }; };
  const store = createLeaseStore({ run });
  const v = await store.get(); await store.get();
  assert.deepEqual(calls, ['list --json']);                       // cached
  assert.equal(v.ok, true);
  const sec = 1_800_000_000;
  const view = platformsView({ leases: v.leases, deploys: [D({ agent: 'mac:t', blocking: [] })], waiters: v.waiters, sessionNames: NAMES, machines: M, nowMs: sec * 1000,
    deployed: { 'node1-vpt': { frontend: { at: sec - 60, ref: 'main', commit: 'abc', version: 'v1', agent: 'x' }, server: { at: sec - 120, ref: 'main', commit: 'abc', version: 'v1', agent: 'x' } }, 'node3-qualiai': {} } });
  assert.deepEqual(view.map((e) => e.env), ['node1-vpt', 'node3-qualiai']);
  const e = view[0];
  assert.deepEqual(e.resources.map((r) => [r.resource, r.session, r.unknown, r.blocksDeploy]), [['frontend', null, 'codebox:stb4-anchor-run', false], ['vpt-pi1/stb4', 'qualiai-pipeline', null, true]]);
  assert.equal(e.queue.length, 1); assert.equal(e.queue[0].session, null);
  assert.equal(e.waiters.length, 1);
  assert.equal(e.deployedSummary, 'v1 · 2 targets · 60s ago');
  assert.equal(view[1].deployedSummary, 'nothing recorded');
  const bad = await createLeaseStore({ run: async () => ({ code: 255, stdout: '', stderr: 'down' }) }).get();
  assert.deepEqual(bad, { ok: false, error: 'down' });
});

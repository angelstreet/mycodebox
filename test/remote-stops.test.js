// Round 9 item 1: stops from other machines (the Mac Stop hook) enter the manager through POST /api/remote/v1/stops.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { hashToken } from '../lease-routes.js';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghosty-remote-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: stateDir, JEV_URL: '', JEV_API_KEY: '' });
const manager = await import('../manager.js');
const { createRemoteStops, PREFIX, validateStop, stopText } = await import('../remote-stops.js');

const REMOTE = 'tok-remote-0123456789abcdef';   // leak-scan: allow (fake test token)
const PLAIN = 'tok-plain-0123456789abcdef';     // leak-scan: allow (fake test token)
const leasesDir = path.join(stateDir, 'leases');
fs.mkdirSync(leasesDir, { recursive: true });
fs.writeFileSync(path.join(leasesDir, 'clients.json'), JSON.stringify({ clients: [
  { name: 'mac-a', sha256: hashToken(REMOTE), remote: true }, { name: 'plain', sha256: hashToken(PLAIN) },
] }));

const owner = [];   // onOwnerNeeded calls
const remote = createRemoteStops({ manager, dir: leasesDir, stateDir });
await manager.initManager({
  onOwnerNeeded: (session, stall, reason) => owner.push({ session, case: stall.case, reason }),
  sendKey: async (n, k) => (remote.owns(n) ? remote.deliverKey(n, k) : null),
  sendKeys: async (n, t) => (remote.owns(n) ? remote.deliver(n, t) : null),
});
await manager.setManagerConfig({ delayMs: 250, maxPerSessionPerHour: 50 });
fs.writeFileSync(path.join(stateDir, 'remote.json'), JSON.stringify({ waitS: 10 }));

const server = http.createServer((req, res) => { remote.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;
const call = async (method, p, { body, token = REMOTE } = {}) => {
  const r = await fetch(base + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
test.after(() => new Promise((r) => server.close(r)));

let n = 0;
const stop = (over = {}) => ({ machine: 'mac-test', project: 'demo', session_id: `sid-${++n}-aaaaaaaa`, session_name: `s${n}`, text: 'Done.\nSTATUS: done', ...over });
const post = (over, token) => call('POST', '/stops', { body: stop(over), token });
const answer = (id, wait = 5) => call('GET', `/stops/${id}/answer?wait=${wait}`);
const stalls = () => fs.readFileSync(path.join(stateDir, 'stalls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const MENU = (rec) => `Two ways to store the cache.\nWhich storage should I use?\n\n1. In memory${rec === 1 ? ' (recommended)' : ''}\n2. On disk${rec === 2 ? ' (recommended)' : ''}`;
const OWNER_MENU = 'Two ways to store the cache.\n\n1. In memory\n2. On disk\n\nSTATUS: needs-owner: which storage?';

test('auth: no token 401, a client without the remote flag 403, a revoked/unknown token 401', async () => {
  assert.equal((await call('POST', '/stops', { body: stop(), token: null })).status, 401);
  assert.equal((await call('POST', '/stops', { body: stop(), token: 'nope-nope-nope-nope' })).status, 401);   // leak-scan: allow (fake test token)
  const r = await post({}, PLAIN);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /--remote/);
  assert.equal((await call('GET', '/nothing')).status, 404);
  assert.equal((await call('GET', '/stops')).status, 405);
});

test('address allowlist: an address outside loopback / tailnet is refused before the token is looked at', async () => {
  const req = Object.assign(new PassThrough(), { url: `${PREFIX}/stops`, method: 'POST', headers: { authorization: `Bearer ${REMOTE}` }, socket: { remoteAddress: '203.0.113.9' } });   // leak-scan: allow (documentation address)
  let code = 0, out = '';
  const res = { writeHead: (c) => { code = c; }, end: (b) => { out = b; } };
  assert.equal(await remote.handle(req, res), true);
  assert.equal(code, 403); assert.match(out, /source address/);
});

test('validation: required fields, size caps, odd characters, options', () => {
  assert.equal(validateStop({}).ok, false);
  assert.equal(validateStop({ machine: 'm', session_id: 'x', text: '  ' }).ok, false);
  assert.equal(validateStop({ machine: '../etc', session_id: 'x', text: 't' }).ok, false);
  const big = validateStop({ machine: 'm', session_id: 'x', text: `${'a'.repeat(50000)}END` });
  assert.ok(big.ok); assert.equal(big.v.text.length, 12000); assert.ok(big.v.text.endsWith('END'), 'the tail is kept');
  assert.equal(validateStop({ machine: 'm', session_id: 'x', text: 't', remote_control_url: 'javascript:alert(1)' }).v.remote_control_url, undefined);
  assert.equal(validateStop({ machine: 'm', session_id: 'x', text: 't', options: Array(20).fill({ text: 'a' }) }).ok, false);
  const far = validateStop({ machine: 'm', session_id: 'x', text: 't', at: '2001-01-01T00:00:00Z' }, 1e12);
  assert.equal(far.v.at, 1e12, 'a far-off clock is not believed');
  assert.match(stopText({ text: 'Which one?', options: [{ n: 1, text: 'A', recommended: true }, { n: 2, text: 'B' }] }), /1\. A \(recommended\)\n  2\. B/);
});

test('a needs-owner stop with options is classified like a local one, escalated, and shown as a mac: row', async () => {
  const r = await post({ session_name: 'owner-menu', text: OWNER_MENU });
  assert.equal(r.status, 200); assert.equal(r.body.session, 'mac:owner-menu'); assert.equal(r.body.answerable, true);
  const a = await answer(r.body.id);
  assert.equal(a.body.state, 'none'); assert.match(a.body.reason, /owner/);
  const rec = stalls().find((s) => s.type === 'stall' && s.session === 'mac:owner-menu');
  assert.ok(rec, 'journalled in stalls.jsonl'); assert.equal(rec.case, 'owner_decision'); assert.equal(rec.textSource, 'reporter');
  assert.ok(owner.some((o) => o.session === 'mac:owner-menu'), 'needs-you push');
  const row = remote.statusRows()['mac:owner-menu'];
  assert.equal(row.state, 'done'); assert.equal(row.remote.machine, 'mac-test'); assert.equal(row.stall.case, 'owner_decision'); assert.equal(row.stall.options.length, 2);
});

test('a menu with a recommended option is answered after the countdown and the answer rides the long-poll', async () => {
  const t0 = Date.now();
  const r = await post({ session_name: 'rec-menu', text: MENU(1) });
  const a = await answer(r.body.id);
  assert.equal(a.body.state, 'answered', JSON.stringify(a.body));
  assert.match(a.body.answer, /option 1|recommendation/i);
  assert.ok(Date.now() - t0 >= 200, 'the cancel window (countdown) was honoured');
  await new Promise((x) => setTimeout(x, 100));   // the journal line is written just after the send
  assert.ok(stalls().some((s) => s.type === 'answer' && s.session === 'mac:rec-menu'), 'journalled as an answer');
});

test('cancelling the countdown on the dashboard resolves the long-poll with no answer', async () => {
  await manager.setManagerConfig({ delayMs: 3000 });
  const r = await post({ session_name: 'cancel-me', text: MENU(2) });
  const p = answer(r.body.id);
  await new Promise((x) => setTimeout(x, 150));
  assert.equal(manager.cancelAuto('mac:cancel-me'), true);
  const a = await p;
  assert.equal(a.body.state, 'none'); assert.match(a.body.reason, /cancelled by owner/);
  await manager.setManagerConfig({ delayMs: 250 });
});

test('loop guard: a stop that arrives with stop_hook_active is never answered, the owner is told', async () => {
  const before = owner.length;
  const r = await post({ session_name: 'looping', text: MENU(1), stop_hook_active: true });
  assert.equal(r.body.answerable, false);
  const a = await answer(r.body.id);
  assert.equal(a.body.state, 'none');
  assert.ok(owner.length > before && owner.at(-1).session === 'mac:looping');
  assert.match(owner.at(-1).reason, /loop guard/);
});

test('hourly cap: the manager cap applies per remote session', async () => {
  await manager.setManagerConfig({ maxPerSessionPerHour: 1 });
  const r1 = await post({ session_name: 'capped', session_id: 'sid-cap-aaaaaaaa', text: MENU(1) });
  assert.equal((await answer(r1.body.id)).body.state, 'answered');
  const r2 = await post({ session_name: 'capped', session_id: 'sid-cap-aaaaaaaa', text: MENU(2).replace('storage should', 'format should') });
  const a2 = await answer(r2.body.id);
  assert.equal(a2.body.state, 'none');
  await manager.setManagerConfig({ maxPerSessionPerHour: 50 });
});

test('merge / push questions without a local checkout are escalated, never answered', async () => {
  const r = await post({ session_name: 'merge-ask', text: 'Tests pass on branch feature-x.\nShall I merge feature-x into main and push?\nSTATUS: needs-owner: merge and push?' });
  const a = await answer(r.body.id);
  assert.equal(a.body.state, 'none');
  assert.ok(owner.some((o) => o.session === 'mac:merge-ask'));
});

test('a stop the hook stops waiting for drops its pending answer; a later stop of the session settles the earlier one', async () => {
  fs.writeFileSync(path.join(stateDir, 'remote.json'), JSON.stringify({ waitS: 5 }));
  await manager.setManagerConfig({ delayMs: 600000 });   // the countdown would outlast the hook
  const r = await post({ session_name: 'timeout', text: MENU(1) });
  const a = await call('GET', `/stops/${r.body.id}/answer?wait=1`);   // short poll: still pending
  assert.equal(a.body.state, 'pending');
  assert.equal((await call('GET', `/stops/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}/answer`)).status, 404);
  await manager.setManagerConfig({ delayMs: 250 });
  fs.writeFileSync(path.join(stateDir, 'remote.json'), JSON.stringify({ waitS: 10 }));
  const r2 = await post({ session_name: 'timeout', text: 'Back at it.\nSTATUS: done' });   // the next stop supersedes the pending one
  assert.equal((await answer(r.body.id)).body.state, 'none');
  assert.equal((await answer(r2.body.id)).body.state, 'none');
});

test('a posted stop of another client cannot be read', async () => {
  const r = await post({ session_name: 'private', text: 'x\nSTATUS: done' });
  fs.writeFileSync(path.join(leasesDir, 'clients.json'), JSON.stringify({ clients: [
    { name: 'mac-a', sha256: hashToken(REMOTE), remote: true }, { name: 'mac-b', sha256: hashToken('tok-other-0123456789abcdef'), remote: true },   // leak-scan: allow (fake test token)
  ] }));
  await new Promise((x) => setTimeout(x, 20));
  const other = await call('GET', `/stops/${r.body.id}/answer`, { token: 'tok-other-0123456789abcdef' });   // leak-scan: allow (fake test token)
  assert.equal(other.status, 404);
});

test('ledger: a hook-delivered answer is recorded as remote-hook, an owner reply seen on the next stop as owner via mac', async () => {
  const ledger = () => fs.readFileSync(path.join(stateDir, 'owner-roundtrips.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const sid = 'sid-ledger-aaaaaaaa';
  const r1 = await post({ session_name: 'ledger1', session_id: sid, text: MENU(1) });
  assert.equal((await answer(r1.body.id)).body.state, 'answered');
  await post({ session_name: 'ledger1', session_id: sid, text: 'Continued.\nSTATUS: done' });
  await new Promise((x) => setTimeout(x, 150));
  const a = ledger().find((x) => x.session === 'mac:ledger1');
  assert.ok(a, 'a record for the answered stop'); assert.equal(a.by, 'remote-hook'); assert.equal(a.via, 'hook'); assert.equal(a.machine, 'mac-test'); assert.equal(a.class, 'menu_recommended'); assert.equal(a.resolution, 'answered');

  const sid2 = 'sid-ledger-bbbbbbbb';
  const r2 = await post({ session_name: 'ledger2', session_id: sid2, text: OWNER_MENU });
  assert.equal((await answer(r2.body.id)).body.state, 'none');
  await new Promise((x) => setTimeout(x, 1200));
  await post({ session_name: 'ledger2', session_id: sid2, text: 'Used disk.\nSTATUS: done', prompt_at: new Date(Date.now() - 400).toISOString() });
  await new Promise((x) => setTimeout(x, 150));
  const b = ledger().find((x) => x.session === 'mac:ledger2');
  assert.ok(b); assert.equal(b.by, 'owner'); assert.equal(b.via, 'mac'); assert.equal(b.class, 'owner_decision');
  assert.ok(b.wait_s >= 0 && b.wait_s <= 2, `the wait ends at the owner's prompt, not at the next stop (${b.wait_s})`);
});

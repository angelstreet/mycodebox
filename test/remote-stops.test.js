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
const { createRemoteStops, PREFIX, validateStop, stopText, slugName, HOOK_LOST } = await import('../remote-stops.js');

const REMOTE = 'tok-remote-0123456789abcdef';   // leak-scan: allow (fake test token)
const PLAIN = 'tok-plain-0123456789abcdef';     // leak-scan: allow (fake test token)
const leasesDir = path.join(stateDir, 'leases');
fs.mkdirSync(leasesDir, { recursive: true });
fs.writeFileSync(path.join(leasesDir, 'clients.json'), JSON.stringify({ clients: [
  { name: 'mac-a', sha256: hashToken(REMOTE), remote: true }, { name: 'plain', sha256: hashToken(PLAIN) },
] }));

const owner = [];   // onOwnerNeeded calls
const remote = createRemoteStops({ manager, dir: leasesDir, stateDir, graceMs: 1500, pollWaitMs: 600 });
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
  const NM = r.body.session;
  assert.equal(r.status, 200); assert.match(NM, /^mac:owner-menu-sid-\d+$/, 'the title plus a fragment of the session id'); assert.equal(r.body.answerable, true);
  const a = await answer(r.body.id);
  assert.equal(a.body.state, 'none'); assert.match(a.body.reason, /owner/);
  const rec = stalls().find((s) => s.type === 'stall' && s.session === NM);
  assert.ok(rec, 'journalled in stalls.jsonl'); assert.equal(rec.case, 'owner_decision'); assert.equal(rec.textSource, 'reporter');
  assert.ok(owner.some((o) => o.session === NM), 'needs-you push');
  const row = remote.statusRows()[NM];
  assert.equal(row.state, 'done'); assert.equal(row.remote.machine, 'mac-test'); assert.equal(row.stall.case, 'owner_decision'); assert.equal(row.stall.options.length, 2);
});

test('a menu with a recommended option is answered after the countdown and the answer rides the long-poll', async () => {
  const t0 = Date.now();
  const r = await post({ session_name: 'rec-menu', text: MENU(1) });
  const NM = r.body.session;
  const a = await answer(r.body.id);
  assert.equal(a.body.state, 'answered', JSON.stringify(a.body));
  assert.match(a.body.answer, /option 1|recommendation/i);
  assert.ok(Date.now() - t0 >= 200, 'the cancel window (countdown) was honoured');
  await new Promise((x) => setTimeout(x, 100));   // the journal line is written just after the send
  assert.ok(stalls().some((s) => s.type === 'answer' && s.session === NM), 'journalled as an answer');
});

test('cancelling the countdown on the dashboard resolves the long-poll with no answer', async () => {
  await manager.setManagerConfig({ delayMs: 3000 });
  const r = await post({ session_name: 'cancel-me', text: MENU(2) });
  const p = answer(r.body.id);
  await new Promise((x) => setTimeout(x, 150));
  assert.equal(manager.cancelAuto(r.body.session), true);
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
  assert.ok(owner.length > before && owner.at(-1).session === r.body.session);
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
  assert.ok(owner.some((o) => o.session === r.body.session));
});

test('p1: a hook that polls once and stops gets an owner escalation, never a silent "answered"', async () => {
  await manager.setManagerConfig({ delayMs: 1500 });
  fs.writeFileSync(path.join(stateDir, 'remote.json'), JSON.stringify({ waitS: 20 }));
  const before = owner.length, answersBefore = stalls().filter((x) => x.type === 'answer').length;
  const r = await post({ session_name: 'p1-gone', text: MENU(1) });
  assert.equal((await call('GET', `/stops/${r.body.id}/answer?wait=1`)).body.state, 'pending');   // one poll, then the hook is gone
  await new Promise((x) => setTimeout(x, 3500));
  const a = await call('GET', `/stops/${r.body.id}/answer`);
  assert.equal(a.body.state, 'none'); assert.equal(a.body.reason, HOOK_LOST);
  assert.ok(owner.slice(before).some((o) => o.session === r.body.session && o.reason === HOOK_LOST), 'the owner is told: ' + JSON.stringify(owner.slice(before)));
  assert.equal(stalls().filter((x) => x.type === 'answer').length, answersBefore, 'no answer was recorded as sent');
  assert.ok(stalls().some((x) => x.type === 'answer_cancelled' && x.session === r.body.session && x.reason.includes(HOOK_LOST)), 'journalled, not cancelled quietly');
  await manager.setManagerConfig({ delayMs: 250 });
  fs.writeFileSync(path.join(stateDir, 'remote.json'), JSON.stringify({ waitS: 10 }));
});

test('a poll whose connection closes means the hook stopped waiting: the pending answer goes to the owner', async () => {
  await manager.setManagerConfig({ delayMs: 900 });
  const before = owner.length;
  const r = await post({ session_name: 'closed-poll', text: MENU(2) });
  const ac = new AbortController();
  const p = fetch(`${base}/stops/${r.body.id}/answer?wait=8`, { headers: { authorization: `Bearer ${REMOTE}` }, signal: ac.signal }).catch(() => null);
  await new Promise((x) => setTimeout(x, 200));
  ac.abort(); await p;
  await new Promise((x) => setTimeout(x, 400));
  assert.ok(owner.slice(before).some((o) => o.session === r.body.session && o.reason === HOOK_LOST), JSON.stringify(owner.slice(before)));
  assert.equal((await call('GET', `/stops/${r.body.id}/answer`)).body.state, 'none');
  await manager.setManagerConfig({ delayMs: 250 });
});

test('the countdown is capped by the hook deadline minus a margin; no time left escalates at once', async () => {
  await manager.setManagerConfig({ delayMs: 30000 });
  fs.writeFileSync(path.join(stateDir, 'remote.json'), JSON.stringify({ waitS: 6 }));   // deadline 6 s, margin 5 s: about 1 s of countdown
  const t0 = Date.now();
  const r = await post({ session_name: 'capped-wait', text: MENU(1) });
  const a = await answer(r.body.id, 6);
  assert.equal(a.body.state, 'answered'); assert.ok(Date.now() - t0 < 2500, `answered in ${Date.now() - t0} ms`);
  fs.writeFileSync(path.join(stateDir, 'remote.json'), JSON.stringify({ waitS: 4 }));   // 4 s - 5 s margin: no time at all
  const before = owner.length;
  const r2 = await post({ session_name: 'no-time', text: MENU(1) });
  assert.equal((await answer(r2.body.id, 3)).body.state, 'none');
  assert.ok(owner.slice(before).some((o) => o.session === r2.body.session && o.reason === HOOK_LOST));
  await manager.setManagerConfig({ delayMs: 250 });
  fs.writeFileSync(path.join(stateDir, 'remote.json'), JSON.stringify({ waitS: 10 }));
});

test('overlapping stops of one session: each hook call acts on its own stop only', async () => {
  const sid = 'sid-over-aaaaaaaa';
  await manager.setManagerConfig({ delayMs: 400 });
  const r1 = await post({ session_name: 'overlap', session_id: sid, text: MENU(1) });
  const p1 = answer(r1.body.id, 6);
  await new Promise((x) => setTimeout(x, 100));
  const r2 = await post({ session_name: 'overlap', session_id: sid, text: MENU(2).replace('storage', 'format') });   // a newer stop before the first countdown ended
  assert.equal(r1.body.session, r2.body.session);
  const [a1, a2] = [await p1, await answer(r2.body.id, 6)];
  assert.equal(a1.body.state, 'none', 'the first stop was superseded: its cancel resolves only itself');
  assert.equal(a2.body.state, 'answered', 'the second stop got its own answer');
  assert.match(a2.body.answer, /option 2|recommendation/i);
  const second = remote._sessions.get(r2.body.session);
  assert.equal(second.open.id, r2.body.id);
  await manager.setManagerConfig({ delayMs: 250 });
});

test('two Mac sessions with the same title do not share a row', async () => {
  const a = await post({ session_name: 'same-title', session_id: 'aaaaaa-111', text: 'x\nSTATUS: done' });
  const b = await post({ session_name: 'same-title', session_id: 'bbbbbb-222', text: 'y\nSTATUS: done' });
  assert.notEqual(a.body.session, b.body.session);
  const rows = remote.statusRows();
  assert.ok(rows[a.body.session] && rows[b.body.session]);
});

test('merge and push questions from a Mac session escalate (evaluated only for local sessions); a checkout does not change that', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-checkout-'));
  fs.writeFileSync(path.join(stateDir, 'remote.json'), JSON.stringify({ waitS: 10, checkouts: { 'co-proj': repo } }));
  for (const [title, text] of [['rm-merge', 'Tests: 120/120 pass on feat.\nShould I merge feat into main?'], ['rm-push', 'Tests: 120/120 pass on feat.\nShall I push feat to origin?']]) {
    const before = owner.length;
    const r = await post({ session_name: title, project: 'co-proj', text });
    assert.equal((await answer(r.body.id)).body.state, 'none');
    assert.ok(owner.slice(before).some((o) => o.session === r.body.session && /evaluated only for local sessions: the Mac's branch is not visible here/.test(o.reason)), JSON.stringify(owner.slice(before)));
  }
  fs.writeFileSync(path.join(stateDir, 'remote.json'), JSON.stringify({ waitS: 10 }));
});

test('intake slugs names instead of rejecting them, and the hook\'s dry-run output goes through validateStop', () => {
  const v = validateStop({ machine: "Jo's MacBook Pro", project: '[TASK72] fix', session_id: 'x', session_name: '_proj \u00e9t\u00e9 \u4e2d\u6587', text: 't' });
  assert.ok(v.ok);
  assert.equal(v.v.machine, 'Jo-s-MacBook-Pro'); assert.equal(v.v.project, 'TASK72-fix'); assert.equal(v.v.session_name, '_proj-ete');
  assert.equal(validateStop({ machine: '../etc', session_id: 'x', text: 't' }).v.machine, 'etc');
  assert.equal(validateStop({ machine: '\u4e2d\u6587', session_id: 'x', text: 't' }).v.machine, 'unknown-machine');
  assert.equal(slugName('', 'fb'), 'fb');
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
  const a = ledger().find((x) => x.session === 'mac:ledger1-sid-le');
  assert.ok(a, 'a record for the answered stop'); assert.equal(a.by, 'remote-hook'); assert.equal(a.via, 'hook'); assert.equal(a.machine, 'mac-test'); assert.equal(a.class, 'menu_recommended'); assert.equal(a.resolution, 'answered');

  const sid2 = 'sid-ledger-bbbbbbbb';
  const r2 = await post({ session_name: 'ledger2', session_id: sid2, text: OWNER_MENU });
  assert.equal((await answer(r2.body.id)).body.state, 'none');
  await new Promise((x) => setTimeout(x, 1200));
  await post({ session_name: 'ledger2', session_id: sid2, text: 'Used disk.\nSTATUS: done', prompt_at: new Date(Date.now() - 400).toISOString() });
  await new Promise((x) => setTimeout(x, 150));
  const b = ledger().find((x) => x.session === 'mac:ledger2-sid-le');
  assert.ok(b); assert.equal(b.by, 'owner'); assert.equal(b.via, 'mac'); assert.equal(b.class, 'owner_decision');
  assert.ok(b.wait_s >= 0 && b.wait_s <= 2, `the wait ends at the owner's prompt, not at the next stop (${b.wait_s})`);
});

// Archived in the Claude app -> removed / parked in ghosty (owner 2026-11-25): only the API's status `archived` acts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cseOf, parseList, archivedIds, macRowsToDrop, readToken, fetchAll, API_URL } from '../archive-sync.js';
import { titleSlug } from '../remote-stops.js';
import { autoParkArchived } from '../parking.js';
import { tmp } from './helpers-tmp.js';

const T0 = Date.parse('2026-11-25T15:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const item = (id, title, status, at = T0, extra = {}) => ({ id: `cse_${id}`, title, status, updated_at: iso(at), worker_status: 'idle', connection_status: 'disconnected', ...extra });
const row = (name, title, lastSeen = T0 - 600e3, rcUrl = null) => ({ name, titleKey: title ? titleSlug(title) : null, rcUrl, lastSeen });

test('cseOf maps the claude.ai URL, bridgeSessionId and the API id to one id', () => {
  assert.equal(cseOf('https://claude.ai/code/session_01P912Uu93FXPyqEtKQ5dSQN'), 'cse_01P912Uu93FXPyqEtKQ5dSQN');
  assert.equal(cseOf('session_01P912Uu93FXPyqEtKQ5dSQN'), 'cse_01P912Uu93FXPyqEtKQ5dSQN');
  assert.equal(cseOf('cse_01P912Uu93FXPyqEtKQ5dSQN'), 'cse_01P912Uu93FXPyqEtKQ5dSQN');
  for (const x of [null, '', 'https://claude.ai/code', 'mysession_x']) assert.equal(cseOf(x), null);
});

test('parseList keeps well-formed items only; archivedIds holds only status archived', () => {
  const l = parseList({ data: [item('AAAAAAAAAAAA', 'a', 'archived'), item('BBBBBBBBBBBB', 'b', 'active'), { id: 'x' }, null, { id: 'cse_CCCCCCCCCCCC', status: 'archived' }] });
  assert.deepEqual(l.map((x) => x.id), ['cse_AAAAAAAAAAAA', 'cse_BBBBBBBBBBBB', 'cse_CCCCCCCCCCCC']);
  assert.deepEqual([...archivedIds(l)], ['cse_AAAAAAAAAAAA', 'cse_CCCCCCCCCCCC']);
  assert.deepEqual(parseList(null), []);
});

test('a mac: row whose session is archived is dropped: by its Remote Control id, else by its title', () => {
  const list = parseList({ data: [item('AAAAAAAAAAAA', 'BLE remote panel and pairing handover', 'archived'), item('BBBBBBBBBBBB', 'Other', 'archived')] });
  const rows = [row('mac:BLE-remote-panel-and-pairing-handover-0ef772', 'BLE remote panel and pairing handover'),
    row('mac:renamed-111111', 'renamed locally', T0 - 600e3, 'https://claude.ai/code/session_BBBBBBBBBBBB')];
  assert.deepEqual(macRowsToDrop(rows, list), [
    { name: 'mac:BLE-remote-panel-and-pairing-handover-0ef772', id: 'cse_AAAAAAAAAAAA', by: 'title' },
    { name: 'mac:renamed-111111', id: 'cse_BBBBBBBBBBBB', by: 'id' }]);
});

test('nothing else triggers it: idle, done/completed, disconnected, usage limit, vanished from the list, no title', () => {
  const list = parseList({ data: [
    item('IDLE00000000', 'idle one', 'active'),
    item('DONE00000000', 'done one', 'active', T0, { external_metadata: { post_turn_summary: { status_category: 'completed' } } }),
    item('LIMIT0000000', 'limit one', 'active', T0, { external_metadata: { rate_limit_info: { status: 'rejected' } }, worker_status: 'requires_action' }),
    item('DISC00000000', 'disconnected one', 'active', T0, { connection_status: 'disconnected' }),
  ] });
  const rows = ['idle one', 'done one', 'limit one', 'disconnected one', 'vanished one'].map((t, i) => row(`mac:${titleSlug(t)}-00000${i}`, t));
  rows.push(row('mac:proj-abc123', null));
  assert.deepEqual(macRowsToDrop(rows, list), []);
  assert.deepEqual(macRowsToDrop(rows, []), [], 'an empty or failed list removes nothing');
});

test('an id the row carries decides alone: active id + archived same-titled session keeps the row', () => {
  const list = parseList({ data: [item('AAAAAAAAAAAA', 'Same', 'active'), item('BBBBBBBBBBBB', 'Same', 'archived')] });
  assert.deepEqual(macRowsToDrop([row('mac:Same-111111', 'Same', T0 - 600e3, 'https://claude.ai/code/session_AAAAAAAAAAAA')], list), []);
});

test('two sessions with one title: nothing until both are archived', () => {
  const one = parseList({ data: [item('AAAAAAAAAAAA', 'Badge tooltip removal', 'archived'), item('BBBBBBBBBBBB', 'Badge tooltip removal', 'active')] });
  const rows = [row('mac:Badge-tooltip-removal-ec58a3', 'Badge tooltip removal'), row('mac:Badge-tooltip-removal-337a19', 'Badge tooltip removal')];
  assert.deepEqual(macRowsToDrop(rows, one), []);
  const both = parseList({ data: [item('AAAAAAAAAAAA', 'Badge tooltip removal', 'archived'), item('BBBBBBBBBBBB', 'Badge tooltip removal', 'archived')] });
  assert.equal(macRowsToDrop(rows, both).length, 2);
});

test('a row that posted after the archive stays (unarchived, or a process that kept running)', () => {
  const list = parseList({ data: [item('AAAAAAAAAAAA', 'Kept running', 'archived', T0)] });
  assert.deepEqual(macRowsToDrop([row('mac:Kept-running-111111', 'Kept running', T0 + 5 * 60e3)], list), []);
  assert.equal(macRowsToDrop([row('mac:Kept-running-111111', 'Kept running', T0 + 30e3)], list).length, 1, 'within the margin: the stop that came with the archive');
});

test('readToken: missing, malformed or expiring credentials give null; the token is never refreshed', () => {
  const dir = tmp('archive-sync-');
  assert.equal(readToken(dir, T0), null);
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{bad');
  assert.equal(readToken(dir, T0), null);
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-token', expiresAt: T0 + 30e3 } }));
  assert.equal(readToken(dir, T0), null, 'expires within a minute');
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-token', expiresAt: T0 + 3600e3 } }));
  assert.equal(readToken(dir, T0), 'fake-token');
});

test('fetchAll: one GET per account with a token, union without duplicates, errors name the account and never the token', async () => {
  const dirs = ['a', 'b', 'c'].map((id) => { const d = tmp(`archive-sync-${id}-`); return { id, configDir: d }; });
  for (const [i, d] of dirs.slice(0, 2).entries()) fs.writeFileSync(path.join(d.configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `fake-${i}`, expiresAt: T0 + 3600e3 } }));
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    if (opts.headers.Authorization === 'Bearer fake-1') return { ok: false, status: 401 };
    return { ok: true, json: async () => ({ data: [item('AAAAAAAAAAAA', 'x', 'archived'), item('AAAAAAAAAAAA', 'x', 'archived')] }) };
  };
  const r = await fetchAll({ accounts: dirs, fetchImpl, now: T0 });
  assert.deepEqual(calls.map((c) => c.url), [API_URL, API_URL], 'the account without credentials is skipped');
  assert.equal(r.list.length, 1);
  assert.deepEqual(r.errors, ['b: HTTP 401']);
  assert.ok(!JSON.stringify(r).includes('fake-'));
});

test('autoParkArchived: a live bridge parks only when the API says archived; idle/done without it never parks', async () => {
  const parked = [];
  const pane = (name, bridge) => ({ name, claude: { pid: 1, info: { sessionId: `s-${name}`, bridgeSessionId: bridge, status: 'idle' } } });
  const archived = new Set(['cse_ARCHIVED0001']);
  const run = (panes) => autoParkArchived({
    panes, tailOf: async () => '', factsOf: async () => ({}), checks: () => [], seen: new Map(), notice: async () => {},
    park: async (n) => { parked.push(n); }, cloudArchived: (info) => archived.has(cseOf(info.bridgeSessionId)),
  });
  await run([pane('archived', 'session_ARCHIVED0001'), pane('idle-done', 'session_ACTIVE000001'), pane('no-bridge', null)]);
  assert.deepEqual(parked, ['archived']);
});

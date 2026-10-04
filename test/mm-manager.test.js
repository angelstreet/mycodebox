// Tests for the MiniMax shadow manager (TASK-47 G11, SHADOW only).
//   - compare.js pure functions on fixtures: agreement, miss, risky, audit, $-sums.
//   - mm-manager.sh --once --dry on a fixture events file: writes a prompt containing the events
//     and the rules, makes no network call (GHOSTY_PORT points at a closed port).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  realAction,
  hasForbiddenTopic,
  classifyAgreement,
  auditCheck,
  sumBuckets,
  buildReport,
  dayKey,
} from '../scripts/mm-manager-compare.js';

const DAY_MS = 86400000;
const T0 = new Date('2026-10-04T12:00:00Z').getTime();

const ev = (offset = 0) => ({ at: new Date(T0 + offset).toISOString(), key: 's1:asks', session: 's1', kind: 'asks' });
const send = (by, offset) => ({ type: 'send', at: new Date(T0 + offset).toISOString(), session: 's1', by });
const escalate = (offset) => ({ type: 'escalated', at: new Date(T0 + offset).toISOString(), session: 's1' });
const alertRec = (offset) => ({ type: 'alert', at: new Date(T0 + offset).toISOString(), session: 's1' });

// ---- realAction ----
test('realAction: a non-owner send within 15 min -> answer', () => {
  assert.equal(realAction({ at: ev(0).at, eventsForSession: [send('manager-agent', 60_000)] }), 'answer');
});
test('realAction: an escalated record within 15 min -> escalate', () => {
  assert.equal(realAction({ at: ev(0).at, eventsForSession: [escalate(60_000)] }), 'escalate');
});
test('realAction: a manager-agent alert within 15 min -> alert', () => {
  assert.equal(realAction({ at: ev(0).at, eventsForSession: [alertRec(60_000)] }), 'alert');
});
test('realAction: only an owner send -> owner', () => {
  assert.equal(realAction({ at: ev(0).at, eventsForSession: [send('owner', 60_000)] }), 'owner');
});
test('realAction: nothing within 15 min -> none', () => {
  assert.equal(realAction({ at: ev(0).at, eventsForSession: [send('owner', 30 * 60_000)] }), 'none');
});
test('realAction: mm-manager by is ignored (shadow never acts)', () => {
  assert.equal(realAction({ at: ev(0).at, eventsForSession: [send('mm-manager', 60_000)] }), 'none');
});

// ---- hasForbiddenTopic ----
test('hasForbiddenTopic: deploy in excerpt -> true', () => {
  assert.equal(hasForbiddenTopic({ excerpt: 'we should deploy now' }), true);
});
test('hasForbiddenTopic: clean excerpt -> false', () => {
  assert.equal(hasForbiddenTopic({ excerpt: 'continue with the refactor' }), false);
});
test('hasForbiddenTopic: missing -> false', () => {
  assert.equal(hasForbiddenTopic(null), false);
});

// ---- classifyAgreement ----
test('classifyAgreement: real=answer, mm=answer -> agree', () => {
  assert.equal(classifyAgreement({ mmProposal: { proposal: 'answer', reply: 'Yes, continue.' }, real: 'answer', stallRec: null }), 'agree');
});
test('classifyAgreement: real=owner, mm=none -> miss', () => {
  assert.equal(classifyAgreement({ mmProposal: { proposal: 'none' }, real: 'owner', stallRec: null }), 'miss');
});
test('classifyAgreement: real=answer, mm=escalate -> miss', () => {
  assert.equal(classifyAgreement({ mmProposal: { proposal: 'escalate' }, real: 'answer', stallRec: null }), 'miss');
});
test('classifyAgreement: mm=answer but forbidden topic -> needs a deny', () => {
  // The shadow should have escalated; a proposed "answer" with a forbidden topic is risky.
  const v = classifyAgreement({ mmProposal: { proposal: 'answer', reply: 'Deploying now.' }, real: 'none', stallRec: { excerpt: 'please deploy this' } });
  assert.equal(v, 'risky');
});
test('classifyAgreement: real=alert, mm=alert -> agree', () => {
  assert.equal(classifyAgreement({ mmProposal: { proposal: 'alert' }, real: 'alert', stallRec: null }), 'agree');
});
test('classifyAgreement: real=owner, mm=escalate -> agree', () => {
  assert.equal(classifyAgreement({ mmProposal: { proposal: 'escalate' }, real: 'owner', stallRec: null }), 'agree');
});

// ---- auditCheck ----
test('auditCheck: no mm-manager by -> empty', () => {
  assert.deepEqual(auditCheck([{ type: 'send', by: 'owner' }, { type: 'send', by: 'manager-agent' }]), []);
});
test('auditCheck: any by containing mm-manager -> hit', () => {
  const hits = auditCheck([{ type: 'send', by: 'mm-manager' }, { type: 'escalated', by: 'owner' }]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].type, 'send');
});

// ---- sumBuckets ----
test('sumBuckets: sums MiniMax tokens, sonnet $ from decisions, real-mgr $ from ledger', () => {
  const out = sumBuckets({
    mmTokens: { input: 100, output: 50, cache_read: 200 },
    sonnetRows: [{ sonnet_usd: 0.012 }, { sonnet_usd: 0.0034 }],
    realMgrLedger: [{ cost: { total: 1.234 } }, { cost: { total: 0.567 } }],
  });
  assert.deepEqual(out.mmTokens, { input: 100, output: 50, cache_read: 200 });
  assert.equal(out.sonnetCalls, 2);
  assert.equal(out.sonnetUsd, 0.015);   // 0.012 + 0.0034 -> 0.015 (3 dp)
  assert.equal(out.realMgrUsd, 1.801);  // 1.234 + 0.567 -> 1.801 (3 dp)
});

// ---- buildReport end-to-end ----
test('buildReport: aggregates per day, sonnet $, real-mgr $, AUDIT on mm-manager by', () => {
  const decisions = [
    { key: 's1:asks', at: ev(0).at, proposal: 'answer', reply: 'Yes, continue.', sonnet: true, sonnet_usd: 0.02, batch_id: 'b1', mm_tokens: { input: 100, output: 50, cache_read: 200 } },
    { key: 's2:holds', at: ev(60_000).at, proposal: 'none', sonnet: false, batch_id: 'b1', mm_tokens: { input: 100, output: 50, cache_read: 200 } },
  ];
  const events = [ev(0), { at: ev(60_000).at, key: 's2:holds', session: 's2', kind: 'hold' }];
  const stallRecs = [
    { type: 'stall', at: ev(0).at, session: 's1', case: 'continue', excerpt: 'Continue with the next step.' },
    { type: 'send', at: ev(60_000).at, session: 's1', by: 'manager-agent' },
    { type: 'stall', at: ev(60_000).at, session: 's2', case: 'owner_action', excerpt: 'plug in the box' },
    { type: 'send', at: new Date(T0 + 70_000).toISOString(), session: 's2', by: 'mm-manager' },  // AUDIT FAIL
  ];
  const ledger = [
    { id: 'mgr-1', agent: 'claude', label: 'manager', ts: T0, cost: { total: 0.42 } },
    { id: 'mgr-2', agent: 'claude', label: 'manager', ts: T0 + 1, cost: { total: 0.08 } },
  ];
  const managerCfg = { managerSessions: ['manager'] };

  const report = buildReport({ decisions, events, stallRecs, ledger, managerCfg });
  assert.equal(report.length, 1);
  const day = report[0];
  assert.equal(day.day, '2026-10-04');
  assert.equal(day.events, 2);
  assert.equal(day.proposals.answer, 1);
  assert.equal(day.proposals.none, 1);
  assert.equal(day.sonnetCalls, 1);
  assert.equal(day.sonnetUsd, 0.02);
  assert.equal(day.realMgrUsd, 0.5);
  assert.equal(day.audit.length, 1);   // the mm-manager send
  assert.equal(day.audit[0].type, 'send');
});

// ---- dayKey ----
test('dayKey: extracts YYYY-MM-DD in UTC', () => {
  assert.equal(dayKey('2026-10-04T23:59:59Z'), '2026-10-04');
  assert.equal(dayKey('not a date'), null);
});

// ---------------------------------------------------------------------------
// mm-manager.sh --once --dry: writes the prompt, makes no network call.
// ---------------------------------------------------------------------------
test('mm-manager.sh --once --dry writes a prompt with events + rules; tolerates a closed port', () => {
  const repo = join(import.meta.dirname, '..');
  const dir = mkdtempSync(join(tmpdir(), 'mm-mgr-'));
  const eventsFile = join(dir, 'events.jsonl');
  writeFileSync(eventsFile, [
    JSON.stringify({ at: '2026-10-04T12:00:00.000Z', key: 's1:asks', session: 's1', kind: 'asks' }),
    JSON.stringify({ at: '2026-10-04T12:00:30.000Z', key: 's2:holds', session: 's2', kind: 'hold' }),
  ].join('\n') + '\n');

  const stateDir = join(dir, 'state');
  // GHOSTY_PORT points at a closed port; the GET must fail and be tolerated with empty facts.
  const env = {
    ...process.env,
    GHOSTY_STATE_DIR: stateDir,
    GHOSTY_PORT: '1',           // closed (1 is a privileged port we never bind to in tests)
    BATCH_S: '5',
    PATH: process.env.PATH,
  };

  execFileSync('bash', [join(repo, 'scripts/mm-manager.sh'), '--once', eventsFile, '--dry'], {
    env,
    stdio: 'pipe',
    timeout: 30_000,
  });

  // A prompt file should exist (the most recent batch's prompt).
  const batchDir = join(stateDir, 'mm-manager');
  assert.ok(existsSync(batchDir), 'batch dir should exist');
  const files = readdirSync(batchDir);
  const prompts = files.filter((f) => f.endsWith('.prompt'));
  assert.equal(prompts.length, 1, 'exactly one prompt file');

  const text = readFileSync(join(batchDir, prompts[0]), 'utf8');
  assert.match(text, /SHADOW manager/i, 'prompt names the role');
  assert.match(text, /s1:asks/, 'prompt contains the first event key');
  assert.match(text, /s2:holds/, 'prompt contains the second event key');
  assert.match(text, /Decision table/i, 'prompt carries the decision table');

  // No decisions were appended (--dry skips mcode).
  const decLog = join(stateDir, 'mm-manager-decisions.jsonl');
  assert.ok(!existsSync(decLog), 'no decisions file in --dry mode');
});


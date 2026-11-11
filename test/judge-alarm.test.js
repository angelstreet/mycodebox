// Review 2026-11-11 item 2: judge-down alarm, tolerant JSON extraction, optional Claude fallback provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createJudgeAlarm } from '../judge-alarm.js';
import { extractJson, parseReviewerAnswer } from '../triage.js';
import { createFallbackDecider, parseChoice, FALLBACK_MODES } from '../minimax-fallback.js';
import { tmp } from './helpers-tmp.js';

test('alarm: one push per outage after 1 h of failures, per judge, re-armed by a good answer', () => {
  let t = 1e9; const pushes = [];
  const a = createJudgeAlarm({ push: (p) => pushes.push(p), now: () => t });
  a.fail('router', 'no OpenRouter credit'); t += 30 * 60e3; a.fail('router', 'no OpenRouter credit');
  assert.equal(pushes.length, 0);
  t += 31 * 60e3; a.fail('router', 'no OpenRouter credit'); a.fail('router', 'again');
  assert.equal(pushes.length, 1); assert.equal(pushes[0].kind, 'router'); assert.match(pushes[0].body, /credit/);
  a.fail('triage', 'answer is not JSON'); assert.equal(pushes.length, 1, 'triage has its own clock');
  a.ok('router'); a.fail('router', 'x'); t += 61 * 60e3; a.fail('router', 'x');
  assert.equal(pushes.length, 2, 'a new outage after a good answer alarms again');
});

test('alarm: state survives a restart (no second push for the same outage) and never throws', () => {
  const f = join(tmp('judge-alarm-'), 'a.json'); let t = 1e9; const pushes = [];
  const mk = () => createJudgeAlarm({ file: f, push: (p) => pushes.push(p), now: () => t });
  mk().fail('triage', 'x'); t += 2 * 3600e3; mk().fail('triage', 'x'); mk().fail('triage', 'x');
  assert.equal(pushes.length, 1);
  assert.doesNotThrow(() => createJudgeAlarm({ push: () => { throw new Error('boom'); }, now: () => t }).fail('x', 'y'));
});

test('extractJson: think blocks, fences, braces in prose, the keyed object wins', () => {
  const ans = '{"proposed_reply":"Yes, continue.","reasoning":"r","confidence":0.8,"owner_needed":false}';
  assert.equal(parseReviewerAnswer(`<think>maybe {"a":1} or {x}</think>\n${ans}`).ai.proposed_reply, 'Yes, continue.');
  assert.equal(parseReviewerAnswer('Reasoning: the format is {json}.\n```json\n' + ans + '\n```\nDone {ok}').ai.proposed_reply, 'Yes, continue.');
  assert.equal(parseReviewerAnswer(`<think>unclosed ${ans}`).error, 'answer is not JSON', 'an unclosed think block holds no answer');
  assert.equal(parseReviewerAnswer('I think you should continue.').error, 'answer is not JSON');
  assert.deepEqual(extractJson('{"owner_needed":true} then {"other":1}', ['owner_needed']), { owner_needed: true });
  assert.equal(parseChoice('<think>{"choice":"x"}</think> {"choice":"ask_owner","confidence":0.7}', ['continue', 'ask_owner']).choice, 'ask_owner');
});

test('claude provider: aiFallback "claude" is a mode; prompt on stdin, no tools, empty cwd, answer parsed', async () => {
  assert.ok(FALLBACK_MODES.includes('claude') && FALLBACK_MODES.includes('minimax'));
  const dir = tmp('claude-fb-'), log = join(dir, 'log.json'), bin = join(dir, 'claude');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('fs'); let inp = '';
process.stdin.on('data', (d) => { inp += d; }).on('end', () => {
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), inp, cwd: process.cwd(), leaked: Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET/.test(k)) }));
  console.log('<think>hmm {x}</think>{"proposed_reply":"Yes, continue.","reasoning":"ok","confidence":0.9,"owner_needed":false,"owner_needed_why":"","options":[]}');
});
`); chmodSync(bin, 0o755);
  const d = createFallbackDecider({ provider: 'claude', bin, env: { PATH: process.env.PATH, HOME: dir, JEV_API_KEY: 'must-not-leak' } });   // leak-scan: allow (fake value)
  const r = await d.reviewer({ facts: { session: 's', agent: 'claude', case: 'question', text: 'Continue?' } });
  assert.equal(r.ai.proposed_reply, 'Yes, continue.'); assert.equal(r.cost, 0); assert.match(r.model, /claude/);
  const seen = JSON.parse(readFileSync(log, 'utf8'));
  assert.match(seen.inp, /Continue\?/); assert.ok(seen.args.includes('-p') && seen.args.includes('--tools'));
  assert.deepEqual(seen.leaked, []); assert.ok(!existsSync(seen.cwd), 'temp cwd removed');
});

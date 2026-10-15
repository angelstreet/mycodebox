import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { render, rulesBody, BEGIN, END } from '../scripts/render-deploy-skill.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'render-deploy-skill.js');
const fixture = path.join(root, 'test', 'fixtures', 'sample-deploy-skill.md');
const rules = fs.readFileSync(path.join(root, 'docs', 'LEASE-RULES.md'), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'render-skill-'));

test('the lease rules say the required things, generically', () => {
  for (const s of ['--wait', 'vpt-lease run', 'never use `--force`', 'heartbeat', 'release', 'pin', 'observe', 'frontend', 'UNAVAILABLE', '`waiting` or `blocked`']) {
    assert.ok(rules.toLowerCase().includes(s.toLowerCase()), `rules mention ${s}`);
  }
  assert.doesNotMatch(rules, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|@|proxmox|node1/i);
});

test('render replaces only the marked section, keeps the rest, and is idempotent', () => {
  const skill = fs.readFileSync(fixture, 'utf8');
  const out = render(skill, rules);
  assert.ok(out.startsWith('---\nname: deploy'));
  assert.ok(out.includes('## After the deploy\n\nRecord the result.'));
  assert.doesNotMatch(out, /OLD LEASE TEXT/);
  assert.ok(out.includes(BEGIN) && out.includes(END));
  assert.match(out, /### What to claim/);          // headings nest under the skill's own
  assert.doesNotMatch(out, /^# Lease rules/m);
  assert.equal(render(out, rules), out);
  assert.ok(out.includes(rulesBody(rules)));
});

test('render refuses a skill without exactly one marker pair', () => {
  assert.throws(() => render('no markers', rules), /exactly one/);
  assert.throws(() => render(`${END}\n${BEGIN}`, rules), /exactly one/);
  assert.throws(() => render(`${BEGIN}\n${BEGIN}\n${END}`, rules), /exactly one/);
});

test('CLI: stdout by default, --out writes only that file, never the input', () => {
  const before = fs.readFileSync(fixture, 'utf8');
  let r = spawnSync('node', [script, '--in', fixture], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, render(before, rules));
  const outFile = path.join(tmp, 'rendered.md');
  r = spawnSync('node', [script, '--in', fixture, '--out', outFile], { encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
  assert.equal(fs.readFileSync(outFile, 'utf8'), render(before, rules));
  assert.equal(fs.readFileSync(fixture, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(tmp), ['rendered.md']);
  r = spawnSync('node', [script, '--in', fixture, '--out', fixture], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.equal(fs.readFileSync(fixture, 'utf8'), before);
  r = spawnSync('node', [script], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /usage/);
});

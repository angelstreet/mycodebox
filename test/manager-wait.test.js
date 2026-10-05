// manager-wait.sh cursor: events appended while the manager is "busy" (no wait running) are all delivered by the next call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';

const SH = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'manager-wait.sh');
const ev = (i, extra = {}) => JSON.stringify({ at: new Date(1e12 + i * 1000).toISOString(), key: `s${i}:asks`, kind: 'asks', session: `s${i}`, title: `t${i}`, body: `question ${i}`, ...extra }) + '\n';
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-mwait-'));
  mkdirSync(join(dir, 'manager-reports'));
  return { dir, events: join(dir, 'manager-events.jsonl'), cursor: join(dir, 'manager-reports', '.cursor'), env: { ...process.env, GHOSTY_STATE_DIR: dir, MANAGER_WAIT_POLL: '0.1', MANAGER_WAIT_GRACE: '0.5' } };
};
const run = (s) => spawnSync('bash', [SH], { env: s.env, encoding: 'utf8', timeout: 20000 });
const ids = (out) => out.split('\n').filter(Boolean).map((l) => JSON.parse(l).l.session);

test('first run starts at EOF: old events are not replayed, a new one is delivered', async () => {
  const s = setup();
  writeFileSync(s.events, ev(1) + ev(2));
  const p = spawn('bash', [SH], { env: s.env });
  let out = ''; p.stdout.on('data', (d) => { out += d; });
  await new Promise((r) => setTimeout(r, 800));
  appendFileSync(s.events, ev(3));
  await new Promise((r) => p.on('close', r));
  assert.deepEqual(ids(out), ['s3']);
  assert.equal(Number(readFileSync(s.cursor, 'utf8')), readFileSync(s.events).length);
});

test('events appended while busy are all delivered by the next call, then the cursor is at EOF', () => {
  const s = setup();
  writeFileSync(s.events, ev(1));
  writeFileSync(s.cursor, String(readFileSync(s.events).length) + '\n');
  appendFileSync(s.events, ev(2) + ev(3) + ev(4));                       // landed while no wait was running
  const r = run(s);
  assert.equal(r.status, 0);
  assert.deepEqual(ids(r.stdout), ['s2', 's3', 's4']);
  assert.equal(Number(readFileSync(s.cursor, 'utf8')), readFileSync(s.events).length);
});

test('routine deploy noise is filtered but the cursor still moves past it on delivery', () => {
  const s = setup();
  writeFileSync(s.cursor, '0\n');
  writeFileSync(s.events, ev(1, { kind: 'deploy', state: 'start', session: undefined }) + ev(2) + ev(3, { kind: 'deploy', state: 'failed', session: undefined }));
  const r = run(s);
  assert.deepEqual(r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l).l.key), ['s2:asks', 's3:asks']);
  assert.equal(Number(readFileSync(s.cursor, 'utf8')), readFileSync(s.events).length);
});

test('a partial last line is not consumed until complete', () => {
  const s = setup();
  writeFileSync(s.cursor, '0\n');
  const full = ev(5);
  writeFileSync(s.events, ev(1) + full.slice(0, 20));
  const r = run(s);
  assert.deepEqual(ids(r.stdout), ['s1']);
  assert.equal(Number(readFileSync(s.cursor, 'utf8')), ev(1).length);
});

test('custom filter-command argument keeps the legacy behaviour (no cursor)', () => {
  const s = setup();
  const r = spawnSync('bash', [SH, 'echo one; sleep 0.2; echo two; sleep 5'], { env: s.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'one\ntwo\n');
  assert.equal(existsSync(s.cursor), false);
});

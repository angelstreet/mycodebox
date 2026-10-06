// Cross-run dedupe for scripts/manager-event-filter.sh:
//   - asks / waiting / lease lines: deduped across runs within a 6-hour window (persisted in <state>/manager-reports/.seen-keys)
//   - deploy / hold / quota / disk / credits lines: per-run dedupe only (the awk array, as before)
//
// The filter reads JSONL lines on STDIN, runs them through jq selects, then dedupes via awk. We spawn the script with
// a temp GHOSTY_STATE_DIR and feed two separate runs of the same input to assert what is printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SH = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'manager-event-filter.sh');

const ev = (overrides) => JSON.stringify({ at: new Date(1e12).toISOString(), title: 't', body: '', ...overrides }) + '\n';
const asksLine   = ev({ key: 'web:asks',    kind: 'asks',    session: 'web', body: 'Should I deploy now?' });
const waitingLine= ev({ key: 'web:waiting', kind: 'waiting', session: 'web', body: 'Need approval' });
const leaseLine  = ev({ key: 'lease:narrowed', kind: 'lease', state: 'narrowed', body: 'shrunk' });
const deployLine = ev({ key: 'deploy:a:failed', kind: 'deploy', state: 'failed', body: 'crashed' });
const holdLine   = ev({ key: 'web:hold',    kind: 'hold',    session: 'web', body: 'paused' });

const run = (env, input) => spawnSync('bash', [SH], { env, input, encoding: 'utf8', timeout: 20000 });
const kinds = (r) => r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l).l.kind);
const seenPath = (dir) => join(dir, 'manager-reports', '.seen-keys');

test('cross-run dedupe: asks / waiting / lease are suppressed in run 2; deploy / hold keep per-run dedupe only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-filt-'));
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const input = asksLine + waitingLine + leaseLine + deployLine + holdLine;

  const r1 = run(env, input);
  assert.equal(r1.status, 0, r1.stderr);
  assert.deepEqual(kinds(r1).sort(), ['asks', 'deploy', 'hold', 'lease', 'waiting'], 'run 1 prints everything (deploy:failed passes the selects)');

  const r2 = run(env, input);
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(kinds(r2).sort(), ['deploy', 'hold'], 'run 2 prints only deploy + hold; asks / waiting / lease are deduped across runs');
});

test('seen-keys file: only cross-run kinds (asks / waiting / lease) are appended; per-run kinds (deploy / hold) are not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-filt-'));
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  run(env, asksLine + waitingLine + leaseLine + deployLine + holdLine);
  const lines = readFileSync(seenPath(dir), 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 3, 'asks + waiting + lease are persisted');
  const keys = lines.map((l) => l.split(' ').slice(1).join(' ')).sort();
  assert.deepEqual(keys, [
    'web|asks|ShouldIdeploynow?',
    'web|waiting|Needapproval',
    '|lease|shrunk',
  ]);
});

test('seen-keys: entries older than 6 h are pruned on startup, so the same asks line prints again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-filt-'));
  mkdirSync(join(dir, 'manager-reports'), { recursive: true });
  const seven_h_ago = Math.floor(Date.now() / 1000) - 7 * 3600;
  writeFileSync(seenPath(dir), `${seven_h_ago} web|asks|ShouldIdeploynow?\n`);
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const r = run(env, asksLine);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(kinds(r), ['asks'], 'entry older than 6 h was pruned, so the asks line prints again');
});

test('seen-keys: an entry within the 6 h window is kept and suppresses the same asks line in a later run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-filt-'));
  mkdirSync(join(dir, 'manager-reports'), { recursive: true });
  const one_h_ago = Math.floor(Date.now() / 1000) - 3600;
  writeFileSync(seenPath(dir), `${one_h_ago} web|asks|ShouldIdeploynow?\n`);
  const env = { ...process.env, GHOSTY_STATE_DIR: dir };
  const r = run(env, asksLine);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(kinds(r), [], 'recent entry suppresses the same asks line');
  // after the run, the entry is still there (within the window)
  const lines = readFileSync(seenPath(dir), 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
});
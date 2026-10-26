import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// ---- harness ----
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CLI = join(REPO_ROOT, 'scripts', 'jev-ask.js');

// Spawn the CLI. Stdin is closed. Returns { code, stdout, stderr }.
function runCli(args, { env = {}, cwd = REPO_ROOT, stdin = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

// A small mock VPT server. Each test sets `handler` and `port` is 0.
function startMockServer(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        calls.push({ method: req.method, url: req.url, headers: req.headers, body });
        Promise.resolve(handler({ req, body, calls })).then((out) => {
          res.writeHead(out.status || 200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out.json || {}));
        }).catch(() => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{}');
        });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port, calls, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'jev-ask-'));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

// ---- help ----
test('jev-ask: --help prints usage with one example per point and exits 0', async () => {
  const { code, stdout } = await runCli(['--help']);
  assert.equal(code, 0);
  for (const p of ['wake', 'builder', 'reviewer', 'retry', 'stop', 'model', 'merge']) {
    assert.match(stdout, new RegExp(p), `help should mention point "${p}"`);
  }
  assert.match(stdout, /usage:/);
  assert.match(stdout, /stdout is exactly one JSON line/);
});

// ---- bad usage ----
test('jev-ask: unknown point exits 2 with stderr message', async () => {
  const { code, stdout, stderr } = await runCli(['nope', '--facts', '{}']);
  assert.equal(code, 2);
  assert.match(stderr, /unknown point: nope/);
  assert.equal(stdout, '');
});
test('jev-ask: missing --facts exits 2', async () => {
  const { code, stderr } = await runCli(['stop']);
  assert.equal(code, 2);
  assert.match(stderr, /--facts/);
});
test('jev-ask: unparsable facts JSON exits 2', async () => {
  const { code, stderr } = await runCli(['stop', '--facts', '{not json']);
  assert.equal(code, 2);
  assert.match(stderr, /could not parse facts/);
});
test('jev-ask: facts must be an object, not an array', async () => {
  const { code, stderr } = await runCli(['stop', '--facts', '[1,2,3]']);
  assert.equal(code, 2);
  assert.match(stderr, /JSON object/);
});

// ---- happy path: server up, Jev's pick wins at >= threshold ----
test('jev-ask: prints one JSON line and takes Jev pick at >= threshold', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jev-ask-'));
  const mock = await startMockServer(({ body }) => {
    const req = JSON.parse(body);
    assert.equal(req.usage, 'text.decision.manager');
    assert.equal(req.profile, 'jev');
    assert.equal(req.log, true);
    assert.equal(req.timeout_s, 20);
    assert.equal(req.refs.source, 'ghosty-manager-cli');
    return { status: 200, json: { success: true, decision_id: 'd-test-1', answers: { choice: { choice: 'answer', confidence: 0.92 } } } };
  });
  try {
    const env = { JEV_URL: `http://127.0.0.1:${mock.port}`, JEV_API_KEY: 'k-test', VPT_TEAM_ID: 't-test', GHOSTY_STATE_DIR: stateDir };
    const { code, stdout, stderr } = await runCli(['stop', '--facts', JSON.stringify({ session: 's1', agent: 'claude', case: 'owner_decision' })], { env });
    assert.equal(code, 0, `stderr: ${stderr}`);
    const lines = stdout.trim().split('\n');
    assert.equal(lines.length, 1, `stdout should be one JSON line, got: ${JSON.stringify(stdout)}`);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.point, 'stop');
    assert.equal(rec.pick, 'answer');
    assert.equal(rec.source, 'jev');
    assert.ok(Math.abs(rec.confidence - 0.92) < 1e-9);
    assert.equal(rec.decision_id, 'd-test-1');
    assert.equal(rec.ruleDefault, 'escalate');
    assert.deepEqual(rec.allowed.sort(), ['answer', 'escalate']);
    // X-API-Key was set, server never saw it (header asserted below).
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].headers['x-api-key'], 'k-test');
    assert.equal(mock.calls[0].headers['x-api-key'] !== 'never printed', true);

    // manager-asks.jsonl got one line
    const log = (await readFile(join(stateDir, 'manager-asks.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(log.length, 1);
    const lr = JSON.parse(log[0]);
    assert.equal(lr.point, 'stop');
    assert.equal(lr.pick, 'answer');
    assert.equal(lr.source, 'jev');
    assert.equal(lr.decision_id, 'd-test-1');
    assert.equal(lr.ruleDefault, 'escalate');
    assert.ok(lr.at);
  } finally { await mock.close(); await rm(stateDir, { recursive: true, force: true }); }
});

// ---- low confidence -> rule fallback ----
test('jev-ask: falls back to ruleDefault when Jev confidence < threshold', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jev-ask-'));
  const mock = await startMockServer(() => ({ status: 200, json: { success: true, decision_id: 'd-low', answers: { choice: { choice: 'answer', confidence: 0.4 } } } }));
  try {
    const env = { JEV_URL: `http://127.0.0.1:${mock.port}`, JEV_API_KEY: 'k', VPT_TEAM_ID: 't', GHOSTY_STATE_DIR: stateDir };
    const { code, stdout } = await runCli(['stop', '--threshold', '0.7', '--facts', JSON.stringify({ case: 'owner_decision' })], { env });
    assert.equal(code, 0);
    const rec = JSON.parse(stdout.trim());
    assert.equal(rec.pick, 'escalate');
    assert.equal(rec.source, 'rule');
    assert.equal(rec.ruleDefault, 'escalate');
    assert.equal(rec.decision_id, 'd-low');
  } finally { await mock.close(); await rm(stateDir, { recursive: true, force: true }); }
});

// ---- server down -> rule fallback, no crash ----
test('jev-ask: when the server is unreachable, falls back to ruleDefault', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jev-ask-'));
  const env = { JEV_URL: 'http://127.0.0.1:1', JEV_API_KEY: 'k', VPT_TEAM_ID: 't', GHOSTY_STATE_DIR: stateDir };
  const { code, stdout, stderr } = await runCli(['stop', '--facts', JSON.stringify({ case: 'owner_decision' })], { env });
  assert.equal(code, 0, `stderr: ${stderr}`);
  const rec = JSON.parse(stdout.trim());
  assert.equal(rec.pick, 'escalate');
  assert.equal(rec.source, 'error');
  assert.ok(rec.error, 'error text present');
  assert.equal(rec.decision_id, null);
  // still logged locally
  const log = (await readFile(join(stateDir, 'manager-asks.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(log.length, 1);
});
test('jev-ask: when JEV_URL is unset, falls back to ruleDefault without trying the network', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jev-ask-'));
  const env = { GHOSTY_STATE_DIR: stateDir, JEV_URL: '', JEV_API_KEY: '', VPT_TEAM_ID: '', GHOSTY_ENV_FILE: join(stateDir, 'none.env') };
  const { code, stdout } = await runCli(['stop', '--facts', JSON.stringify({ case: 'owner_decision' })], { env });
  assert.equal(code, 0);
  const rec = JSON.parse(stdout.trim());
  assert.equal(rec.pick, 'escalate');
  assert.equal(rec.source, 'rule');
});

// ---- forced floor makes no HTTP call ----
test('jev-ask: forced floor (permission case) makes no HTTP call', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jev-ask-'));
  const mock = await startMockServer(() => ({ status: 200, json: { success: true, answers: { choice: { choice: 'answer', confidence: 0.99 } } } }));
  try {
    const env = { JEV_URL: `http://127.0.0.1:${mock.port}`, JEV_API_KEY: 'k', VPT_TEAM_ID: 't', GHOSTY_STATE_DIR: stateDir };
    const { code, stdout } = await runCli(['stop', '--facts', JSON.stringify({ case: 'permission' })], { env });
    assert.equal(code, 0);
    const rec = JSON.parse(stdout.trim());
    assert.equal(rec.pick, 'escalate');
    assert.equal(rec.source, 'forced');
    assert.equal(rec.confidence, 1);
    assert.equal(mock.calls.length, 0, 'forced floor should not call the server');
  } finally { await mock.close(); await rm(stateDir, { recursive: true, force: true }); }
});

// ---- --facts-file path ----
test('jev-ask: --facts-file <path> reads JSON from the file', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jev-ask-'));
  const factsDir = await mkdtemp(join(tmpdir(), 'jev-ask-facts-'));
  const factsPath = join(factsDir, 'facts.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(factsPath, JSON.stringify({ case: 'owner_decision', session: 's1' }));
  const mock = await startMockServer(({ body }) => {
    const req = JSON.parse(body);
    assert.deepEqual(JSON.parse(req.state), { case: 'owner_decision', session: 's1' });
    return { status: 200, json: { success: true, decision_id: 'd-f', answers: { choice: { choice: 'answer', confidence: 0.95 } } } };
  });
  try {
    const env = { JEV_URL: `http://127.0.0.1:${mock.port}`, JEV_API_KEY: 'k', VPT_TEAM_ID: 't', GHOSTY_STATE_DIR: stateDir };
    const { code, stdout } = await runCli(['stop', '--facts-file', factsPath], { env });
    assert.equal(code, 0);
    const rec = JSON.parse(stdout.trim());
    assert.equal(rec.pick, 'answer');
    assert.equal(rec.source, 'jev');
  } finally { await mock.close(); await rm(stateDir, { recursive: true, force: true }); await rm(factsDir, { recursive: true, force: true }); }
});

// ---- stdin facts ----
test('jev-ask: --facts - reads JSON from stdin', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jev-ask-'));
  const mock = await startMockServer(() => ({ status: 200, json: { success: true, decision_id: 'd-s', answers: { choice: { choice: 'escalate', confidence: 0.99 } } } }));
  try {
    const env = { JEV_URL: `http://127.0.0.1:${mock.port}`, JEV_API_KEY: 'k', VPT_TEAM_ID: 't', GHOSTY_STATE_DIR: stateDir };
    const { code, stdout } = await runCli(['stop', '--facts', '-'], { env, stdin: JSON.stringify({ case: 'done' }) });
    assert.equal(code, 0);
    const rec = JSON.parse(stdout.trim());
    assert.equal(rec.pick, 'escalate');
    assert.equal(rec.source, 'jev');
  } finally { await mock.close(); await rm(stateDir, { recursive: true, force: true }); }
});

// ---- --task and --run ride on refs ----
test('jev-ask: --task and --run ride on refs.task and refs.run, logged in jsonl', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jev-ask-'));
  const seen = [];
  const mock = await startMockServer(({ body }) => {
    const req = JSON.parse(body);
    seen.push(req.refs);
    return { status: 200, json: { success: true, decision_id: 'd-tr', answers: { choice: { choice: 'answer', confidence: 0.9 } } } };
  });
  try {
    const env = { JEV_URL: `http://127.0.0.1:${mock.port}`, JEV_API_KEY: 'k', VPT_TEAM_ID: 't', GHOSTY_STATE_DIR: stateDir };
    const { code, stdout } = await runCli(['stop', '--facts', JSON.stringify({ case: 'owner_decision' }), '--task', 'should I deploy?', '--run', 'r-1'], { env });
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout.trim()).pick, 'answer');
    assert.equal(seen[0].task, 'should I deploy?');
    assert.equal(seen[0].run, 'r-1');
    const lr = JSON.parse((await readFile(join(stateDir, 'manager-asks.jsonl'), 'utf8')).trim().split('\n')[0]);
    assert.equal(lr.task, 'should I deploy?');
  } finally { await mock.close(); await rm(stateDir, { recursive: true, force: true }); }
});

// ---- API key never printed ----
test('jev-ask: never prints the API key, even on error', async () => {
  const KEY = 'super-secret-key-12345';
  const stateDir = await mkdtemp(join(tmpdir(), 'jev-ask-'));
  // server returns 500 -> still no key printed
  const mock = await startMockServer(() => ({ status: 500, json: { error: 'boom' } }));
  try {
    const env = { JEV_URL: `http://127.0.0.1:${mock.port}`, JEV_API_KEY: KEY, VPT_TEAM_ID: 't', GHOSTY_STATE_DIR: stateDir };
    const { stdout, stderr } = await runCli(['stop', '--facts', JSON.stringify({ case: 'owner_decision' })], { env });
    assert.ok(!stdout.includes(KEY), 'stdout must not include API key');
    assert.ok(!stderr.includes(KEY), 'stderr must not include API key');
  } finally { await mock.close(); await rm(stateDir, { recursive: true, force: true }); }
});

// ---- .env fallback ----
test('jev-ask: falls back to the .env file when env vars are missing', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jev-ask-'));
  const mock = await startMockServer(() => ({ status: 200, json: { success: true, decision_id: 'd-env', answers: { choice: { choice: 'answer', confidence: 0.95, probabilities: { answer: 0.95, escalate: 0.05 } } } } }));
  try {
    const envFile = join(stateDir, 'test.env');
    await writeFile(envFile, `# test\nJEV_URL=http://127.0.0.1:${mock.port}/server/ai/decide\nJEV_API_KEY=k\nVPT_TEAM_ID=t\n`);
    const env = { GHOSTY_STATE_DIR: stateDir, JEV_URL: '', JEV_API_KEY: '', VPT_TEAM_ID: '', GHOSTY_ENV_FILE: envFile };
    const { code, stdout } = await runCli(['stop', '--facts', JSON.stringify({ case: 'owner_decision' })], { env });
    assert.equal(code, 0);
    const rec = JSON.parse(stdout.trim());
    assert.equal(rec.pick, 'answer');
    assert.equal(rec.source, 'jev');
    assert.equal(rec.decision_id, 'd-env');
    const log = (await readFile(join(stateDir, 'manager-asks.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(log.length, 1);
  } finally { await mock.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('jev-ask: merge point forces escalate when the floor reasons are present, merges otherwise', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jev-ask-'));
  try {
    const env = { GHOSTY_STATE_DIR: stateDir, JEV_URL: '', JEV_API_KEY: '', GHOSTY_ENV_FILE: join(stateDir, 'none.env') };
    const a = await runCli(['merge', '--facts', JSON.stringify({ branch: 'b', floor_reasons: ['no green test report on the branch'] })], { env });
    assert.equal(a.code, 0, a.stderr);
    assert.equal(JSON.parse(a.stdout).pick, 'escalate');
    assert.equal(JSON.parse(a.stdout).source, 'forced');
    const b = await runCli(['merge', '--facts', JSON.stringify({ branch: 'b', floor_reasons: [] })], { env });
    assert.equal(JSON.parse(b.stdout).pick, 'merge');
    assert.equal(JSON.parse(b.stdout).source, 'rule');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

// ---- round 12 narrowing (2026-10-18, owner rule) -- the five representative cases via the stop point ----
// The stop point (router.js: text.decision.manager) checks STOP_FLOOR_TOPICS against facts.touches. Round 12 narrows
// the floor to money / customers / shared_data_delete / credentials / physical; migrations, generated secrets,
// merge/push, deploy/restart, infra config and tests/CI are manager items.
test('stop round 12 case 1: migration is a manager item, not in the floor (no touches -> answer)', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jev-ask-'));
  try {
    const env = { GHOSTY_STATE_DIR: stateDir, JEV_URL: '', JEV_API_KEY: '', GHOSTY_ENV_FILE: join(stateDir, 'none.env') };
    // "apply migration 0018 to Neon" arrives at the stop point as { case: 'owner_decision', touches: [] } because
    // the migration topic is NOT in STOP_FLOOR_TOPICS anymore. ruleDefault: case=owner_decision -> escalate.
    const { code, stdout } = await runCli(['stop', '--facts', JSON.stringify({ case: 'owner_decision', touches: [] })], { env });
    assert.equal(code, 0, code);
    // The rule default for owner_decision with no delegation is escalate; Jev may downgrade when recommended+reversible.
    // Without a Jev server, the rule default stands: escalate (the manager escalates because no delegation, no recommendation).
    const rec = JSON.parse(stdout);
    assert.equal(rec.pick, 'escalate', 'no touches, no delegation, no recommendation -> escalate');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('stop round 12 case 2: generated app secret is a manager item, not in the floor', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jev-ask-'));
  try {
    const env = { GHOSTY_STATE_DIR: stateDir, JEV_URL: '', JEV_API_KEY: '', GHOSTY_ENV_FILE: join(stateDir, 'none.env') };
    // "set CRON_SECRET (generate)" -> no touches (generated_secret is NOT in STOP_FLOOR_TOPICS).
    // With delegation + recommended+reversible, the rule default is answer: the manager takes it.
    const { code, stdout } = await runCli(['stop', '--facts', JSON.stringify({ case: 'owner_decision', touches: [], delegated: true })], { env });
    assert.equal(code, 0, code);
    assert.equal(JSON.parse(stdout).pick, 'answer', 'delegated stop with no touches -> manager answers');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('stop round 12 case 3: third-party credential rotation is an owner item (escalate)', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jev-ask-'));
  try {
    const env = { GHOSTY_STATE_DIR: stateDir, JEV_URL: '', JEV_API_KEY: '', GHOSTY_ENV_FILE: join(stateDir, 'none.env') };
    // "rotate the Stripe API key" -> touches=['credentials'] -> forced escalate.
    const { code, stdout } = await runCli(['stop', '--facts', JSON.stringify({ case: 'owner_decision', touches: ['credentials'] })], { env });
    assert.equal(code, 0, code);
    const rec = JSON.parse(stdout);
    assert.equal(rec.pick, 'escalate', 'touches credentials -> forced escalate');
    assert.equal(rec.source, 'forced');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('stop round 12 case 4: money / purchase is an owner item (escalate)', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jev-ask-'));
  try {
    const env = { GHOSTY_STATE_DIR: stateDir, JEV_URL: '', JEV_API_KEY: '', GHOSTY_ENV_FILE: join(stateDir, 'none.env') };
    // "buy a domain" -> touches=['money'] -> forced escalate.
    const { code, stdout } = await runCli(['stop', '--facts', JSON.stringify({ case: 'owner_decision', touches: ['money'] })], { env });
    assert.equal(code, 0, code);
    const rec = JSON.parse(stdout);
    assert.equal(rec.pick, 'escalate', 'touches money -> forced escalate');
    assert.equal(rec.source, 'forced');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('stop round 12 case 5: STATUS: needs-manager stops are manager items (no touches, delegated -> answer)', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jev-ask-'));
  try {
    const env = { GHOSTY_STATE_DIR: stateDir, JEV_URL: '', JEV_API_KEY: '', GHOSTY_ENV_FILE: join(stateDir, 'none.env') };
    // "STATUS: needs-manager: pick option 1 or 2" -> the agent addresses the manager directly. The stop point sees
    // an owner_decision with a menu. With a recommended+reversible option (delegated), the manager answers.
    const { code, stdout } = await runCli(['stop', '--facts', JSON.stringify({ case: 'owner_decision', touches: [], recommended: true, reversible: true })], { env });
    assert.equal(code, 0, code);
    assert.equal(JSON.parse(stdout).pick, 'answer', 'recommended+reversible -> manager answers');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('stop technical gate records yes for a scoped CI credential and no for a drone slot or floor item', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jev-ask-'));
  try {
    const env = { GHOSTY_STATE_DIR: stateDir, JEV_URL: '', JEV_API_KEY: '', GHOSTY_ENV_FILE: join(stateDir, 'none.env') };
    for (const [facts, expected] of [
      [{ touches: ['credentials'], purpose_scoped_credential: true, recommended: true, reversible: true }, 'yes'],
      [{ touches: ['physical'], recommended: true, reversible: true }, 'no'],
      [{ touches: ['money'], recommended: true, reversible: true }, 'no'],
      [{ touches: ['credentials'], purpose_scoped_credential: true, forbidden_topic: true, recommended: true, reversible: true }, 'no'],
    ]) {
      const out = await runCli(['stop', '--facts', JSON.stringify(facts)], { env });
      assert.equal(out.code, 0, out.stderr);
      assert.equal(JSON.parse(out.stdout).technical, expected);
    }
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

// ---- owner 2026-10-26: routine unit / safer / permission-fix changes are not floors ----
const stopPick = async (facts) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jev-ask-'));
  try {
    const env = { GHOSTY_STATE_DIR: stateDir, JEV_URL: '', JEV_API_KEY: '', GHOSTY_ENV_FILE: join(stateDir, 'none.env') };
    const { code, stdout } = await runCli(['stop', '--facts', JSON.stringify({ case: 'owner_decision', ...facts })], { env });
    assert.equal(code, 0);
    return JSON.parse(stdout);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
};

test('stop 2026-10-26: a routine unit / safer / permission-fix change with a rollback line is answered, not escalated', async () => {
  for (const facts of [
    { routine_change: 'unit', backup: true, rollback: true, touches: ['infra'] },
    { routine_change: 'safer', rollback: true, touches: ['migration'] },
    { routine_change: 'perm', rollback: true, contents_unread: true, touches: ['credentials'] },
  ]) {
    const rec = await stopPick(facts);
    assert.equal(rec.pick, 'answer', JSON.stringify(facts));
    assert.notEqual(rec.source, 'forced', JSON.stringify(facts));
  }
});

test('stop 2026-10-26: what is still a floor still forces escalate, routine or not', async () => {
  const routine = { routine_change: 'perm', rollback: true, contents_unread: true };
  for (const facts of [
    { ...routine, touches: ['credentials', 'money'] }, { ...routine, touches: ['customers'] }, { ...routine, touches: ['shared_data_delete'] },
    { ...routine, touches: ['destructive_migration'] }, { ...routine, touches: ['sudoers'] }, { ...routine, touches: ['history_rewrite'] },
    { ...routine, touches: ['physical'] },
    { ...routine, contents_unread: false, touches: ['credentials'] },                       // the contents may be read: credentials
    { routine_change: 'safer', rollback: true, touches: ['credentials'] },                  // credentials only excused for the perm class
    { routine_change: 'unit', backup: true, rollback: true, prod_host: true, touches: ['credentials'] },
    { routine_change: 'unit', backup: true, touches: ['credentials'] },                     // no rollback line
  ]) {
    const rec = await stopPick(facts);
    assert.equal(rec.pick, 'escalate', JSON.stringify(facts));
    assert.equal(rec.source, 'forced', JSON.stringify(facts));
  }
  // without the routine facts the rule default is unchanged
  assert.equal((await stopPick({ touches: ['infra'] })).pick, 'escalate');
});

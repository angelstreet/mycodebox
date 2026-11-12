// scripts/session-guard-hook.js: raw SQL writes, unchecked / lease-less vpt-* restarts, host-config saves without devices (owner 2026-11-11).
// Commands shaped like the ones of 2026-11-11, with fake host names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardCommand, sqlWrite, restartWithoutLease, hostConfigWithoutDevices } from '../scripts/session-guard-hook.js';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'session-guard-hook.js');
const lease = (id, resources, session, mode = 'exclusive') => ({ id, resources, session: `codebox:${session}`, agent: `codebox:${session}`, mode });

test('(a) psql writes are refused with the route to use; reads, local test databases and other tools pass', () => {
  const kpiWeb = `ssh jump "psql -h db.internal -U app -d platform -c \\"UPDATE navigation_edges SET kpi_references = '[]' WHERE id = 'e1'\\""`;
  const r = sqlWrite(kpiWeb);
  assert.equal(r.rule, 'sql');
  assert.match(r.why, /`UPDATE navigation_edges SET` through psql/);
  assert.match(r.why, /PUT route/);
  for (const c of ['psql -d platform -c "INSERT INTO t VALUES (1)"', 'psql -c "delete from devices where id=3"', 'echo "DROP TABLE x" | psql platform', 'psql -c "TRUNCATE kpi_results"', 'pgcli -e "ALTER TABLE x ADD c int"'])
    assert.ok(sqlWrite(c), c);
  assert.equal(sqlWrite('psql -d platform -c "SELECT * FROM navigation_edges WHERE id = 1"'), null);
  assert.equal(sqlWrite('psql -h localhost -d vpt_test -c "DELETE FROM t"'), null, 'a local test database');
  assert.equal(sqlWrite('grep -n "UPDATE x SET" migrations/*.sql'), null, 'no SQL client');
  assert.equal(sqlWrite("cat >> t.test.js <<'EOF'\nconst c = 'psql -c \"DELETE FROM t\"';\nEOF\nnode --test t.test.js"), null, 'psql only inside a heredoc that writes a file');
  assert.ok(sqlWrite("cat > upd.sql <<'EOF'\nupdate navigation_edges set a = 1 where id = 2;\nEOF\nssh jump \"psql -d platform\" < upd.sql"), 'kpi-web: the .sql heredoc fed to psql');
  assert.ok(sqlWrite('psql -d platform -f fix.sql', { readFile: () => 'BEGIN; UPDATE t SET a = 1; COMMIT;' }), 'a -f file is read');
  assert.equal(sqlWrite('psql -d platform -f q.sql', { readFile: () => 'SELECT 1;' }), null);
});

test('(b) a restart after an unchecked claim is refused (fp194-opus-status: BUSY claim, then restart)', () => {
  const c = 'vpt-lease claim node1-vpt/lab-host-m --kind host --agent fp194 ; ssh lab-host-m sudo systemctl restart vpt-host';
  const r = restartWithoutLease(c, { leases: [], session: 'fp194' });
  assert.equal(r.rule, 'restart');
  assert.match(r.why, /is not checked/);
  assert.match(r.why, /&&/);
  assert.ok(restartWithoutLease('vpt-lease claim e/h --kind host || true\nssh h sudo systemctl stop vpt-stream1', { leases: [] }));
  assert.equal(restartWithoutLease('vpt-lease claim e/lab-host-m --kind host --wait && ssh lab-host-m sudo systemctl restart vpt-host', { leases: [] }), null);
  assert.equal(restartWithoutLease('vpt-lease run e/lab-host-m --kind host -- ssh lab-host-m sudo systemctl restart vpt-host', { leases: [] }), null);
});

test('(b) a restart / stop on a host this session holds no lease on is refused; its own host or device lease passes', () => {
  const c = 'ssh lab-host-m sudo systemctl restart vpt-host';
  const r = restartWithoutLease(c, { leases: [lease('L1', ['lab-host-m/device5'], 'mi-tv-fix')], session: 'fp194' });
  assert.match(r.why, /holds no lease on lab-host-m/);
  assert.match(restartWithoutLease('ssh lab-host-m sudo systemctl stop vpt-stream2', { leases: [], session: 'x' }).why, /systemctl stop vpt-stream2/);
  assert.equal(restartWithoutLease(c, { leases: [lease('L2', ['lab-host-m'], 'fp194')], session: 'fp194' }), null);
  assert.equal(restartWithoutLease(c, { leases: [lease('L3', ['lab-host-m/device2'], 'fp194')], session: 'fp194' }), null);
  assert.equal(restartWithoutLease(c, { leases: [lease('L4', ['lab-host-m'], 'fp194', 'shared')], session: 'fp194' }) !== null, true, 'a shared lease is not ownership');
  assert.equal(restartWithoutLease(c, { leases: null, session: 'fp194' }), null, 'registry unreadable: fail open');
  assert.equal(restartWithoutLease('sudo systemctl restart vpt-host', { leases: [], session: 'x' }), null, 'no host named: not decided here');
  assert.equal(restartWithoutLease('ssh lab-host-m sudo systemctl status vpt-host', { leases: [] }), null);
  assert.equal(restartWithoutLease('ssh lab-host-m sudo systemctl restart nginx', { leases: [] }), null, 'not a vpt-* unit');
});

test('(c) host-config saves: empty or missing devices refused (web-kpi-unblock wiped DEVICE keys), a full body passes', () => {
  const url = 'http://127.0.0.1:5109/server/settings/host-config';
  const wipe = `curl -s -X POST ${url} -H 'content-type: application/json' -d '{"host_name":"lab-host-c","env":{"MONITOR_PROFILE":"pc_kpi"},"devices":{}}'`;
  assert.match(hostConfigWithoutDevices(wipe).why, /sends `devices` empty/);
  assert.match(hostConfigWithoutDevices(`curl -X POST http://h:6109/host/system/config -d '{"env":{"A":"1"}}'`).why, /no `devices` object/);
  assert.match(hostConfigWithoutDevices(`curl -X POST ${url} --data @-`).why, /stdin or an unreadable file/);
  assert.equal(hostConfigWithoutDevices(`curl -X POST ${url} -d '{"env":{"A":"1"},"devices":{"DEVICE1":{"name":"stb"}}}'`), null);
  assert.equal(hostConfigWithoutDevices(`curl -X POST ${url} -d @body.json`, { readFile: () => '{"devices":{"DEVICE1":{}}}' }), null);
  assert.ok(hostConfigWithoutDevices(`curl -X POST ${url} -d @body.json`, { readFile: () => '{"devices": {}}' }));
  assert.equal(hostConfigWithoutDevices(`curl -s ${url}`), null, 'a GET reads');
  assert.equal(hostConfigWithoutDevices(`curl -s -X POST http://127.0.0.1:7777/api/send/s -d '{"keys":"save it through /server/settings/host-config with devices:{}"}'`), null, 'a message that mentions the route');
  assert.ok(hostConfigWithoutDevices(`curl -s -X POST -d '{"devices":{}}' "$SERVER/server/settings/host-config"`), 'a $VAR-prefixed target');
});

test('guardCommand: override from the environment only, per rule or all; an override inside the command is refused', () => {
  const sql = 'psql -c "UPDATE t SET a=1"';
  assert.equal(guardCommand(sql).rule, 'sql');
  assert.equal(guardCommand(sql, { override: 'sql' }), null);
  assert.equal(guardCommand(sql, { override: 'restart' }).rule, 'sql');
  assert.equal(guardCommand(sql, { override: 'all' }), null);
  assert.equal(guardCommand(`GHOSTY_GUARD_OVERRIDE=sql ${sql}`).rule, 'override');
  assert.equal(guardCommand('ls -la'), null);
  let read = 0;
  guardCommand('git status', { leases: () => { read++; return []; } });
  assert.equal(read, 0, 'the lease registry is read only for a vpt-* restart / stop');
  assert.equal(guardCommand('ssh lab-host-m sudo systemctl restart vpt-host', { leases: () => [lease('L', ['lab-host-m'], 'other')], session: 'me' }).rule, 'restart');
});

test('hook: the PreToolUse JSON in, a deny decision out; a harmless command prints nothing', () => {
  const run = (command) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8', env: { ...process.env, GHOSTY_GUARD_OVERRIDE: '', PATH: '/nonexistent' } });
  const d = run('psql -c "DELETE FROM devices"');
  const o = JSON.parse(d.stdout);
  assert.equal(o.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(o.hookSpecificOutput.permissionDecisionReason, /^session-guard \(sql\)/);
  assert.equal(run('echo hi').stdout, '');
  assert.equal(run('ssh lab-host-m sudo systemctl restart vpt-host').stdout, '', 'no vpt-lease on PATH: fail open');
});

test('install-guard-hooks: adds one Bash entry next to kill-guard, idempotent; the hook is a no-op while the checkout lacks it', async () => {
  const { withGuard, hookCommand, MARK } = await import('../scripts/install-guard-hooks.js');
  const cur = { model: 'x', hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'python3 w.py' }] }, { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 ~/.claude/hooks/kill-guard.py' }] }] } };
  const a = withGuard(cur, '/srv/checkout/ghosty-sessions');
  assert.equal(a.changed, true);
  assert.equal(a.settings.model, 'x');
  const bash = a.settings.hooks.PreToolUse.find((e) => e.matcher === 'Bash').hooks;
  assert.equal(bash.length, 2);
  assert.match(bash[1].command, new RegExp(MARK));
  assert.equal(withGuard(a.settings, '/srv/checkout/ghosty-sessions').changed, false);
  assert.equal(cur.hooks.PreToolUse[1].hooks.length, 1, 'input not mutated');
  assert.equal(withGuard({}, '/c').settings.hooks.PreToolUse[0].matcher, 'Bash');
  const r = spawnSync('sh', ['-c', hookCommand('/nonexistent-checkout')], { input: '{"tool_input":{"command":"psql -c \\"DELETE FROM t\\""}}', encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
});

// ---- (d) the manager's own background commands (owner 2026-11-12, TASK-239 G6) ----
test('(d) the manager may run only its event wait and system waits in the background; other sessions are not concerned', () => {
  const m = { session: 'manager', managers: ['manager'], background: true };
  assert.equal(guardCommand('curl -s http://127.0.0.1:7777/api/alerts -d x', m)?.rule, 'manager-bg');
  assert.equal(guardCommand('echo "Re-arm the wait"; sleep 30', m)?.rule, 'manager-bg');
  assert.equal(guardCommand('~/ghosty-sessions/scripts/manager-wait.sh', m), null);
  assert.equal(guardCommand('until ~/ghosty-sessions/scripts/manager-wait.sh; rc=$?; [ $rc -ne 3 ]; do sleep 5; done', m), null);
  assert.equal(guardCommand('integrate wait int-1a2b', m), null);
  assert.equal(guardCommand('vpt-lease claim boxA/host --wait 600 --agent codebox:manager', m), null);
  assert.equal(guardCommand('curl -s http://127.0.0.1:7777/api/alerts -d x', { ...m, background: false }), null, 'a foreground command passes');
  assert.equal(guardCommand('curl -s http://127.0.0.1:7777/api/alerts -d x', { ...m, session: 'kpi-web' }), null, 'a worker session may run background jobs');
  assert.equal(guardCommand('curl -s http://x', { ...m, override: 'manager-bg' }), null, 'the owner override');
});

test('(b) real host names are vpt-* too; `ssh -p` / `user@` are read; text that only mentions a restart is not a restart (2026-11-12 replay)', () => {
  const S = 'systemctl';
  const none = { leases: [], session: 'kpi-web' };
  assert.match(restartWithoutLease(`ssh vpt-lab9 sudo ${S} stop vpt-stream1`, none).why, /holds no lease on vpt-lab9/, 'a vpt-* host is a host');
  assert.match(restartWithoutLease(`ssh -p 2222 -o BatchMode=yes ops@vpt-lab4 sudo ${S} restart vpt-host`, none).why, /holds no lease on vpt-lab4/);
  assert.match(restartWithoutLease(`ssh vpt-lab1 'sudo ${S} restart vpt-host vpt-monitor-img'`, none).why, /vpt-lab1/);
  assert.equal(restartWithoutLease(`ssh vpt-lab9 sudo ${S} restart vpt-kpi`, { leases: [lease('L', ['vpt-lab9/device50'], 'kpi-web')], session: 'kpi-web' }), null, 'own device lease on that host');
  assert.ok(restartWithoutLease(`ssh vpt-lab9 sudo ${S} restart vpt-kpi`, { leases: [lease('L', ['vpt-lab9/device50'], 'zap-restore')], session: 'kpi-web' }), 'another session\'s lease is not mine');
  assert.equal(restartWithoutLease(`found-bug --title "deploy left vpt-kpi old on vpt-lab9" --reason "ssh vpt-lab9 sudo ${S} restart vpt-kpi fixes it"`, none), null, 'a bug report');
  assert.equal(restartWithoutLease(`curl -s -X POST http://127.0.0.1:7777/api/send/s -d '{"keys":"then ssh vpt-lab9 sudo ${S} restart vpt-host"}'`, none), null, 'a message');
  assert.equal(restartWithoutLease(`cat > fix.sh <<'EOF'\nssh vpt-lab9 sudo ${S} restart vpt-host\nEOF\nchmod +x fix.sh`, none), null, 'a script being written');
});

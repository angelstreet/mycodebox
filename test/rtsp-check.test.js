// scripts/agent/rtsp_check.py + rtsp_replace.py (owner 2026-11-11: nightly RTSP check and replace). Fake ffprobe/ffmpeg,
// a fake vpt-lease and a fake host-config server: no network, no live state, no real credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHECK = path.resolve('scripts/agent/rtsp_check.py');
const REPLACE = path.resolve('scripts/agent/rtsp_replace.py');
const PW = 'sekret-pw-123';
const sh = (dir, name, body) => { const f = path.join(dir, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
const py = (file, args, env) => new Promise((res) => execFile('python3', ['-I', file, ...args], { env: { PATH: process.env.PATH, ...env }, timeout: 60000 },
  (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));

function fakes() {
  const dir = mkdtempSync(path.join(tmpdir(), 'rtsp-'));
  // url containing "dead": refuses; "novideo": no streams; "still": identical frames; else 12 moving frames
  const ffprobe = sh(dir, 'ffprobe', `for a; do u=$a; done\ncase "$u" in http*) for a; do [ "$a" = -rtsp_transport ] && { echo 'Option rtsp_transport not found' >&2; exit 1; }; done;; esac\ncase "$u" in *dead*) echo "$u: Connection refused" >&2; exit 1;; *novideo*) echo '{"streams":[]}';; *) echo '{"streams":[{"codec_name":"h264","width":640,"height":360}]}';; esac`);
  const ffmpeg = sh(dir, 'ffmpeg', `for a; do case "$a" in rtsp*) u=$a;; esac; done\necho '#format: frame checksums'\ncase "$u" in *still*) for i in 1 2 3 4; do echo "0, $i, $i, 1, 10, aaaa"; done;; *) for i in 1 2 3 4; do echo "0, $i, $i, 1, 10, m$i"; done;; esac`);
  return { dir, env: { RTSP_CHECK_FFPROBE: ffprobe, RTSP_CHECK_FFMPEG: ffmpeg } };
}

test('rtsp_check: ok, no_connect, no_video, frozen; exit code; credentials never printed', async () => {
  const { env } = fakes();
  const urls = [`rtsp://admin:${PW}@10.0.0.5/good`, `rtsp://admin:${PW}@10.0.0.5/dead`, 'rtsp://h/novideo', 'rtsp://h/still'];
  const r = await py(CHECK, ['--json', ...urls], env);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.streams.map((s) => s.status), ['ok', 'no_connect', 'no_video', 'frozen']);
  assert.equal(j.streams[0].codec, 'h264');
  assert.equal(j.streams[0].width, 640);
  assert.equal(r.code, 1);
  assert.ok(!r.stdout.includes(PW) && !r.stderr.includes(PW), 'password leaked');
  const t = await py(CHECK, [`rtsp://admin:${PW}@10.0.0.5/dead`], env);
  assert.ok(!t.stdout.includes(PW) && !t.stderr.includes(PW));
  assert.equal((await py(CHECK, ['rtsp://h/good'], env)).code, 0);
});

test('rtsp_check: a loopback source without an ssh alias is unverified, never ok', async () => {
  const { env } = fakes();
  const j = JSON.parse((await py(CHECK, ['--json', 'rtsp://127.0.0.1:8554/smoke'], env)).stdout);
  assert.equal(j.streams[0].status, 'unverified');
});

test('rtsp_check: --host probes a loopback source from that host (alias from RTSP_CHECK_SSH)', async () => {
  const { dir, env } = fakes();
  sh(dir, 'ssh', 'shift 5 2>/dev/null; eval "$*"'); // the probe runs locally instead of over ssh
  const E = { ...env, PATH: `${dir}:${process.env.PATH}`, RTSP_CHECK_SSH: 'h1=local' };
  const j = JSON.parse((await py(CHECK, ['--json', '--host', 'h1', 'rtsp://127.0.0.1:8554/smoke'], E)).stdout);
  assert.equal(j.streams[0].status, 'ok');
  assert.equal(j.streams[0].codec, 'h264');
  const bare = JSON.parse((await py(CHECK, ['--json', 'rtsp://127.0.0.1:8554/smoke'], E)).stdout);
  assert.equal(bare.streams[0].status, 'unverified'); // without --host only the host can reach it
  const alias = JSON.parse((await py(CHECK, ['--json', '--ssh', 'local', 'rtsp://127.0.0.1:8554/smoke'], E)).stdout);
  assert.equal(alias.streams[0].status, 'ok');
});

// ---- the replacement run ----
async function world({ devices, pool, leaseBusy = false, leaseMissing = false, brokenAfterSave = false }) {
  const { dir, env } = fakes();
  const posts = []; const restarts = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      const u = new URL(req.url, 'http://x'); const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      if (u.pathname === '/server/system/getAllHosts') return send({ hosts: [{ host_name: 'h1' }] });
      if (u.pathname === '/server/settings/host-config' && req.method === 'GET') return send({ host: { _stream_profile: 'x' }, devices });
      if (u.pathname === '/server/settings/host-config') {
        const body = JSON.parse(b); posts.push(body);
        for (const d of Object.keys(devices)) if (!(d in body.devices)) delete devices[d]; // the host deletes what the payload omits
        for (const [d, f] of Object.entries(body.devices)) devices[d] = { ...(devices[d] || {}), ...f };
        return send({ success: true });
      }
      if (u.pathname === '/server/system/controlHostService') { restarts.push(JSON.parse(b)); return send({ success: true }); }
      res.statusCode = 404; send({});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const state = mkdtempSync(path.join(tmpdir(), 'rtsp-state-'));
  const poolFile = path.join(dir, 'pool.json'); writeFileSync(poolFile, JSON.stringify(pool));
  if (!leaseMissing) sh(dir, 'vpt-lease', leaseBusy ? 'echo BUSY >&2; exit 1' : 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"');
  sh(dir, 'tok', 'echo tok');
  // leaseMissing: a PATH without any vpt-lease, so the run really cannot find the lease CLI
  const pathV = leaseMissing ? `${dir}:/usr/bin:/bin` : `${dir}:${process.env.PATH}`;
  const E = { ...env, PATH: pathV, GHOSTY_STATE_DIR: state, RTSP_POOL_FILE: poolFile, RTSP_CHECK_TOKEN_CMD: path.join(dir, 'tok'),
    RTSP_CHECK_SERVERS: `envA=http://127.0.0.1:${server.address().port}`, RTSP_SETTLE_SECONDS: '0', RTSP_CONFIRM_SECONDS: '0', RTSP_CHECK_SSH: 'h1=local', RTSP_LOOPBACK_HOSTS: 'h1' };
  // the ssh alias must not run ssh in tests: the probe goes through a fake ssh that runs the command locally
  sh(dir, 'ssh', 'shift 5 2>/dev/null; eval "$*"');
  return { E, state, posts, restarts, devices, close: () => server.close() };
}
const POOL = { maxReplacementsPerNight: 3, sources: [
  { id: 'smoke', kind: 'loopback', url: 'rtsp://127.0.0.1:8554/good-smoke', vetted: '2026-11-11', hostsEnv: 'RTSP_LOOPBACK_HOSTS' },
  { id: 'pub', kind: 'public', url: 'rtsp://test.example/dead-pub', vetted: null },
  { id: 'hlsgood', kind: 'public', url: 'https://cdn.example/good/test.m3u8', vetted: '2026-11-11' } ] };
const dev = (n, v) => ({ DEVICE_NAME: n, DEVICE_VIDEO: v, DEVICE_VIDEO_CAPTURE_PATH: `/c/${n}` });

test('run live: a dead public stream is replaced with the FULL devices payload; camera and healthy streams untouched', async () => {
  const w = await world({ pool: POOL, devices: {
    DEVICE1: dev('a', 'rtsp://test.example/dead-pub'), DEVICE2: dev('cam', `rtsp://admin:${PW}@192.0.2.9/dead`),
    DEVICE3: dev('ok', 'rtsp://test.example/dead-pub-not'.replace('dead-', 'good-')), DEVICE4: dev('hdmi', '/dev/stb4') } });
  w.devices.DEVICE3.DEVICE_VIDEO = 'rtsp://test.example/good-pub'; // healthy public (host in pool: public)
  const r = await py(REPLACE, ['--mode', 'live'], w.E);
  w.close();
  assert.equal(w.posts.length, 1, r.stdout + r.stderr);
  assert.deepEqual(Object.keys(w.posts[0].devices).sort(), ['DEVICE1', 'DEVICE2', 'DEVICE3', 'DEVICE4']); // never devices:{}
  assert.equal(w.devices.DEVICE1.DEVICE_VIDEO, 'rtsp://127.0.0.1:8554/good-smoke');
  assert.equal(w.devices.DEVICE2.DEVICE_VIDEO, `rtsp://admin:${PW}@192.0.2.9/dead`); // camera never replaced
  assert.equal(w.devices.DEVICE4.DEVICE_VIDEO, '/dev/stb4');
  assert.equal(w.restarts.length, 1);
  assert.equal(w.restarts[0].service, 'vpt-stream');
  assert.match(r.stdout, /camera down/);
  const dir = path.join(w.E.GHOSTY_STATE_DIR, 'rtsp-nightly');
  assert.equal(statSync(path.join(dir, 'backups', readdirSync(path.join(dir, 'backups'))[0])).mode & 0o777, 0o600);
  for (const f of ['journal.jsonl', ...readdirSync(dir).filter((x) => x.startsWith('report-'))]) assert.ok(!readFileSync(path.join(dir, f), 'utf8').includes(PW), `${f} leaked`);
  assert.match(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'), /"outcome": "replaced"/);
});

test('run dry (the default): reports what it would do and writes nothing', async () => {
  const w = await world({ pool: POOL, devices: { DEVICE1: dev('a', 'rtsp://test.example/dead-pub') } });
  const r = await py(REPLACE, [], w.E);
  w.close();
  assert.match(r.stdout, /dry: would replace with pool 'smoke'/);
  assert.equal(w.posts.length, 0);
  assert.equal(w.restarts.length, 0);
  assert.equal(w.devices.DEVICE1.DEVICE_VIDEO, 'rtsp://test.example/dead-pub');
});

test('the report says how many hosts were walked, so an empty night is readable', async () => {
  const w = await world({ pool: POOL, devices: { DEVICE1: dev('a', '/dev/stb1') } }); // no rtsp source anywhere
  const r = await py(REPLACE, [], w.E);
  const inv = JSON.parse((await py(CHECK, ['--json', '--inventory'], w.E)).stdout); // the check reports it too
  w.close();
  assert.match(r.stdout, /no stream devices found/);
  assert.match(r.stdout, /1 host\(s\) walked, 1 read/);
  assert.equal(inv.hosts.walked, 1);
  assert.equal(inv.hosts.read, 1);
  assert.equal(inv.streams.length, 0);
  const day = new Date().toISOString().slice(0, 10);
  const rep = JSON.parse(readFileSync(path.join(w.state, 'rtsp-nightly', `report-${day}.json`), 'utf8'));
  assert.equal(rep.hosts.walked, 1);
  assert.equal(rep.hosts.read, 1);
  assert.equal(rep.streams.length, 0);
});

test('run live: a BUSY lease never runs the command, nothing is touched', async () => {
  const w = await world({ pool: POOL, leaseBusy: true, devices: { DEVICE1: dev('a', 'rtsp://test.example/dead-pub') } });
  const r = await py(REPLACE, ['--mode', 'live'], w.E);
  w.close();
  assert.match(r.stdout, /lease not granted/);
  assert.equal(w.posts.length, 0);
});

test('run live: a missing lease command is reported, the night does not die on it', async () => {
  const w = await world({ pool: POOL, leaseMissing: true, devices: { DEVICE1: dev('a', 'rtsp://test.example/dead-pub') } });
  const r = await py(REPLACE, ['--mode', 'live'], w.E);
  w.close();
  assert.equal(r.code, 1, r.stdout + r.stderr); // the stream was not fixed: the night is not ok, but it reported
  assert.match(r.stdout, /lease command could not be run/);
  assert.equal(w.posts.length, 0);
  assert.equal(w.devices.DEVICE1.DEVICE_VIDEO, 'rtsp://test.example/dead-pub');
  assert.match(readFileSync(path.join(w.state, 'rtsp-nightly', 'journal.jsonl'), 'utf8'), /lease_not_available/);
});

test('run live: a replacement that does not play is rolled back to the backup (full payload again)', async () => {
  const w = await world({ pool: POOL, devices: { DEVICE1: dev('a', 'rtsp://test.example/dead-pub'), DEVICE2: dev('b', '/dev/stb2') } });
  // the pool source plays until the vpt-stream restart, then the fake ffprobe reports it gone (the restart creates a flip file)
  const probe = w.E.RTSP_CHECK_FFPROBE;
  writeFileSync(probe, `#!/bin/sh\nfor a; do u=$a; done\ncase "$u" in *dead*) exit 1;; esac\nif [ -e "${w.state}/flip" ]; then echo gone >&2; exit 1; fi\necho '{"streams":[{"codec_name":"h264","width":640,"height":360}]}'\n`);
  const push = w.restarts.push.bind(w.restarts);
  w.restarts.push = (x) => { writeFileSync(path.join(w.state, 'flip'), '1'); return push(x); };
  const r = await py(REPLACE, ['--mode', 'live'], w.E);
  w.close();
  assert.equal(w.posts.length, 2, r.stdout + r.stderr); // change, then rollback
  assert.deepEqual(Object.keys(w.posts[1].devices).sort(), ['DEVICE1', 'DEVICE2']);
  assert.equal(w.devices.DEVICE1.DEVICE_VIDEO, 'rtsp://test.example/dead-pub');
  assert.equal(w.devices.DEVICE2.DEVICE_VIDEO, '/dev/stb2');
  assert.match(readFileSync(path.join(w.state, 'rtsp-nightly', 'journal.jsonl'), 'utf8'), /rolled_back/);
});

test('scope: every rtsp_video device is checked; a dead HLS device gets a vetted HLS source, file / empty source are only reported', async () => {
  const w = await world({ pool: POOL, devices: {
    DEVICE1: { ...dev('tv', 'https://cdn.example/good/index.m3u8'), DEVICE_MODEL: 'rtsp_video' },
    DEVICE2: { ...dev('tv-dead', 'https://cdn.example/dead/index.m3u8'), DEVICE_MODEL: 'rtsp_video' },
    DEVICE3: { ...dev('loop', '/var/lib/vpt-movies/good.mp4'), DEVICE_MODEL: 'rtsp_video' },
    DEVICE4: { ...dev('empty', ''), DEVICE_MODEL: 'rtsp_video' },
    DEVICE5: dev('hdmi', '/dev/stb5') } });   // not rtsp_video, not rtsp: ignored
  const r = await py(REPLACE, ['--mode', 'live'], w.E);
  w.close();
  assert.match(r.stdout, /DEVICE1\s+hls\s+ok -> none/, r.stdout);
  assert.match(r.stdout, /DEVICE2\s+hls\s+no_connect -> replaced \(pool 'hlsgood'\)/, r.stdout);
  assert.equal(w.devices.DEVICE2.DEVICE_VIDEO, 'https://cdn.example/good/test.m3u8');
  assert.match(r.stdout, /DEVICE3\s+file\s+ok -> none/);
  assert.match(r.stdout, /DEVICE4\s+no_source\s+no_source -> report: no_source source not ok/);
  assert.ok(!/DEVICE5/.test(r.stdout));
  assert.equal(w.posts.length, 1); // only the dead HLS device; file / empty never
});

test('the pool file never holds credentials and only vetted entries are replacement candidates', () => {
  const pool = JSON.parse(readFileSync(path.resolve('config/rtsp-pool.json'), 'utf8'));
  for (const s of pool.sources) { assert.ok(!/\/\/[^/]*@/.test(s.url), `${s.id} has credentials`); assert.ok(['loopback', 'public'].includes(s.kind)); }
  assert.ok(pool.maxReplacementsPerNight <= 3);
  assert.ok(existsSync(path.resolve('scripts/agent/rtsp_replace.py')));
});

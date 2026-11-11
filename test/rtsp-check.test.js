// scripts/agent/rtsp_check.py + rtsp_replace.py (owner 2026-11-11: nightly RTSP check and replace). Fake ffprobe/ffmpeg,
// a fake vpt-lease and a fake host-config server: no network, no live state, no real credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
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
  const ffprobe = sh(dir, 'ffprobe', `case "$*" in *stream=index,codec_type*) for a; do f=$a; done; n=$(cat "$f" | tr -dc 0-9); n=\${n:-1}; for pass in program streams; do echo 0,video; i=1; while [ $i -le $n ]; do echo $i,audio; i=$((i+1)); done; done; exit 0;; esac
for a; do u=$a; done\ncase "$u" in http*) for a; do [ "$a" = -rtsp_transport ] && { echo 'Option rtsp_transport not found' >&2; exit 1; }; done;; esac\ncase "$u" in *dead*) echo "$u: Connection refused" >&2; exit 1;; *novideo*) echo '{"streams":[]}';; *) echo '{"streams":[{"codec_name":"h264","width":640,"height":360}]}';; esac`);
  const ffmpeg = sh(dir, 'ffmpeg', `case "$*" in *signalstats*) for a; do last=$a; done; inp=""; prev=""; for a; do [ "$prev" = -i ] && inp=$a; prev=$a; done
  if [ -f "$inp" ] && grep -q BLACK "$inp"; then echo "lavfi.signalstats.YHIGH=18.0" >&2; elif case "$inp" in *blacksrc*) true;; *) false;; esac; then echo "lavfi.signalstats.YHIGH=17.0" >&2; else echo "lavfi.signalstats.YHIGH=190.0" >&2; fi; exit 0;; esac
for a; do case "$a" in rtsp*|http*|file*|/*) u=$a;; esac; done\necho '#format: frame checksums'\ncase "$u" in *still*) for i in 1 2 3 4; do echo "0, $i, $i, 1, 10, aaaa"; done;; *) for i in 1 2 3 4; do echo "0, $i, $i, 1, 10, m$i"; done;; esac`);
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

test('rtsp_check: a file that opens on a black leader is ok, not frozen (the probe looks past the leader)', async () => {
  const { dir, env } = fakes();
  // "leader": the first window is identical frames (a black leader); after a seek the picture moves.
  // "still": identical frames whatever happens (a genuinely static file).
  // "short": a 30 s clip with the same leader: the seek must land inside it (past the leader, before the end).
  const ffprobe = sh(dir, 'ffprobe-leader', `u=""; dur=""; prev=""; for a; do case "$a" in -show_entries) dur=1;; esac; case "$a" in rtsp*|http*|file*|/*) u=$a;; esac; done\ncase "$u" in *short*) if [ -n "$dur" ]; then echo "30.000000"; else echo '{"streams":[{"codec_name":"h264","width":640,"height":360}]}'; fi;; *) echo '{"streams":[{"codec_name":"h264","width":640,"height":360}]}';; esac`);
  const ffmpeg = sh(dir, 'ffmpeg-leader', `u=""; seek=""; prev=""; for a; do if [ "$prev" = "-ss" ]; then seek="$a"; fi; case "$a" in rtsp*|http*|file*|/*) u=$a;; esac; prev="$a"; done\necho '#format: frame checksums'\ncase "$u" in *still*) for i in 1 2 3 4; do echo "0, $i, $i, 1, 10, aaaa"; done;; *short*) if [ -n "$seek" ] && [ "$seek" -le 15 ]; then for i in 1 2 3 4; do echo "0, $i, $i, 1, 10, m$i"; done; else for i in 1 2 3 4; do echo "0, $i, $i, 1, 10, lead"; done; fi;; *) if [ -n "$seek" ]; then for i in 1 2 3 4; do echo "0, $i, $i, 1, 10, m$i"; done; else for i in 1 2 3 4; do echo "0, $i, $i, 1, 10, lead"; done; fi;; esac`);
  sh(dir, 'ssh', 'shift 5 2>/dev/null; eval "$*"'); // the probe runs locally instead of over ssh
  const E = { ...env, PATH: `${dir}:${process.env.PATH}`, RTSP_CHECK_FFMPEG: ffmpeg, RTSP_CHECK_FFPROBE: ffprobe };
  const leader = JSON.parse((await py(CHECK, ['--json', '--ssh', 'local', '/var/lib/vpt-movies/leader.mp4'], E)).stdout);
  assert.equal(leader.streams[0].status, 'ok', 'a film with a black leader must not be called frozen');
  const still = JSON.parse((await py(CHECK, ['--json', '--ssh', 'local', '/var/lib/vpt-movies/still.mp4'], E)).stdout);
  assert.equal(still.streams[0].status, 'frozen', 'a file that never moves stays frozen');
  const short = JSON.parse((await py(CHECK, ['--json', '--ssh', 'local', '/var/lib/vpt-movies/short.mp4'], E)).stdout);
  assert.equal(short.streams[0].status, 'ok', 'a short clip with a leader: the seek must land inside the clip');
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
async function world({ devices, pool, leaseBusy = false, leaseMissing = false, leaseBusyFirst = false, brokenAfterSave = false, flaky502 = null, snapshots = {} }) {
  const { dir, env } = fakes();
  const posts = []; const restarts = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      const u = new URL(req.url, 'http://x'); const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      if (u.pathname === '/server/system/getAllHosts') {
        if (flaky502 && !flaky502.seen) { flaky502.seen = true; res.statusCode = 502; return send({}); } // one proxy blip
        return send({ hosts: [{ host_name: 'h1' }] });
      }
      if (u.pathname === '/server/settings/host-config' && req.method === 'GET') return send({ host: { _stream_profile: 'x' }, devices });
      if (u.pathname === '/server/settings/host-config') {
        const body = JSON.parse(b); posts.push(body);
        for (const d of Object.keys(devices)) if (!(d in body.devices)) delete devices[d]; // the host deletes what the payload omits
        for (const [d, f] of Object.entries(body.devices)) devices[d] = { ...(devices[d] || {}), ...f };
        return send({ success: true });
      }
      if (u.pathname === '/server/system/controlHostService') { restarts.push(JSON.parse(b)); return send({ success: true }); }
      const m = u.pathname.match(/^\/host\/([^/]+)\/stream\/([^/]+)\/thumbnails\/latest\.jpg$/);
      if (m) { // the tile's snapshot: snapshots[capture] = 'BLACK' | 'STALE' | 'MISSING', default a picture, fresh
        const kind = snapshots[m[2]] || 'PICTURE';
        if (kind === 'MISSING') { res.statusCode = 404; return res.end(); }
        if (kind.startsWith('MULTI')) return res.end('PICTURE'); // a fine snapshot; the stream is the problem
        res.setHeader('Last-Modified', new Date(Date.now() - (kind === 'STALE' ? 3600e3 : 1e3)).toUTCString());
        return res.end(kind === 'STALE' ? 'PICTURE' : kind);
      }
      const sg = u.pathname.match(/^\/host\/([^/]+)\/stream\/([^/]+)\/segments\/(.+)$/);
      if (sg) { // the stream the live player loads: MULTI4 = 4 audio tracks in its segments, else 1
        const n = (snapshots[sg[2]] || '').startsWith('MULTI') ? snapshots[sg[2]].slice(5) : '1';
        return res.end(sg[3] === 'output.m3u8' ? '#EXTM3U\n#EXTINF:0.4,\nsegment_1.ts\n' : `TS${n}`);
      }
      res.statusCode = 404; send({});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const state = mkdtempSync(path.join(tmpdir(), 'rtsp-state-'));
  const poolFile = path.join(dir, 'pool.json'); writeFileSync(poolFile, JSON.stringify(pool));
  if (!leaseMissing) sh(dir, 'vpt-lease', leaseBusy ? 'echo BUSY >&2; exit 1'
    // leaseBusyFirst: the host is busy for the first (short) wait and free for the end-of-night retry
    : leaseBusyFirst ? `d="${state}/lease-used"; [ -e "$d" ] || { : > "$d"; echo BUSY >&2; exit 1; }; while [ "$1" != "--" ]; do shift; done; shift; exec "$@"`
    : 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"');
  sh(dir, 'tok', 'echo tok');
  // leaseMissing: a PATH without any vpt-lease, so the run really cannot find the lease CLI
  const pathV = leaseMissing ? `${dir}:/usr/bin:/bin` : `${dir}:${process.env.PATH}`;
  const E = { ...env, PATH: pathV, GHOSTY_STATE_DIR: state, RTSP_POOL_FILE: poolFile, RTSP_CHECK_TOKEN_CMD: path.join(dir, 'tok'),
    RTSP_CHECK_SERVERS: `envA=http://127.0.0.1:${server.address().port}`, RTSP_SETTLE_SECONDS: '0', RTSP_CONFIRM_SECONDS: '0', RTSP_API_RETRY_SECONDS: '0', RTSP_BLACK_RESAMPLE_SECONDS: '0', RTSP_CHECK_SSH: 'h1=local', RTSP_LOOPBACK_HOSTS: 'h1' };
  // the ssh alias must not run ssh in tests: the probe goes through a fake ssh that runs the command locally
  sh(dir, 'ssh', 'shift 5 2>/dev/null; eval "$*"');
  return { E, state, posts, restarts, devices, close: () => server.close() };
}
const POOL = { maxReplacementsPerNight: 3, sources: [
  { id: 'smoke', kind: 'loopback', url: 'rtsp://127.0.0.1:8554/good-smoke', vetted: '2026-11-11', hostsEnv: 'RTSP_LOOPBACK_HOSTS' },
  { id: 'pub', kind: 'public', url: 'rtsp://test.example/dead-pub', vetted: null } ] };
const dev = (n, v) => ({ DEVICE_NAME: n, DEVICE_VIDEO: v, DEVICE_VIDEO_CAPTURE_PATH: `/var/www/html/stream/cap-${n.replace(/\W+/g, '')}` });

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
  assert.deepEqual(readdirSync(dir).filter((x) => x.startsWith('apply-')), [], 'no scratch files left in the state dir');
  for (const f of ['journal.jsonl', ...readdirSync(dir).filter((x) => x.startsWith('report-'))]) assert.ok(!readFileSync(path.join(dir, f), 'utf8').includes(PW), `${f} leaked`);
  assert.match(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'), /"outcome": "replaced"/);
});

test('run dry (the default): reports what it would do and writes nothing', async () => {
  const w = await world({ pool: POOL, devices: { DEVICE1: dev('a', 'rtsp://test.example/dead-pub') } });
  const r = await py(REPLACE, [], w.E);
  w.close();
  assert.match(r.stdout, /dry: would replace with 'pool smoke'/);
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

test('run live: a lease busy for the short wait is retried at the end of the night, so the stream is repaired', async () => {
  const w = await world({ pool: POOL, leaseBusyFirst: true, devices: { DEVICE1: dev('a', 'rtsp://test.example/dead-pub') } });
  const r = await py(REPLACE, ['--mode', 'live'], w.E);
  w.close();
  assert.match(r.stdout, /replaced \(replace: 'pool smoke'\)/, r.stdout + r.stderr);
  assert.equal(w.posts.length, 1, r.stdout + r.stderr);
  assert.equal(w.devices.DEVICE1.DEVICE_VIDEO, 'rtsp://127.0.0.1:8554/good-smoke');
  const j = readFileSync(path.join(w.state, 'rtsp-nightly', 'journal.jsonl'), 'utf8');
  assert.match(j, /"outcome": "lease_not_granted"/);  // the first attempt was refused
  assert.match(j, /"outcome": "replaced"/);           // the end-of-night retry got the lease
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

test('a dead HLS channel is restored (same channel, new URL) or replaced (same group, unused, renamed); file / empty only reported', async () => {
  const w = await world({ pool: POOL, devices: {
    DEVICE1: { ...dev('FR Music 2 — Used FM (720p)', 'https://cdn.example/good/used.m3u8'), DEVICE_MODEL: 'rtsp_video' },
    DEVICE2: { ...dev('FR News 2 — Dead News', 'https://cdn.example/manifest/AbCdEfGhIjKlMnOpQrStUv/dead.m3u8'), DEVICE_MODEL: 'rtsp_video' },
    DEVICE7: { ...dev('FR Music 3 — Gone Too FM', 'https://cdn.example/dead/gone2.m3u8'), DEVICE_MODEL: 'rtsp_video' },
    DEVICE3: { ...dev('loop', '/var/lib/vpt-movies/good.mp4'), DEVICE_MODEL: 'rtsp_video' },
    DEVICE4: { ...dev('empty', ''), DEVICE_MODEL: 'rtsp_video' },
    DEVICE5: dev('hdmi', '/dev/stb5'),   // not rtsp_video, not rtsp: ignored
    DEVICE6: { ...dev('FR Music 1 — Gone FM', 'https://cdn.example/dead/gone.m3u8'), DEVICE_MODEL: 'rtsp_video' } } });
  const dir = path.dirname(w.E.RTSP_POOL_FILE);
  const inf = (name, group, url, extra = '') => `#EXTINF:-1 tvg-id="${name.replace(/\W/g, '')}.fr" ${extra}group-title="${group}",${name}\n${url}\n`;
  writeFileSync(path.join(dir, 'up.m3u'), '#EXTM3U\n' + inf('Dead Newsroom French (720p)', 'News', 'https://cdn.example/master/AbCdEfGhIjKlMnOpQrStUv/good.m3u8'));
  writeFileSync(path.join(dir, 'repo.m3u'), '#EXTM3U\n' + inf('Gone FM (720p)', 'Music', 'https://cdn.example/dead/gone.m3u8') + inf('Gone Too FM (720p)', 'Music', 'https://cdn.example/dead/gone2.m3u8')
    + inf('Used FM (720p)', 'Music', 'https://cdn.example/good/used.m3u8')
    + inf('Needs UA FM (720p)', 'Music', 'https://cdn.example/good/ua.m3u8', 'http-user-agent="X" ')
    + inf('Other FM (720p)', 'Music', 'https://cdn.example/good/other.m3u8'));
  w.E.RTSP_CHANNEL_LISTS = `${path.join(dir, 'up.m3u')},${path.join(dir, 'repo.m3u')}`;
  const dry = await py(REPLACE, [], w.E);
  assert.match(dry.stdout, /DEVICE2\s+hls\s+no_connect -> dry: would restore with 'Dead Newsroom French'/, dry.stdout);
  assert.match(dry.stdout, /DEVICE6\s+hls\s+no_connect -> dry: would replace with 'Other FM' \(device renamed 'FR Music 1 — Other FM \(720p\)'\)/);
  assert.equal(w.posts.length, 0);
  const r = await py(REPLACE, ['--mode', 'live'], w.E);
  w.close();
  assert.match(r.stdout, /DEVICE2\s+hls\s+no_connect -> replaced \(restore: 'Dead Newsroom French'\)/, r.stdout);
  assert.equal(w.devices.DEVICE2.DEVICE_VIDEO, 'https://cdn.example/master/AbCdEfGhIjKlMnOpQrStUv/good.m3u8'); // found by the stream id, the name differs
  assert.equal(w.devices.DEVICE2.DEVICE_NAME, 'FR News 2 — Dead News');            // same channel: name kept
  assert.equal(w.devices.DEVICE6.DEVICE_VIDEO, 'https://cdn.example/good/other.m3u8', r.stdout); // not the one already used, not the UA one
  assert.equal(w.devices.DEVICE6.DEVICE_NAME, 'FR Music 1 — Other FM (720p)');
  // Other FM went to DEVICE6: DEVICE7 (same group) must not get it too; nothing else in the group plays
  assert.match(r.stdout, /DEVICE7\s+hls\s+no_connect -> report: no working same channel/, r.stdout);
  assert.equal(w.devices.DEVICE7.DEVICE_VIDEO, 'https://cdn.example/dead/gone2.m3u8');
  assert.match(r.stdout, /DEVICE3\s+file\s+ok -> none/);
  assert.match(r.stdout, /DEVICE4\s+no_source\s+no_source -> report/);
  assert.ok(!/DEVICE5/.test(r.stdout));
  assert.equal(w.posts.length, 2);
  for (const pst of w.posts) assert.equal(Object.keys(pst.devices).length, 7); // full payload every time
});

test('the pool file never holds credentials and only vetted entries are replacement candidates', () => {
  const pool = JSON.parse(readFileSync(path.resolve('config/rtsp-pool.json'), 'utf8'));
  for (const s of pool.sources) { assert.ok(!/\/\/[^/]*@/.test(s.url), `${s.id} has credentials`); assert.ok(['loopback', 'public'].includes(s.kind)); }
  assert.ok(pool.maxReplacementsPerNight <= 3);
  assert.ok(existsSync(path.resolve('scripts/agent/rtsp_replace.py')));
});

test('a stream that fails once but plays on the slower re-probe, or shows a frozen picture, is never changed', async () => {
  const w = await world({ pool: POOL, devices: {
    DEVICE1: { ...dev('FR Music 1 — Slow FM', 'https://cdn.example/slow/a.m3u8'), DEVICE_MODEL: 'rtsp_video' },
    DEVICE2: { ...dev('FR Music 2 — Still FM', 'https://cdn.example/still/b.m3u8'), DEVICE_MODEL: 'rtsp_video' } } });
  // "slow": fails the first probe only (a marker file per url)
  const probe = w.E.RTSP_CHECK_FFPROBE;
  writeFileSync(probe, `#!/bin/sh\nfor a; do u=$a; done\ncase "$u" in *slow*) m="${w.state}/slow-seen"; [ -e "$m" ] || { : > "$m"; exit 1; };; esac\necho '{"streams":[{"codec_name":"h264","width":640,"height":360}]}'\n`);
  const dir = path.dirname(w.E.RTSP_POOL_FILE);
  writeFileSync(path.join(dir, 'l.m3u'), '#EXTM3U\n#EXTINF:-1 group-title="Music",Other FM (720p)\nhttps://cdn.example/good/o.m3u8\n');
  w.E.RTSP_CHANNEL_LISTS = path.join(dir, 'l.m3u');
  const r = await py(REPLACE, ['--mode', 'live'], w.E);
  w.close();
  assert.match(r.stdout, /DEVICE1\s+hls\s+no_connect -> report: no_connect once, played on the re-probe/, r.stdout);
  assert.match(r.stdout, /DEVICE2\s+hls\s+frozen -> report: frozen picture confirmed/);
  assert.equal(w.posts.length, 0);
});

test('a 502 blip from the server is retried: the night still reads its hosts', async () => {
  const w = await world({ pool: POOL, flaky502: {}, devices: { DEVICE1: dev('a', 'rtsp://test.example/good-pub') } });
  const r = await py(REPLACE, [], w.E);
  w.close();
  assert.doesNotMatch(r.stdout, /ERROR/, r.stdout);
  assert.match(r.stdout, /1 streams/);
});

test('the tile snapshot is checked too: a black or stale host capture of a playing source is reported, never changed', async () => {
  const w = await world({ pool: POOL, snapshots: { 'cap-BFM2': 'BLACK', 'cap-Old': 'STALE', 'cap-Gone': 'MISSING' }, devices: {
    DEVICE1: { ...dev('BFM2', 'https://cdn.example/good/bfm2.m3u8'), DEVICE_MODEL: 'rtsp_video' },
    DEVICE2: { ...dev('Old', 'https://cdn.example/good/old.m3u8'), DEVICE_MODEL: 'rtsp_video' },
    DEVICE3: { ...dev('Gone', 'https://cdn.example/good/gone.m3u8'), DEVICE_MODEL: 'rtsp_video' },
    DEVICE4: { ...dev('Fine', 'https://cdn.example/good/fine.m3u8'), DEVICE_MODEL: 'rtsp_video' } } });
  const r = await py(REPLACE, ['--mode', 'live'], w.E);
  w.close();
  assert.match(r.stdout, /DEVICE1\s+hls\s+ok -> report: the source plays but the tile's snapshot is black: host capture side/, r.stdout);
  assert.match(r.stdout, /DEVICE2\s+hls\s+ok -> report: the source plays but the tile's snapshot is stale \(\d+ s old\)/);
  assert.match(r.stdout, /DEVICE3\s+hls\s+ok -> report: the source plays but the tile's snapshot is missing/);
  assert.match(r.stdout, /DEVICE4\s+hls\s+ok -> none\s+ok/);
  assert.match(r.stdout, /tile snapshots \(what the app shows\): \{"black": 1, "stale": 1, "missing": 1, "ok": 1\}; capture repairs: dry/);
  assert.equal(w.posts.length, 0);
});

test('a channel whose own picture is black: reported while capture checks are dry, repaired from the lists once live', async () => {
  const devices = () => ({ DEVICE1: { ...dev('FR News 1 — Dark News', 'https://cdn.example/good/blacksrc.m3u8'), DEVICE_MODEL: 'rtsp_video' } });
  const lists = (w) => { const d = path.dirname(w.E.RTSP_POOL_FILE); writeFileSync(path.join(d, 'l.m3u'),
    '#EXTM3U\n#EXTINF:-1 group-title="News",Dark News (720p)\nhttps://cdn.example/good/blacksrc.m3u8\n#EXTINF:-1 group-title="News",Bright News (720p)\nhttps://cdn.example/good/bright.m3u8\n');
    w.E.RTSP_CHANNEL_LISTS = path.join(d, 'l.m3u'); };
  let w = await world({ pool: POOL, snapshots: { 'cap-FRNews1DarkNews': 'BLACK' }, devices: devices() }); lists(w);
  let r = await py(REPLACE, ['--mode', 'live'], w.E);
  w.close();
  assert.match(r.stdout, /DEVICE1\s+hls\s+ok -> report: the channel's own picture is black .*capture checks are dry, nothing changed/, r.stdout);
  assert.equal(w.posts.length, 0);
  w = await world({ pool: POOL, snapshots: { 'cap-FRNews1DarkNews': 'BLACK' }, devices: devices() }); lists(w);
  mkdirSync(path.join(w.state, 'rtsp-nightly'), { recursive: true });
  writeFileSync(path.join(w.state, 'rtsp-nightly', 'capture-mode'), 'live\n');
  r = await py(REPLACE, ['--mode', 'live'], w.E);
  w.close();
  assert.match(r.stdout, /DEVICE1\s+hls\s+ok -> replaced \(replace: 'Bright News'\)/, r.stdout);
  assert.equal(w.devices.DEVICE1.DEVICE_VIDEO, 'https://cdn.example/good/bright.m3u8');
});

test('a host stream with several audio tracks (the browser player stays black) is reported', async () => {
  const w = await world({ pool: POOL, snapshots: { 'cap-BFM2': 'MULTI4' }, devices: {
    DEVICE1: { ...dev('BFM2', 'https://cdn.example/good/master.m3u8'), DEVICE_MODEL: 'rtsp_video' },
    DEVICE2: { ...dev('P2M', 'https://cdn.example/good/one.m3u8'), DEVICE_MODEL: 'rtsp_video' } } });
  const r = await py(REPLACE, ['--mode', 'live'], w.E);
  w.close();
  assert.match(r.stdout, /DEVICE1\s+hls\s+ok -> report: the source plays but the host stream has 4 audio tracks: the browser's live player cannot play it/, r.stdout);
  assert.match(r.stdout, /DEVICE2\s+hls\s+ok -> none\s+ok/);
  assert.equal(w.posts.length, 0);
});

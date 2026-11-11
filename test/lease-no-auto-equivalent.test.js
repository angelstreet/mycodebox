// Bug 2026-11-11 (fp194-opus-status): `vpt-lease run ... vpt-mf1/device3 --no-auto-equivalent` still moved to vpt-mf1/device2 and ran a
// command written for device3 on a device another session held. Real client + real service, in central mode AND central-through-ssh
// (a fake ssh runs the forwarded call locally): named / auto-equivalent / --any / --no-auto-equivalent, notice, env, literal refusal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createLeaseService } from '../lease-service.js';
import { createLeaseRoutes } from '../lease-routes.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CLIENT = path.join(ROOT, 'scripts', 'vpt-lease');
const tmp = fs.mkdtempSync(path.join(os.homedir(), 'vpt-lease-noeq-'));
const home = path.join(tmp, 'home'), bin = path.join(tmp, 'bin');
let server, base;

before(async () => {
  fs.mkdirSync(path.join(home, '.config', 'vpt-lease'), { recursive: true }); fs.mkdirSync(bin);
  const dir = path.join(tmp, 'state');
  const tok = spawnSync('node', [path.join(ROOT, 'scripts', 'lease-token.js'), 'add', 'm', '--dir', dir, '--owner'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(home, 'token'), tok + '\n', { mode: 0o600 });
  const service = createLeaseService({ dir, config: { envs: ['env-a'], inventory: { 'env-a': { mf: ['vpt-mf1/device2', 'vpt-mf1/device3'] } } } });
  const routes = createLeaseRoutes({ service, dir });
  server = http.createServer((req, res) => { routes.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }, () => { res.writeHead(500); res.end(); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(home, '.config', 'vpt-lease', 'config'), `VPT_LEASE_MODE=central\nVPT_LEASE_URL=${base}\nVPT_LEASE_TOKEN_FILE=${path.join(home, 'token')}\n`);
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n', { mode: 0o755 });   // fake ssh: run the forwarded call here
  fs.writeFileSync(path.join(tmp, 'remote'), `#!/bin/sh\nexec python3 -I ${CLIENT} "$@"\n`, { mode: 0o755 });
});
after(() => { server.closeAllConnections?.(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function vl(args, mode = 'central') {
  let child;
  const pr = new Promise((resolve) => {
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, LANG: 'C', VPT_LEASE_TEST_FAST: '1' };
    if (mode === 'ssh') Object.assign(env, { VPT_LEASE_MODE: 'central-through-ssh', VPT_LEASE_SSH_TARGET: '<registry-host>', VPT_LEASE_REMOTE_CMD: path.join(tmp, 'remote') });
    child = spawn('python3', ['-I', CLIENT, ...args], { env });
    let out = '', err = '';
    child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (err += c));
    child.stdin.end('');
    child.on('close', (code) => resolve({ code, out, err }));
  });
  pr.child = child;
  return pr;
}
const base_ = ['--kind', 'host'];
const hold = async (res, agent) => (await vl(['claim', 'env-a', res, '--agent', agent, ...base_])).out.trim().split('\n')[0];
const rel = (id) => vl(['release', id]);
const ECHO = ['sh', '-c', 'echo "got=$VPT_LEASE_RESOURCE dev=$VPT_LEASE_DEVICE host=$VPT_LEASE_HOST"'];

for (const mode of ['central', 'ssh']) {
  test(`${mode}: the exact bug: device3 held, device2 free, --no-auto-equivalent never gets device2 and the command never runs`, async () => {
    const h = await hold('vpt-mf1/device3', 'codebox:holder');
    const w = vl(['run', 'env-a', 'vpt-mf1/device3', '--no-auto-equivalent', '--agent', 'codebox:w', ...base_, '--', 'sh', '-c', 'echo RAN vpt-mf1/device3'], mode);
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(await Promise.race([w, new Promise((r) => setTimeout(() => r('waiting'), 50))]), 'waiting', 'it waits on device3, does not move');
    const l = (await vl(['list', 'env-a'])).out;
    assert.doesNotMatch(l, /LEASE.*codebox:w/, 'no lease for the waiter on device2');
    w.child.kill();
    await new Promise((r) => setTimeout(r, 400));
    await rel(h);
  });

  test(`${mode}: --no-auto-equivalent gets exactly the named device once it is free; env names it`, async () => {
    const h = await hold('vpt-mf1/device3', 'codebox:holder');
    const w = vl(['run', 'env-a', 'vpt-mf1/device3', '--no-auto-equivalent', '--agent', 'codebox:w', ...base_, '--', ...ECHO], mode);
    await new Promise((r) => setTimeout(r, 1500));
    await rel(h);
    const r = await w;
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /got=vpt-mf1\/device3 dev=device3 host=vpt-mf1/);
    assert.doesNotMatch(r.err, /SWITCHED|auto-equivalent:/);
  });

  test(`${mode}: named, free: runs on the named one, no notice`, async () => {
    const r = await vl(['run', 'env-a', 'vpt-mf1/device3', '--agent', 'codebox:w', ...base_, '--', ...ECHO], mode);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /got=vpt-mf1\/device3 dev=device3/);
    assert.doesNotMatch(r.err, /SWITCHED/);
  });

  test(`${mode}: auto-equivalent switch: the command gets the ACTUAL resource, with a stderr notice`, async () => {
    const h = await hold('vpt-mf1/device3', 'codebox:holder');
    const r = await vl(['run', 'env-a', 'vpt-mf1/device3', '--agent', 'codebox:w', ...base_, '--', ...ECHO], mode);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /got=vpt-mf1\/device2 dev=device2 host=vpt-mf1/);
    assert.match(r.err, /SWITCHED from vpt-mf1\/device3/);
    await rel(h);
  });

  test(`${mode}: a switch refuses a command naming the original device literally, unless --allow-switch`, async () => {
    const h = await hold('vpt-mf1/device3', 'codebox:holder');
    const cmd = ['sh', '-c', 'echo RAN vpt-mf1/device3'];
    const r = await vl(['run', 'env-a', 'vpt-mf1/device3', '--agent', 'codebox:w', ...base_, '--', ...cmd], mode);
    assert.equal(r.code, 8, r.err);
    assert.doesNotMatch(r.out, /RAN/);
    assert.match(r.err, /names vpt-mf1\/device3 literally/);
    const split = await vl(['run', 'env-a', 'vpt-mf1/device3', '--agent', 'codebox:w', ...base_, '--', 'sh', '-c', 'echo RAN vpt-mf1 --device device3'], mode);
    assert.equal(split.code, 8, 'host and device as separate words count as literal too');
    const ok = await vl(['run', 'env-a', 'vpt-mf1/device3', '--allow-switch', '--agent', 'codebox:w', ...base_, '--', ...cmd], mode);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /RAN vpt-mf1\/device3/);
    assert.match((await vl(['list', 'env-a'])).out, /codebox:holder/);
    assert.doesNotMatch((await vl(['list', 'env-a'])).out, /codebox:w/, 'the refused lease was released');
    await rel(h);
  });

  test(`${mode}: --any gets a free member and exports the actual one`, async () => {
    const h = await hold('vpt-mf1/device3', 'codebox:holder');
    const r = await vl(['run', 'env-a', '--any', 'mf', '--agent', 'codebox:w', ...base_, '--', ...ECHO], mode);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /got=vpt-mf1\/device2 dev=device2/);
    await rel(h);
  });
}

after(() => {});

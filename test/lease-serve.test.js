import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startLeaseServer } from '../scripts/lease-serve.js';
import { tmp } from './helpers-tmp.js';

test('standalone lease service: loopback listener, token required, same routes as the dashboard', async () => {
  const dir = tmp('lease-serve-');
  const token = execFileSync(process.execPath, ['scripts/lease-token.js', 'add', 'registry', '--dir', dir], { encoding: 'utf8' }).trim().split('\n')[0];
  const s = startLeaseServer({ dir, port: 0, log: { log() {}, error() {} } });
  try {
    const port = await s.ready;
    assert.equal(s.server.address().address, '127.0.0.1');
    const url = `http://127.0.0.1:${port}/api/lease/v1/list`;
    assert.equal((await fetch(url)).status, 401);
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
    assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);
  } finally { await s.close(); }
});

test('the shadow store can be seeded with the legacy leases (cut-over shadow window)', async () => {
  const dir = tmp('lease-serve-');
  const { createLeaseService } = await import('../lease-service.js');
  const svc = createLeaseService({ dir, config: {} });
  try {
    const row = { id: 'abc12345', env: 'env-a', resource: '*', agent: 'mac:x', purpose: 'p', kind: 'server', since: Math.floor(Date.now() / 1000) - 60, expires: Math.floor(Date.now() / 1000) + 3600 };
    const r = await svc.shadow.op('importLegacy', { leases: [row], deploys: [], owner: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal((await svc.shadow.op('list', {})).leases.length, 1);
    assert.equal((await svc.list({})).leases.length, 0, 'the real store is untouched');
  } finally { await svc.close(); }
});

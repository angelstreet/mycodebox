// The dashboard answers to the names of this box only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostAllow, hostNameOf } from '../host-allow.js';

test('hostNameOf drops the port and reads bracketed addresses', () => {
  assert.equal(hostNameOf('Box-A:7777'), 'box-a');
  assert.equal(hostNameOf('box-a'), 'box-a');
  assert.equal(hostNameOf('[::1]:7777'), '::1');
  assert.equal(hostNameOf('127.0.0.1:7443'), '127.0.0.1');
  assert.equal(hostNameOf('name.example.:80'), 'name.example');
  assert.equal(hostNameOf(''), '');
  assert.equal(hostNameOf(undefined), '');
});

test('names of this box are answered', () => {
  const h = createHostAllow({ env: { PUBLIC_URL: 'http://box-a.lab.example:7777', GHOSTY_ALLOWED_HOSTS: 'dash.example.org, Other.Example.org:8443' }, hostname: 'box-a.internal.example' });
  for (const host of ['127.0.0.1:7777', 'localhost:7777', '[::1]:7777', '100.64.0.9:7777', '192.168.0.5:7443', 'box-a:7777', 'box-a',
    'box-a.tail1234.ts.net', 'box-a.lab.example:7777', 'box-a.internal.example', 'dash.example.org', 'other.example.org:8443', '']) {
    assert.equal(h.allowed(host), true, host);
  }
});

test('any other dotted name is not answered', () => {
  const h = createHostAllow({ env: { PUBLIC_URL: 'http://box-a:7777' }, hostname: 'box-a' });
  for (const host of ['page.example.com:7777', 'box-a.example.com', 'ts.net.example.com', 'localhost.example.com:7777', '127.0.0.1.example.com']) {
    assert.equal(h.allowed(host), false, host);
  }
});

test('a token client is not judged by its Host; a browser-style request is', () => {
  const h = createHostAllow({ env: {}, hostname: 'box-a' });
  assert.equal(h.refuses({ headers: { host: 'page.example.com:7777' } }), true);
  assert.equal(h.refuses({ headers: { host: 'page.example.com:7777', authorization: 'Bearer dummy' } }), false);
  assert.equal(h.refuses({ headers: { host: 'box-a:7777' } }), false);
  assert.equal(h.refuses({ headers: {} }), false);
});

test('a bad PUBLIC_URL or an empty list adds nothing and does not throw', () => {
  const h = createHostAllow({ env: { PUBLIC_URL: 'not a url', GHOSTY_ALLOWED_HOSTS: ' , ' }, hostname: '' });
  assert.deepEqual(h.names(), []);
  assert.equal(h.allowed('page.example.com'), false);
});

// The manager's forbidden-topic list (stall.js) and policy.js's topic -> action-class map must stay in step:
// every phrasing the manager blocks maps to a concrete approval class, not only the generic forbidden_topic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { restrictedTopics } from '../orchestration/policy.js';

test('T02: every manager-blocked phrasing maps to a concrete approval class', () => {
  const cases = {
    'clean up: rm -rf the old state dir': 'destructive', 'wipe the cache': 'destructive', 'hard-reset the branch': 'destructive',
    'overwrite the config': 'destructive', 'refund the order': 'money', 'transfer the funds': 'money', 'charge the card on file': 'money',
    'email the client': 'customer', 'rotate the signing key': 'credentials', 'revoke the token': 'credentials',
    'apply the terraform plan': 'deploy', 'kill the production pods': 'deploy', 'redeploy staging': 'deploy',
    'publish the package to npm': 'push_shared', 'rebase onto main': 'merge_protected', 'restart ghosty': 'host_maintenance',
  };
  for (const [text, cls] of Object.entries(cases)) {
    const got = restrictedTopics(text).map((x) => x.class);
    assert.ok(got.includes(cls), `${text}: ${JSON.stringify(got)}`);
  }
});

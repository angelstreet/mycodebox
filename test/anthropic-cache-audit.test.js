import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/anthropic-cache-audit.py', import.meta.url));

test('the cache audit sums every cache-write kind and hides keys in errors', () => {
  const code = `
import importlib.util, json, sys
s = importlib.util.spec_from_file_location('a', sys.argv[1]); a = importlib.util.module_from_spec(s); s.loader.exec_module(a)
row = {'model': 'm', 'uncached_input_tokens': 1, 'cache_read_input_tokens': 2, 'output_tokens': 5,
       'cache_creation': {'ephemeral_5m_input_tokens': 3, 'ephemeral_1h_input_tokens': 4}}
got = a.summarise([{'results': [row]}, {'results': [row]}], lambda b, r: r['model'])
print(json.dumps([got['m'], a.clean('bad ' + '-'.join(['sk', 'ant', 'fake']))]))`;
  const out = JSON.parse(execFileSync('python3', ['-B', '-c', code, script], { encoding: 'utf8' }));
  assert.deepEqual(out, [[2, 4, 14, 10], 'bad ***']);
});

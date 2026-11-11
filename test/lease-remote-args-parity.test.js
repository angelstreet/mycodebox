// bug-72c433b4 (idea after the 2026-11-11 --no-auto-equivalent bug): every claim flag must be forwarded by remote_claim_args (ssh mode)
// or be listed here as client-side only, so the next flag cannot be silently dropped on the forwarded path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'vpt-lease'), 'utf8');
const body = (name) => {
  const lines = src.split('\n'); const i = lines.findIndex((l) => new RegExp(`^\\s*def ${name}\\(`).test(l)); assert.ok(i >= 0, name);
  const ind = lines[i].match(/^\s*/)[0].length; const out = [];
  for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].match(/^\s*/)[0].length > ind); j++) out.push(lines[j]);
  return out.join('\n');
};
// client-side only (never sent): --ticket is a different command mode, --on-fence / --allow-switch act on the local child, --auto-equivalent is the default
const LOCAL = new Set(['--ticket', '--on-fence', '--allow-switch', '--auto-equivalent', '--wait', '--json']);

test('remote_claim_args forwards every claim flag except the client-side ones', () => {
  const flags = [...body('claim_args').matchAll(/add_argument\("(--[a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(flags.length > 15, 'parsed the claim flags');
  const remote = body('remote_claim_args');
  const missing = flags.filter((f) => !LOCAL.has(f) && !remote.includes(`"${f}"`));
  assert.deepEqual(missing, [], 'claim flags not forwarded over ssh by remote_claim_args (add them or list as client-side)');
});

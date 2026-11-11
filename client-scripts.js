// The Mac/cloud client scripts (scripts/integrate, scripts/found-bug) served by the dashboard host so a client can update itself
// (`integrate self-update`, docs/MAC-HOOK.md). The files come from the running checkout; the version is the `CLIENT_SCRIPTS_VERSION=N`
// line both scripts carry (bump it on every change to either one; test/client-scripts.test.js keeps them equal).
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NAMES = ['integrate', 'found-bug'];
const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'scripts');
export const versionOf = (text) => Number(/^CLIENT_SCRIPTS_VERSION=(\d+)\b/m.exec(text)?.[1] || 0);

// -> { version, files: { name: { sha256, size, version } } }; throws when a script is missing
export function manifest(dir = DEFAULT_DIR) {
  const files = {}; let version = 0;
  for (const n of NAMES) {
    const buf = fs.readFileSync(join(dir, n));
    const v = versionOf(buf.toString('utf8'));
    files[n] = { sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length, version: v };
    version = Math.max(version, v);
  }
  return { version, files };
}
export const read = (name, dir = DEFAULT_DIR) => (NAMES.includes(name) ? fs.readFileSync(join(dir, name)) : null);

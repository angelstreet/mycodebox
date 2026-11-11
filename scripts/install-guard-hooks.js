#!/usr/bin/env node
// Install the codebox PreToolUse(Bash) guard (scripts/session-guard-hook.js) into a Claude settings file, next to kill-guard.py. Idempotent:
// an entry that already runs session-guard-hook.js is left alone. A backup <file>.bak-<stamp> is written before any change.
//   node scripts/install-guard-hooks.js [--settings ~/.claude/settings.json] [--checkout ~/ghosty-sessions] [--dry-run]
// The hook command runs the LIVE checkout's copy (updated by every deploy) and is a no-op while that copy does not exist yet, so the
// install is safe before the change is merged. The Mac is not touched (docs/MAC-HOOK.md "Guard hook").
import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MARK = 'session-guard-hook.js';
export const hookCommand = (checkout) => `sh -c 'f="${checkout}/scripts/${MARK}"; [ -f "$f" ] || exit 0; exec node "$f"'`;

// Pure. settings object -> { changed, settings }
export function withGuard(settings, checkout) {
  const s = settings && typeof settings === 'object' ? structuredClone(settings) : {};
  s.hooks ||= {};
  s.hooks.PreToolUse ||= [];
  const all = s.hooks.PreToolUse.flatMap((e) => e.hooks || []);
  if (all.some((h) => String(h.command || '').includes(MARK))) return { changed: false, settings: s };
  let bash = s.hooks.PreToolUse.find((e) => e.matcher === 'Bash');
  if (!bash) { bash = { matcher: 'Bash', hooks: [] }; s.hooks.PreToolUse.push(bash); }
  bash.hooks ||= [];
  bash.hooks.push({ type: 'command', command: hookCommand(checkout) });
  return { changed: true, settings: s };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const file = arg('--settings', join(homedir(), '.claude', 'settings.json'));
  const checkout = arg('--checkout', join(homedir(), 'ghosty-sessions'));
  const dry = process.argv.includes('--dry-run');
  const cur = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const { changed, settings } = withGuard(cur, checkout);
  if (!changed) { console.log(`install-guard-hooks: ${file} already runs ${MARK}`); process.exit(0); }
  if (dry) { console.log(JSON.stringify(settings.hooks.PreToolUse, null, 2)); process.exit(0); }
  if (existsSync(file)) copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`);
  writeFileSync(`${file}.tmp`, JSON.stringify(settings, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
  console.log(`install-guard-hooks: added ${MARK} (checkout ${checkout}) to ${file}`);
}

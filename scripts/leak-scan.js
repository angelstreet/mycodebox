#!/usr/bin/env node
// Pre-push leak scan over the ADDED lines of a git diff (default: origin/main...HEAD).
//   node scripts/leak-scan.js [<range>]        exit 1 when anything matches
// LEAK_SCAN_EXTRA=<file outside the repo>: one extra regex per line (private host, tailnet, customer names).
// Generic patterns only here: the repo is public, so real identifiers never belong in this file.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const range = process.argv[2] || 'origin/main...HEAD';
const PATTERNS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['api token', /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/],
  ['bearer/secret assignment', /\b(?:api[_-]?key|secret|token|password|passwd|vapid[_-]?private)\b\s*[:=]\s*['"][A-Za-z0-9+/_.=-]{16,}['"]/i],
  ['tailnet name', /\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b/i],
  ['home path', /\/home\/(?!<user>|user\b|me\b|owner\b)[a-z_][a-z0-9_-]*/],
  ['e-mail', /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b|anthropic\.com\b|users\.noreply\.github\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  // Documentation (RFC 5737), loopback, unspecified and version-like strings are allowed.
  ['ipv4 address', /\b(?!(?:127|0)\.)(?!192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/],
];
if (process.env.LEAK_SCAN_EXTRA) {
  for (const line of readFileSync(process.env.LEAK_SCAN_EXTRA, 'utf8').split('\n')) {
    if (line.trim() && !line.startsWith('#')) PATTERNS.push(['private denylist', new RegExp(line.trim(), 'i')]);
  }
}
// Pre-existing fixtures that intentionally contain fake private-range IPs or placeholders.
const ALLOW_FILES = [/^package-lock\.json$/];

const diff = execFileSync('git', ['diff', '--unified=0', '--no-color', range], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
let file = '', lineNo = 0, hits = 0;
for (const raw of diff.split('\n')) {
  if (raw.startsWith('+++ ')) { file = raw.slice(6); continue; }
  const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
  if (h) { lineNo = Number(h[1]); continue; }
  if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
  const text = raw.slice(1);
  if (!ALLOW_FILES.some((re) => re.test(file)) && !/leak-scan: allow/.test(text)) {
    for (const [name, re] of PATTERNS) {
      if (re.test(text)) {
        hits++;
        // Print the location and kind, not the matched value.
        console.log(`${file}:${lineNo}: ${name}`);
      }
    }
  }
  lineNo++;
}
console.log(hits ? `leak-scan: ${hits} finding(s) in ${range}` : `leak-scan: clean (${range})`);
process.exit(hits ? 1 : 0);

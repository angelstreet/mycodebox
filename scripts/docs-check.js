#!/usr/bin/env node
// V2 docs check (round 5): the acceptance check for docs-class tasks. Checks the Markdown files the change touches
// (vs V2_BASE_SHA, which the V2 verifier sets; all tracked *.md without it, or with --all): relative links resolve to
// a file in the repo, code fences are closed, no merge-conflict markers. Exit 0 = pass, 1 = findings, 2 = cannot run.
// Not checked here: reference-style and HTML links, links inside inline code, #fragments (test/v2-docs-links.test.js
// checks fragments repo-wide).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// -> repo-relative paths of the Markdown files to check (existing ones only: a deleted file has nothing to check)
export function changedMarkdown({ base = process.env.V2_BASE_SHA, all = false } = {}) {
  const list = all || !base
    ? git(['ls-files', '--', '*.md'])
    : git(['diff', '--name-only', '--diff-filter=d', base, 'HEAD', '--', '*.md']);
  return list.split('\n').filter(Boolean).filter((f) => fs.existsSync(f));
}

// text: the file's content; file: its repo-relative path; exists(p): repo-relative existence test. -> findings[]
export function checkMarkdown(text, file, exists = (p) => fs.existsSync(p)) {
  const out = [];
  const lines = text.split('\n');
  let fence = null;   // the open fence's marker and line, or null
  lines.forEach((line, i) => {
    const n = i + 1;
    if (/^(<{7}|={7}|>{7})( |$)/.test(line)) out.push(`${file}:${n}: merge-conflict marker`);
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = { mark: f[1], line: n };
      else if (f[1][0] === fence.mark[0] && f[1].length >= fence.mark.length && !line.trim().slice(f[1].length).trim()) fence = null;
      return;
    }
    if (fence) return;
    // Inline code spans hold example syntax, not links.
    const prose = line.replace(/`[^`]*`/g, '');
    for (const m of prose.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const target = m[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;   // URLs, mail, in-page anchors
      const rel = decodeURIComponent(target.split('#')[0].split('?')[0]);
      if (!rel) continue;
      const p = rel.startsWith('/') ? rel.slice(1) : path.posix.join(path.posix.dirname(file), rel);
      if (!exists(p)) out.push(`${file}:${n}: broken link ${target}`);
    }
  });
  if (fence) out.push(`${file}:${fence.line}: code fence ${fence.mark} never closed`);
  return out;
}

function main() {
  let files;
  try { files = changedMarkdown({ all: process.argv.includes('--all') }); } catch (e) {
    console.error(`docs-check: cannot list files: ${e.stderr || e.message}`);
    process.exit(2);
  }
  const findings = files.flatMap((f) => checkMarkdown(fs.readFileSync(f, 'utf8'), f));
  for (const x of findings) console.log(x);
  console.log(`docs-check: ${files.length} Markdown file(s) checked, ${findings.length} finding(s)`);
  process.exit(findings.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

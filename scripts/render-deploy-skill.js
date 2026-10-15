#!/usr/bin/env node
// Render docs/LEASE-RULES.md into the lease section of a deploy SKILL.md, between the lease-rules markers.
// Usage: node scripts/render-deploy-skill.js --in <SKILL.md> [--out <file>] [--rules <file>]
// Reads --in, never writes it; writes only --out (default stdout).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BEGIN = '<!-- lease-rules:begin -->';
export const END = '<!-- lease-rules:end -->';
const here = path.dirname(fileURLToPath(import.meta.url));

// Rules text for a skill: no top-level title, headings pushed one level down so they nest under the skill's own.
export function rulesBody(md) {
  return md.replace(/^# .*\n+/, '').replace(/^(#{2,5}) /gm, '$1# ').trim();
}

export function render(skill, rules) {
  const b = skill.indexOf(BEGIN);
  const e = skill.indexOf(END);
  if (b < 0 || e < 0 || e < b || skill.indexOf(BEGIN, b + 1) >= 0) {
    throw new Error(`skill needs exactly one ${BEGIN} ... ${END} pair`);
  }
  return skill.slice(0, b + BEGIN.length) + '\n' + rulesBody(rules) + '\n' + skill.slice(e);
}

function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (['--in', '--out', '--rules'].includes(argv[i]) && argv[i + 1] !== undefined) opt[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unknown or incomplete argument: ${argv[i]}`);
  }
  if (!opt.in) throw new Error('usage: render-deploy-skill.js --in <SKILL.md> [--out <file>] [--rules <file>]');
  const out = render(fs.readFileSync(opt.in, 'utf8'), fs.readFileSync(opt.rules || path.join(here, '..', 'docs', 'LEASE-RULES.md'), 'utf8'));
  if (opt.out) {
    if (path.resolve(opt.out) === path.resolve(opt.in)) throw new Error('--out must not be the --in file');
    fs.writeFileSync(opt.out, out);
  } else process.stdout.write(out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
}

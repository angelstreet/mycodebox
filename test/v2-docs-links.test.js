// Every local link and image in the README and docs resolves (file exists; #fragments match a heading in the target).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function mdFiles(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) mdFiles(p, out); else if (f.endsWith('.md')) out.push(p);
  }
  return out;
}
const files = [...['README.md', 'AGENTS.md', 'HANDOVER.md', 'V2_VERIFICATION.md'].map((f) => join(ROOT, f)).filter(existsSync), ...mdFiles(join(ROOT, 'docs'))];

// GitHub heading slug: lowercase, drop everything but word characters, spaces and hyphens, spaces -> hyphens.
const slug = (h) => h.trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/`/g, '').replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/ /g, '-');
function anchors(file) {
  const seen = new Map(); const set = new Set();
  let fence = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    const m = !fence && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slug(m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
    const n = seen.get(base) || 0; seen.set(base, n + 1);
    set.add(n ? `${base}-${n}` : base);
  }
  return set;
}
const strip = (text) => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
function linksOf(file) {
  const text = strip(readFileSync(file, 'utf8'));
  const out = [];
  for (const m of text.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push(m[1]);
  for (const m of text.matchAll(/\b(?:href|src)="([^"]+)"/g)) out.push(m[1]);
  return out;
}

test('the checker itself: slugs and broken-link detection', () => {
  assert.equal(slug('Current capabilities / V2 roadmap'), 'current-capabilities--v2-roadmap');
  assert.equal(slug('V2 task API (opt-in)'), 'v2-task-api-opt-in');
  assert.equal(slug('`HOST` and more'), 'host-and-more');
  assert.deepEqual(linksOf(join(ROOT, 'docs/README.md')).filter((l) => l === 'nope-does-not-exist.md'), []);
});

test('README and docs link to the new V2 pages', () => {
  const idx = readFileSync(join(ROOT, 'docs/README.md'), 'utf8');
  for (const p of ['v2/MIGRATION.md', 'v2/SCORING.md', 'v2/ARCHITECTURE.md']) assert.ok(idx.includes(p), `docs/README.md should link ${p}`);
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  for (const p of ['docs/images/v2-architecture.svg', 'docs/images/v2-workflow.svg', 'docs/images/mycodebox-desktop.png', 'docs/images/mycodebox-mobile.png', 'V2_VERIFICATION.md']) assert.ok(readme.includes(p), `README should reference ${p}`);
});

test('every local link in README.md, AGENTS.md and docs/**/*.md resolves', () => {
  const bad = [];
  let checked = 0;
  for (const file of files) {
    for (const raw of linksOf(file)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue;   // http(s), mailto, data
      const [pathPart, frag] = raw.split('#');
      const target = pathPart ? resolve(dirname(file), decodeURIComponent(pathPart)) : file;
      checked += 1;
      const where = `${relative(ROOT, file)} -> ${raw}`;
      if (!target.startsWith(ROOT) || !existsSync(target)) { bad.push(`${where} (missing)`); continue; }
      if (frag && target.endsWith('.md') && !anchors(target).has(decodeURIComponent(frag).toLowerCase())) bad.push(`${where} (no such heading)`);
    }
  }
  assert.ok(checked > 40, `suspiciously few links checked: ${checked}`);
  assert.deepEqual(bad, []);
});

test('the architecture and workflow SVGs are well formed and labelled', () => {
  for (const f of ['v2-architecture.svg', 'v2-workflow.svg']) {
    const s = readFileSync(join(ROOT, 'docs/images', f), 'utf8');
    assert.match(s, /^<svg[^>]+role="img"/);
    assert.match(s, /<title id="t">/);
    assert.equal((s.match(/<svg/g) || []).length, 1);
  }
  assert.match(readFileSync(join(ROOT, 'docs/images/v2-architecture.svg'), 'utf8'), /PLANNED/);
});

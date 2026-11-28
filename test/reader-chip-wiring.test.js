// The reader's play chip must work after any rebuild (2026-11-28): paintReader wired chips only on its first paint (`_chipsWired`), so a chip
// painted later (after "no reply yet") was a dead button. Every `el.innerHTML = ...` of the reader is followed by wireAudioChips(el).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');

test('paintReader wires the audio chips after every rebuild, not once per reader', () => {
  const start = src.indexOf('function paintReader(');
  assert.ok(start > 0);
  const end = src.indexOf('\n}\n', start);
  const body = src.slice(start, end);
  assert.doesNotMatch(body, /_chipsWired/, 'a once-per-reader flag leaves later chips unwired');
  const sets = [...body.matchAll(/el\.innerHTML = [^;]+;/g)];
  assert.ok(sets.length >= 2);
  for (const m of sets) {   // the next code line after the rebuild (comments skipped) wires the chips
    const next = body.slice(m.index + m[0].length).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'))[0];
    assert.match(next, /^wireAudioChips\(el\);/, `not wired after: ${m[0]}`);
  }
});

test('the reader play chip reads the Summary: lines only, never the STATUS line or the reply (owner 2026-11-28)', () => {
  const start = src.indexOf('function paintReader(');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /const spoken = spokenSummaryOf\(c\?\.summary\);/);
  assert.doesNotMatch(body, /spokenStatusOf|Read status aloud/);
  assert.match(body, /audioChipHtml\(\{ text: spoken, label: 'Read summary aloud' \}\)/);
});

test('a reply without a summary shows the "no summary yet" hint where the play chip would be', () => {
  const start = src.indexOf('function paintReader(');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /spoken \? audioChipHtml\(\{ text: spoken, label: 'Read summary aloud' \}\) : NO_SUMMARY_HINT/);
  assert.match(body, /NO_SUMMARY_HINT = '<span class="rd-nosum"[^']*>no summary yet<\/span>'/);
  const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'style.css'), 'utf8');
  assert.match(css, /\.reader \.rd-actions \.rd-nosum\{/);
});

test('scripts/reader-audio-check.js answers the writes in the browser and skips without playwright-core', async () => {
  const { execFileSync } = await import('node:child_process');
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'reader-audio-check.js');
  const s = fs.readFileSync(file, 'utf8');
  for (const r of ["'**/api/tts/**'", "'**/api/resize/**'", "'**/api/layout'"]) assert.ok(s.includes(r), r);
  const env = { ...process.env }; delete env.PLAYWRIGHT_CORE;
  assert.match(execFileSync(process.execPath, [file, 'http://127.0.0.1:1', 'zz-x'], { env, encoding: 'utf8' }), /^SKIPPED/);
});

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

// Text-to-speech (TASK-70 Part 1): piper binary talks the wake brief / stall summary aloud.
// One worker, started on first request and stopped after IDLE_MS without a job. Cached at
// Cached at <state dir>/tts/<hash>.wav (RIFF WAVE PCM 16-bit, piper's default) so repeat plays
// are instant; downloads are just GET of that file.
//
// Voice: en_US-amy-low (Q93=2 — owner picked the piper default over joe-medium). Quality trade-off
// accepted: smaller model, lower naturalness for short briefs.
//
// Where piper lives:
//   - PIPER_BIN env var, defaults to ~/.local/share/piper/piper (the path install-piper.sh uses)
//   - PIPER_VOICE env var, defaults to ~/.local/share/piper/voices/en_US-amy-low.onnx
// Both are injected via the createTts factory so tests can mock them.

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { writeFile, unlink, stat, readdir, mkdir, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const IDLE_MS = 10 * 60e3;        // worker idle timeout (kept for shape parity with transcribe.js; piper is one-shot here)
const KEEP_DAYS = 14;              // Q95=1 — matches daily-checks.json keepDays
const MAX_TEXT = 8000;             // briefs are well under this

export function createTts({
  bin = process.env.PIPER_BIN || path.join(homedir(), '.local', 'share', 'piper', 'piper'),
  voice = process.env.PIPER_VOICE || path.join(homedir(), '.local', 'share', 'piper', 'voices', 'en_US-amy-low.onnx'),
  cacheDir,                          // required: caller passes <stateDir>/tts
  piperRunner = runPiper,            // (bin, voice, textFile, outFile) -> Promise<void>; tests override
} = {}) {
  if (!cacheDir) throw new Error('cacheDir required');

  // Compute a stable hash of the brief text. Trimmed + length-prefixed so trailing whitespace
  // changes don't collide with the real content.
  function hashText(text) {
    const s = String(text || '').trim();
    const h = createHash('sha256');
    h.update(s);
    h.update(`|${s.length}`);
    return h.digest('hex').slice(0, 32);   // 128 bits
  }

  function cachePath(hash) {
    if (!/^[0-9a-f]{16,64}$/i.test(hash)) throw new Error('bad hash');
    return path.join(cacheDir, `${hash}.wav`);   // piper's default output is RIFF WAVE PCM, not MP3
  }

  // Returns the path to a rendered mp3 for the given text. Cached by hash. Async (Q96=1).
  async function render(text, givenHash) {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('empty text');
    if (trimmed.length > MAX_TEXT) throw new Error(`text too long (>${MAX_TEXT} chars)`);

    const hash = givenHash || hashText(trimmed);
    // URL-hash defence: the frontend computes the hash from the text and sticks it in the URL.
    // If those don't agree, the cache key would be wrong and we'd render against the wrong text.
    if (givenHash && givenHash !== hashText(trimmed)) {
      throw new Error('hash mismatch: URL hash does not match text');
    }
    const out = cachePath(hash);

    // cache hit: file exists and is non-empty
    try {
      const st = await stat(out);
      if (st.size > 0) return { path: out, hash, cached: true };
    } catch { /* not cached yet */ }

    // cache miss: render. Piper is one-shot per invocation (no JSON stdio protocol), so we spawn it
    // per job. For repeat hashes, the cache hit path above skips the spawn entirely.
    await mkdir(cacheDir, { recursive: true });
    const inFile = path.join(tmpdir(), `ghosty-tts-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    await writeFile(inFile, trimmed, { mode: 0o600 });
    try {
      await piperRunner(bin, voice, inFile, out);
    } finally {
      unlink(inFile).catch(() => {});
    }
    const st = await stat(out).catch(() => null);
    if (!st || !st.size) throw new Error('piper produced no output');
    return { path: out, hash, cached: false };
  }

  // Q95=1: 14-day prune. Removes .wav files in cacheDir whose mtime is older than KEEP_DAYS days.
  async function prune({ now = Date.now() } = {}) {
    const cutoff = now - KEEP_DAYS * 24 * 3600 * 1000;
    let removed = 0;
    let files = [];
    try { files = await readdir(cacheDir); } catch { return { removed: 0 }; }
    for (const f of files) {
      if (!f.endsWith('.wav')) continue;
      const full = path.join(cacheDir, f);
      try {
        const st = await stat(full);
        if (st.mtimeMs < cutoff) { await rm(full); removed++; }
      } catch { /* file gone, fine */ }
    }
    return { removed };
  }

  return { render, prune, hashText, cachePath, KEEP_DAYS };
}

// Default piper runner: `piper --model <voice> --output_file <out> < text_file`.
// Tested with piper-tts 1.2.0 binary.
async function runPiper(bin, voice, textFile, outFile) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['--model', voice, '--output_file', outFile], { stdio: ['pipe', 'ignore', 'pipe'] });
    let errTail = '';
    p.stderr.on('data', (d) => { errTail = (errTail + d).slice(-400); });
    p.on('error', reject);
    p.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`piper exited (${code})${errTail ? `: ${errTail.trim().split('\n').pop()}` : ''}`));
    });
    const rs = createReadStream(textFile);
    rs.on('error', reject);
    rs.pipe(p.stdin);
  });
}
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
import { createReadStream, openSync, readSync, closeSync } from 'node:fs';
import { writeFile, unlink, stat, readdir, mkdir, rm, rename } from 'node:fs/promises';
import { tmpdir, homedir, setPriority } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const IDLE_MS = 10 * 60e3;        // worker idle timeout (kept for shape parity with transcribe.js; piper is one-shot here)
const KEEP_DAYS = 14;              // Q95=1 — matches daily-checks.json keepDays
const MAX_TEXT = 8000;             // briefs are well under this
const NICE = 10;                   // renders yield to sessions, the server and test runs
const THREADS = 2;                 // onnxruntime threads per render = cores used (GHOSTY_TTS_THREADS)
const RENDER_MAX_MS = 10 * 60e3;   // a hung piper must not hold the queue for ever
const SHIM = fileURLToPath(new URL('./tts-piper-shim.py', import.meta.url));

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

  // One piper at a time: parallel renders each take THREADS cores. `inflight` joins a repeat POST of the same text.
  let tail = Promise.resolve();
  const inflight = new Map();
  function enqueue(hash, job) {
    let p = inflight.get(hash);
    if (p) return p;
    p = tail.then(job).finally(() => inflight.delete(hash));
    inflight.set(hash, p);
    tail = p.catch(() => {});
    return p;
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
    await enqueue(hash, () => renderOne(trimmed, out));
    return { path: out, hash, cached: false };
  }

  // Piper writes to <out>.part: the POST route calls any non-empty .wav ready, so it appears only when complete.
  async function renderOne(text, out) {
    await mkdir(cacheDir, { recursive: true });
    const inFile = path.join(tmpdir(), `ghosty-tts-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    const part = `${out}.part`;
    await writeFile(inFile, text, { mode: 0o600 });
    try {
      await piperRunner(bin, voice, inFile, part);
      const st = await stat(part).catch(() => null);
      if (!st || !st.size) throw new Error('piper produced no output');
      await rename(part, out);
    } finally {
      unlink(inFile).catch(() => {});
      await rm(part, { force: true });
    }
  }

  // Q95=1: 14-day prune. Removes .wav files in cacheDir whose mtime is older than KEEP_DAYS days.
  async function prune({ now = Date.now() } = {}) {
    const cutoff = now - KEEP_DAYS * 24 * 3600 * 1000;
    let removed = 0;
    let files = [];
    try { files = await readdir(cacheDir); } catch { return { removed: 0 }; }
    for (const f of files) {
      if (!f.endsWith('.wav') && !f.endsWith('.wav.part')) continue;   // .part: cut off by a restart
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

// The command for one render. The pip `piper` is a Python script: it runs through the shim, which caps the
// onnxruntime threads. Any other binary runs as it is (niced only).
export function piperCommand(bin, args) {
  let head = '';
  try {
    const fd = openSync(bin, 'r');
    try { const b = Buffer.alloc(256); head = b.toString('utf8', 0, readSync(fd, b, 0, b.length, 0)); } finally { closeSync(fd); }
  } catch { /* missing or unreadable: spawn reports it */ }
  const shebang = /^#![ \t]*([^\r\n]*python[^\r\n]*)/.exec(head);
  if (!shebang) return [bin, args];
  const [interpreter, ...flags] = shebang[1].trim().split(/\s+/);
  return [interpreter, [...flags, SHIM, bin, ...args]];
}

// Default piper runner: `piper --model <voice> --output_file <out> < text_file`, niced and thread-limited.
// Tested with piper-tts 1.2.0 binary.
export async function runPiper(bin, voice, textFile, outFile, { timeoutMs = RENDER_MAX_MS } = {}) {
  return new Promise((resolve, reject) => {
    const [cmd, args] = piperCommand(bin, ['--model', voice, '--output_file', outFile]);
    const env = { ...process.env, GHOSTY_TTS_THREADS: process.env.GHOSTY_TTS_THREADS || String(THREADS) };
    const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'], env });
    // Set at once, before piper starts threads (Linux niceness is per thread, inherited). No `nice` binary needed.
    try { if (p.pid) setPriority(p.pid, NICE); } catch { /* not permitted or already gone: render anyway */ }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeoutMs);
    let errTail = '';
    p.stderr.on('data', (d) => { errTail = (errTail + d).slice(-400); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else if (timedOut) reject(new Error(`piper timed out after ${Math.round(timeoutMs / 1000)} s`));
      else reject(new Error(`piper exited (${code})${errTail ? `: ${errTail.trim().split('\n').pop()}` : ''}`));
    });
    p.stdin.on('error', () => {});   // piper died before reading: the exit code reports it
    const rs = createReadStream(textFile);
    rs.on('error', reject);
    rs.pipe(p.stdin);
  });
}
// HTTP Range for the .wav route: iOS Safari will not play audio from a server that ignores Range.
// 'bytes=a-b' | 'bytes=a-' | 'bytes=-n' -> {start, end} inclusive; null = no/unusable header (send all), 'bad' = unsatisfiable (416).
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { const n = Number(m[2]); if (!n) return 'bad'; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start >= size || start > end ? 'bad' : { start, end };
}

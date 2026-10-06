// Voice input: the dock's mic button uploads a recording, a faster-whisper worker (scripts/transcribe.py) turns it into
// text. One worker, started on first use and stopped after IDLE_MS without a job (the model holds a few hundred MB).
// WHISPER_MODEL picks the model (default base: ~3 s for a 7 s clip on this CPU; small is ~3x slower).
import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IDLE_MS = 10 * 60e3;
const JOB_MS = 60e3;
export const MAX_AUDIO = 10 * 1024 * 1024;

export function createTranscriber({ script = path.join(HERE, 'scripts', 'transcribe.py'), python = 'python3' } = {}) {
  let proc = null;
  let ready = null;          // promise: resolves when the model is loaded
  let buf = '';
  let seq = 0;
  let idleTimer = null;
  const jobs = new Map();    // id -> { resolve, reject, timer }

  function failAll(err) {
    for (const j of jobs.values()) { clearTimeout(j.timer); j.reject(err); }
    jobs.clear();
  }
  function start() {
    if (proc) return ready;
    proc = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let onReady, onFail;
    ready = new Promise((res, rej) => { onReady = res; onFail = rej; });
    ready.catch(() => {});
    let errTail = '';
    proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-600); });
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.ready) { onReady(); continue; }
        const j = jobs.get(m.id);
        if (!j) continue;
        jobs.delete(m.id); clearTimeout(j.timer);
        if (m.error) j.reject(new Error(m.error)); else j.resolve({ text: m.text || '', lang: m.lang || null, ms: m.ms });
      }
    });
    proc.on('exit', (code) => {
      const err = new Error(`transcriber exited (${code})${errTail ? `: ${errTail.trim().split('\n').pop()}` : ''}`);
      proc = null; buf = '';
      onFail(err); failAll(err);
    });
    return ready;
  }
  function stop() { if (proc) { proc.kill(); proc = null; } }
  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!jobs.size) stop(); }, IDLE_MS);
    idleTimer.unref?.();
  }

  async function transcribe(audio, { ext = 'webm', lang = null } = {}) {
    const file = path.join(tmpdir(), `ghosty-voice-${process.pid}-${Date.now()}-${++seq}.${ext}`);
    await writeFile(file, audio);
    try {
      await start();
      const id = seq;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { jobs.delete(id); reject(new Error('transcription timed out')); }, JOB_MS);
        jobs.set(id, { resolve, reject, timer });
        proc.stdin.write(JSON.stringify({ id, path: file, lang }) + '\n');
      });
    } finally {
      armIdle();
      unlink(file).catch(() => {});
    }
  }
  return { transcribe, stop };
}

// recording mime type -> file extension ffmpeg (inside faster-whisper) recognises
export function extFor(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('mp4') || t.includes('m4a') || t.includes('aac')) return 'm4a';
  if (t.includes('ogg')) return 'ogg';
  if (t.includes('wav')) return 'wav';
  if (t.includes('mpeg') || t.includes('mp3')) return 'mp3';
  return 'webm';
}

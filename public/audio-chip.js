// TTS audio chip (TASK-70 Part 1): the wake brief / stall summary becomes audio. Three controls
// per chip:
//   - play / pause toggle (one button, two icons)
//   - download (saves the rendered .wav to disk)
//   - speed selector (1x / 1.25x / 1.5x, default 1x)
//
// Lifecycle on first interaction:
//   1. compute SHA-256 hash of the brief text (32 hex chars, tts.js-compatible)
//   2. POST /api/tts/<hash> with {text}; CSS pulse + disabled controls while pending
//   3. poll GET /api/tts/<hash>/status until state=='ready'
//   4. on ready, swap disabled off, point the <audio> element at /api/tts/<hash>.wav
//
// Repeat plays use the browser HTTP cache (Cache-Control: public, max-age=86400 on the .wav
// route) and never re-render server-side (the hash is the cache key).

import { icon } from '/icons.js';

// SHA-256 -> 32 hex chars, must match tts.js hashText() exactly (server enforces equality).
async function hashText(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text || '').trim() + '|' + String(text || '').length));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

const POLL_MS = 500;       // how often to poll /status while pending
const POLL_MAX_MS = 30000; // give up after 30s and surface the failure

// Returns HTML for one audio chip. The chip is inert until wireAudioChip() is called on its root.
// `text` is what piper will read aloud (the truncated "[kind] title — body [jev pick]" body, or
// the full stall block for [asks] events).
export function audioChipHtml({ text, label = 'audio' } = {}) {
  const safe = String(text || '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<span class="audio-chip" data-text="${safe}" aria-label="${label}">
    <button class="ac-play" type="button" aria-label="Play audio" title="Play audio" disabled>${icon('play', 14)}</button>
    <button class="ac-loader hidden" type="button" aria-label="Loading audio" tabindex="-1">${icon('loader', 14)}</button>
    <a class="ac-download hidden" href="#" download aria-label="Download audio" title="Download audio">${icon('download', 14)}</a>
    <span class="ac-speeds" role="group" aria-label="Playback speed">
      <button class="ac-speed on" type="button" data-rate="1" aria-label="Speed 1x">1×</button>
      <button class="ac-speed" type="button" data-rate="1.25" aria-label="Speed 1.25x">1.25×</button>
      <button class="ac-speed" type="button" data-rate="1.5" aria-label="Speed 1.5x">1.5×</button>
    </span>
    <audio class="ac-audio" preload="none"></audio>
  </span>`;
}

// Wire one chip: POST the text to /api/tts/<hash>, poll /status, attach the .wav to <audio>.
// Idempotent: a chip wired twice is a no-op (data-wired flag).
export async function wireAudioChip(root) {
  if (!root || root.dataset.wired) return;
  root.dataset.wired = '1';
  const text = root.dataset.text || '';
  const playBtn = root.querySelector('.ac-play');
  const loaderBtn = root.querySelector('.ac-loader');
  const dlBtn = root.querySelector('.ac-download');
  const speedBtns = [...root.querySelectorAll('.ac-speed')];
  const audio = root.querySelector('.ac-audio');

  // kick off the render. errors here fail loudly: the chip stays disabled with the loader visible.
  let url;
  try {
    const hash = await hashText(text);
    root.dataset.hash = hash;
    const post = await fetch(`/api/tts/${hash}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!post.ok && post.status !== 202) throw new Error(`tts post ${post.status}`);
    const body = await post.json();
    if (body.ready) {
      url = body.url;
      onReady();
      return;
    }
    // poll until ready (or fail)
    const startedAt = Date.now();
    while (Date.now() - startedAt < POLL_MAX_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const st = await fetch(`/api/tts/${hash}/status`).then((r) => r.json()).catch(() => ({ state: 'pending' }));
      if (st.state === 'ready') { url = st.url; onReady(); return; }
      if (st.state === 'failed') throw new Error(st.error || 'render failed');
    }
    throw new Error('tts render timed out');
  } catch (err) {
    console.error('[tts]', err.message);
    // disable the chip forever; show the loader (no play)
    root.classList.add('failed');
    loaderBtn.classList.remove('hidden');
    playBtn.disabled = true;
    return;
  }

  function onReady() {
    loaderBtn.classList.add('hidden');
    playBtn.disabled = false;
    audio.src = url;
    dlBtn.href = url;
    dlBtn.classList.remove('hidden');
    dlBtn.setAttribute('download', `${(root.dataset.hash || 'tts').slice(0, 12)}.wav`);
    root.classList.add('ready');
    audio.playbackRate = 1;
  }

  playBtn.addEventListener('click', async () => {
    if (audio.paused) {
      // QF-05: iOS Safari rejects play() with NotAllowedError when the user-gesture
      // context is lost, or with NotSupportedError on a bad codec. Surface the
      // real error instead of swallowing it so the user can see what went wrong.
      try { await audio.play(); }
      catch (err) {
        console.error('[tts] play failed', err);
        root.classList.add('ac-failed');
        const orig = playBtn.getAttribute('aria-label') || 'Play audio';
        playBtn.setAttribute('aria-label', `audio failed: ${err && err.message ? err.message : (err && err.name) || err}`);
        setTimeout(() => { root.classList.remove('ac-failed'); playBtn.setAttribute('aria-label', orig); }, 2400);
      }
    } else { audio.pause(); }
  });
  audio.addEventListener('play', () => { playBtn.innerHTML = icon('pause', 14); playBtn.setAttribute('aria-label', 'Pause audio'); });
  audio.addEventListener('pause', () => { playBtn.innerHTML = icon('play', 14); playBtn.setAttribute('aria-label', 'Play audio'); });
  audio.addEventListener('ended', () => { playBtn.innerHTML = icon('play', 14); playBtn.setAttribute('aria-label', 'Play audio'); });
  for (const b of speedBtns) {
    b.addEventListener('click', () => {
      const r = Number(b.dataset.rate);
      audio.playbackRate = r;
      for (const x of speedBtns) x.classList.toggle('on', x === b);
    });
  }
}

// Wire every audio chip under `root`. Call after rendering a surface that contains chips.
export function wireAudioChips(root = document) {
  const chips = [...root.querySelectorAll('.audio-chip:not([data-wired])')];
  for (const c of chips) wireAudioChip(c);
}
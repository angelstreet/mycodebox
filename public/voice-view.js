// Voice mode (round 8, hands-free): a full-screen page that reads what needs the owner, listens for the answer, sends it, moves on.
// Loop: GET /api/voice/queue -> speak the item (piper via /api/tts, speechSynthesis as the fallback) -> listen (mic, auto-stop on
// silence) -> POST /api/transcribe -> POST /api/voice/answer -> speak the reply -> next. Empty queue: poll every 20 s.
// The logic (endOfSpeech, createVoiceLoop, settings, media session) is pure or takes its I/O as arguments, so it is unit tested;
// only openVoice() touches the DOM, the mic and the speaker.
import { icon } from './icons.js';

// ---------- settings (rate, auto-listen), remembered in localStorage; every access is in try/catch ----------
export const RATES = [1, 1.25, 1.5];
const SETTINGS_KEY = 'ghosty.voice.settings';
export const DEFAULT_SETTINGS = { rate: 1, autoListen: true };
export function loadSettings(storage) {
  try {
    const j = JSON.parse(storage.getItem(SETTINGS_KEY) || '{}');
    return { rate: RATES.includes(j.rate) ? j.rate : DEFAULT_SETTINGS.rate, autoListen: typeof j.autoListen === 'boolean' ? j.autoListen : DEFAULT_SETTINGS.autoListen };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(storage, s) {
  try { storage.setItem(SETTINGS_KEY, JSON.stringify({ rate: s.rate, autoListen: !!s.autoListen })); return true; } catch { return false; }
}

// ---------- end-of-speech detection ----------
// `levels` = RMS (0..1) sampled every intervalMs since listening started. Done when: about silenceMs of quiet after speech, maxMs in
// total, or noSpeechMs without any speech. The threshold follows the room: 3x the quiet part of the first 300 ms, between floor and cap.
export const VAD = { intervalMs: 50, silenceMs: 1200, maxMs: 8000, noSpeechMs: 5000, minSpeechMs: 200, floor: 0.015, factor: 3, cap: 0.06, calibMs: 300 };
export function endOfSpeech(levels, opts = {}) {
  const c = { ...VAD, ...opts };
  const calibN = Math.max(1, Math.round(c.calibMs / c.intervalMs));
  const head = levels.slice(0, calibN).filter(Number.isFinite).sort((a, b) => a - b);
  const noise = head.length ? head[Math.floor((head.length - 1) * 0.2)] : 0;
  const threshold = Math.min(c.cap, Math.max(c.floor, noise * c.factor));
  let speechMs = 0, lastSpeechAt = 0, started = false;
  for (let i = 0; i < levels.length; i++) {
    const t = (i + 1) * c.intervalMs;
    if (levels[i] > threshold) { speechMs += c.intervalMs; lastSpeechAt = t; if (speechMs >= c.minSpeechMs) started = true; }
    if (started && t - lastSpeechAt >= c.silenceMs) return { done: true, reason: 'silence', speechMs, started, threshold };
    if (t >= c.maxMs) return { done: true, reason: 'max', speechMs, started, threshold };
    if (!started && t >= c.noSpeechMs) return { done: true, reason: 'no-speech', speechMs, started, threshold };
  }
  return { done: false, reason: null, speechMs, started, threshold };
}
export const rms = (buf) => { let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return buf.length ? Math.sqrt(s / buf.length) : 0; };

// ---------- the loop ----------
// deps: api { queue(), answer(body), digest() }, speak(text) (resolves when done), listen() -> transcript string ('' = heard nothing),
//   chime(), sleep(ms), onState(state, item), pollMs (20000), maxTries (3), autoListen() -> bool, waitTap() -> 'listen'|'next'|'repeat'
export function createVoiceLoop(deps) {
  const pollMs = deps.pollMs ?? 20000, maxTries = deps.maxTries ?? 3;
  const skipped = new Set();   // ids the owner skipped; forgotten when the item leaves the queue
  let running = false, runId = 0, announcedEmpty = false, current = null, force = null, wake = null;
  const state = (s, item = current) => { try { deps.onState?.(s, item); } catch { /* UI only */ } };
  const interrupt = () => { if (wake) { const w = wake; wake = null; w(); } };
  const sleep = async (ms) => { await Promise.race([deps.sleep(ms), new Promise((r) => { wake = r; })]); wake = null; };

  async function say(text) { if (!text) return; state('speaking'); await deps.speak(text); }

  async function turn(item, myRun) {
    let tries = 0, pending = null;
    while (running && runId === myRun) {
      let text = '';
      if (deps.autoListen && !deps.autoListen()) {
        state('idle');
        const tap = await deps.waitTap();
        if (!running || runId !== myRun) return;
        if (tap === 'next') { skipped.add(item.id); return; }
        if (tap === 'repeat') { await say(item.script); continue; }
      }
      state('listening');
      try { text = (await deps.listen()) || ''; } catch { text = ''; }
      if (!running || runId !== myRun) return;
      if (force) { const f = force; force = null; if (f === 'skip') { skipped.add(item.id); return; } if (f === 'repeat') { await say(item.script); continue; } }
      if (!text.trim()) {
        if (++tries >= maxTries) { skipped.add(item.id); await say('No answer. Skipping.'); return; }
        await say('I did not hear you.'); continue;
      }
      state('thinking');
      let r;
      try { r = await deps.api.answer({ id: item.id, transcript: text, ...(pending != null ? { pending } : {}) }); }
      catch { await say('I could not reach the server.'); return; }
      if (!running || runId !== myRun) return;
      switch (r.status) {
        case 'sent': await say(r.say); return;
        case 'confirm': pending = r.option; await say(r.say); tries = 0; continue;
        case 'again': if (++tries >= maxTries) { skipped.add(item.id); await say('Skipping.'); return; } await say(r.say); continue;
        case 'stale': case 'draft': skipped.add(item.id); await say(r.say); return;
        case 'intent':
          if (r.intent === 'repeat') { await say(item.script); continue; }
          if (r.intent === 'digest') { await speakDigest(); await say(item.script); continue; }
          if (r.intent === 'stop') { await say(r.say); loop.stop(); return; }
          if (r.intent === 'cancel') { pending = null; skipped.add(item.id); await say(r.say); return; }
          skipped.add(item.id); await say(r.say); return;   // skip, next, wait
        default: await say(r.say || 'Something went wrong.'); skipped.add(item.id); return;
      }
    }
  }

  async function speakDigest() {
    try { const d = await deps.api.digest(); await say(d.text || 'Nothing to report.'); } catch { await say('I could not get the digest.'); }
  }

  async function run(myRun) {
    while (running && runId === myRun) {
      let items = [];
      try { items = (await deps.api.queue()).items || []; } catch { state('offline'); await sleep(pollMs); continue; }
      const ids = new Set(items.map((i) => i.id));
      for (const id of [...skipped]) if (!ids.has(id)) skipped.delete(id);
      const open = items.filter((i) => !skipped.has(i.id));
      if (!open.length) {
        current = null; state('empty', null);
        if (!announcedEmpty) { announcedEmpty = true; await say(items.length ? 'Nothing else needs you.' : 'Nothing needs you.'); }
        await sleep(pollMs);
        continue;
      }
      if (announcedEmpty) { announcedEmpty = false; await deps.chime?.(); }
      current = open[0];
      state('item', current);
      await say(current.script);
      if (!running || runId !== myRun) return;
      await turn(current, myRun);
    }
  }

  const loop = {
    get running() { return running; },
    start() { if (running) return; running = true; announcedEmpty = false; const my = ++runId; state('starting'); run(my).catch(() => {}).finally(() => { if (runId === my) { running = false; state('stopped'); } }); },
    stop() { running = false; runId++; interrupt(); deps.cancel?.(); state('stopped'); },
    next() { if (current) skipped.add(current.id); force = 'skip'; deps.cancel?.(); interrupt(); },
    repeat() { force = 'repeat'; deps.cancel?.(); interrupt(); },
    async digest() { await speakDigest(); },
    skippedIds: () => [...skipped],
  };
  return loop;
}

// ---------- Media Session: headset / car / lock-screen buttons ----------
export function setupMediaSession(nav, loop) {
  const ms = nav && nav.mediaSession;
  if (!ms || typeof ms.setActionHandler !== 'function') return false;
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch { /* an action this browser does not know */ } };
  set('play', () => loop.start());
  set('pause', () => loop.stop());
  set('nexttrack', () => loop.next());
  set('previoustrack', () => loop.repeat());
  return true;
}
export function setMediaMetadata(nav, MetadataCtor, item) {
  try {
    if (!nav?.mediaSession || !MetadataCtor) return;
    nav.mediaSession.metadata = new MetadataCtor({ title: item ? item.session : 'Nothing needs you', artist: 'mycodebox', album: item ? (item.kind === 'ask' ? 'Question' : 'Stop') : '' });
  } catch { /* cosmetic */ }
}

// ---------- html ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function itemHtml(item) {
  if (!item) return '<div class="vv-empty">Nothing needs you.</div>';
  const opts = (item.options || []).map((o) => `<button class="vv-opt${o.recommended ? ' rec' : ''}" data-vv-opt="${esc(o.n)}"><b>${esc(o.n)}</b> ${esc(o.label)}${o.recommended ? ' <i>recommended</i>' : ''}</button>`).join('');
  return `<div class="vv-sess">${esc(item.session)}</div><div class="vv-q">${esc(item.question)}</div><div class="vv-opts">${opts}</div>`;
}
const STATE_TEXT = { starting: 'Starting', item: 'Reading', speaking: 'Speaking', listening: 'Listening', thinking: 'Sending', empty: 'Nothing needs you', idle: 'Tap Answer to speak', offline: 'Server unreachable', stopped: 'Stopped' };
export const stateText = (s) => STATE_TEXT[s] || '';

// ---------- the page (browser only) ----------
async function hashText(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text || '').trim() + '|' + String(text || '').length));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const jpost = async (url, body) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); return { ...j, _http: r.status }; };
const api = {
  async queue() { const r = await fetch('/api/voice/queue', { cache: 'no-store' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); },
  answer: (b) => jpost('/api/voice/answer', b),
  async digest() { const r = await fetch('/api/voice/digest?minutes=60', { cache: 'no-store' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); },
};

export function openVoice({ onClose = () => {}, storage = globalThis.localStorage } = {}) {
  if (document.getElementById('voiceView')) return;
  const settings = loadSettings(storage || { getItem() { return null; }, setItem() {} });
  const root = document.createElement('div');
  root.id = 'voiceView'; root.className = 'vv'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Voice mode');
  root.innerHTML = `<div class="vv-top"><div class="vv-title">${icon('headphones', 26)} Voice mode</div><button class="vv-x" id="vvClose" aria-label="Close voice mode">${icon('x', 28)}</button></div>
    <div class="vv-state" id="vvState" aria-live="polite">Stopped</div>
    <div class="vv-meter"><i id="vvMeter"></i></div>
    <div class="vv-item" id="vvItem">${itemHtml(null)}</div>
    <button class="vv-go" id="vvGo">${icon('play', 34)} <span>Start</span></button>
    <div class="vv-row">
      <button class="vv-btn" id="vvNext">${icon('skip-forward', 26)} Next</button>
      <button class="vv-btn" id="vvRepeat">${icon('rotate-ccw', 26)} Repeat</button>
      <button class="vv-btn" id="vvDigest">${icon('note', 26)} Digest</button>
      <button class="vv-btn" id="vvAnswer">${icon('mic', 26)} Answer</button>
    </div>
    <div class="vv-set"><span>Speed</span>${RATES.map((r) => `<button class="vv-rate${r === settings.rate ? ' on' : ''}" data-rate="${r}">${r}x</button>`).join('')}
      <label class="vv-auto"><input type="checkbox" id="vvAuto"${settings.autoListen ? ' checked' : ''}> Listen automatically</label></div>
    <div class="vv-hint" id="vvHint"></div>`;
  document.body.appendChild(root);
  const $ = (id) => root.querySelector(id);
  const audio = new Audio(); audio.preload = 'auto';
  let shown = null, touchPending = null, tapResolve = null, cancelSpeak = null, listenCancel = null, wakeLock = null, stream = null;

  // --- speaking: piper first, speechSynthesis when it is not available or too slow ---
  async function ttsUrl(text) {
    const hash = await hashText(text);
    const r = await fetch(`/api/tts/${hash}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    if (r.status === 200) return (await r.json()).url;
    if (r.status !== 202) throw new Error(`tts HTTP ${r.status}`);
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      await sleepMs(400);
      const s = await (await fetch(`/api/tts/${hash}/status`)).json();
      if (s.state === 'ready') return s.url;
      if (s.state === 'failed') throw new Error(s.error || 'tts failed');
    }
    throw new Error('tts timeout');
  }
  const prefetch = (text) => { hashText(text).then((h) => fetch(`/api/tts/${h}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })).catch(() => {}); };
  function browserSpeak(text) {
    return new Promise((resolve) => {
      const ss = globalThis.speechSynthesis;
      if (!ss || typeof SpeechSynthesisUtterance === 'undefined') return resolve();
      const u = new SpeechSynthesisUtterance(text); u.rate = settings.rate; u.onend = u.onerror = () => resolve();
      cancelSpeak = () => { try { ss.cancel(); } catch {} resolve(); };
      ss.speak(u);
    });
  }
  async function speak(text) {
    let url = null;
    try { url = await ttsUrl(text); } catch { url = null; }
    if (url) {
      const ok = await new Promise((resolve) => {
        audio.src = url; audio.playbackRate = settings.rate;
        const done = (v) => { audio.onended = audio.onerror = null; cancelSpeak = null; resolve(v); };
        audio.onended = () => done(true); audio.onerror = () => done(false);
        cancelSpeak = () => { try { audio.pause(); } catch {} done(true); };
        audio.play().catch(() => done(false));
      });
      if (ok) return;
    }
    await browserSpeak(text);
    cancelSpeak = null;
  }
  async function chime() {
    try {
      const ac = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = 880; g.gain.setValueAtTime(0.0001, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.35);
      o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.4);
      await sleepMs(450); ac.close().catch(() => {});
    } catch { /* no audio context: the spoken line follows anyway */ }
  }

  // --- listening: getUserMedia + MediaRecorder, the level decides when to stop ---
  async function listen() {
    if (!stream) stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => globalThis.MediaRecorder?.isTypeSupported?.(m)) || '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    const ac = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    const an = ac.createAnalyser(); an.fftSize = 1024;
    const src = ac.createMediaStreamSource(stream); src.connect(an);
    const buf = new Float32Array(an.fftSize), levels = [];
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start();
    let cancelled = false;
    listenCancel = () => { cancelled = true; };
    while (!cancelled) {
      await sleepMs(VAD.intervalMs);
      an.getFloatTimeDomainData(buf);
      const lv = rms(buf); levels.push(lv);
      const m = $('#vvMeter'); if (m) m.style.width = `${Math.min(100, Math.round(lv * 600))}%`;
      if (endOfSpeech(levels).done) break;
    }
    listenCancel = null;
    try { rec.stop(); } catch {}
    await stopped; try { src.disconnect(); ac.close(); } catch {}
    const m = $('#vvMeter'); if (m) m.style.width = '0';
    if (cancelled) return '';
    const heard = endOfSpeech(levels);
    if (!heard.started) return '';
    const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
    if (!blob.size) return '';
    const r = await fetch('/api/transcribe', { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob });
    const j = await r.json().catch(() => ({}));
    return r.ok ? String(j.text || '') : '';
  }

  // --- wake lock: the screen stays on while the loop runs ---
  async function lock() { try { if (!wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener?.('release', () => { wakeLock = null; }); } } catch { wakeLock = null; } }
  function unlock() { try { wakeLock?.release(); } catch {} wakeLock = null; }
  const onVis = () => { if (document.visibilityState === 'visible' && loop.running) lock(); };
  document.addEventListener('visibilitychange', onVis);

  const loop = createVoiceLoop({
    api, speak, listen, chime, sleep: sleepMs,
    cancel: () => { try { cancelSpeak?.(); } catch {} try { listenCancel?.(); } catch {} },
    autoListen: () => settings.autoListen,
    waitTap: () => new Promise((r) => { tapResolve = r; }),
    onState: (s, item) => {
      $('#vvState').textContent = stateText(s);
      root.dataset.state = s;
      if (s === 'item' || s === 'empty') { shown = item; touchPending = null; $('#vvItem').innerHTML = itemHtml(item); setMediaMetadata(navigator, globalThis.MediaMetadata, item); }
      const go = $('#vvGo'); const on = loop.running && s !== 'stopped';
      go.classList.toggle('on', on); go.querySelector('span').textContent = on ? 'Stop' : 'Start'; go.querySelector('svg').outerHTML = icon(on ? 'pause' : 'play', 34);
      if (s === 'stopped') { unlock(); try { if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused'; } catch {} stream?.getTracks().forEach((t) => t.stop()); stream = null; }
    },
  });
  setupMediaSession(navigator, loop);

  const start = async () => { if (!navigator.mediaDevices?.getUserMedia) { $('#vvHint').textContent = 'This browser cannot use the microphone here (needs https).'; } await lock(); try { if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing'; } catch {} loop.start(); };
  $('#vvGo').onclick = () => (loop.running ? loop.stop() : start());
  $('#vvNext').onclick = () => { if (tapResolve) { const r = tapResolve; tapResolve = null; r('next'); } loop.next(); };
  $('#vvRepeat').onclick = () => { if (tapResolve) { const r = tapResolve; tapResolve = null; r('repeat'); } else loop.repeat(); };
  $('#vvAnswer').onclick = () => { if (tapResolve) { const r = tapResolve; tapResolve = null; r('listen'); } };
  $('#vvDigest').onclick = async () => { if (!loop.running) await lock(); loop.digest(); };
  $('#vvAuto').onchange = (e) => { settings.autoListen = e.target.checked; saveSettings(storage, settings); };
  root.addEventListener('click', async (e) => {
    const rate = e.target.closest('[data-rate]');
    if (rate) { settings.rate = Number(rate.dataset.rate); saveSettings(storage, settings); audio.playbackRate = settings.rate; root.querySelectorAll('.vv-rate').forEach((b) => b.classList.toggle('on', b === rate)); return; }
    const opt = e.target.closest('[data-vv-opt]');   // touch fallback: the same validated answer path (a sensitive option asks for a second tap)
    if (!opt || !shown) return;
    const n = Number(opt.dataset.vvOpt);
    const r = await api.answer({ id: shown.id, option: n, ...(touchPending === n ? { confirm: true } : {}) });
    touchPending = r.status === 'confirm' ? n : null;
    $('#vvHint').textContent = r.say || r.error || '';
  });
  $('#vvClose').onclick = () => { loop.stop(); unlock(); document.removeEventListener('visibilitychange', onVis); root.remove(); onClose(); };
  prefetch('Nothing needs you.');
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The browser module imports '/icons.js': swap that line for a stub and load the rest as it is.
const src = readFileSync(new URL('../public/audio-chip.js', import.meta.url), 'utf8').replace(/^import \{ icon \}.*$/m, 'const icon = () => "";');
const { wireAudioChip } = await import(`data:text/javascript,${encodeURIComponent(src)}`);

function el() {
  const on = {};
  return { on, dataset: {}, paused: true, disabled: true, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, fn) { on[type] = fn; }, setAttribute() {}, getAttribute: () => '' };
}

test('wireAudioChip: nothing renders before a tap; the tap renders and plays; speed is wired', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  for (const replies of [[{ ready: true, url: '/a.wav' }], [{ ready: false }, { state: 'ready', url: '/a.wav' }]]) {
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; const body = replies.shift(); return { ok: true, status: 200, json: async () => body }; };
    const parts = Object.fromEntries(['.ac-play', '.ac-loader', '.ac-download', '.ac-audio'].map((k) => [k, el()]));
    const speed = el();
    speed.dataset.rate = '1.5';
    let played = 0;
    parts['.ac-audio'].play = async () => { played++; };
    wireAudioChip({ ...el(), dataset: { text: 'hello' }, querySelector: (k) => parts[k], querySelectorAll: () => [speed] });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fetches, 0);
    await parts['.ac-play'].on.click();
    assert.equal(played, 1);
    assert.equal(parts['.ac-play'].disabled, false);
    assert.ok(fetches > 0);
    speed.on.click();
    assert.equal(parts['.ac-audio'].playbackRate, 1.5);
  }
});

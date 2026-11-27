// The nightly's browser layer (owner 2026-11-27): every tile of the device-control grid, opened once in a
// headless browser, so the night can prove what the app really shows instead of trusting the capture column.
//
// The payload arrives on stdin (the auto-sign token never travels in argv, where the process list would show it):
//   {app, token, platformServers:[{name,url}], servers:[{name,url}], playwrightPath, perCardTimeoutMs,
//    budgetSeconds, evidenceDir}
// The result leaves on stdout as JSON:
//   {status:'ok'|'skipped', checked, playing, not_playing, tiles:[{name,host,capture,readyState,dt,bright,plays}],
//    not_checked:[{name,why}], why}
//
// A tile plays when all hold (the vpt-headless-verify skill, "Prove a device tile really plays"): a <video> inside
// the card, readyState >= 2, currentTime moves at all (a live tile at the live edge runs slower than wall time),
// no failed HLS request of its own, and a picture that is not black. A tile that reads broken inside the sweep is
// probed again on its own before it is called broken: the sweep's load can read a playing tile as black.
//
// The tile's identity (its host and its capture) comes from the stream the player asks for after the hover
// (/host/<host>/stream/<capture>/segments/output.m3u8): hls.js plays through a blob URL, so the card's DOM carries
// no stream path.
//
// The browser is relaunched per page of the grid and again whenever the page dies (a grid with a hundred players
// can take its renderer down): the night must not lose the rest of the grid because of one page.
import { createRequire } from 'node:module';
import { tileVerdict } from './rtsp_tile_verdict.mjs';

const HLS = /output\.m3u8|segment_\d+\.ts/;

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const payload = JSON.parse((await readStdin()) || '{}');
const { app, token, servers = [], platformServers = [], perCardTimeoutMs = 8000, budgetSeconds = 1800, evidenceDir = null } = payload;
const req = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = req(payload.playwrightPath));
} catch (e) {
  process.stdout.write(JSON.stringify({ status: 'skipped', why: `playwright is not usable: ${e.message}`, checked: 0, playing: 0, not_playing: 0, tiles: [], not_checked: [] }));
  process.exit(0);
}

const deadline = Date.now() + budgetSeconds * 1000;
const out = { status: 'ok', checked: 0, playing: 0, not_playing: 0, tiles: [], not_checked: [], why: null };
const isDead = (e) => /closed|crash|target page/i.test(String(e && e.message));

const cardTitles = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.MuiCard-root')).map((c) => {
  const t = c.querySelector('.MuiCardHeader-title') || c.querySelector('.MuiTypography-root');
  return (t ? t.textContent : c.innerText || '').trim().split('\n')[0].trim();
}));
const read = (card) => card.evaluate((c) => {
  const v = c.querySelector('video');
  if (!v) return { readyState: -1, t: 0, w: 0, h: 0 };
  return { readyState: v.readyState, t: v.currentTime, w: v.videoWidth, h: v.videoHeight };
});
const brightest = (card) => card.evaluate((c) => {
  const v = c.querySelector('video');
  if (!v || !v.videoWidth) return null;
  const cv = document.createElement('canvas'); cv.width = v.videoWidth; cv.height = v.videoHeight;
  const cx = cv.getContext('2d'); cx.drawImage(v, 0, 0);
  const d = cx.getImageData(0, 0, cv.width, cv.height).data;
  let mx = 0;
  for (let i = 0; i < d.length; i += 4) { const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; if (l > mx) mx = l; }
  return Math.round(mx);
});
const ident = (url) => {
  const m = String(url || '').match(/\/host\/([^/]+)\/stream\/([^/?]+)/);
  return m ? { host: decodeURIComponent(m[1]), capture: decodeURIComponent(m[2]) } : { host: null, capture: null };
};

for (const srv of servers) {
  let pageNo = 1;
  let restarts = 0;
  while (pageNo <= 12) {
    if (Date.now() > deadline) { out.not_checked.push({ name: '(the rest)', why: "the sweep's time budget ran out" }); break; }
    let browser = null;
    let ctx = null;
    let page = null;
    const reqs = [];
    const bad = [];
    try {
      browser = await chromium.launch({ headless: true });
      ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      // The picker reads the server list from localStorage, and only a URL that is IN the list is honoured (2026-11-11).
      await ctx.addInitScript((s) => {
        localStorage.setItem('virtualpytest:platformServers', JSON.stringify(s.platform));
        localStorage.setItem('selectedServer', s.url);
      }, { platform: (platformServers.length ? platformServers : servers).map((x) => ({
        name: x.name, url: x.url, enabled: true, sort_order: 0, reachable: true })), url: srv.url });
      page = await ctx.newPage();
      page.on('response', (r) => { if (r.status() >= 400 && HLS.test(r.url())) bad.push(`${r.status()} ${r.url()}`); });
      page.on('request', (r) => reqs.push({ at: Date.now(), url: r.url() }));
      page.on('requestfailed', (r) => {
        const e = (r.failure() && r.failure().errorText) || '';
        if (HLS.test(r.url()) && !/ABORTED/.test(e)) bad.push(`${e} ${r.url()}`);
      });
      // the grid loads late: 0 cards while the page reads "Checking authentication..."
      let loaded = false;
      await page.goto(`${app}/device-control?auto_signed=${encodeURIComponent(token)}`);
      for (let i = 0; i < 25; i++) {
        const n = await page.evaluate(() => document.querySelectorAll('.MuiCard-root').length);
        if (n > 0) { loaded = true; break; }
        await page.waitForTimeout(3000);
      }
      if (!loaded) {
        out.why = out.why || 'the device-control grid never loaded';
        out.not_checked.push({ name: '(the whole grid)', why: out.why });
        break;
      }
      await page.waitForTimeout(4000);            // let the grid's own requests (the snapshots) settle
      for (let p = 1; p < pageNo; p++) {         // walk to this page of the grid
        const next = page.locator('button[aria-label="Go to next page"]');
        if (!(await next.count()) || await next.first().isDisabled()) break;
        await next.first().click();
        await page.waitForTimeout(2500);
      }

      const names = await cardTitles(page);
      const results = [];
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (!name) continue;
        if (Date.now() > deadline) { out.not_checked.push({ name, why: "the sweep's time budget ran out" }); continue; }
        const card = page.locator('.MuiCard-root').nth(i);
        let r = null;
        try {
          r = await probe(page, card, name, reqs, bad);
        } catch (e) {
          if (isDead(e)) throw e;                // the page died: this page is done, the grid is relaunched
          r = { name, host: null, capture: null, readyState: -1, dt: null, bright: null, plays: false, error: String(e.message).slice(0, 80) };
        }
        if (r) {
          if (r.plays === false && evidenceDir) {
            // The frame of a tile that does not play: the night's evidence, next to the report.
            try {
              const file = `${evidenceDir}/tile-${String(r.host || 'host').replace(/\W+/g, '_')}-${String(r.capture || 'cap').replace(/\W+/g, '_')}.png`;
              await card.screenshot({ path: file });
              r.shot = file;
            } catch (e) { /* the frame is a nicety: the verdict stands without it */ }
          }
          results.push(r);
          out.tiles.push(r);        // kept as it is: a page that dies later must not lose the tiles already read
        }
      }
      // the tiles of this page are already in out.tiles (they are pushed as they are read)

      // A tile that reads broken inside the sweep is probed again on its own: the sweep's load can read a playing
      // tile as black (2026-11-27: three tiles of the pi4 grid read broken and played at once).
      for (const t of results.filter((x) => x.plays === false && x.capture)) {
        if (Date.now() > deadline) { t.reprobe = 'the time budget ran out'; continue; }
        try {
          const card = page.locator('.MuiCard-root').filter({ hasText: t.name }).first();
          if (await card.count()) {
            const again = await probe(page, card, t.name, reqs, bad);
            if (again && again.plays) { t.plays = true; t.reprobe = 'plays on its own'; t.readyState = again.readyState; t.dt = again.dt; t.bright = again.bright; }
            else if (again) { t.reprobe = 'still broken on its own'; }
          } else { t.reprobe = 'the card was not found again'; }
        } catch (e) { if (isDead(e)) throw e; t.reprobe = `the re-probe failed: ${String(e.message).slice(0, 60)}`; }
      }

      const next = page.locator('button[aria-label="Go to next page"]');
      if (!(await next.count()) || await next.first().isDisabled()) break;
      pageNo++;
    } catch (e) {
      if (isDead(e) && restarts < 4) {
        restarts++;
        await new Promise((r) => setTimeout(r, 5000));   // the app may still be serving the dead browser's streams
        continue;                                // the same page again, with a fresh browser
      }
      out.why = out.why || `the tile sweep failed on page ${pageNo}: ${String(e.message).slice(0, 140)}`;
      out.not_checked.push({ name: `(page ${pageNo} and the rest)`, why: out.why });
      break;
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }
}

async function probe(page, card, name, reqs, bad) {
  const before = bad.length;
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  if (!box) return { name, host: null, capture: null, readyState: -1, dt: null, bright: null, plays: false, why: 'the card has no box' };
  const round = async () => {
    await page.mouse.move(5, 5);                 // leave the grid: the previous tile's player stops
    await page.waitForTimeout(600);
    const mark = Date.now();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);   // the live player only loads on hover
    let a = null;
    for (let i = 0; i * 500 < perCardTimeoutMs; i++) {
      await page.waitForTimeout(500);
      a = await read(card);
      if (!a) break;
      if (a.readyState === -1) {
        // A card with no live player at all (a drone, a PC screen) never gets one: do not spend the whole card
        // budget on it. The app may add the player a moment after the hover, so it gets a few tries first.
        if (i >= 3 && !reqs.some((r) => r.at >= mark && /output\.m3u8/.test(r.url))) break;
        continue;
      }
      if (a.readyState >= 2) break;              // the player has the picture
      // A live player can sit at readyState 1 while it shows a bright picture and its clock moves (measured on
      // FR Kids 2 on 2026-11-27: readyState 1 at 4 s, 4 at 6 s, alone; under the grid it never passed 1).
      // Waiting for readyState 2 would read healthy tiles as broken, so the clock decides instead.
      if (i >= 2 && a.t > 0) break;
    }
    await page.waitForTimeout(2000);
    const z = await read(card);
    const bright = await brightest(card);
    const first = reqs.find((r) => r.at >= mark && /output\.m3u8/.test(r.url));
    return { a, z, bright, id: ident(first ? first.url : '') };
  };
  let r = await round();
  const moving = (x) => !!(x && x.a && x.z.t - x.a.t > 0 && x.bright !== null && x.bright > 32);
  if (!r.id.capture && r.z.readyState >= 0 && !moving(r)) {
    // The player did not start on the first hover (the grid can still be settling): one more round.
    r = await round();
  }
  if (r.z.readyState === -1) {
    // The card carries no live player at all: a drone, a PC screen, a device the grid shows as a picture.
    // It is not a stream tile, so it is not a broken tile either: it gets no verdict and no frame.
    return { name, host: null, capture: null, readyState: -1, dt: null, bright: null, size: '0x0',
             plays: null, kind: 'no-video', hls_failures: 0 };
  }
  // Only the failures of this tile count: one broken tile must not condemn the rest of the grid.
  const own = bad.length - before;
  // The verdict lives in its own module (scripts/agent/rtsp_tile_verdict.mjs): the clock and the picture decide,
  // readyState 2 is not the bar (FR Kids 2, 2026-11-27).
  const plays = tileVerdict({ readyState: r.z.readyState, dt: r.a ? +(r.z.t - r.a.t).toFixed(2) : null,
                              bright: r.bright, hlsFailures: own });
  return { name, host: r.id.host, capture: r.id.capture, readyState: r.z.readyState,
           dt: r.a ? +(r.z.t - r.a.t).toFixed(2) : null, bright: r.bright, size: `${r.z.w}x${r.z.h}`,
           plays, kind: 'stream', hls_failures: own };
}

out.checked = out.tiles.filter((t) => t.plays === true || t.plays === false).length;
out.playing = out.tiles.filter((t) => t.plays === true).length;
out.not_playing = out.tiles.filter((t) => t.plays === false).length;
// The cards that carry no live player (a drone, a PC screen): seen, but they are not stream tiles and they are
// never broken ones.
out.no_video = out.tiles.filter((t) => t.plays === null || t.plays === undefined).length;
// A sweep that read some tiles and could not finish is 'partial' (what it read stands, the rest is named);
// a sweep that read nothing is 'skipped' (the layer did not run: never a false 'ok').
if (out.why) out.status = out.checked ? 'partial' : 'skipped';
process.stdout.write(JSON.stringify(out));

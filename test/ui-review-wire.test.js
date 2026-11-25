// The needs-owner hold through the real server (the wiring a unit test cannot see: the first version listened on the wrong
// alert and never held anything). An isolated tmux socket, a stand-in agent pane that ends a turn on needs-owner, a stand-in
// reviewer committed on a throwaway product repo, a temp state folder. No live session is touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { makeWorld } from './helpers-lane.js';
import { tmp } from './helpers-tmp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();
const cleanups = [];
after(() => cleanups.forEach((f) => { try { f(); } catch { /* gone */ } }));

test('a needs-owner stop on a visual is held by the running server and sent back into the session', { timeout: 120_000, skip: !hasTmux && 'no tmux' }, async () => {
  const base = tmp('uir-wire-'), state = join(base, 'state'), home = join(base, 'home'), bin = join(base, 'bin');
  [state, home, bin].forEach((d) => mkdirSync(d, { recursive: true }));
  const REVIEWER = 'import sys\nprint("| text.words_per_line | FAIL | 19 words/line |")\nprint("ui-review: uir-1 fail")\nsys.exit(1)\n';
  const w = makeWorld({ base: { 'VERSION.txt': '1\n', 'scripts/review/ui_review_gate.py': '', 'scripts/review/ui_review.py': REVIEWER } });
  const poster = join(base, 'poster.html'); writeFileSync(poster, '<html></html>');
  writeFileSync(join(state, 'integration.json'), JSON.stringify({ repos: { vpt: { ...w.cfg(), uiReview: { paths: ['^frontend/'], from: w.lane, repo: 'virtualpytest' } } } }));
  writeFileSync(join(state, 'manager.json'), JSON.stringify({ enabled: true, aiTriage: 'off' }));
  const socket = `uirwire${process.pid}`, tmuxBin = join(bin, 'tmux'), got = join(base, 'typed.txt'), go = join(base, 'go');
  writeFileSync(tmuxBin, `#!/bin/sh\nexec ${execFileSync('sh', ['-c', 'command -v tmux']).toString().trim()} -L ${socket} "$@"\n`); chmodSync(tmuxBin, 0o755);
  // the stand-in agent: works until told, then ends its turn on needs-owner and records what is typed to it
  writeFileSync(join(bin, 'claude'), `#!/bin/bash
echo "> make the poster"
while [ ! -f ${go} ]; do printf '\\r\\033[K* Working... (%ss · esc to interrupt)' $SECONDS; sleep 0.5; done
printf '\\r\\033[K'
printf '● The poster mockup is ready: ${poster}\\n\\n  STATUS: needs-owner: poster mockup; 1 = ship / 2 = change\\n\\n✻ Crunched for 12s\\n\\n'
printf '──────────────────────────────\\n❯ \\n──────────────────────────────\\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\\n'
cat >> ${got}
`);
  chmodSync(join(bin, 'claude'), 0o755);
  execFileSync(tmuxBin, ['new-session', '-d', '-s', 'poster-session', '-x', '200', '-y', '50', join(bin, 'claude')]);
  cleanups.push(() => rmSync(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, socket), { force: true }));
  cleanups.unshift(() => execFileSync(tmuxBin, ['kill-server']));
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', HOST: '127.0.0.1', PORT: String(port), GHOSTY_STATE_DIR: state, TMUX_BIN: tmuxBin, GHOSTY_NO_UI_REVIEW_NIGHTLY: '1',
    TLS_KEY: join(base, 'none.pem'), TLS_CERT: join(base, 'none.pem'), TICK_MS: '500' };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  cleanups.push(() => child.kill('SIGKILL'));
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; ; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/sessions`)).ok) break; } catch { /* not up */ } if (i > 150) throw new Error(`no server:\n${log}`); await sleep(100); }
  await sleep(4000);   // seen working first: ghosty alerts on changes, never on first sight
  writeFileSync(go, '1');
  const journal = join(state, 'ui-review-ask.jsonl');
  let typed = '';
  for (let i = 0; i < 160 && !/UI review \(run by ghosty/.test(typed); i++) { await sleep(500); typed = existsSync(got) ? readFileSync(got, 'utf8') : ''; }
  const why = () => `${log.slice(-3000)}\n--- pane\n${execFileSync(tmuxBin, ['capture-pane', '-p', '-t', 'poster-session']).toString()}`;
  assert.match(typed, /UI review \(run by ghosty, round 1 of 2\)/, why());
  assert.match(typed, /19 words\/line/);
  for (let i = 0; i < 60 && !existsSync(journal); i++) await sleep(500);   // written once the send returned
  assert.match(readFileSync(journal, 'utf8'), /"held":true/);
  const feed = await (await fetch(`http://127.0.0.1:${port}/api/push/feed?since=0`)).json();
  assert.equal(feed.items.filter((x) => /poster-session/.test(x.title)).length, 0, 'the owner was not pushed');
});

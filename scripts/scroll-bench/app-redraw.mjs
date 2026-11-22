// How long a fullscreen app (Claude Code) takes to redraw after wheel notches, measured the way server.js does it (POST /api/scroll):
// SGR wheel bytes typed with `tmux send-keys -H`, then capture-pane polled until the pane changes and until it stops changing.
// Run it ONLY against a throwaway session on a private tmux socket:  node app-redraw.mjs <tmux socket name> <session> [notches,...]
import { execFileSync } from 'node:child_process';
const [sock, session, list = '1,1,1,1,1,5,5,20,60'] = process.argv.slice(2);
const tmux = (...a) => execFileSync('tmux', ['-L', sock, ...a]).toString();
const cap = () => tmux('capture-pane', '-p', '-e', '-t', `=${session}:`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [cols, rows] = tmux('display', '-p', '-t', `=${session}:`, '#{pane_width} #{pane_height}').trim().split(' ').map(Number);
const hex = (dir) => Array.from(`\x1b[<${dir === 'up' ? 64 : 65};${Math.floor(cols / 2)};${Math.floor(rows / 3)}M`, (c) => c.charCodeAt(0).toString(16).padStart(2, '0'));
// rows the text moved between two captures: the shift that lines the two screens up best
function shift(a, b) {
  const A = a.split('\n'), B = b.split('\n'); let best = 0, score = -1;
  for (let k = 0; k < A.length - 3; k++) { let s = 0; for (let i = 0; i + k < B.length && i < A.length; i++) if (A[i].trim() && A[i] === B[i + k]) s++; if (s > score) { score = s; best = k; } }
  return best;
}
const t0 = Date.now(); for (let i = 0; i < 20; i++) cap(); const capMs = (Date.now() - t0) / 20;
console.log(JSON.stringify({ pane: `${cols}x${rows}`, capture_pane_ms: +capMs.toFixed(1) }));
for (const n of list.split(',').map(Number)) {
  const before = cap();
  const t = Date.now();
  tmux('send-keys', '-t', `=${session}:`, '-H', ...Array.from({ length: n }, () => hex('up')).flat());
  const sent = Date.now() - t;
  let first = null, last = null, prev = before, changes = 0;
  while (Date.now() - t < 3000) {
    const now = cap();
    if (now !== prev) { changes++; last = Date.now() - t; if (first == null) first = last; prev = now; }
    else if (last != null && Date.now() - t - last > 250) break;
    await sleep(3);
  }
  console.log(JSON.stringify({ notches: n, send_keys_ms: sent, first_change_ms: first, last_change_ms: last, repaints_seen: changes, rows_moved: shift(before, prev) }));
  await sleep(300);
}

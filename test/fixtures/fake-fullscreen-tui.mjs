// A stand-in for Claude Code's fullscreen TUI: alternate screen, SGR mouse tracking, a 300-line transcript it scrolls itself
// (wheel = 3 lines, PageUp / PageDown = a page, ctrl+End = the bottom; NO_MOUSE=1: no mouse tracking). Any other input byte is logged to STRAY_LOG: a scroll must never type text.
import fs from 'node:fs';

const N = 300, STEP = 3;
const stray = process.env.STRAY_LOG || '/dev/null';
let off = 0;   // lines scrolled up from the bottom
const size = () => ({ rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 });
function draw() {
  const { rows } = size();
  const h = rows - 1, maxOff = Math.max(0, N - h);
  off = Math.max(0, Math.min(maxOff, off));
  const first = N - h - off;
  let s = '\x1b[H';
  for (let i = 0; i < h; i++) s += `msg ${String(first + i).padStart(3, '0')} of the transcript\x1b[K\r\n`;
  s += `\x1b[7m off=${off} \x1b[0m\x1b[K`;
  process.stdout.write(s);
}
process.stdout.write(process.env.NO_MOUSE ? '\x1b[?1049h\x1b[?25l' : '\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?25l');   // NO_MOUSE: a fullscreen app without mouse tracking
process.stdin.setRawMode(true);
process.stdin.on('data', (buf) => {
  let s = buf.toString('latin1');
  const page = size().rows - 2;
  s = s.replace(/\x1b\[<(\d+);\d+;\d+[Mm]/g, (_, b) => { if (b === '64') off += STEP; else if (b === '65') off -= STEP; return ''; });
  s = s.replace(/\x1b\[5~/g, () => { off += page; return ''; }).replace(/\x1b\[6~/g, () => { off -= page; return ''; }).replace(/\x1b\[1;5F/g, () => { off = 0; return ''; });   // ctrl+End: jump to the bottom, as Claude Code
  if (s) fs.appendFileSync(stray, s);
  draw();
});
process.stdout.on('resize', draw);
draw();

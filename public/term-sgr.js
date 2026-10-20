// xterm.js paints every row that scrolls in with the CURRENT background (erase uses the active SGR bg), so a pane snapshot
// whose grey user-message line is still "open" at a newline turned the blank row after it, and the start of the next
// row, grey across the whole width. Close the background before each newline and re-open it after, so a wrapped
// highlighted line keeps its grey but the new row does not. tmux's `capture-pane -e` carries SGR state across lines.
const SGR = /\x1b\[([0-9;:]*)m/g;

// Returns the bg escape for the state after applying one SGR parameter list, or null when the bg is the default.
function nextBg(params, bg) {
  const p = params === '' ? ['0'] : params.split(/[;:]/);
  for (let i = 0; i < p.length; i++) {
    const n = Number(p[i]);
    if (n === 0 || n === 49) bg = null;
    else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) bg = `\x1b[${n}m`;
    else if (n === 48 && p[i + 1] === '5') { bg = `\x1b[48;5;${p[i + 2]}m`; i += 2; }
    else if (n === 48 && p[i + 1] === '2') { bg = `\x1b[48;2;${p[i + 2]};${p[i + 3]};${p[i + 4]}m`; i += 4; }
    else if (n === 38 && p[i + 1] === '5') i += 2;
    else if (n === 38 && p[i + 1] === '2') i += 4;
  }
  return bg;
}

export function closeBgAtNewlines(text) {
  let bg = null, out = '', last = 0;
  const flush = (upto) => {
    const seg = text.slice(last, upto);
    out += bg ? seg.replace(/\n/g, `\x1b[49m\n${bg}`) : seg;
    last = upto;
  };
  for (const m of text.matchAll(SGR)) {
    flush(m.index);
    out += m[0]; last = m.index + m[0].length;
    bg = nextBg(m[1], bg);
  }
  flush(text.length);
  return out;
}

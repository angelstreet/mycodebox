// Three-way merge of a release note (docs/release_note/README.md) for the integration lane.
// Every session adds entries at the top of "## Unreleased > ### <section>", and main's stamping moves Unreleased entries
// into a "## build N" section, so a plain line union duplicates promoted entries or touches a shipped section (the
// "release note: ## build N differs from what tag carries" returns of 2026-11-10). Here the target's file is kept as is
// and only the entries the branch added under "## Unreleased" are re-applied, by section and by entry id.
// -> { ok: true, text, added } | { ok: false, error }   (null when a stage has no "## Unreleased": the caller falls back)

const UNRELEASED = /^##\s+Unreleased\s*$/i;
const isH2 = (l) => /^##\s/.test(l) && !/^###/.test(l);

// { head: lines before Unreleased, un: lines of the Unreleased block, rest: lines from the next "## " on }
function split(text) {
  const lines = String(text).split('\n');
  const a = lines.findIndex((l) => UNRELEASED.test(l));
  if (a < 0) return null;
  let b = lines.findIndex((l, i) => i > a && isH2(l));
  if (b < 0) b = lines.length;
  return { head: lines.slice(0, a), un: lines.slice(a, b), rest: lines.slice(b) };
}

// Unreleased block -> sections [{ title, at (line index of the heading, -1 for text before any), entries: [{ lines, text }] }]
function sections(un) {
  const out = [{ title: '', at: 0, entries: [] }];
  let cur = null;
  un.forEach((l, i) => {
    if (/^###\s/.test(l)) { out.push({ title: l.replace(/^###\s+/, '').trim(), at: i, entries: [] }); cur = null; return; }
    const s = out.at(-1);
    if (/^-\s/.test(l)) { cur = { lines: [l] }; s.entries.push(cur); }
    else if (cur && l.trim() && /^\s/.test(l)) cur.lines.push(l);   // an indented continuation belongs to the entry
    else cur = null;
  });
  for (const s of out) for (const e of s.entries) e.text = e.lines.join('\n');
  return out;
}

// the ids an entry cites: its first line's BUG-/TASK- numbers, or none
const ids = (e) => [...new Set(e.lines[0].match(/\b(?:BUG|TASK)-\d+\b/g) || [])].sort();
const allIds = (lines) => new Set(lines.join('\n').match(/\b(?:BUG|TASK)-\d+\b/g) || []);

export function mergeReleaseNote(base, ours, theirs) {
  const B = split(base), O = split(ours), T = split(theirs);
  if (!B || !O || !T) return null;
  // the branch may not edit a shipped section (anything below Unreleased) nor the head: main's are kept byte for byte
  const rb = B.rest.join('\n'), rt = T.rest.join('\n'), ro = O.rest.join('\n');
  if (rt !== rb && rt !== ro) {
    const had = new Set(B.rest);
    const changed = [...new Set(T.rest.filter((l) => !had.has(l)))].filter((l) => l.trim()).slice(0, 3).map((l) => l.slice(0, 90));
    return { ok: false, error: `the branch edits a shipped release-note section (below "## Unreleased"): ${changed.map((l) => JSON.stringify(l)).join('; ') || 'lines removed'}; keep main's shipped sections` };
  }
  const baseTexts = new Set(sections(B.un).flatMap((s) => s.entries.map((e) => e.text)));
  const shipped = allIds(O.rest);
  const oursSec = sections(O.un);
  const have = new Set(oursSec.flatMap((s) => s.entries.map((e) => e.text)));
  const haveIds = new Set(oursSec.flatMap((s) => s.entries.map((e) => ids(e).join(','))).filter(Boolean));
  const plan = [];   // { title, entry }
  for (const s of sections(T.un)) for (const e of s.entries) {
    if (baseTexts.has(e.text) || have.has(e.text)) continue;          // not the branch's own addition, or already there
    const k = ids(e);
    if (k.length && (haveIds.has(k.join(',')) || k.every((i) => shipped.has(i)))) continue;   // same entry id already in Unreleased, or already shipped by main
    plan.push({ title: s.title, entry: e });
  }
  const un = [...O.un];
  const byTitle = new Map();
  for (const p of plan) byTitle.set(p.title, [...(byTitle.get(p.title) || []), p.entry]);
  // insert at the top of each section (below its heading, blank lines kept above main's first entry); unknown sections go last
  const secs = sections(un);
  const inserts = [];
  const extra = [];
  for (const [title, list] of byTitle) {
    const sec = secs.find((s) => s.title === title && title);
    const lines = list.flatMap((e) => e.lines);
    if (sec) {
      let at = sec.at + 1;
      if (at < un.length && !un[at].trim()) at++;   // below the blank line the heading has
      inserts.push({ at, lines });
    } else extra.push(...(title ? ['', `### ${title}`, ''] : []), ...lines);
  }
  inserts.sort((x, y) => y.at - x.at).forEach((x) => un.splice(x.at, 0, ...x.lines));
  if (extra.length) {
    let end = un.length;
    while (end > 0 && !un[end - 1].trim()) end--;
    un.splice(end, 0, ...extra);
  }
  const text = [...O.head, ...un, ...O.rest].join('\n');
  return { ok: true, text, added: plan.length };
}

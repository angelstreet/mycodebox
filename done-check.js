// Done check (owner/manager, 2026-10-15): a session's "STATUS: done" is checked against git, not trusted. TASK59 said
// "shipped, nothing pending" with 7 commits that were never on main. Every 5 min, for each idle session whose last STATUS
// is done: commits on its checkout (and on the branches / worktrees its closing text names) that are not on origin/main (equivalent patches count as merged; VERSION.txt-only
// stamps ignored) and uncommitted tracked files. A mismatch gets one feed line and one message to the session (while it
// is idle and the host is not busy), once per finding. Switch: manager.json `doneCheck` "live" (default) | "dry" | "off".
// Journal: done-check.jsonl.
import { pushableItems } from './done-leftovers.js';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Long-lived branches (owner, 2026-10-28): a session that merely sat in a checkout of one (the manager's task44-ai-manager, 13 commits
// ahead of main by design) is not judged on it: 3 false wakes in a day. manager.json `doneCheckIgnoreBranches`, default below.
export const DEFAULT_IGNORE_BRANCHES = ['task44-ai-manager'];
export const POLL_MS = 5 * 60 * 1000;
const FETCH_EVERY_MS = 30 * 60 * 1000;
const MAX_NUDGES_PER_TICK = 2;
const MAX_LOAD_PER_CORE = 1.5, MIN_RAM_AVAIL_PCT = 20;
const IGNORED = ['VERSION.txt'];   // build stamps a hook rewrites on every commit

// Pure. facts: one checkout's { branch, notOnMain: [{sha, subject}], uncommitted: [path], where? }, or a list of them
// (the session's folder plus the branches / worktrees it names) -> a finding, or null when git agrees with "done".
export function finding(facts) {
  const list = (Array.isArray(facts) ? facts : [facts]).filter(Boolean);
  const parts = [];
  for (const f of list) {
    const at = f.where ? ` in ${f.where}` : '';
    if (f.notOnMain.length) parts.push(`${f.notOnMain.length} commit(s) on ${f.branch || 'HEAD'}${at} not on main (${f.notOnMain.slice(0, 3).map((c) => c.sha).join(', ')})`);
    if (f.uncommitted?.length) parts.push(`${f.uncommitted.length} uncommitted file(s)${at} (${f.uncommitted.slice(0, 3).join(', ')})`);
  }
  return parts.length ? { text: parts.join('; '), sig: createHash('sha1').update(JSON.stringify(list.map((f) => [f.branch, f.where, f.notOnMain.map((c) => c.sha), f.uncommitted]))).digest('hex').slice(0, 12) } : null;
}

// Pure. Branch names and absolute / ~ paths a closing text names (candidates only; git decides which exist).
export function namedRefs(text, home = '') {
  const t = String(text || '');
  const paths = [...new Set((t.match(/(?:~|\/home\/[\w.-]+)\/[\w.\/-]+/g) || []).map((x) => x.replace(/^~/, home).replace(/[.,;:)]+$/, '')))].slice(0, 5);
  const words = [...new Set((t.match(/\b[a-z][\w.-]*[\/-][\w.\/-]*[\w]\b/gi) || []).filter((w) => !w.includes('//') && !/^(?:origin\/)?(?:main|master|HEAD)$/.test(w) && w.length <= 80))].slice(0, 12);
  return { paths, branches: words.map((w) => w.replace(/^origin\//, '')) };
}

// (A) Found-bugs enforcement (owner, 2026-10-28): a `STATUS: done` line carries `bugs: none | fixed <what> | reported <id>`.
// Pure. text: the closing text. -> { value } when the last STATUS is a literal done (aliases such as "acknowledged" are not
// checked) and carries the field (value: none | fixed | reported), { missing: true } when it does not, null when the last
// STATUS is not done. Pane-wrapped continuation lines (indented) belong to the STATUS line.
export function bugsFieldOf(text) {
  const lines = String(text || '').split('\n');
  let at = -1;
  lines.forEach((l, i) => { if (/^\W*STATUS:/i.test(l.trim())) at = i; });
  if (at < 0) return null;
  let line = lines[at].trim();
  for (let j = at + 1; j < lines.length && /^\s{2,}\S/.test(lines[j]) && !/^\W*STATUS:/i.test(lines[j].trim()); j++) line += ' ' + lines[j].trim();
  if (!/^\W*STATUS:[*_`]*\s*done\b/i.test(line)) return null;
  const m = /\bbugs\s*[:=]\s*[*_`]*(none|fixed|reported)\b/i.exec(line);
  return m ? { value: m[1].toLowerCase() } : { missing: true };
}
export const BUGS_COOLDOWN_MS = 12 * 3600 * 1000;   // one automatic push per session per 12 h, whatever the next STATUS line looks like
export function bugsMessage() {
  return 'Done check: your STATUS: done line has no bugs field. Add `bugs: none | fixed <what> | reported <id>` to it (for example `STATUS: done — branch x merged; bugs: none`). If you saw anything outside your scope that errored, misbehaved or that you worked around, fix it or run `found-bug --title ... --error ...` first. End with a STATUS line.';
}

// (C) Closing review (owner, 2026-11-10): agents wrote a clean `STATUS: done` and only the owner's "any leftover, suggestion of
// improvement or doc to update before we close?" showed it was not done (3 sessions on 2026-11-09). A done line carries
// `closing review: docs <updated list|none needed> · leftovers <none|filed ids> · unverified <none|list>`.
// Pure. -> null when the last STATUS is not a literal done; { missing: true } without the segment (or with a part absent:
// `parts` lists the missing ones); else { docs, leftovers, unverified, openLeftovers } where openLeftovers is the leftovers text
// when it is neither none nor filed ids (bug-/idea-/int- ids), i.e. work named but neither fixed nor filed.
const REVIEW_PARTS = ['docs', 'leftovers', 'unverified'];
export function closingReviewOf(text) {
  const lines = String(text || '').split('\n');
  let at = -1;
  lines.forEach((l, i) => { if (/^\W*STATUS:/i.test(l.trim())) at = i; });
  if (at < 0) return null;
  let line = lines[at].trim();
  for (let j = at + 1; j < lines.length && /^\s{2,}\S/.test(lines[j]) && !/^\W*STATUS:/i.test(lines[j].trim()); j++) line += ' ' + lines[j].trim();
  if (!/^\W*STATUS:[*_`]*\s*done\b/i.test(line)) return null;
  const seg = /\bclosing[ -]review\s*[:=]\s*(.*)$/i.exec(line.replace(/[*_`]+/g, ''));
  if (!seg) return { missing: true, parts: REVIEW_PARTS };
  const body = seg[1].replace(/[;|]\s*bugs\s*[:=].*$/i, '');
  const out = {};
  for (const k of REVIEW_PARTS) {
    const m = new RegExp(`\\b${k}\\s*:?\\s+(.+?)(?=\\s*[·;|]\\s*(?:${REVIEW_PARTS.join('|')}|bugs)\\b|\\s+(?:${REVIEW_PARTS.filter((x) => x !== k).join('|')})\\s*:|$)`, 'i').exec(body);
    if (m) out[k] = m[1].trim().replace(/[.,;·\s]+$/, '');
  }
  const absent = REVIEW_PARTS.filter((k) => !out[k]);
  if (absent.length) return { missing: true, parts: absent };
  const l = out.leftovers;
  out.openLeftovers = /^(?:none|nothing|n\/a|-)\b/i.test(l) || /^(?:(?:filed|reported)\s*)?(?:[\w]+-[0-9a-f]{6,}[\s,]*)+$/i.test(l) ? null : l;
  return out;
}
export function closingReviewMessage({ bugsMissing = false } = {}) {
  return 'Done check: your STATUS: done line has no closing review. Before we close this session: any leftover, suggestion of improvement, or doc / skill to update? Do it now, then rewrite the done line. '
    + '(1) Docs: list every doc your change makes stale (task doc, REFERENCE / MAP / INDEX, user guide, skill, API inventory, release note) and update it now, in the repo, not as a draft in a scratchpad. '
    + '(2) Leftovers: fix each one now, or file it with `found-bug --title ... --blocking no`. '
    + '(3) Suggestions for improvement: file each as a `found-bug` record (title starts with "idea:"), not prose. '
    + '(4) List what you did NOT verify. '
    + 'Then end with `STATUS: done — <what> · closing review: docs <updated list|none needed> · leftovers <none|filed ids> · unverified <none|list>'
    + (bugsMissing ? ' · bugs: none | fixed <what> | reported <id>`.' : '` (keep the bugs: field).');
}

// Owner rule 2026-11-03: a session ends only when everything is finished. `STATUS: done` with leftovers, `STATUS: not fully confirmed`
// and `STATUS: partial` are not end states: the session is sent back to finish. Real stops are waiting: / blocked: / needs-owner: / needs-manager:.
export const LEFT_PUSHES_PER_DAY = 3;
export const REVIEW_PUSHES_PER_DAY = 3;
export const REVIEW_MAX_AGE_MS = 6 * 3600 * 1000;   // only recent done turns: old idle sessions are not woken by the rollout
const lastStatusLine = (text) => { const l = String(text || '').split('\n').filter((x) => /^\W*STATUS:/i.test(x.trim())); return l[l.length - 1] || ''; };
export function leftoversMessage(items) {
  return `Done check: your STATUS is not an end state, work is still left: ${items.slice(0, 3).join(' | ').slice(0, 280)}. Finish it now. The only acceptable stops are \`STATUS: waiting: <system wait id>\`, \`STATUS: blocked: <hard-floor/physical/lease reason + what you tried>\` or \`STATUS: needs-owner:\` for a hard-floor item. Never ask the owner for anything you can do yourself. "Not fully confirmed" is not an end state.`;
}
// Pure. The last STATUS line of the text, if it is a literal not-fully-confirmed / partial -> the remaining list ('' when none named), else null.
export function unconfirmedStatusOf(text) {
  const lines = String(text || '').split('\n');
  let at = -1;
  lines.forEach((l, i) => { if (/^\W*STATUS:/i.test(l.trim())) at = i; });
  if (at < 0) return null;
  let line = lines[at].trim();
  for (let j = at + 1; j < lines.length && /^\s{2,}\S/.test(lines[j]) && !/^\W*STATUS:/i.test(lines[j].trim()); j++) line += ' ' + lines[j].trim();
  const m = /^\W*STATUS:[*_`]*\s*(?:not fully confirmed|partial)\b[*_`]*[\s:—–-]*(.*)$/i.exec(line);
  return m ? m[1].trim() : null;
}
// (D) Wait while an equivalent is free (owner 2026-11-10): a final `STATUS: waiting: lease ...` / `ticket ...` is not accepted while the
// session's own ticket has a healthy free equivalent (lease service `equivalents_free`). One push with the exact command; the manager is
// told when a later stop (a different STATUS line) still waits on that ticket. Pure. -> true when the last STATUS is a lease/ticket wait.
export function waitingOnLeaseStatus(text) {
  const line = lastStatusLine(text);
  return /^\W*STATUS:[*_`]*\s*waiting\b/i.test(line) && /\b(?:lease|ticket|t-[0-9a-f]{6,}|vpt-lease|device\d*|host)\b/i.test(line);
}
export function equivalentWaitMessage(eq) {
  const r = (eq.resources || []).join(',') || '?';
  const cmd = `vpt-lease ticket ${eq.ticketId} --cancel && vpt-lease claim ${eq.env} ${eq.equivalents[0]} --agent ${eq.agent || '<your agent>'} --kind host --wait`;
  return `Done check: your STATUS: waiting line is not accepted: your ticket ${eq.ticketId} on ${eq.env}/${r} waits while a healthy equivalent is free now (${eq.equivalents.slice(0, 4).join(', ')}). Never wait on a named device while an equivalent is free. Run: ${cmd}  (next time claim ${eq.env} --any ${eq.group || '<group>'} --wait, see vpt-lease inventory ${eq.env}). Then continue with your work. If your work needs exactly ${r} (a model, firmware or account only it has), say why in the STATUS line and use --no-auto-equivalent.`;
}
export function leftoverItemsOf(text) {
  const items = pushableItems(text) || [];
  const m = /^\W*STATUS:\s*(?:done|ok|complete|completed|finished)\b.*?\bnot fully confirmed\b[:\s-]*(.*)$/im.exec(String(text || ''));
  if (m) items.push(`not fully confirmed${m[1] ? ': ' + m[1].trim() : ''}`);
  const cr = closingReviewOf(text);
  if (cr?.openLeftovers) items.push(`closing review leftovers: ${cr.openLeftovers}`);
  const u = unconfirmedStatusOf(text);
  if (u !== null) items.push(`not fully confirmed${u ? ': ' + u : ''}`);
  return items;
}

export function message(f) {
  return `Done check: your STATUS says done, but git disagrees: ${f.text}. Finish it the normal way (commit, merge to main when the merge evaluation passes, push, deploy if needed), or reply with one line saying why it stays as is. End with a STATUS line.`;
}

// Parse `git status --porcelain --untracked-files=no` lines into paths, minus ignored stamps.
export function uncommittedOf(porcelain) {
  return String(porcelain || '').split('\n').filter(Boolean).map((l) => l.slice(3).split(' -> ').pop().trim()).filter((p) => p && !IGNORED.includes(p));
}

export function createDoneCheck({
  stateDir, git, listDone, send, record = async () => {}, equivalentOf = async () => null, mode = () => 'live', home = process.env.HOME || '',
  pressure = () => ({ loadPerCore: 0, ramAvailPct: 100 }), now = Date.now, pollMs = POLL_MS, log = console, ignoreBranches = () => DEFAULT_IGNORE_BRANCHES,
} = {}) {
  const stFile = join(stateDir, 'done-check.json');
  const journal = join(stateDir, 'done-check.jsonl');
  const fetchedAt = new Map();   // repo common dir -> ms
  let last = { at: 0, mode: 'off', checked: 0, findings: [] };
  let timer = null, busy = false;

  async function load() { try { return JSON.parse(await readFile(stFile, 'utf8')); } catch { return { told: {} }; } }
  async function save(st) { await mkdir(stateDir, { recursive: true }); await writeFile(stFile, JSON.stringify(st)); }
  async function note(e) { try { await appendFile(journal, JSON.stringify({ at: new Date(now()).toISOString(), ...e }) + '\n'); } catch {} }

  // Commits of a ref not on base (equivalent patches count as merged, stamps ignored). Content that reached main through
  // other commits (a squash, a resolved cherry-pick) counts as merged too: a trial merge into base that is clean and
  // leaves base's tree unchanged means there is nothing left to land.
  async function notOnMainOf(cwd, base, ref) {
    const log = await git(cwd, ['log', '--format=%h%x09%s', '--no-merges', '--cherry-pick', '--right-only', `${base}...${ref}`, '--', '.', ...IGNORED.map((p) => `:(exclude)${p}`)]).catch(() => '');
    const commits = log.split('\n').filter(Boolean).map((l) => { const [sha, ...s] = l.split('\t'); return { sha, subject: s.join('\t') }; });
    if (!commits.length) return commits;
    try {
      const merged = (await git(cwd, ['merge-tree', '--write-tree', base, ref])).split('\n')[0].trim();
      const changed = (await git(cwd, ['diff', '--name-only', base, merged, '--', '.', ...IGNORED.map((p) => `:(exclude)${p}`)])).trim();
      if (merged && !changed) return [];
    } catch {}   // a conflicting trial merge exits non-zero: the commits stand
    return commits;
  }

  // The session's folder, plus the branches and worktree paths its closing text names that exist in that repo.
  async function allFactsOf(cwd, text) {
    const own = await factsOf(cwd);
    if (!own) return [];
    const out = [own];
    const { paths, branches } = namedRefs(text, home);
    for (const p of paths) {
      if (p === cwd) continue;
      const f = await factsOf(p).catch(() => null);
      if (f && (f.notOnMain.length || f.uncommitted.length)) out.push({ ...f, where: p });
    }
    const ign = new Set(ignoreBranches());
    for (const b of branches) {
      if (b === own.branch || ign.has(b)) continue;
      let ref = null;
      for (const r of [`refs/heads/${b}`, `refs/remotes/origin/${b}`]) { try { await git(cwd, ['rev-parse', '-q', '--verify', r]); ref = r; break; } catch {} }
      if (!ref) continue;
      const notOnMain = await notOnMainOf(cwd, own.base, ref);
      if (notOnMain.length) out.push({ branch: b, notOnMain, uncommitted: [] });
    }
    return out;
  }

  // Git facts of a checkout, or null (not a repo, no origin/main).
  async function factsOf(cwd) {
    let common;
    try { common = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(); } catch { return null; }
    if (now() - (fetchedAt.get(common) || 0) > FETCH_EVERY_MS) { fetchedAt.set(common, now()); try { await git(cwd, ['fetch', '-q', 'origin']); } catch {} }
    let base = null;
    for (const b of ['origin/main', 'origin/master']) { try { await git(cwd, ['rev-parse', '-q', '--verify', b]); base = b; break; } catch {} }
    if (!base) return null;
    const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
    // On a long-lived branch, or a detached HEAD that is part of one: nothing to judge (the session did not work here).
    const ign = ignoreBranches();
    if (ign.includes(branch)) return { branch, base, notOnMain: [], uncommitted: [], ignored: true };
    if (branch === 'HEAD') {
      for (const b of ign) for (const r of [`refs/heads/${b}`, `refs/remotes/origin/${b}`]) {
        try { await git(cwd, ['rev-parse', '-q', '--verify', r]); await git(cwd, ['merge-base', '--is-ancestor', 'HEAD', r]); return { branch: null, base, notOnMain: [], uncommitted: [], ignored: true }; } catch {}
      }
    }
    // Uncommitted files only count in a linked worktree: the repo's main checkout is shared by many sessions (three TASK103
    // sessions sat in it with someone else's 10 uncommitted files, 2026-10-15), so its dirt cannot be attributed.
    const gitDir = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir']).catch(() => '')).trim();
    const shared = !gitDir || gitDir === common;
    // The main checkout can be occupied by several sessions. Its commits are
    // not attributable to the session being checked, so never blame them.
    const notOnMain = shared ? [] : await notOnMainOf(cwd, base, 'HEAD');
    const uncommitted = shared ? [] : uncommittedOf(await git(cwd, ['status', '--porcelain', '--untracked-files=no']).catch(() => ''));
    return { branch: branch === 'HEAD' ? null : branch, base, notOnMain, uncommitted };
  }

  async function tick() {
    if (busy) return last;
    busy = true;
    try {
      const m = mode();
      if (m === 'off') return (last = { at: now(), mode: m, checked: 0, findings: [] });
      const sessions = await listDone();
      const st = await load();
      const live = new Set(sessions.map((s) => s.name));
      for (const n of Object.keys(st.told)) if (!live.has(n)) delete st.told[n];
      const findings = [];
      for (const s of sessions) {
        const f = finding(await allFactsOf(s.cwd, s.text));
        if (f) findings.push({ name: s.name, working: s.working, draft: s.draft, ...f });
      }
      const pr = pressure();
      const quiet = pr.loadPerCore <= MAX_LOAD_PER_CORE && pr.ramAvailPct >= MIN_RAM_AVAIL_PCT;
      let nudged = 0;
      for (const f of findings) {
        if (st.told[f.name] === f.sig || f.working || f.draft) continue;
        if (m === 'dry') { await note({ dry: true, session: f.name, finding: f.text }); continue; }
        if (!quiet || nudged >= MAX_NUDGES_PER_TICK) continue;   // a later tick tells it
        try {
          await send(f.name, message(f));
          st.told[f.name] = f.sig; nudged++;
          await note({ session: f.name, finding: f.text });
          await record({ key: `done-check:${f.name}`, title: `${f.name} said done, git disagrees`, body: f.text, url: '/', priority: 'default' });
        } catch (e) { log.error?.('[done-check] send', f.name, e.message); }
      }
      // (C) a done STATUS without the closing review segment gets one push per session turn (one done line), while idle, no draft,
      // host not busy; at most REVIEW_PUSHES_PER_DAY per session. It also asks for the bugs field when that is missing too.
      st.toldBugs ||= {}; st.toldReview ||= {};
      for (const n of Object.keys(st.toldReview)) if (!live.has(n)) delete st.toldReview[n];
      const missingReview = [], reviewSent = new Set();
      const day = new Date(now()).toISOString().slice(0, 10);
      for (const s of sessions) {
        const cr = closingReviewOf(s.text);
        if (s.doneAt && now() - s.doneAt > REVIEW_MAX_AGE_MS) continue;   // a done turn from before the rule: not reopened
        if (!cr?.missing || s.working || s.draft || findings.some((f) => f.name === s.name) || leftoverItemsOf(s.text).length) continue;
        missingReview.push(s.name);
        const sig = createHash('sha1').update(lastStatusLine(s.text)).digest('hex').slice(0, 12);
        const t = st.toldReview[s.name];
        if (t?.sig === sig) continue;   // once per session turn
        const used = t?.day === day ? t.n : 0;
        if (used >= REVIEW_PUSHES_PER_DAY) continue;
        if (m === 'dry') { await note({ dry: true, session: s.name, closingReview: 'missing' }); continue; }
        if (!quiet || nudged >= MAX_NUDGES_PER_TICK) continue;
        const bugsMissing = !!bugsFieldOf(s.text)?.missing;
        try {
          await send(s.name, closingReviewMessage({ bugsMissing }));
          st.toldReview[s.name] = { sig, day, n: used + 1 }; nudged++; reviewSent.add(s.name);
          if (bugsMissing) st.toldBugs[s.name] = now();   // the same push asked for it
          await note({ session: s.name, closingReview: 'missing', parts: cr.parts });
        } catch (e) { log.error?.('[done-check] send closing review', s.name, e.message); }
      }
      // (A) a done STATUS without the bugs field gets one push (while idle, host not busy)
      for (const n of Object.keys(st.toldBugs)) if (!live.has(n)) delete st.toldBugs[n];
      const missing = [];
      for (const s of sessions) {
        if (reviewSent.has(s.name) || missingReview.includes(s.name)) continue;   // the closing review push carries the bugs field
        const b = bugsFieldOf(s.text);
        if (!b?.missing || s.working || s.draft || findings.some((f) => f.name === s.name)) continue;
        if (now() - (st.toldBugs[s.name] || 0) < BUGS_COOLDOWN_MS) continue;
        missing.push(s.name);
        if (m === 'dry') { await note({ dry: true, session: s.name, bugsField: 'missing' }); continue; }
        if (!quiet || nudged >= MAX_NUDGES_PER_TICK) continue;
        try { await send(s.name, bugsMessage()); st.toldBugs[s.name] = now(); nudged++; await note({ session: s.name, bugsField: 'missing' }); }
        catch (e) { log.error?.('[done-check] send bugs', s.name, e.message); }
      }
      // (B) a done STATUS that lists leftovers / "not fully confirmed" is sent back to finish them, once per distinct list
      st.toldLeft ||= {}; st.leftCount ||= {};
      for (const n of Object.keys(st.leftCount)) if (!live.has(n)) delete st.leftCount[n];
      for (const n of Object.keys(st.toldLeft)) if (!live.has(n)) delete st.toldLeft[n];
      for (const s of sessions) {
        if (s.working || s.draft) continue;   // never type over an owner's draft
        const items = leftoverItemsOf(s.text);
        if (!items.length) continue;
        const sig = createHash('sha1').update(items.join('\0')).digest('hex').slice(0, 12);
        if (st.toldLeft[s.name] === sig) continue;
        const cnt = st.leftCount[s.name];
        const used = cnt?.day === day ? cnt.n : 0;
        if (used >= LEFT_PUSHES_PER_DAY) {   // cap reached: report to the manager once, then stay quiet
          if (m !== 'dry' && !cnt.reported) { cnt.reported = true; await record({ key: `done-check-left-cap:${s.name}`, title: `${s.name} keeps stopping with leftovers`, body: items.join(' | ').slice(0, 300), url: '/', priority: 'default' }).catch(() => {}); }
          continue;
        }
        if (m === 'dry') { await note({ dry: true, session: s.name, leftovers: items }); continue; }
        if (!quiet || nudged >= MAX_NUDGES_PER_TICK) continue;
        try { await send(s.name, leftoversMessage(items)); st.toldLeft[s.name] = sig; st.leftCount[s.name] = { day, n: used + 1, reported: false }; nudged++; await note({ session: s.name, leftovers: items }); }
        catch (e) { log.error?.('[done-check] send leftovers', s.name, e.message); }
      }
      // (D) a lease wait while a healthy equivalent is free: one push; the manager is told on the second distinct stop
      st.toldEq ||= {};
      for (const n of Object.keys(st.toldEq)) if (!live.has(n)) delete st.toldEq[n];
      const waitEq = [];
      for (const s of sessions) {
        if (s.working || s.draft || !waitingOnLeaseStatus(s.text)) continue;
        let eq = null; try { eq = await equivalentOf(s.name); } catch { eq = null; }
        if (!eq?.equivalents?.length) continue;
        waitEq.push(s.name);
        const sig = createHash('sha1').update(lastStatusLine(s.text)).digest('hex').slice(0, 12);
        const t = st.toldEq[s.name];
        if (t?.sig === sig) continue;   // once per stop
        if (m === 'dry') { await note({ dry: true, session: s.name, waitWhileEquivalentFree: eq.ticketId }); continue; }
        if (t?.n >= 2) { if (!t.reported) { t.reported = true; await record({ key: `done-check-eq:${s.name}`, title: `${s.name} keeps waiting on a lease while an equivalent is free`, body: `ticket ${eq.ticketId} on ${eq.env}/${(eq.resources || []).join(',')}; free: ${eq.equivalents.join(', ')}`, url: '/?leases=1', priority: 'default' }).catch(() => {}); } continue; }
        if (!quiet || nudged >= MAX_NUDGES_PER_TICK) continue;
        try {
          if (t?.n >= 1) { st.toldEq[s.name] = { sig, n: t.n + 1, reported: true }; await record({ key: `done-check-eq:${s.name}`, title: `${s.name} keeps waiting on a lease while an equivalent is free`, body: `ticket ${eq.ticketId} on ${eq.env}/${(eq.resources || []).join(',')}; free: ${eq.equivalents.join(', ')}`, url: '/?leases=1', priority: 'default' }).catch(() => {}); await note({ session: s.name, waitWhileEquivalentFree: eq.ticketId, told: 'manager' }); continue; }
          await send(s.name, equivalentWaitMessage(eq));
          st.toldEq[s.name] = { sig, n: 1, reported: false }; nudged++;
          await note({ session: s.name, waitWhileEquivalentFree: eq.ticketId, equivalents: eq.equivalents });
        } catch (e) { log.error?.('[done-check] send equivalent wait', s.name, e.message); }
      }
      await save(st);
      return (last = { at: now(), mode: m, checked: sessions.length, waitingWhileEquivalentFree: waitEq, missingBugsField: missing, missingClosingReview: missingReview, findings: findings.map(({ name, text }) => ({ name, text })), held: quiet ? null : 'host busy' });
    } catch (e) {
      log.error?.('[done-check]', e.message);
      return (last = { ...last, at: now(), error: e.message });
    } finally { busy = false; }
  }

  return {
    tick,
    snapshot: () => last,
    start(firstDelayMs = 4 * 60 * 1000) { if (timer) return; setTimeout(() => tick(), firstDelayMs).unref?.(); timer = setInterval(() => tick(), pollMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
  };
}

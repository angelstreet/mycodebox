// Goal check (owner, 2026-11-11): agents wrote `STATUS: done` and only when the owner asked "did you reach the goal?" did they remember and keep
// working. A line that passed every earlier check: "STATUS: done — resolved bug-3fbdd970, bug-430a348e, bug-b6a0056d · closing review: docs none
// needed · leftovers bug-827764ef, bug-2f32e7a7, bug-8fc8fc0d, bug-03ccc6a7, bug-80bdcdc1 · unverified: none · bugs: none": five leftovers filed
// instead of fixed, and no statement of the goal. The gate, before a done line is accepted:
//   1. fix-first: a done line whose leftovers list 2+ filed bugs in the area the session touched (filed by it, or naming a file it changed) is
//      sent back with each bug's --why-not-fixed text: small ones are fixed now. (Leftovers that are neither none nor ids: done-check (B).)
//   2. the owner's question, once per done: "Goal as given: <goal>. Did you reach it? Quote the evidence for each part. If not, continue."
//      The next done turn is the reply: accepted only when it restates the goal and cites evidence (file, run id, screenshot, KPI number).
// At most BOUNCES_PER_DAY bounces (fix-first or a reply not accepted) per session per day, then the manager is told once. Never closes a session.
// The goal is captured at session start (createGoalStore; first prompt / handover line, status-honesty.js goalOf), else the task doc title.
// Used by done-check.js (codebox panes) and remote-stops.js (the Mac Stop hook). State: <state>/goal-check.json, journal goal-check.jsonl.
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { lastStatus, goalOf, timeBoxOf, MACHINE_TEXT_RE } from './status-honesty.js';

export const BOUNCES_PER_DAY = 2;
const DONE_KINDS = new Set(['done', 'ok', 'complete', 'completed', 'finished', 'shipped']);
const NOT_FIXABLE = new Set(['host-or-device', 'credentials', 'owner-floor']);   // a filed bug with one of these reasons is a real reason, not a leftover
const ID_RE = /\b(?:bug|idea)-[0-9a-f]{6,}\b/gi;
const unmark = (s) => String(s || '').replace(/[*`]+/g, '');

// ---- parsing ----
// Pure. The leftovers segment of a done line's closing review -> the bug / idea ids it lists ([] for none / text without ids).
export function leftoverIdsOf(text) {
  const st = lastStatus(text);
  if (!st || !DONE_KINDS.has(st.kind)) return [];
  const m = /\bleftovers?\s*:?\s+(.+?)(?=\s*[·;|]\s*(?:unverified|bugs|docs|goal|evidence)\b|\s+(?:unverified|bugs)\s*:|$)/i.exec(unmark(st.text));
  return m ? [...new Set((m[1].match(ID_RE) || []).map((x) => x.toLowerCase()))] : [];
}

// Pure. bugs: found-bug records (found-bugs.js list), touched: paths the session changed, name: the session -> the leftover ids that count:
// unresolved, not explained by a hard reason (host/device, credentials, owner floor), and in the touched area (filed by the session or naming
// a touched file / module). An id the store does not know counts: the session named it as its own leftover.
export function touchedLeftovers(ids, { bugs = [], touched = [], name = '' } = {}) {
  const byId = new Map(bugs.filter((b) => b && b.id).map((b) => [String(b.id).toLowerCase(), b]));
  const keys = [...new Set(touched.flatMap((p) => { const b = basename(String(p)).replace(/\.[^.]+$/, ''); return b.length >= 4 ? [b.toLowerCase()] : []; }))];
  const out = [];
  for (const id of ids) {
    const b = byId.get(id);
    if (!b) { out.push({ id, why: 'not in the bug store', reason: '' }); continue; }
    if (b.resolved || b.fixed || b.state === 'fixed' || b.removed) continue;
    if (NOT_FIXABLE.has(b.why)) continue;
    const hay = `${b.title || ''} ${b.endpoint || ''} ${b.repro || ''} ${b.error || ''} ${b.reason || ''}`.toLowerCase();
    const mine = name && b.session && (b.session === name || b.session.replace(/^mac[-:]/, '') === name.replace(/^mac[-:]/, ''));
    if (mine || keys.some((k) => hay.includes(k))) out.push({ id, why: b.why || 'missing', reason: String(b.reason || '').slice(0, 140), title: String(b.title || '').slice(0, 90) });
  }
  return out;
}

const STOP = new Set('the a an and or of to on in for with from by at is are was were be this that these those it its as into via per one two first then than not no our your their task owner request agent session fix make run use new old all any each only also both more most did done goal reach reached evidence quote part'.split(' '));
const words = (s) => new Set((String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9_+.-]{2,}/g) || []).filter((w) => !STOP.has(w)));
// Evidence the owner can open or check: a URL, a file path (with a line), a run / report / integration / bug id, a commit sha, a screenshot / frame,
// a KPI number with its unit, a test count.
const EVIDENCE = [
  ['url', /https?:\/\/\S+/i],
  ['file', /(?:^|[\s(`'"])(?:[\w.-]+\/)*[\w.-]+\.(?:js|mjs|ts|tsx|py|sh|md|json|ya?ml|sql|css|html)(?::\d+)?\b/i],
  ['run id', /\b(?:int|run|report|result|job|exec|execution|deploy|t)-[0-9a-z]{6,}\b|\b(?:run|report|result|execution|job)\s*(?:id\s*)?[#:=]\s*\S{4,}/i],
  ['commit', /\b(?:commit|sha|merged as|@)\s*[0-9a-f]{7,40}\b|\b[0-9a-f]{9,40}\b/i],
  ['screenshot', /\S+\.(?:png|jpe?g|webp|gif|mp4|webm|wav|mp3)\b|\b(?:screenshot|frame|capture)\s+\S+/i],
  ['KPI number', /\b\d+(?:[.,]\d+)?\s?(?:ms|s|sec|seconds|min|%|fps|kbps|mbps|MB|GB)\b|\b\d+\s*\/\s*\d+\s+(?:tests?|pass(?:ed)?|green|ok|runs?|checks?)\b|\b(?:tests?|pass(?:ed)?)\s*[:=]?\s*\d+\s*\/\s*\d+\b/i],
];
export function evidenceOf(text) { const t = String(text || ''); return EVIDENCE.filter(([, re]) => re.test(t)).map(([k]) => k); }

// Pure. The task's numbered parts ("1. ...", "2) ...") from the first prompt: the first list of 2..8 consecutive items starting at 1 that is
// not the cbsession preamble's own steps. Each part is its label (text before a colon, when short) or its first 120 characters.
const PREAMBLE_STEP = /\b(?:first command|read the handover|write a short summary|then do the work|ask the owner only)\b/i;
export function taskPartsOf(prompt) {
  const lines = String(prompt || '').split('\n');
  // a `Done when:` block wins (harness-done-honest 2026-11-11): its numbered or bulleted items are the parts, each judged on its own evidence
  const dw = lines.findIndex((l) => /^\s*(?:[*_#>\s-]*)done[ -]when\b[^:]*:/i.test(l));
  if (dw >= 0) {
    const items = [];
    const inline = lines[dw].replace(/^[^:]*:\s*/, '').trim();
    if (inline) items.push(inline);
    for (let j = dw + 1; j < lines.length && items.length < 8; j++) {
      const m = /^\s*(?:\(?\d+[.)]|[-*•])\s+(.+)$/.exec(lines[j]);
      if (m) items.push(m[1].trim()); else if (!lines[j].trim() && items.length) break; else if (lines[j].trim() && !/^\s{2,}\S/.test(lines[j])) { if (items.length) break; }
    }
    if (items.length) return items.map((x) => { const t = unmark(x).replace(/\s+/g, ' '); const c = /^(.{6,60}?):\s/.exec(t); return (c ? c[1] : t).slice(0, 120); });
  }
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\(?1[.)]\s+\S/.test(lines[i])) continue;
    const items = [];
    for (let j = i, n = 1; j < lines.length && items.length < 8; j++) {
      const m = new RegExp(`^\\s*\\(?${n}[.)]\\s+(.+)$`).exec(lines[j]);
      if (m) { items.push(m[1].trim()); n++; continue; }
      if (/^\s*\(?\d+[.)]\s/.test(lines[j]) || (!lines[j].trim() && !/^\s+\S|^\s*\(?\d+[.)]\s/.test(lines[j + 1] || ''))) break;   // another list, or the list ended
    }
    if (items.length < 2 || items.some((x) => PREAMBLE_STEP.test(x))) continue;
    return items.map((x) => { const t = unmark(x).replace(/\s+/g, ' '); const c = /^(.{6,60}?):\s/.exec(t); return (c ? c[1] : t).slice(0, 120); });
  }
  return [];
}
// Pure. For each part, a line of the reply that names it (its number, or 2 of its words) and carries evidence. -> [{ n, part }] without evidence.
export function partsWithoutEvidence(text, parts = []) {
  const lines = unmark(text).split(/\n|;\s+/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  parts.forEach((part, i) => {
    const pw = words(part), need = Math.min(2, pw.size);
    const num = new RegExp(`^(?:[-*•]\\s*)?(?:part\\s*)?\\(?${i + 1}[.):]\\s`, 'i');
    const ok = lines.some((l) => { if (!evidenceOf(l).length) return false; if (num.test(l)) return true; let h = 0; for (const w of words(l)) if (pw.has(w)) h++; return need > 0 && h >= need; });
    if (!ok) out.push({ n: i + 1, part });
  });
  return out;
}

const NOT_REACHED = /\b(?:not (?:yet )?(?:achieved|reached|met|done|built|fixed|verified)|partially|only partly|still (?:open|missing|failing)|did(?: not|n'?t) (?:reach|achieve)|goal not\b)/i;
// Pure. text: the reply turn (closing text), goal: the goal as given ('' when none was recorded) -> { ok, restated, evidence: [kinds], missing: [..] }.
// Restated: the reply states the goal ("Goal as given: ...", "Goal: ...") or uses at least half of the goal's words (2..6 of them).
// parts: the task's numbered parts (taskPartsOf); each needs its own line with evidence.
export function goalReplyOf(text, goal = '', parts = []) {
  const t = unmark(text);
  const gw = words(goal), tw = words(t);
  let hit = 0; for (const w of gw) if (tw.has(w)) hit++;
  const need = Math.min(3, Math.max(2, Math.ceil(gw.size / 2)));   // was up to 6: "names 5 of the goal words, 6 needed" rejected a good reply (2026-11-11)
  const evidence = evidenceOf(t);
  const noPart = evidence.length ? partsWithoutEvidence(text, parts) : [];
  // with parts, the reply is judged on evidence per part: a reply that gives one per part restates the goal by doing so
  const restated = (parts.length && evidence.length && !noPart.length) || /\bgoal(?: as given)?\s*[:=]\s*(?!achieved\b)\S{3,}/i.test(t) || (gw.size ? hit >= need : false);
  const notReached = NOT_REACHED.exec(t.replace(/\bgoal not achieved\b(?=[^.]*\bif not\b)/i, ''));
  const missing = [];
  if (!restated) missing.push(gw.size ? `a restatement of the goal (it names ${hit} of the goal's words, ${need} needed)` : 'a restatement of the goal ("Goal: ...")');
  if (!evidence.length) missing.push('evidence for each part (a file path, run / integration id, commit, screenshot or KPI number)');
  if (noPart.length) missing.push(`evidence for part ${noPart.map((p) => `${p.n} (${p.part.slice(0, 60)})`).join(', ')}: one line per part, with its file / run id / screenshot / KPI number`);
  if (notReached) missing.push(`the goal reached: your reply says "${notReached[0]}"`);
  return { ok: !missing.length, restated, evidence, missing, partsMissing: noPart.map((p) => p.n) };
}

// ---- messages ----
export function goalQuestion(goal, parts = []) {
  return `Goal check: ${goal ? `Goal as given: "${goal.slice(0, 240)}".` : 'No goal was recorded for this session: state it from your first prompt or task doc.'}${parts.length ? ` Parts: ${parts.map((p, i) => `${i + 1}. ${p.slice(0, 80)}`).join(' ')}.` : ''} Did you reach it? `
    + 'Quote the evidence for each part (file:line, test run, integration id, commit, report link, screenshot, KPI number). If not, continue the work now. '
    + 'Reply by restating the goal, one line per part with its evidence, then your STATUS line (done only when every part is reached; else failed / blocked / waiting).';
}
export function replyBounceMessage(goal, r) {
  return `Goal check: your reply is not accepted, it lacks ${r.missing.join('; ')}. ${goal ? `Goal as given: "${goal.slice(0, 240)}". ` : ''}`
    + 'Continue the work until each part is reached, then restate the goal with the evidence for each part. If it cannot be reached, end with `STATUS: failed — goal not achieved: <why> · tried: <list>`.';
}
export function fixFirstMessage(items) {
  const list = items.slice(0, 6).map((b) => `${b.id} (why-not-fixed: ${b.why}${b.reason ? ` — "${b.reason}"` : ''}${b.title ? `; ${b.title}` : ''})`).join('; ');
  return `Goal check: your done line lists ${items.length} filed leftovers in the area you touched: ${list}. Fix-first rule (AGENTS.md): a bug you found in your own area `
    + 'is fixed now when it is small and you have the repro; run `found-bug --claim <id>`, fix it in your worktree, ship it with `integrate request`, then `found-bug --resolve <id> --commit <sha|integration id>`. '
    + 'Keep a bug filed only when its --why-not-fixed reason really holds (large, another host / device / credentials, owner floor, a live session\'s task): say why per bug. Then rewrite the done line.';
}

// ---- the goal store: captured at session start ----
// <state>/goals.json { "<session>": { goal, source, at } }. The first capture wins unless the later one is explicit (`Goal:` line).
export function createGoalStore({ stateDir, now = Date.now } = {}) {
  const file = join(stateDir, 'goals.json');
  const load = () => { try { return JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { return {}; } };
  return {
    file,
    get: (name) => load()[name] || null,
    // prompt: the first prompt / handover text. -> the stored entry or null.
    capture(name, prompt, source = 'prompt') {
      if (!name || !prompt) return null;
      const goal = goalOf(prompt);
      if (!goal) return null;
      const all = load(), prev = all[name];
      const explicit = /^\s*(?:[*_#>\s]*)goal\s*:/im.test(String(prompt));
      if (prev && !MACHINE_TEXT_RE.test(String(prev.goal || '')) && !(explicit && !prev.explicit)) return prev;   // a stored machine message is replaced by the first real prompt
      all[name] = { goal, parts: taskPartsOf(prompt), timeBoxMs: timeBoxOf(prompt), source, explicit, at: new Date(now()).toISOString() };
      const keys = Object.keys(all);
      for (const k of keys.slice(0, Math.max(0, keys.length - 2000))) delete all[k];   // bounded
      try { mkdirSync(stateDir, { recursive: true }); writeFileSync(file, JSON.stringify(all)); } catch { /* best effort */ }
      return all[name];
    },
    forget(name) { const all = load(); if (all[name]) { delete all[name]; try { writeFileSync(file, JSON.stringify(all)); } catch {} } },
  };
}

// ---- the gate (stateful) ----
// session: { name, text, doneAt?, remote?, canAnswer? }. goalOf(name) -> goal text; bugsOf() -> found-bug records; touchedOf(session) -> paths.
// evaluate() -> null (nothing to say) | { kind: 'ask'|'fix-first'|'reply-rejected'|'accepted'|'capped', message?, goal, ... }. It never sends:
// the caller sends `message` and then calls sent(name, decision) so the state counts it (a failed send is not counted).
export function createGoalGate({ stateDir, goalOf: goalFor = async () => '', partsOf = async () => [], bugsOf = async () => [], touchedOf = async () => [], record = async () => {}, now = Date.now, mode = () => 'live', log = console } = {}) {
  const stFile = join(stateDir, 'goal-check.json');
  const journal = join(stateDir, 'goal-check.jsonl');
  let st = null;
  async function load() { if (st) return st; try { st = JSON.parse(await readFile(stFile, 'utf8')); } catch { st = {}; } st.s ||= {}; return st; }
  async function save() { try { await mkdir(stateDir, { recursive: true }); await writeFile(stFile, JSON.stringify(st)); } catch (e) { log.error?.('[goal-check] save', e.message); } }
  async function note(e) { try { await appendFile(journal, JSON.stringify({ at: new Date(now()).toISOString(), ...e }) + '\n'); } catch {} }
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const sigOf = (text) => createHash('sha1').update(lastStatus(text)?.line || '').digest('hex').slice(0, 12);

  async function evaluate(s) {
    if (mode() === 'off') return null;
    const ls = lastStatus(s.text);
    if (!ls || !DONE_KINDS.has(ls.kind)) return null;
    await load();
    const e = (st.s[s.name] ||= {});
    const sig = sigOf(s.text);
    // a new done turn: a different line, or the same line written after we asked (doneAt later than the ask)
    const fresh = (at) => sig !== e.sig || (s.doneAt && at && s.doneAt > at);
    if (e.accepted === sig && !(s.doneAt && e.acceptedAt && s.doneAt > e.acceptedAt + 1000)) return null;
    if (e.sig === sig && !fresh(e.at)) return null;   // already answered this done turn (asked, bounced or accepted)
    let goal = ''; try { goal = String(await goalFor(s.name) || ''); } catch { goal = ''; }
    let parts = []; try { parts = ((await partsOf(s.name)) || []).map(String).slice(0, 8); } catch { parts = []; }
    const b = e.bounces?.day === day() ? e.bounces : (e.bounces = { day: day(), n: 0, reported: false });
    // 1. fix-first
    const ids = leftoverIdsOf(s.text);
    let left = [];
    if (ids.length >= 2) {
      let bugs = [], touched = [];
      try { bugs = (await bugsOf()) || []; } catch {}
      try { touched = (await touchedOf(s)) || []; } catch {}
      left = touchedLeftovers(ids, { bugs, touched, name: s.name });
    }
    let d = null;
    if (left.length >= 2) d = { kind: 'fix-first', bounce: true, message: fixFirstMessage(left), leftovers: left.map((x) => x.id) };
    else if (e.asked && !e.accepted) {
      // 2b. the reply to our question
      const r = goalReplyOf(s.text, goal, parts);
      d = r.ok ? { kind: 'accepted', evidence: r.evidence } : { kind: 'reply-rejected', bounce: true, message: replyBounceMessage(goal, r), missing: r.missing };
    } else d = { kind: 'ask', message: goalQuestion(goal, parts) };
    d.goal = goal; d.sig = sig;
    if (d.kind === 'accepted') {
      Object.assign(e, { sig, at: now(), accepted: sig, acceptedAt: s.doneAt || now(), asked: false });
      await note({ session: s.name, accepted: true, evidence: d.evidence, goal: goal.slice(0, 160) }); await save();
      return d;
    }
    if (d.bounce && b.n >= BOUNCES_PER_DAY) {
      Object.assign(e, { sig, at: now() });
      if (!b.reported) {
        b.reported = true;
        await record({ key: `goal-check-cap:${s.name}`, title: `${s.name}: done bounced ${b.n} times today by the goal check`, body: `${d.kind}: ${(d.missing || d.leftovers || []).join(' | ').slice(0, 260)}${goal ? ` · goal: ${goal.slice(0, 160)}` : ''}`, url: '/', priority: 'default' }).catch(() => {});
        await note({ session: s.name, capped: true, kind: d.kind });
      }
      await save();
      return { kind: 'capped', goal, sig, was: d.kind };
    }
    if (s.canAnswer === false) {   // a Mac stop under the loop guard: ghosty cannot type back (tmux route), the manager can SendMessage; a bounce goes to the manager
      Object.assign(e, { sig, at: now() });
      if (d.bounce) await record({ key: `goal-check:${s.name}`, title: `${s.name}: done not accepted by the goal check (Mac: reply with SendMessage to the session name)`, body: (d.missing || d.leftovers || []).join(' | ').slice(0, 300), url: '/', priority: 'default' }).catch(() => {});
      await note({ session: s.name, kind: d.kind, unanswerable: true }); await save();
      return { ...d, message: null, unanswerable: true };
    }
    if (mode() === 'dry') { Object.assign(e, { sig, at: now() }); await note({ dry: true, session: s.name, kind: d.kind }); await save(); return { ...d, dry: true }; }
    return d;
  }
  // the caller delivered d.message to the session
  async function sent(name, d) {
    await load();
    const e = (st.s[name] ||= {});
    Object.assign(e, { sig: d.sig, at: now(), asked: d.kind !== 'fix-first', accepted: null });   // fix-first: the next done is asked the question afresh
    if (d.bounce) { const b = e.bounces?.day === day() ? e.bounces : (e.bounces = { day: day(), n: 0, reported: false }); b.n += 1; e.total = (e.total || 0) + 1; }
    await note({ session: name, kind: d.kind, goal: (d.goal || '').slice(0, 160), ...(d.missing ? { missing: d.missing } : {}), ...(d.leftovers ? { leftovers: d.leftovers } : {}) });
    await save();
  }
  // counts for the manager's status scan: bounced dones per session today
  async function snapshot() {
    await load();
    const today = day(), sessions = {};
    for (const [n, e] of Object.entries(st.s)) {
      const nb = e.bounces?.day === today ? e.bounces.n : 0;
      if (nb || e.asked) sessions[n] = { bouncedToday: nb, capped: nb >= BOUNCES_PER_DAY, waitingForReply: !!e.asked && !e.accepted };
    }
    return { at: new Date(now()).toISOString(), day: today, bouncesPerDay: BOUNCES_PER_DAY, bouncedToday: Object.values(sessions).reduce((a, x) => a + x.bouncedToday, 0), sessions };
  }
  // drop gone tmux sessions; Mac rows (mac:...) are not tmux panes and stay
  async function forget(live) { await load(); let ch = false; for (const n of Object.keys(st.s)) if (!live.has(n) && !n.startsWith('mac:')) { delete st.s[n]; ch = true; } if (ch) await save(); }
  return { evaluate, sent, snapshot, forget };
}

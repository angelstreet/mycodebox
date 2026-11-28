// A session that stops `needs-owner` on something to look at (owner / manager, 2026-11-25): ghosty reviews it itself before the
// owner is woken. The push is held; a fail goes back to the session as its next message (the owner is not woken); the owner is pushed
// with the verdict once it passes, or after MAX_ROUNDS send-backs with the failing table said. The session runs and grades nothing.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_ROUNDS = 2;
export const ROUND_TTL_MS = 12 * 3600 * 1000;
const NEEDS_OWNER = /^\W*STATUS:\W*needs-owner\b/im;
const VISUAL_WORDS = /\bmock-?ups?\b|\bartifacts?\b|\bposters?\b|\blessons?\b|\blayout\b|\bscreenshots?\b|\bLearn card\b|claude\.ai\/(?:code\/)?artifact/i;
const VISUAL_PATHS = /^(?:frontend\/src\/|frontend\/index\.html|features\/[^/]+\/frontend\/|docs\/(?:img|view)\/|docs\/index\.html|learn\/|scripts\/promo\/concepts\/)/;
const FILE = /(?:~\/|\/(?:home|tmp)\/)[^\s'"`)\]>]+?\.(?:html|svg|png|jpe?g)\b/gi;
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Pure. -> null when this stop is not a visual ask, else { files: [candidates in the text], artifact: bool, branch: bool }
export function visualAskOf(text, branchFiles = []) {
  const t = String(text || '');
  const lines = t.split('\n');
  let at = -1;
  lines.forEach((l, i) => { if (/^\W*STATUS:/i.test(l.trim())) at = i; });
  if (at < 0 || !NEEDS_OWNER.test(lines[at].trim())) return null;
  const branch = branchFiles.some((f) => VISUAL_PATHS.test(f));
  const files = [...new Set(t.match(FILE) || [])].slice(0, 3);
  if (!branch && !VISUAL_WORDS.test(t)) return null;
  return { files, artifact: /claude\.ai\/(?:code\/)?artifact/i.test(t), branch };
}

export const kindOf = (file, text) => (/poster/i.test(`${file} ${text}`) ? 'poster' : /lesson|learn card/i.test(text) ? 'lesson' : 'mockup');

export function sendBackMessage(u, round) {
  return `UI review (run by ghosty, round ${round} of ${MAX_ROUNDS}): your needs-owner ask is on hold and the owner has not been woken, because what you want them to look at fails the basic checks. Fix the rows below, then end your turn again; ghosty reviews it again. Do not ask for an exception and do not run your own review instead.\n${u}`;
}

// deps: reviewer() -> the folder holding the exported reviewer | null; run(cmd, {cwd, timeoutMs}); branchOf(session) -> { cwd, base, files } | null;
//   send(session, text); push(session, extraBody) (the held owner push, now with the verdict); journal(entry); home
export function createAskReview({ stateDir, review, run, branchOf, send, journal = () => {}, home = process.env.HOME, now = () => Date.now(), log = () => {} }) {
  const stateFile = path.join(stateDir, 'ui-review-ask.json');
  const busy = new Set();
  const load = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
  const save = (s) => { try { fs.writeFileSync(stateFile, JSON.stringify(s), { mode: 0o600 }); } catch (e) { log('ask state', e.message); } };
  const last = new Map();   // session -> { verdict, line, at } for the dashboard card

  async function judge(session, ask, text) {
    const b = await branchOf(session).catch(() => null);
    // pictures are usually the session's evidence frames, not the deliverable: a page or drawing file comes first, then the branch
    // a shared page (`page publish`, pages.js) named by its dashboard URL is reviewed from its published file
    const shared = [...new Set([...String(text).matchAll(/\/p\/([a-z0-9][a-z0-9-]{0,59})\/?(?=[\s)'"`>\]]|$)/g)].map((m) => path.join(stateDir, 'pages', m[1], 'site', 'index.html')))].slice(0, 3);
    const files = [...ask.files.map((f) => f.replace(/^~/, home)), ...shared].filter((f) => /\.(?:html|svg)$/i.test(f) && fs.existsSync(f));
    if (files.length) return review({ id: `ask-${session}-${now()}`, files: files.map((f) => ({ file: f, kind: kindOf(f, text) })) });
    if (b && b.files.some((f) => VISUAL_PATHS.test(f))) return review({ id: `ask-${session}-${now()}`, tree: b.cwd, base: b.base });
    if (ask.artifact || (ask.files.length && /\bmock-?ups?\b|\bposters?\b|\blessons?\b/i.test(text))) return { verdict: 'fail', summary: 'the reviewer cannot judge a claude.ai artifact or a flat picture: publish it with `page publish <file>` and put the /p/<slug>/ URL (or the absolute path of the HTML file) in your closing text', table: '' };
    return null;   // words only ("the layout of the config file"): nothing to look at
  }

  // -> { push: true, note } to push the owner now (note appended to the body), or { push: false } (held and sent back)
  async function handle(session, text) {
    const b = await branchOf(session).catch(() => null);
    const ask = visualAskOf(text, b?.files || []);
    if (!ask) return { push: true, note: '' };
    const sig = createHash('sha1').update(String(text).slice(-3000)).digest('hex').slice(0, 12);
    const st = load();
    const mine = st[session] && now() - st[session].at < ROUND_TTL_MS ? st[session] : { rounds: 0 };
    if (mine.sig === sig) return mine.pushed ? { push: true, note: mine.note || '' } : { push: false };   // the same stop seen again
    let u;
    try { u = await judge(session, ask, text); } catch (e) { u = { verdict: 'cannot', summary: e.message.slice(0, 200), table: '' }; }
    if (!u || u.verdict === 'skip' || u.verdict === 'absent') return { push: true, note: '' };
    const table = [u.summary, u.table, u.dir ? `Frames: ${u.dir}` : ''].filter(Boolean).join('\n').slice(0, 3500);
    const fail = u.verdict === 'fail';
    if (fail && mine.rounds < MAX_ROUNDS) {
      try { await send(session, sendBackMessage(table, mine.rounds + 1)); } catch (e) {
        log('send back failed', session, e.message);
        return { push: true, note: `UI review: FAILING (could not be sent back to the session)\n${table}` };
      }
      st[session] = { rounds: mine.rounds + 1, sig, at: now(), pushed: false };
      save(st);
      journal({ session, verdict: 'fail', round: mine.rounds + 1, held: true, summary: u.summary });
      last.set(session, { verdict: 'fail', line: `UI review failed, sent back (round ${mine.rounds + 1}): ${u.summary}`.slice(0, 200), at: now() });
      return { push: false };
    }
    const head = fail ? `UI review: STILL FAILING after ${mine.rounds} send-backs` : u.verdict === 'pass' ? 'UI review: pass'
      : u.verdict === 'partial' ? 'UI review: NOT fully reviewed' : 'UI review could not run';
    const note = `${head}\n${table}`;
    st[session] = { rounds: u.verdict === 'pass' ? 0 : mine.rounds, sig, at: now(), pushed: true, note };
    save(st);
    journal({ session, verdict: u.verdict, rounds: mine.rounds, held: false, summary: u.summary });
    last.set(session, { verdict: u.verdict, line: `${head}: ${u.summary}`.slice(0, 200), at: now() });
    return { push: true, note };
  }

  return {
    // The alert path's question (server.js notifySession). A STATUS stop reaches the owner as the manager's `asks` alert, once the
    // turn has ended (state `done`). A `waiting` alert, or an `asks` over a live menu, is a prompt on screen: nothing is typed into it.
    takeAlert(session, { kind, state, status, text }, onPush) {
      if (kind !== 'asks' || state === 'waiting' || (status && status !== 'needs-owner')) return false;
      return this.take(session, text, onPush);
    },
    // Synchronous front door for the alert path: true = this alert is taken over; onPush(note) is called when the owner should be pushed.
    take(session, text, onPush) {
      if (!NEEDS_OWNER.test(String(text || ''))) return false;
      if (busy.has(session)) return true;
      busy.add(session);
      handle(session, text).then((r) => { if (r.push) onPush(r.note); }).catch((e) => { log('ask review', session, e.message); onPush(''); }).finally(() => busy.delete(session));
      return true;
    },
    handle,
    cardOf: (session) => { const c = last.get(session); return c && now() - c.at < ROUND_TTL_MS ? c : null; },
  };
}

// The review the asks use: the exported reviewer, on the files named (one run per kind) or on the session's branch (the gate, before/after).
export function createAskRunner({ lane, cfg, stateDir, run }) {
  return async function review({ id, files = null, tree = null, base = null }) {
    const conf = cfg();
    if (!conf) return { verdict: 'absent', summary: 'no uiReview block configured' };
    if (tree) return lane.review(conf, { id, mode: 'pre-merge', tree, base, head: 'HEAD' });
    const exported = await lane.exportReviewer(conf, id);
    if (exported.missing) return { verdict: 'absent', summary: 'the reviewer is not on main yet' };
    const dir = path.join(stateDir, 'integration', 'ui-review', id);
    fs.mkdirSync(dir, { recursive: true });
    const out = [];
    let worst = 'pass';
    try {
      for (const f of files) {
        const x = await run(`python3 ${sq(path.join(exported.home, 'scripts/review/ui_review.py'))} ${sq(f.file)} --kind ${f.kind} --model-advisory --out ${sq(path.join(dir, path.basename(f.file)))}`,
          { cwd: dir, timeoutMs: conf.timeoutMin * 60_000 });
        const said = /^ui-review: uir-\S+ (pass-with-exceptions|pass|fail)\b/m.exec(x.out)?.[1];
        const verdict = x.code === 0 && said?.startsWith('pass') ? 'pass' : x.code === 1 && said === 'fail' ? 'fail' : 'cannot';
        if (verdict === 'fail' || (verdict === 'cannot' && worst === 'pass')) worst = verdict;
        out.push(x.out.split('\n').filter((l) => /^## |\| FAIL \||^ui-review: /.test(l)).slice(0, 14).map((l) => l.slice(0, 400)).join('\n') || x.out.slice(-600));
      }
    } finally { fs.rmSync(exported.home, { recursive: true, force: true }); }
    return { verdict: worst, summary: `${files.length} file(s) reviewed: ${worst}`, table: out.join('\n'), dir };
  };
}

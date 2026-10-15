// Hands-free loop (round 8, G2): the open "needs you" items as a spoken queue, a spoken answer mapped to an option, and a spoken
// digest. Pure functions first (unit tested), then createVoice(deps), a small router server.js installs under /api/voice/*.
//   GET  /api/voice/queue                 -> { items }
//   POST /api/voice/answer { id, transcript?, option?, confirm?, pending?, via? } -> { status: sent|confirm|intent|again|open|stale|draft, say, ... }
//   GET  /api/voice/digest?minutes=60     -> { text, parts }
// Nothing here writes a pane by itself: the answer goes through deps.send (the server's guarded send), by 'owner-voice'.
import { createHash } from 'node:crypto';
import { deriveButtons, needsOwner } from './public/buttons.js';
import { forbiddenMatch } from './stall.js';
import { summarize as leaseSummary } from './lease-source.js';
import { parseReadySpeech } from './ready-window.js';

export const VOICE_BY = 'owner-voice';
const MAX_READ_OPTIONS = 6;

// --- text clean-up for the ear ---------------------------------------------------------------------------------
// No markdown, no urls, no long paths: a path is read as its last segment, a url as "a link".
export function plainSpeech(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/(?:^|\s)((?:~|\.{1,2})?\/[\w.@+\/-]*[\w.@+-]|[\w.@+-]+(?:\/[\w.@+-]+){2,}\/?)(?=[\s,;:.!?)]*(?:\s|$))/g, (m, p) => ` ${p.replace(/\/+$/, '').split('/').pop() || 'a folder'}`)
    .replace(/[*_#>|]+/g, ' ')
    .replace(/\s*[\u2014\u2013]\s*|\s-\s/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}
// Trim at a word boundary, never mid-word.
export function trimTo(text, max) {
  const t = String(text ?? '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}
const sentence = (s) => { const t = String(s || '').trim(); return !t ? '' : /[.!?…]$/.test(t) ? t : `${t}.`; };

// --- the queue ---------------------------------------------------------------------------------------------------
const WAIT_ID = /^wait$/;
// The id of a stop = its stop id + a hash of what the owner would hear (question text and option texts). stallOf() can hand out the previous
// stop's id with the new stop's content for a moment after the pane changes; with the content in the id, an old notification's tap no longer matches.
const stopHash = (stall) => createHash('sha1').update(JSON.stringify([String(stall.question || ''), (stall.options || []).map((o) => String(o.text || ''))])).digest('hex').slice(0, 8);

// Options of a stop, from the same derivation the buttons use: a live menu -> { key: 'N' }, yes/no and lettered -> { text }.
export function stopOptions({ state, stall, triage }) {
  const d = deriveButtons({ state, stall, triage });
  const menu = d.kind === 'menu';
  const full = menu ? new Map(stall.options.map((o) => [String(o.n), o.text])) : null;
  const buttons = d.buttons.filter((b) => !b.reply && (b.key != null || b.text != null));
  return {
    kind: d.kind,
    options: buttons.map((b, i) => {
      const label = plainSpeech(menu ? full.get(b.key) ?? b.label : String(b.label).replace(/^\s*[A-Za-z0-9]\s·\s/, ''));
      const n = menu && Number.isInteger(Number(b.key)) ? Number(b.key) : i + 1;
      const letter = /^o[A-Za-z]$/.test(b.id) ? b.id.slice(1).toUpperCase() : null;
      return {
        n, id: b.id, label: trimTo(label || String(b.label), 80), ...(letter ? { letter } : {}),
        recommended: !!(b.rec || (b.ai && b.primary)),
        confirm: !!b.confirm || !!forbiddenMatch(`${label} ${b.text || ''}`),
        answer: b.key != null ? { key: String(b.key) } : { text: String(b.text) },
      };
    }),
  };
}

const isP0 = (priority, text) => priority === 'P0' || /\bP0\b/.test(text || '');

// Ordered open items: P0 first, then oldest. `managerSessions`: their own stops are never the owner's. `priority(session)` optional.
export function voiceQueue({ status = {}, ownerAsks = [], managerSessions = [], isPaused = () => false, priority = () => null, managerName = null, now = Date.now() } = {}) {
  const mgrs = new Set(managerSessions);
  const items = [];
  for (const [session, st] of Object.entries(status || {})) {
    const item = stopItem(session, st, { mgrs, isPaused, priority, now });
    if (item) items.push(item);
  }
  const target = managerName || managerSessions[0] || 'manager';
  for (const a of ownerAsks || []) {
    const item = askItem(a, { target, priority });
    if (item) items.push(item);
  }
  return items.sort((x, y) => (y.p0 - x.p0) || ((x.at || 0) - (y.at || 0))).map(({ p0, ...r }) => r);
}

// One stop -> an item, or null when it is not the owner's to answer by voice.
export function stopItem(session, st, { mgrs = new Set(), isPaused = () => false, priority = () => null, now = Date.now() } = {}) {
  const stall = st?.stall;
  if (!stall || mgrs.has(session) || isPaused(session) || st.auto || st.state === 'working') return null;
  if (!needsOwner(st)) return null;
  if (!(stall.escalated || st.state === 'waiting' || stall.case === 'owner_decision')) return null;
  const { kind, options } = stopOptions({ state: st.state, stall, triage: st.triage });
  if (!stall.id) return null;   // no stop id: nothing to validate a later answer against
  const stallId = stall.id;
  const question = plainSpeech(stall.question || stall.excerpt || '');
  const item = {
    id: `stop:${session}:${stallId}:${stopHash(stall)}`, kind: 'stop', session, question, questionKind: kind, options,
    ...(stall.draft ? { draft: true } : {}),
    ...(stall.forbidden ? { topic: String(stall.forbidden) } : {}),
    stallId, at: now - Math.max(0, Number(st.lastActivitySec) || 0) * 1000, p0: isP0(priority(session), `${stall.question || ''}`) ? 1 : 0,
  };
  item.script = spokenScript(item);
  return item;
}

// A ledger question: options are strings; the answer goes to the manager as "Answer: <Qid> <n>".
export function askItem(a, { target = 'manager', priority = () => null } = {}) {
  if (!a?.id || !a.question) return null;
  const opts = (Array.isArray(a.options) ? a.options : []).map((o) => (typeof o === 'string' ? o : o?.label || o?.text || ''));
  const rec = String(a.recommendation ?? '').trim();
  const recN = /^\d+$/.test(rec) ? Number(rec) : (rec ? (opts.findIndex((o) => o && rec.toLowerCase().includes(o.toLowerCase())) + 1 || (opts.findIndex((o) => o && o.toLowerCase().includes(rec.toLowerCase())) + 1) || (/^[A-Za-z]$/.test(rec) ? rec.toUpperCase().charCodeAt(0) - 64 : 0)) : 0);
  const qTopic = forbiddenMatch(plainSpeech(a.question));   // a question about a merge or a key rotation needs a "confirm" whatever the option says
  const options = opts.map((o, i) => {
    const label = plainSpeech(o);
    return { n: i + 1, id: String(i + 1), label: trimTo(label, 80), recommended: recN === i + 1, confirm: !!qTopic || !!forbiddenMatch(label), answer: { text: `Answer: ${a.id} ${i + 1}`, to: target } };
  }).filter((o) => o.label);
  const item = {
    id: `ask:${a.id}`, kind: 'ask', session: a.session || target, question: plainSpeech(a.question), questionKind: 'menu', options,
    askId: a.id, ...(qTopic ? { topic: String(qTopic) } : {}), at: Date.parse(a.at) || 0, p0: isP0(priority(a.session), `${a.question}`) ? 1 : 0,
  };
  item.script = spokenScript(item);
  return item;
}

export function spokenScript(item) {
  const q = trimTo(plainSpeech(item.question), 300);
  const parts = [`${item.session} needs you.`];
  if (q) parts.push(sentence(q));
  (item.options || []).slice(0, MAX_READ_OPTIONS).forEach((o, i) => parts.push(`Option ${o.n ?? i + 1}: ${sentence(trimTo(o.label, 80)).replace(/\.$/, '')}${o.recommended ? ', recommended' : ''}.`));
  if (item.draft) parts.push('There is a draft in its input box, so I will not send anything.');
  parts.push('Say a number, recommended, yes, no, wait, skip, or repeat.');
  return parts.join(' ');
}

// --- understanding the answer ----------------------------------------------------------------------------------------
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5, '6th': 6 };
const NUM_FILLER = new Set('option number choice answer the a an pick choose select take go with i ill will let lets us please just say it is that this one for me my want would like and to do thanks thank you okay ok then so um uh'.split(' '));
const YES_WORDS = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'correct', 'affirmative', 'absolutely', 'definitely', 'yes please', 'please do', 'do it', 'go ahead', 'go on', 'proceed', 'continue', 'sounds good', 'that works', 'yes do it', 'yes go ahead', 'yes continue']);
const NO_WORDS = new Set(['no', 'nope', 'nah', 'negative', 'do not', 'dont', "don't", 'no thanks', 'no thank you', 'no way']);

// Case, punctuation and whisper's capitalisation do not matter: "Option 2." == "option two".
export const normalizeSpeech = (t) => String(t ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

const INTENTS = [
  ['digest', /^(?:what (?:has )?happened|what happened(?: (?:in|over) the last (?:hour|\w+ minutes))?|what s? ?(?:has )?been happening|digest|the digest|summary|summarize|summarise|give me (?:a |the )?(?:digest|summary|update)|catch me up|update me|status|status report|any news)$/],
  ['leases', /^(?:(?:the |any |my )?leases|lease status|(?:what|which) leases(?: are (?:held|taken|there))?|are there (?:any )?leases(?: held)?|who holds(?: (?:it|the lease|the leases|them|anything))?|who has the lease|who holds what|what s leased|what is leased|lease report)$/],
  ['repeat', /^(?:repeat(?: that| it| please| again)?|say (?:that |it )?again|again|read (?:that |it )?again|come again|pardon(?: me)?|sorry what|what was that|one more time|say it once more)$/],
  ['skip', /^(?:skip(?: it| this| this one)?|not now|later|pass|leave it|skip for now)$/],
  ['next', /^(?:next|next one|next item|next question|the next one|move on|go to the next(?: one)?)$/],
  ['stop', /^(?:stop|stop listening|stop now|pause|end|quit|exit|that s all|that is all|goodbye|bye)$/],
  ['cancel', /^(?:cancel(?: that| it)?|never ?mind|abort|forget it|no cancel|do not send(?: it)?|dont send(?: it)?|don't send(?: it)?)$/],
  ['confirm', /^(?:confirm(?:ed)?|i confirm|yes confirm|confirm it|confirm send|yes i confirm|yes confirmed|send it|confirmed send)$/],
  ['wait', /^(?:wait|wait please|please wait|hold on|hold on a (?:second|moment|minute)|wait for me|let me (?:answer|do) (?:it|this)(?: myself)?|i will answer(?: it)? myself|ill answer(?: it)? myself|not yet)$/],
];

const numberOf = (tok) => (/^\d{1,2}$/.test(tok) ? Number(tok) : NUM_WORDS[tok] ?? ORDINALS[tok] ?? null);

// The option number the words name, or null when none / ambiguous ("one or two").
function spokenNumber(words) {
  const toks = words.split(' ').filter(Boolean);
  const hasOrdinal = toks.some((t) => ORDINALS[t] != null);
  const nums = new Set();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (NUM_FILLER.has(t)) {
      if (t === 'one' && !hasOrdinal && !(i === toks.length - 1 && i > 0 && numberOf(toks[i - 1]) != null)) nums.add(1);
      continue;
    }
    const v = numberOf(t);
    if (v == null) return { n: null, other: true };
    nums.add(v);
  }
  return { n: nums.size === 1 ? [...nums][0] : null, other: false, many: nums.size > 1 };
}

const byId = (item, re) => (item.options || []).find((o) => re.test(String(o.id)) || re.test(String(o.label)));
const yesOption = (item) => (item.options || []).find((o) => /^(?:yes|continue)$/.test(String(o.id)) || /^yes\b/i.test(o.label));
const noOption = (item) => (item.options || []).find((o) => /^no$/.test(String(o.id)) || /^no\b(?!\s*[,—-]\s*wait)/i.test(o.label)) || waitOption(item);
const waitOption = (item) => (item.options || []).find((o) => WAIT_ID.test(String(o.id)) || /wait for me/i.test(o.label));

// transcript + the open item -> { type:'choice', option } | { type:'intent', intent } | { type:'none' }
export function matchSpokenAnswer(transcript, item) {
  const t = normalizeSpeech(transcript);
  if (!t) return { type: 'none' };
  const opts = item?.options || [];
  const none = { type: 'none' };

  // recommended: "recommended", "go with the recommendation", "your recommendation"
  if (/\brecommend/.test(t)) {
    if (/\b(?:not|dont|don't|except|instead|other than|without)\b/.test(t)) return none;
    const rec = opts.filter((o) => o.recommended);
    return rec.length ? { type: 'choice', option: rec[0] } : none;
  }
  // ---- ready window (round 9 item 8; keep this block together): "ready for 30 minutes [on <device>]" ----
  const rdy = parseReadySpeech(t);
  if (rdy) return { type: 'intent', intent: 'ready', minutes: rdy.minutes, device: rdy.device };
  for (const [intent, re] of INTENTS) {
    if (!re.test(t)) continue;
    if (intent === 'wait') { const w = waitOption(item || {}); return w ? { type: 'choice', option: w } : { type: 'intent', intent }; }
    return { type: 'intent', intent };
  }

  // yes / no, for a yes/no item or one with options labelled yes / no
  const words = t.replace(/\b(?:please|thanks|thank you)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const isYes = YES_WORDS.has(words) || YES_WORDS.has(t), isNo = NO_WORDS.has(words) || NO_WORDS.has(t);
  if (isYes || isNo) {
    const o = isYes ? yesOption(item || {}) : noOption(item || {});
    return o ? { type: 'choice', option: o } : none;
  }

  // lettered options: "option b", "letter c"
  const lm = /^(?:option|letter|choice|answer)\s+([a-f])$/.exec(t);
  if (lm) { const o = opts.find((x) => x.letter === lm[1].toUpperCase()); return o ? { type: 'choice', option: o } : none; }

  const { n } = spokenNumber(t);
  if (n != null) {
    const o = opts.find((x) => x.n === n) || (opts[n - 1] && opts[n - 1].n === n ? opts[n - 1] : null);
    return o ? { type: 'choice', option: o } : none;
  }
  return none;
}

// A spoken answer touching a sensitive topic (deploy, push, delete, secrets, money, customer, ...) needs a spoken "confirm".
export function needsConfirm(option, item = null) {
  if (!option) return false;
  if (item && item.kind === 'ask' && forbiddenMatch(item.question || '')) return true;
  return !!option.confirm || !!forbiddenMatch(`${option.label || ''} ${option.answer?.text || ''}`);
}
export const topicOf = (option, item) => {
  const m = forbiddenMatch(`${option?.label || ''} ${option?.answer?.text || ''}`) || item?.topic || (item?.kind === 'ask' ? forbiddenMatch(item.question || '') : null) || null;
  return typeof m === 'string' ? m : 'a sensitive topic';
};

// "recommended" | "wait" | n -> the option of the item (notification actions, the buttons of the page)
export function pickOption(item, which) {
  const opts = item?.options || [];
  if (which === 'recommended') return opts.find((o) => o.recommended) || null;
  if (which === 'wait') return waitOption(item || {}) || null;
  const n = Number(which);
  return Number.isInteger(n) ? opts.find((o) => o.n === n) || null : null;
}

export const shortOptions = (item) => (item.options || []).slice(0, 4).map((o) => `Option ${o.n}: ${trimTo(o.label, 40).replace(/[.…]+$/, '')}.`).join(' ');

// Feed `actions` for a needs-you push: only when the stop has a recommended option that is not forbidden.
export function feedActions(item) {
  const rec = item && item.kind === 'stop' && !item.draft ? (item.options || []).find((o) => o.recommended) : null;
  if (!rec || needsConfirm(rec) || item.topic) return null;
  const actions = [{ action: 'recommended', title: 'Do recommended' }];
  if (waitOption(item)) actions.push({ action: 'wait', title: 'Wait' });
  return actions;
}

// --- the spoken digest -------------------------------------------------------------------------------------------------
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (names, max = 3) => { const u = [...new Set(names)]; const s = u.slice(0, max).join(', '); return u.length > max ? `${s} and ${u.length - max} more` : s; };

// Pure. Sources: queue (open items), history (rows of /api/history), stalls (stalls.jsonl records), decided (G1 endpoint body or null),
// deploys (deploy-runner snapshot().deploys), quota (quota.get()). -> { text (<= 900 chars), parts }.
// One spoken sentence from lease-source summarize(): counts, the head of the queue with its ETA, idle holds.
export function leaseSpeech(sum) {
  if (!sum?.ok) return 'I cannot read the leases right now.';
  if (!sum.held && !sum.queued) return sum.pins ? `No leases are held; ${plural(sum.pins, 'pin')}.` : 'No leases are held and nobody is waiting.';
  const bits = [`${plural(sum.held, 'lease')} held${sum.pins ? `, ${plural(sum.pins, 'pin')}` : ''}`];
  if (sum.queued) {
    const h = sum.head;
    const eta = h?.etaMin == null ? '' : h.etaMin < 1 ? ', ETA under a minute' : `, ETA ${plural(h.etaMin, 'minute')}`;
    bits.push(h ? `the ${plainSpeech(h.resource === '*' ? h.env || 'env' : h.resource)} queue has ${h.count} waiting${eta}${sum.queued > h.count ? `, ${sum.queued - h.count} more elsewhere` : ''}` : `${sum.queued} waiting`);
  }
  bits.push(sum.idle ? `${plural(sum.idle, 'lease')} ${sum.idle === 1 ? 'looks' : 'look'} idle` : 'no lease is idle');
  return `${bits.join('; ')}.`;
}

export function digestText({ now = Date.now(), minutes = 60, queue = [], history = [], stalls = [], decided = null, deploys = [], quota = null, leases = null } = {}) {
  const since = now - minutes * 60000;
  const inWin = (t) => { const v = typeof t === 'number' ? t : Date.parse(t); return Number.isFinite(v) && v >= since && v <= now + 60000; };
  const parts = [];
  const win = minutes === 60 ? 'the last hour' : `the last ${minutes} minutes`;
  parts.push(queue.length ? `${plural(queue.length, 'item')} ${queue.length === 1 ? 'needs' : 'need'} you${queue.length ? `: ${list(queue.map((q) => q.session))}` : ''}.` : 'Nothing needs you right now.');

  const done = new Map();   // session -> latest finished-turn record in the window
  for (const r of stalls) if (r?.type === 'stall' && r.case === 'done' && r.session && inWin(r.at)) done.set(r.session, r);
  if (done.size) {
    const rows = [...done.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const lines = rows.slice(0, 3).map((r) => { const q = trimTo(plainSpeech(String(r.question || '').replace(/^STATUS:\s*/i, '')), 90); return q ? `${r.session}: ${q.replace(/[.…]+$/, '')}` : r.session; });
    parts.push(`In ${win}, ${plural(done.size, 'session')} finished a turn. ${lines.join('. ')}${done.size > 3 ? `. And ${done.size - 3} more` : ''}.`);
  }
  const started = history.filter((h) => inWin(h.start)), ended = history.filter((h) => h.end != null && inWin(h.end));
  if (started.length) parts.push(`${plural(started.length, 'session')} started: ${list(started.map((h) => h.name))}.`);
  if (ended.length) parts.push(`${plural(ended.length, 'session')} ended: ${list(ended.map((h) => h.name))}.`);

  if (decided && decided.summary && (decided.summary.count > 0 || decided.summary.text)) parts.push(sentence(plainSpeech(decided.summary.text) || `${plural(decided.summary.count, 'decision')} made for you`));
  else if (!decided) {
    const answers = stalls.filter((r) => r?.type === 'answer' && inWin(r.at || r.ts)).length;
    if (answers) parts.push(`${plural(answers, 'answer')} typed for you.`);
  }

  const fin = (deploys || []).filter((d) => (d.state === 'done' || d.state === 'failed') && inWin(d.finished));
  const bad = fin.filter((d) => d.state === 'failed'), ok = fin.filter((d) => d.state === 'done');
  if (bad.length) parts.push(`${plural(bad.length, 'deploy')} failed${bad.length ? `: ${list(bad.map((d) => d.env || d.id))}` : ''}.`);
  if (ok.length) parts.push(`${plural(ok.length, 'deploy')} finished${ok.length ? `: ${list(ok.map((d) => d.env || d.id))}` : ''}.`);

  if (leases?.ok && (leases.held || leases.queued)) parts.push(leaseSpeech(leases));

  const hot = [];
  for (const p of quota?.plans || []) for (const w of p.windows || []) if (!w.expired && Number.isFinite(w.usedPercent) && w.usedPercent >= 80) hot.push(`${p.plan} ${w.name} quota is at ${Math.round(w.usedPercent)} percent`);
  if (hot.length) parts.push(`${hot.slice(0, 2).join('. ')}.`.replace(/^./, (c) => c.toUpperCase()));

  let text = '';
  const kept = [];
  for (const p of parts) {
    const next = text ? `${text} ${p}` : p;
    if (next.length > 900) { if (!text) { text = trimTo(p, 900); kept.push(text); } break; }
    text = next; kept.push(p);
  }
  return { text, parts: kept };
}

// The decided-for-you view, in-process (manager.js decidedView). null when the call throws: the digest then counts the answers itself.
export async function decidedFor(view, { since, minutes, now = Date.now() }) {
  try { return await view({ hours: Math.max(1, Math.ceil(minutes / 60)), since: new Date(since).toISOString(), limit: 100, now }); }
  catch { return null; }
}

// --- the router -------------------------------------------------------------------------------------------------------
// deps: status() async -> status map, ownerAsks() async -> ledger asks, managerSessions() -> names, isPaused(name), priority(name),
//   send({ session, answer, by }) async (the guarded send; answer = { key } | { text }), logChoice(rec) async (manager.js logOwnerChoice),
//   digestSources({ since, minutes }) async -> { history, stalls, decided, deploys, quota }, now()
export function createVoice(deps) {
  const now = deps.now || Date.now;
  const queue = async () => voiceQueue({
    status: await deps.status(), ownerAsks: await deps.ownerAsks(), managerSessions: deps.managerSessions(),
    isPaused: deps.isPaused || (() => false), priority: deps.priority || (() => null), now: now(),
  });
  const err = (status, body) => ({ status, body: { ok: false, ...body } });
  const ok = (body) => ({ status: 200, body: { ok: true, ...body } });

  // The item for one session right now (used when a push is built): { item, actions } | null
  async function itemFor(session, st) {
    const item = stopItem(session, st, { mgrs: new Set(deps.managerSessions()), isPaused: deps.isPaused, priority: deps.priority, now: now() });
    return item;
  }

  async function answer(body) {
    const id = typeof body?.id === 'string' ? body.id : '';
    if (!id) return err(400, { error: 'id required' });
    const items = await queue();
    const item = items.find((i) => i.id === id);
    if (!item) {
      const m = /^stop:(.+?):[^:]+:[0-9a-f]{8}$/.exec(id);
      const changed = m && items.some((i) => i.kind === 'stop' && i.session === m[1]);
      return err(409, { status: 'stale', say: changed ? 'That stop changed. I did not send anything.' : 'That one is already handled.', error: changed ? 'stop changed' : 'item is no longer open' });
    }
    const via = body.via === 'notification' ? 'notification' : 'voice';
    if (item.draft) return err(409, { status: 'draft', say: `${item.session} has a draft in its input box. I did not send anything.`, error: 'draft in the input box' });

    // 1) which option?
    let option = null, confirmed = body.confirm === true;
    if (body.option !== undefined && body.option !== null) {
      option = pickOption(item, body.option);
      if (!option) return ok({ status: 'again', say: `Sorry, that option is not available. ${shortOptions(item)}`.trim() });
    } else {
      const m = matchSpokenAnswer(body.transcript, item);
      if (m.type === 'intent') {
        if (m.intent === 'confirm' || m.intent === 'cancel') {
          const pend = body.pending != null ? pickOption(item, body.pending) : null;
          if (m.intent === 'cancel') return ok({ status: 'intent', intent: 'cancel', say: 'Cancelled. Nothing was sent.' });
          if (!pend) return ok({ status: 'intent', intent: 'confirm', say: 'There is nothing to confirm.' });
          option = pend; confirmed = true;
        } else if (m.intent === 'ready') {   // ---- ready window (round 9 item 8) ----
          if (!deps.setReady) return ok({ status: 'intent', intent: 'ready', say: 'Ready windows are not connected.' });
          try {
            const w = await deps.setReady({ minutes: m.minutes, device: m.device, session: m.device ? null : item.session || null, by: VOICE_BY });
            return ok({ status: 'intent', intent: 'ready', ready: w, say: `Okay. Sessions may retry hardware steps ${m.device ? `on ${m.device}` : item.session ? `for ${item.session}` : ''} without asking, until ${w.until_hhmm}.`.replace(/\s+/g, ' ') });
          } catch (e) { return ok({ status: 'intent', intent: 'ready', say: `I could not set that. ${String(e.message || '').slice(0, 80)}` }); }
        } else {
          const say = m.intent === 'leases' ? await leaseSentence() : { skip: 'Skipping.', next: 'Next.', repeat: '', stop: 'Stopping.', digest: '', wait: `Okay, I will leave ${item.session} for you.` }[m.intent] ?? '';
          return ok({ status: 'intent', intent: m.intent, say });
        }
      } else if (m.type === 'choice') {
        option = m.option;
      } else {
        const pend = body.pending != null ? pickOption(item, body.pending) : null;
        const tail = pend ? ` You chose ${pend.label}. Say confirm to send, or cancel.` : ` ${shortOptions(item)}`;
        return ok({ status: 'again', say: `Sorry, I did not get that.${tail}`.trim() });
      }
    }

    // 2) a sensitive topic needs a spoken confirm; a notification never confirms
    if (needsConfirm(option, item) && !confirmed) {
      if (via === 'notification') return ok({ status: 'open', url: '/?voice=1', say: 'That needs a confirmation. Open the app.' });
      return ok({ status: 'confirm', option: option.n, label: option.label,
        say: `You chose ${option.label} for ${item.session}. That touches ${topicOf(option, item)}. Say confirm to send, or cancel.` });
    }

    // 3) send it (the item was re-read just above; the guarded send re-checks the pane)
    const target = option.answer.to || item.session;
    try { await deps.send({ session: target, answer: option.answer.to ? { text: option.answer.text } : option.answer, by: VOICE_BY }); }
    catch (e) { return err(e.status || 500, { status: 'error', say: `I could not send that to ${item.session}. ${String(e.message || '').slice(0, 80)}`, error: e.message }); }
    try { await deps.logChoice?.({ id: item.stallId || item.askId, session: item.session, kind: item.kind === 'ask' ? 'ledger' : item.questionKind, owner: String(option.id).slice(0, 80) }); } catch { /* logging never blocks the answer */ }
    return ok({ status: 'sent', option: option.n, label: option.label, say: item.kind === 'ask' ? `Sent option ${option.n} for ${item.askId} to the manager (${target}).` : `Sent ${option.label} to ${item.session}.` });
  }

  // the lease sentence from the lease source (deps.leaseView: async -> lease-source view); unreadable = said so, never "none"
  async function leaseSentence() {
    if (!deps.leaseView) return 'Leases are not connected.';
    let v = null; try { v = await deps.leaseView(); } catch { v = null; }
    return leaseSpeech(leaseSummary(v, now()));
  }
  async function digest(minutes) {
    const m = Math.min(24 * 60, Math.max(5, Math.round(Number(minutes)) || 60));
    const t = now();
    const src = await deps.digestSources({ since: t - m * 60000, minutes: m });
    let leases = null;
    if (deps.leaseView) { try { leases = leaseSummary(await deps.leaseView(), t); } catch { leases = null; } }
    return digestText({ now: t, minutes: m, queue: await queue(), leases, ...src });
  }

  // -> { status, body } | null (not a voice route)
  async function route({ method, path, query, readBody }) {
    if (!path.startsWith('/api/voice/')) return null;
    try {
      if (method === 'GET' && path === '/api/voice/queue') return ok({ items: await queue() });
      if (method === 'GET' && path === '/api/voice/digest') return ok(await digest(query?.get ? query.get('minutes') : query?.minutes));
      if (method === 'POST' && path === '/api/voice/answer') return await answer(await readBody());
    } catch (e) { return err(e.status || (e instanceof SyntaxError ? 400 : 500), { error: e.message }); }
    return err(404, { error: 'no such voice route' });
  }
  return { route, queue, answer, digest, itemFor };
}

// A stop that asks the owner about a lease is never an owner question (round 10 design sections 4 and 7): the manager answers it from the
// lease source with a fixed template and the rule "wait, never ask". Pure: detection, parts, the template, the idle-hold flag.
// stall.js FORBIDDEN_RE is untouched; hardMatch is only used to keep the typed answer free of words the hard floor would block.
import { hardMatch } from './stall.js';

export const LEASE_RULE = 'Wait with `vpt-lease claim ... --wait` (or `vpt-lease run ... -- <cmd>`); never ask the owner about a lease.';

// --- detection --------------------------------------------------------------------------------------------------------
// An ask: a question mark, an interrogative opener, or a modal ("should I", "can I", "ok to", "whether").
const ASK_RE = /\?|^\W*(?:is|are|was|can|could|may|might|should|shall|do|does|did|will|would|who|what|which|when|how|ok|okay)\b|\b(?:should|shall|can|could|may|do|did|would|will) (?:i|we)\b|\b(?:ok|okay|fine|safe) to\b|\bwhether\b|\bwant me to\b|\bneed(?:s)? to know\b/i;
// a resource word: what a lease is about
const RES_WORD = /\b(?:frontend|server|host|hosts|device|devices|env|environment|stb|box|node\d*|platform|resource|cluster)\b|[\w.-]+\/[\w:./-]+|\b(?:host|stb|device|node)-?\d+\b/i;
const FREE_WORD = /\b(?:free|available|busy|taken|in use|locked|held|reserved|occupied)\b(?!\s+(?:of|from|tier|up)\b)/i;
const LEASE_WORD = /\bleases?\b|\bleased\b|\bvpt-lease\b/i;
const LEASE_CTX = /\b(?:held|holds?|holder|holding|exclusive|claim(?:ed|s)?|release[ds]?|free|busy|wait(?:ing)?|queue[ds]?|ticket|registry|expire[ds]?|env|frontend|server|host|device|resource|deploy(?:ing)?|blocked|pin(?:ned)?|taken|still|clear|available|vpt-lease|mine|ours)\b/i;
const NOT_LEASE = /\b(?:apartment|office|rental|landlord|tenant|car lease|lease agreement|lease for the (?:new )?(?:office|flat|car|building)|sign(?:ing)? (?:the|a) lease)\b/i;
const WHO_RE = /\bwho (?:holds|has|owns|is using|is on|is holding|took|is blocking)\b[^?.\n]{0,50}\b(?:lease|frontend|server|host|device|env|stb|resource|platform|it)\b/i;
const WAIT_RE = /\b(?:should|shall|can|do|could) (?:i|we) (?:just |keep |continue )?(?:wait|queue|retry|poll|keep waiting)\b[^?.\n]{0,60}\b(?:lease|free|frees|held|holder|released|busy)\b|\bwait(?:ing)? (?:for|until|on)\b[^?.\n]{0,40}\b(?:lease|frontend|server|host|device)\b[^?.\n]{0,30}\b(?:free|released?|held|busy)\b/i;
const FREE_Q = new RegExp(String.raw`\b(?:is|are|was|will)\b[^?.\n]{0,60}${FREE_WORD.source}`, 'i');

// -> { lease: boolean, kind: 'free'|'who'|'wait'|'lease'|null }
export function leaseAsk(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t || NOT_LEASE.test(t)) return { lease: false, kind: null };
  const ask = ASK_RE.test(t);
  if (!ask) return { lease: false, kind: null };
  if (WHO_RE.test(t) && (RES_WORD.test(t) || LEASE_WORD.test(t))) return { lease: true, kind: 'who' };
  if (WAIT_RE.test(t)) return { lease: true, kind: 'wait' };
  if (LEASE_WORD.test(t) && (LEASE_CTX.test(t) || /vpt-lease/i.test(t))) return { lease: true, kind: /\bfree|busy|held|taken\b/i.test(t) ? 'free' : 'lease' };
  if (FREE_Q.test(t) && RES_WORD.test(t)) return { lease: true, kind: 'free' };
  return { lease: false, kind: null };
}

// the resources a question names: env-a/frontend, host-1/device2, frontend, server, stb-1 ...
export function mentionsOf(text) {
  const t = String(text ?? '');
  const out = new Set();
  for (const m of t.match(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_:./-]+/g) || []) { if (!/^https?:/i.test(m) && !/\.\w{2,4}$/.test(m)) out.add(m.replace(/[.,;:)]+$/, '').toLowerCase()); }
  for (const m of t.match(/\b(?:frontend|server)\b/gi) || []) out.add(m.toLowerCase());
  for (const m of t.match(/\b(?:host|stb|device|node|env)-?[\w-]*\d[\w-]*|\benv-[a-z][\w-]*/gi) || []) out.add(m.toLowerCase());
  return [...out].filter((x) => ![...out].some((y) => y !== x && y.startsWith(`${x}/`)));   // "env-a" beside "env-a/frontend" is only its prefix
}

// --- the answer -------------------------------------------------------------------------------------------------------
const clean = (s, n) => String(s ?? '').replace(/[`\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const mins = (ms) => Math.max(0, Math.round(ms / 60000));
const shortRes = (env, r) => (r === '*' ? `${env}/*` : `${env ? `${env}/` : ''}${r}`);
const mine = (agent, session) => !!session && !!agent && (agent === `codebox:${session}` || String(agent).endsWith(`:${session}`));

// does a lease (env, resources) touch what the question names? An env-wide lease touches every resource of its env; a host lease its devices.
export function touches(mention, env, resources) {
  const m = String(mention).toLowerCase();
  return resources.some((r) => {
    const res = String(r).toLowerCase(), full = `${env}/${res}`.toLowerCase();
    if (res === '*') return m === env.toLowerCase() || m.startsWith(`${env.toLowerCase()}/`) || !m.includes('/');
    return full.includes(m) || m.includes(res) || m.endsWith(res) || res.includes(m) || (res.includes('/') && m === res.split('/')[0]);
  });
}

// text with every hard-floor hit masked; null when it cannot be made safe. The reply is typed as the manager's own answer,
// so it must not carry a word the hard floor blocks (a holder named "manager:deploy", a purpose "frontend deploy").
function safe(text) {
  let t = text;
  for (let i = 0; i < 6; i++) {
    const hit = hardMatch(t, {});
    if (!hit) return t;
    t = t.split(hit).join('…');
  }
  return hardMatch(t, {}) ? null : t;
}

// view: lease-source view() ({ ok, leases (rich), tickets }); ask: the text of the lease part.
// -> { text, held, mentions } | null (when no safe text can be built)
export function answerLeaseAsk({ ask, view, session = '', now = Date.now() } = {}) {
  const mentions = mentionsOf(ask);
  if (!view?.ok) {
    const t = safe(`The lease source is unreachable, so treat ${mentions[0] || 'the resource'} as busy. ${LEASE_RULE}`);
    return t ? { text: t, held: null, mentions } : null;
  }
  const leases = (view.leases || []).filter((l) => l.mode === 'exclusive');
  const rel = mentions.length ? leases.filter((l) => mentions.some((m) => touches(m, l.env, l.resources))) : leases;
  const tickets = (view.tickets || []).filter((x) => mine(x.agent, session) || mine(x.session, session) || x.session === `codebox:${session}`);
  const build = (withPurpose) => {
    const parts = [];
    if (!rel.length) {
      parts.push(mentions.length ? `${mentions.slice(0, 2).join(', ')} has no exclusive lease held right now, so it is free; claim it before you drive it.` : 'No exclusive lease is held right now; claim what you drive before you drive it.');
    } else {
      for (const l of rel.slice(0, 3)) {
        const since = l.sinceMs ? `, since ${mins(now - l.sinceMs)} min ago` : '';
        const left = l.ttlLeftMin != null ? `, ${l.ttlLeftMin} min left` : '';
        const idle = l.idleMin != null && l.idleMin > 0 ? `, idle ${l.idleMin} min` : '';
        const purpose = withPurpose && l.purpose ? ` for "${clean(l.purpose, 80)}"` : '';
        parts.push(`${l.resources.map((r) => shortRes(l.env, r)).join(', ')} is held by ${clean(l.agent, 60) || 'an unknown agent'} (${l.mode})${purpose}${since}${left}${idle}.`);
      }
      if (rel.length > 3) parts.push(`${rel.length - 3} more held.`);
    }
    for (const x of tickets.slice(0, 2)) {
      const eta = x.etaMs ? `, expected free in about ${mins(x.etaMs - now)} min` : '';
      parts.push(`You are #${x.position ?? '?'} in the queue for ${x.resources.map((r) => shortRes(x.env, r)).join(', ')}${eta}.`);
    }
    const own = leases.filter((l) => mine(l.agent, session) || mine(l.session, session) || l.session === `codebox:${session}`);
    if (own.length && !rel.some((l) => own.includes(l))) parts.push(`You hold ${own.slice(0, 2).map((l) => l.resources.map((r) => shortRes(l.env, r)).join(', ')).join('; ')}.`);
    parts.push(LEASE_RULE);
    return parts.join(' ');
  };
  const text = safe(build(true)) || safe(build(false));
  return text ? { text, held: rel.length, mentions } : null;
}

// --- a session that holds an exclusive lease while its STATUS says it waits (legacy mode feed flag; central: the service downgrades it) ---
export function idleHoldEvent({ session, status, rows }) {
  if (!/^(?:waiting|blocked)$/i.test(String(status || '')) || !(rows || []).length) return null;
  const what = rows.slice(0, 3).map((r) => `${r.env}/${r.resource}`).join(', ');
  return { key: 'lease:idle-hold', title: `${session} holds ${what} while STATUS is ${String(status).toLowerCase()}`,
    body: `exclusive lease held by a session that waits; it should release or downgrade it (vpt-lease release <id> / narrow); lease ids: ${rows.map((r) => r.id).join(', ')}`, url: '/?leases=1', priority: 'default' };
}

// does the text talk about a lease (a question or a statement)? Used by ops-ask.js for a STATUS that blocks on one.
export const leaseTopic = (text) => { const t = String(text ?? ''); return !NOT_LEASE.test(t) && LEASE_WORD.test(t) && LEASE_CTX.test(t); };

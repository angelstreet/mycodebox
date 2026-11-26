// In doubt, ask Opus (owner, 2026-11-26): "when you have doubt to answer a question in your harness you should say ask opus to answer".
// Pure. Two places show doubt: jev-ask on point `stop` when Jev did not decide (source rule / error), and a session's question in the
// manager's event feed. Both only SAY so, with the command (scripts/ask-opus.js); nothing here or in the server calls a model.
// The owner's floor never goes to Opus: it stays with the owner whatever Opus would say.
import { floor } from './router.js';
import { ownerFloorMatch, hardMatch, readAsk } from './stall.js';

export const DOUBT_NOTE = 'in doubt: ask Opus to answer (before guessing or asking the owner); owner-floor items stay with the owner';

// -> null, or why only the owner may answer: the stop point's forced floors (facts), then the owner / hard floor read off the ask (as ops-ask.js).
export function ownerOnly({ facts = null, text = '' } = {}) {
  if (facts) {
    const f = floor('stop', facts);
    if (f.forced) return f.reasons.join('; ');
  }
  const ask = readAsk([text, facts?.proposed_reply, facts?.closing_text].filter(Boolean).join('\n'));
  const hit = ownerFloorMatch(ask) || hardMatch(ask, { mergePresent: true, pushPresent: true, deployPresent: true });
  return hit ? `owner floor wording: "${String(hit).slice(0, 60)}"` : null;
}

export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The fields jev-ask adds to its JSON line. {} when there is no doubt (Jev decided, a floor decided, another point).
export function jevDoubt({ point, source, facts, script }) {
  if (point !== 'stop' || (source !== 'rule' && source !== 'error')) return {};
  const owner = ownerOnly({ facts });
  if (owner) return { owner_only: owner };
  return { in_doubt: DOUBT_NOTE, ask_opus: `node ${shellQuote(script)} --facts ${shellQuote(JSON.stringify(facts))}` };
}

// A manager-feed event that carries a session's question: an ask, a needs-manager line, or a lease / deploy manager item.
const QUESTION_KEY = /:(?:asks|needs-manager|manager-item)$/;
export function eventDoubt({ key, session, title = '', body = '' }) {
  if (!QUESTION_KEY.test(String(key)) || !session) return null;
  if (ownerOnly({ text: `${title}\n${body}` })) return null;
  return `in doubt: ask Opus to answer: ~/ghosty-sessions/scripts/ask-opus.js --session ${shellQuote(session)} --question '<question + facts>'`;
}

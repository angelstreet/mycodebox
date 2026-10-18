// Lease and deploy stops are manager items, never owner items (OWNER_DECISIONS §19). Pure: decides whether a stop's ask is about a lease or
// a deploy and nothing else. The manager escalates what it cannot answer; such a stop goes to the manager (an event in the feed the manager
// agent follows), not to the owner (no push, not in NEEDS YOU). Deletions, credentials, money, customers, migrations, sudo stay owner items.
import { hardMatch } from './stall.js';
import { leaseAsk, leaseTopic } from './lease-ask.js';

// a deploy: the word, update_core, the deploy queue / approval, or a restart of a service done by the deploy procedure
const DEPLOY_TOPIC = /\bdeploy(?:s|ed|ing|ment|ments)?\b|\bredeploy\w*|\bupdate_core\b|\bdeploy[- ]?(?:queue|runner|request|approval)\b|\brestart(?:ing|s|ed)?\b[^.?\n]{0,40}\b(?:service|services|server|backend|frontend|pm2|vpt-[\w-]+|unit)\b/i;
const NOT_OPS = /\b(?:deploy(?:ment)? (?:docs?|documentation|diagram|tests?|script (?:name|file)))\b/i;

// -> 'lease' | 'deploy' | null
export function opsAsk(final) {
  if (!final || typeof final !== 'object') return null;
  const text = String(final.question || '').replace(/\[[^\]\n]{0,60}\]/g, ' ').replace(/\s+/g, ' ').trim();   // "[1 yes 2 wait]" is the answer menu, not part of the ask
  const c = final.case;
  const status = String(final.status || '').toLowerCase();
  const stopKind = c === 'waiting_deploy' ? 'waiting_deploy' : c === 'owner_decision' || /^(?:needs-owner|blocked)$/.test(status) ? 'decision' : null;
  if (!stopKind) return null;
  // the hard floor: anything but deploy / restart in the text keeps the stop with the owner (deletion, credentials, money, customers, migrations, sudo ...)
  if (hardMatch(`${text} ${final.blocked || ''}`, { deployPresent: true })) return null;
  if (final.forbidden && hardMatch(String(final.forbidden), { deployPresent: true })) return null;
  if (stopKind === 'waiting_deploy') return leaseTopic(text) || leaseAsk(text).lease ? 'lease' : 'deploy';
  if (!text) return null;
  // every question of the stop must be about a lease or a deploy; a mixed stop (a product question beside a deploy one) goes to the owner
  const segs = text.split(/(?<=\?)\s+/).map((s) => s.trim()).filter((s) => s.endsWith('?'));
  const parts = segs.length ? segs : [text];
  let kind = null;
  for (const s of parts) {
    const lease = leaseAsk(s).lease || leaseTopic(s);
    const deploy = DEPLOY_TOPIC.test(s) && !NOT_OPS.test(s);
    if (!lease && !deploy) return null;
    kind = kind === 'deploy' || (deploy && !lease) ? 'deploy' : 'lease';
  }
  return kind;
}
export const isLeaseOrDeployAsk = (final) => !!opsAsk(final);

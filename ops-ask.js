// Lease and deploy stops are manager items, never owner items (OWNER_DECISIONS §19). Pure: decides whether a stop's ask is about a lease or
// a deploy and nothing else. The manager escalates what it cannot answer; such a stop goes to the manager (an event in the feed the manager
// agent follows), not to the owner (no push, not in NEEDS YOU). Owner items are now only: money/payments, customers, deleting shared data,
// owner-held credentials (third-party logins, keys to rotate), and physical actions on a device. Migrations, generated app secrets, merge/push,
// tests/CI, infra config and technical choices are manager items. A stop whose STATUS line is `STATUS: needs-manager: ...` is always a manager
// item regardless of topic.
//
// The OWNER-vs-MANAGER routing decision uses OWNER_FLOOR (stall.js ownerFloorMatch), NOT the FORBIDDEN_RE safety filter.
// FORBIDDEN_RE is the auto-answer safety filter -- it is the hard gate that never lets ghosty auto-answer deploy / push /
// merge / sudo / migration / money / customer / destructive data / third-party credential / physical, and it is restored
// exactly as on main. Only OWNER_FLOOR topics (money, customers, shared_data_delete, owner-held credentials with the
// generated-secret exception, physical) escalate to the owner; any other FORBIDDEN_RE topic (deploy, push, merge, sudo,
// migration, generated app secrets) escalates to the manager (the manager's merge / deploy evaluation owns it).
import { ownerFloorMatch, hardMatch } from './stall.js';
import { leaseAsk, leaseTopic } from './lease-ask.js';

// a deploy: the word, update_core, the deploy queue / approval, or a restart of a service done by the deploy procedure
const DEPLOY_TOPIC = /\bdeploy(?:s|ed|ing|ment|ments)?\b|\bredeploy\w*|\bupdate_core\b|\bdeploy[- ]?(?:queue|runner|request|approval)\b|\brestart(?:ing|s|ed)?\b[^.?\n]{0,40}\b(?:service|services|server|backend|frontend|pm2|vpt-[\w-]+|unit)\b/i;
// a yes/no "fix <your own defect> now?": the session found a defect in its own work and asks leave to fix it. Never an owner question
// (AGENTS: fix own defects, never ask); a manager item that the manager answers "yes, fix it". Floor topics are excluded before this runs.
const OWN_FIX = /^(?:(?:should|shall|may|can|do you want me to|ok to|okay to)\s+(?:i|we)\s+)?(?:fix|patch|repair|correct)\b[^?]{0,80}\bnow\s*\?$/i;
const NOT_OPS = /\b(?:deploy(?:ment)? (?:docs?|documentation|diagram|tests?|script (?:name|file)))\b/i;

// -> 'lease' | 'deploy' | null  (any non-null value signals: this stop is a manager item)
export function opsAsk(final) {
  if (!final || typeof final !== 'object') return null;
  const text = String(final.question || '').replace(/\[[^\]\n]{0,60}\]/g, ' ').replace(/\s+/g, ' ').trim();   // "[1 yes 2 wait]" is the answer menu, not part of the ask
  const c = final.case;
  const status = String(final.status || '').toLowerCase();
  // needs-manager: the agent addresses the manager directly, always a manager item (no topic check)
  if (status === 'needs-manager') return 'lease';
  const stopKind = c === 'merge_wait' ? 'waiting_deploy' : c === 'waiting_deploy' ? 'waiting_deploy' : c === 'owner_decision' || /^(?:needs-owner|blocked)$/.test(status) ? 'decision' : null;
  if (!stopKind) return null;
  // the routing floor: only OWNER_FLOOR topics (money, customers, shared_data_delete, owner-held credentials with the
  // generated-secret exception, physical) keep the stop with the owner. Deploy / push / merge / sudo / migration /
  // generated app secrets / unit files / reboot are FORBIDDEN_RE topics that route to the manager (the manager's
  // evaluation owns them).
  if (ownerFloorMatch(`${text} ${final.blocked || ''}`)) return null;
  if (final.forbidden && ownerFloorMatch(String(final.forbidden))) return null;
  if (hardMatch(`${text} ${final.blocked || ''}`, { mergePresent: true, pushPresent: true, deployPresent: true })) return null;   // OWNER_DECISIONS §15 hard floor (force-push, tags, publish, sudoers, units, migrations): never a manager item; the deploy / push / merge words themselves are the manager's
  if (c === 'merge_wait') return final.topics?.hard ? null : 'merge';   // never the owner's: a hard word (force-push, secrets) keeps it with the owner
  if (stopKind === 'waiting_deploy') return leaseTopic(text) || leaseAsk(text).lease ? 'lease' : 'deploy';
  if (!text) return null;
  // every question of the stop must be about a lease or a deploy; a mixed stop (a product question beside a deploy one) goes to the owner
  const segs = text.split(/(?<=\?)\s+/).map((s) => s.trim()).filter((s) => s.endsWith('?'));
  const parts = segs.length ? segs : [text];
  let kind = null;
  for (const s of parts) {
    const lease = leaseAsk(s).lease || leaseTopic(s);
    const deploy = DEPLOY_TOPIC.test(s) && !NOT_OPS.test(s);
    if (!lease && !deploy && OWN_FIX.test(s) && parts.length === 1) return 'fix';
    if (!lease && !deploy) return null;
    kind = kind === 'deploy' || (deploy && !lease) ? 'deploy' : 'lease';
  }
  return kind;
}
export const isLeaseOrDeployAsk = (final) => !!opsAsk(final);

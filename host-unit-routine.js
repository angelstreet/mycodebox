// The one predicate for the routine-change exceptions to the owner's hard floor. Three classes, all decided and journaled
// by the manager ("Decided for you"), never sent to the owner:
//   unit   - host_units (owner, 2026-10-25: "it is technical, there is no risk of adding that system unit"; widened
//            2026-10-26 from CI runner VMs to codebox and helper / database hosts)
//   safer  - a change that only makes something safer or idempotent: a migration made re-runnable, a guard added,
//            permissions tightened (owner, 2026-10-26: "making something more safe should be allowed")
//   perm   - a permission / ownership fix so a service can read its own settings file, contents never read or printed
//            (owner, 2026-10-26: "pure technical change, change the harness so that you can answer that")
// Historic note for the unit class (2026-10-25): Every place that treats unit / service / systemd / sudo words as the owner's hard floor
// asks this first: stall.js hardMatch (and so topicSplit, ops-ask, merge-policy, info-lookup, lease-ask, ready-window,
// manager) and owner-asks.js checkAsk (the host_units floor). Do not copy these regexes elsewhere.
//
// ROUTINE unit: adding or updating a unit, timer or script that is in a reviewed and merged repo change, on codebox, a CI
// runner VM or another non-production helper / database host, with the previous file kept as a backup and a rollback
// line. The text must SAY all of that; a text that leaves one out is not routine and stays with the owner.
// STILL FLOOR (all classes): sudoers; production or customer-facing app hosts; the ghosty-sessions service itself (its own
// restart / deploy procedure); reboots; removing / masking / disabling a unit that is not a replacement; new, rotated or
// revoked credentials (the permission class may name a settings file, never its values); money, customers, deleting data,
// destructive migrations and history rewrites (those stay with stall.js hardMatch, which still reads the text). One
// still-floor word anywhere in the text (also in a spelling variant) cancels the exception.

const ACTION = /\b(?:install(?:s|ed|ing)?|add(?:s|ed|ing)?|updat(?:e|es|ed|ing)|upgrad(?:e|es|ed|ing)|re-?install(?:s|ed|ing)?|render(?:s|ed|ing)?)\b/i;
const UNIT_THING = /\b(?:units?|timers?|systemd|scripts?)\b|\.(?:service|timer)\b/i;
const HELPER_VM = /\b(?:(?:ci|cicd)[- ]runner|runner) VMs?\b|\bnon-?production (?:helper )?(?:VMs?|hosts?)\b|\bhelper (?:VMs?|hosts?)\b|\b(?:database|db) hosts?\b|\bcodebox\b/i;
const MERGED = /\bmerged\b/i, REVIEWED = /\breview(?:ed)?\b/i;
const BACKUP = /\bback(?:ed)?[- ]?ups?\b|\b(?:old|previous)\b[^.\n]{0,30}\b(?:kept|keep|saved)\b|\b(?:keep|kept|keeps|keeping|save[sd]?)\b[^.\n]{0,30}\b(?:old|previous)\b/i;
const ROLLBACK = /\brollback\b|\broll(?:s|ed)? back\b|\brestor(?:e|es|ing)\b/i;

const STILL_FLOOR = [
  /sudoers|\/etc\/sudo|visudo/i,
  /(?<!non-)\bprod(?:uction)?\b|\bcustomer|\bclient[- ]facing\b|\blive host\b/i,
  /\bghosty-sessions\b/i,
  /\breboot|\bshutdown\b|\bpower[- ]?cycle\b/i,
  /\.env\b|credential|password|passphrase|\bsecret|\btoken|bearer\b|\bapi[_ -]?key|ssh key|private key|\brevo(?:k(?:e|es|ed|ing)|cation)\b|\brotat(?:e|es|ed|ing|ion)\b/i,
];
// removal is floor unless the text says what replaces it
const REMOVAL = /\b(?:remov(?:e|es|ed|ing|al)|delet(?:e|es|ed|ing|ion)|uninstall(?:s|ed|ing)?|mask(?:s|ed|ing)?|disabl(?:e|es|ed|ing)|\brm\b)\b/i;
const REPLACEMENT = /\breplac(?:e|es|ed|ement|ing)\b/i;

const readings = (text, variants) => {
  const raw = String(text || '');
  return [raw, ...(typeof variants === 'function' ? variants(raw) : [])];
};

// -> { routine: boolean, why: string }   why names the first missing piece or the first still-floor hit
export function routineHostUnit(text, variants) {
  const all = readings(text, variants);
  for (const t of all) for (const re of STILL_FLOOR) { const m = re.exec(t); if (m) return { routine: false, why: `still floor: "${m[0]}"` }; }
  for (const t of all) if (REMOVAL.test(t) && !REPLACEMENT.test(t)) return { routine: false, why: 'still floor: removes or masks a unit that is not a replacement' };
  const raw = all[0];
  const need = [
    [ACTION, 'no install / add / update action'], [UNIT_THING, 'no unit, timer or script named'], [HELPER_VM, 'target is not a CI runner VM or other non-production helper VM'],
    [MERGED, 'not from a merged repo change'], [REVIEWED, 'not reviewed'], [BACKUP, 'no backup of the previous file'], [ROLLBACK, 'no rollback line'],
  ];
  for (const [re, why] of need) if (!re.test(raw)) return { routine: false, why };
  return { routine: true, why: 'reviewed + merged unit / timer / script on a CI runner or non-production helper VM, backup and rollback stated' };
}

// ---- safer / idempotent changes (owner, 2026-10-26) ----
const SAFER = /\bidempotent|\bre-?runnable\b|\bcreate or replace\b|\bif (?:not )?exists\b|\bguard(?:s|ed|ing)?\b|\btighten(?:s|ed|ing)?\b|\bhardens?\b|\b(?:more|makes?|made|making) (?:it |them |this )?safer?\b/i;
const UNDO = /\brollback\b|\broll(?:s|ed)? back\b|\brevert(?:s|ed|ing)?\b|\brestor(?:e|es|ing)\b|\bundo\b/i;
// a change that destroys or loses anything is not "only safer"
const DESTRUCTIVE = /\b(?:drop(?:s|ped|ping)?|truncat\w*|delet\w*|destroy\w*|wip(?:e|es|ed|ing)|purg\w*|eras\w*|irreversible|destructive|unreadable)\b/i;

// ---- permission / ownership fix so a service reads its own settings (owner, 2026-10-26) ----
const PERM = /\b(?:chmod|chown|chgrp|setfacl|permissions?|ownership|group[- ]read(?:able)?)\b/i;
const SETTINGS_FILE = /\b(?:settings|config(?:uration)?|env(?:ironment)?) file\b|\bits own (?:settings|config)/i;
// the text must say the contents are not read or printed
const NO_CONTENT = /\b(?:without|never|not|no)\b[^.\n]{0,30}\b(?:read\w*|print\w*|show\w*|reveal\w*|display\w*|cat\w*|log\w*|open\w*)\b[^.\n]{0,40}\b(?:contents?|values?|file)\b|\b(?:contents?|values?)\b[^.\n]{0,20}\b(?:is|are|stay|stays|remain|remains|never|not)\b[^.\n]{0,15}\b(?:read|printed|shown|logged|displayed|touched|opened)\b/i;
// the permission class may name a credential-ish file, but never change, show or hand out the credentials themselves
const PERM_FLOOR = [
  /sudoers|\/etc\/sudo|visudo/i,
  /(?<!non-)\bprod(?:uction)?\b|\bcustomer|\bclient[- ]facing\b|\blive host\b/i,
  /\bghosty-sessions\b/i,
  /\breboot|\bshutdown\b|\bpower[- ]?cycle\b/i,
  /\.env\b|password|passphrase|private key|ssh key|\brevo(?:k(?:e|es|ed|ing)|cation)\b|\brotat(?:e|es|ed|ing|ion)\b/i,
  /\b(?:new|replac\w+|chang\w+|print\w*|show\w*|reveal\w*|display\w*|cat|dump\w*|copy\w*|send\w*|share\w*|paste\w*)\b[^.\n]{0,25}\b(?:credentials?|secrets?|tokens?|keys?|passwords?|contents?|values?)\b/i,
];

const floorHit = (all, list) => { for (const t of all) for (const re of list) { const m = re.exec(t); if (m) return m[0]; } return null; };

function routineSafer(all) {
  const raw = all[0];
  const f = floorHit(all, STILL_FLOOR.slice(0, 4));   // sudoers / production / ghosty-sessions / reboot
  if (f) return { routine: false, why: `still floor: "${f}"` };
  for (const t of all) { const m = DESTRUCTIVE.exec(t); if (m) return { routine: false, why: `not only safer: "${m[0]}"` }; }
  const cred = floorHit(all, [STILL_FLOOR[4]]);
  if (cred) return { routine: false, why: `still floor: "${cred}"` };
  if (!SAFER.test(raw)) return { routine: false, why: 'no safer / idempotent change named' };
  if (!UNDO.test(raw)) return { routine: false, why: 'no rollback line' };
  return { routine: true, why: 'only makes something safer or idempotent (re-runnable, guarded, tightened), rollback stated' };
}

function routinePerm(all) {
  const raw = all[0];
  const f = floorHit(all, PERM_FLOOR.slice(0, 4));
  if (f) return { routine: false, why: `still floor: "${f}"` };
  if (!PERM.test(raw)) return { routine: false, why: 'no permission / ownership fix named' };
  if (!SETTINGS_FILE.test(raw)) return { routine: false, why: 'no settings file named' };
  if (!NO_CONTENT.test(raw)) return { routine: false, why: 'does not say the contents are not read or printed' };
  if (!UNDO.test(raw)) return { routine: false, why: 'no rollback line (the old mode / owner)' };
  const stripped = all.map((t) => t.replace(new RegExp(NO_CONTENT.source, 'gi'), ' '));
  const hit = floorHit(stripped, PERM_FLOOR.slice(4));
  if (hit) return { routine: false, why: `still floor: "${hit}"` };
  return { routine: true, why: 'permission / ownership fix so a service reads its own settings file; contents not read or printed; rollback stated' };
}

// -> { routine, kind: 'unit' | 'safer' | 'perm' | null, why }. The first class that holds wins; when none does, why is the unit class's.
export function routineChange(text, variants) {
  const all = readings(text, variants);
  const unit = routineHostUnit(text, variants);
  if (unit.routine) return { ...unit, kind: 'unit' };
  const perm = routinePerm(all);
  if (perm.routine) return { ...perm, kind: 'perm' };
  const safer = routineSafer(all);
  if (safer.routine) return { ...safer, kind: 'safer' };
  return { routine: false, kind: null, why: unit.why };
}

// The words that make a routine change look like the host_units floor. A routine text has them replaced by "UNIT" so
// the rest of the hard floor (deletes, credentials, money, history rewrites ...) still reads the same text unchanged.
const NEUTRAL = /\/etc\/systemd\/system\b[\w/.-]*|\bunit files?\b|\bsystemctl (?:enable|daemon-reload)\b(?: --now)?|\b[\w@-]+\.(?:service|timer)\b|\bsudo\b/gi;
export function neutralizeRoutineHostUnit(text, variants) {
  const raw = String(text || '');
  return routineChange(raw, variants).routine ? raw.replace(NEUTRAL, 'UNIT') : raw;
}

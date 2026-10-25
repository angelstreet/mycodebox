// The one predicate for the narrow host_units exception (owner, 2026-10-25: "it is technical, there is no risk of
// adding that system unit"). Every place that treats unit / service / systemd / sudo words as the owner's hard floor
// asks this first: stall.js hardMatch (and so topicSplit, ops-ask, merge-policy, info-lookup, lease-ask, ready-window,
// manager) and owner-asks.js checkAsk (the host_units floor). Do not copy these regexes elsewhere.
//
// ROUTINE (the session / manager decides and journals it in "Decided for you"): adding or updating a unit, timer or
// script that is in a reviewed and merged repo change, on a CI runner VM or other non-production helper VM, with the
// previous file kept as a backup and a rollback line. The text must SAY all of that; a text that leaves one out is
// not routine and stays with the owner.
// STILL FLOOR: sudoers; production or customer-facing hosts, and codebox's own ghosty-sessions service; reboots;
// removing / masking / disabling a unit that is not a replacement; credentials. One still-floor word anywhere in the
// text (also in a spelling variant) cancels the exception.

const ACTION = /\b(?:install(?:s|ed|ing)?|add(?:s|ed|ing)?|updat(?:e|es|ed|ing)|upgrad(?:e|es|ed|ing)|re-?install(?:s|ed|ing)?|render(?:s|ed|ing)?)\b/i;
const UNIT_THING = /\b(?:units?|timers?|systemd|scripts?)\b|\.(?:service|timer)\b/i;
const HELPER_VM = /\b(?:(?:ci|cicd)[- ]runner|runner) VMs?\b|\bnon-?production (?:helper )?(?:VMs?|hosts?)\b|\bhelper VMs?\b/i;
const MERGED = /\bmerged\b/i, REVIEWED = /\breview(?:ed)?\b/i;
const BACKUP = /\bback(?:ed)?[- ]?ups?\b|\b(?:old|previous)\b[^.\n]{0,30}\b(?:kept|keep|saved)\b|\b(?:keep|kept|keeps|keeping|save[sd]?)\b[^.\n]{0,30}\b(?:old|previous)\b/i;
const ROLLBACK = /\brollback\b|\broll(?:s|ed)? back\b|\brestor(?:e|es|ing)\b/i;

const STILL_FLOOR = [
  /sudoers|\/etc\/sudo|visudo/i,
  /(?<!non-)\bprod(?:uction)?\b|\bcustomer|\bclient[- ]facing\b|\blive host\b/i,
  /\bghosty-sessions\b|\bcodebox\b/i,
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

// The words that make a routine install look like the host_units floor. A routine text has them replaced by "UNIT" so
// the rest of the hard floor (deletes, credentials, money, history rewrites ...) still reads the same text unchanged.
const NEUTRAL = /\/etc\/systemd\/system\b[\w/.-]*|\bunit files?\b|\bsystemctl (?:enable|daemon-reload)\b(?: --now)?|\b[\w@-]+\.(?:service|timer)\b|\bsudo\b/gi;
export function neutralizeRoutineHostUnit(text, variants) {
  const raw = String(text || '');
  return routineHostUnit(raw, variants).routine ? raw.replace(NEUTRAL, 'UNIT') : raw;
}

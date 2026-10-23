// The disk-space banner: what it shows and what it says (pure; the DOM lives in app.js).
//
// The disk-space safety policy (disk-guard.js) is ON by default: from the warn threshold a banner shows, at the
// hold threshold new work is refused. The banner never hides a running session and never speaks in jargon: the
// owner reads what is wrong, what is refused and what still works.

export const DISK_REASON = 'disk_low';

const pct = (d) => (d && d.worst && d.worst.pct != null ? Math.round(d.worst.pct) : null);

// -> { show, level, hold, label, text, key }. `key` changes only when the banner has to be repainted.
export function diskBannerView(d) {
  const show = !!d && d.reason === DISK_REASON && (d.level === 'warn' || d.level === 'hold');
  if (!show) return { show: false, level: (d && d.level) || null, hold: false, label: '', text: '', key: '' };
  const hold = d.level === 'hold';
  const p = pct(d);
  const text = hold
    ? `The disk is ${p}% full. New sessions and tasks are paused until it drops below ${d.holdPct}%. Sessions that are already running keep going.`
    : `The disk is ${p}% full. New work pauses at ${d.holdPct}%, so free some space before then.`;
  return {
    show: true,
    level: d.level,
    hold,
    reason: DISK_REASON,
    label: hold ? 'DISK FULL' : 'DISK LOW',
    text,
    key: `${d.level}|${p}|${d.holdPct}|${d.blocked ? 1 : 0}`,
  };
}

// The one line above the list of volumes and folders (the banner's detail sheet).
export function diskDetailNote(d) {
  if (!d) return 'There is enough room on the disk.';
  if (d.level === 'hold') return 'New sessions and tasks are paused until the disk has room again. Running sessions are not affected.';
  if (d.level === 'warn') return `The disk is getting full. New work is paused at ${d.holdPct}%.`;
  return 'There is enough room on the disk.';
}

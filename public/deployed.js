// Time helper for the deploy ledger (epoch seconds). The Platforms view model is in platforms-view.js.

export function agoText(sec, nowSec) {
  const d = Math.max(0, Math.round(nowSec - sec));
  if (d < 90) return `${d}s ago`;
  if (d < 5400) return `${Math.round(d / 60)}m ago`;
  if (d < 172800) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86400)}d ago`;
}

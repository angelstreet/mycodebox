// Cloud sessions (docs/CLOUD.md): Claude Code sessions on Anthropic-hosted VMs are not tmux sessions, so the dashboard never sees
// them as cards. scripts/cloud-start appends one line per start to <state>/cloud-sessions.jsonl
// (at, id, url, repo, base, label, by, task); this reads it for the read-only Cloud view (GET /api/cloud-sessions), newest first,
// with the hand-off: the newest integration request queued as `integrate request ... --mac cloud-<label>` (externalLabel).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CLOUD_LOG = 'cloud-sessions.jsonl';
const URL_RE = /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+$/;   // the only link the view renders: never a free-form href

export function readCloudSessions(stateDir, { limit = 50, requests = [] } = {}) {
  let text = '';
  try { text = readFileSync(join(stateDir, CLOUD_LOG), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }   // a torn last line (a start killed mid-write) is skipped, not fatal
    if (!o || typeof o !== 'object' || !o.id) continue;
    const s = (k, n = 200) => (o[k] == null ? null : String(o[k]).slice(0, n));
    out.push({ at: s('at', 40), id: s('id', 80), url: URL_RE.test(String(o.url || '')) ? o.url : null, repo: s('repo', 80), base: s('base', 120),
      label: s('label', 80) || s('id', 80), by: s('by', 80), task: s('task', 300) });
  }
  out.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  return out.slice(0, Math.max(1, Math.min(500, Number(limit) || 50))).map((c) => ({ ...c, handoff: handoffOf(c, requests) }));
}

// requests: the lane's list (newest first). The match is the label cloud-start was given: `--mac cloud-<label>` (docs/CLOUD.md).
export function handoffOf(c, requests = []) {
  const want = new Set([`cloud-${c.label}`, c.label]);
  const r = (requests || []).find((x) => x && x.externalLabel && want.has(x.externalLabel));
  return r ? { id: r.id, state: r.state, branch: r.branch, repo: r.repo, sha: r.sha || null } : null;
}

// Pure: what a STATUS blocked / waiting line says about the session's own job (round 9, item 11). No imports: stall.js and own-jobs.js both use it.
const OWNER_WORDS = /\b(?:you|your|owner|approval|approve|decision|decide|go-ahead|answer|permission|input|review|confirm|sign[- ]?off|credentials?|token)\b/i;
const END_WORDS = /\b(?:wait(?:ing)?|running|in[ _-]progress|until|finish(?:es|ed|ing)?|complet(?:e|es|ed|ion)|ends?|done|to (?:end|finish)|still|will resume|still going)\b/i;
const JOB_NOUN = /\b(?:run|job|process|build|tests?|test run|suite|export|import|sync|task|script|batch|pipeline|render|training|migration run|benchmark|scan|upload|download|crawl|score_matrix|matrix|dispatch|sweep|poll|watcher|workflow|CI run)\b/i;
export const DETACHED_RE = /\b(?:nohup|setsid|disown)\b|(?:^|[\s)])&\s*(?:$|[;&|)])|\bscreen -dm|\btmux (?:new|new-session)\b[^\n]*-d\b/i;
const DEPLOY_ID = /\bdeploy(?:ment)?(?:\s+id)?\s*[:#=]?\s*([0-9a-f]{3,16})\b/i;
// `integration <id>`: the lane's request id (round 13). Only the lane's own id format (`int-<base36>`, integration-lane.js enqueue), so "integration test-2" / "integration lane" are not ids.
const INTEGRATION_ID = /\bintegration(?:\s+request)?(?:\s+id)?\s*[:#=]?\s*(int-[0-9a-z]{1,40})\b/gi;
const PID_RE = /\bpids?\s*[:=#]?\s*(\d{2,8})\b/i;
const RUN_ID = /\b(?:run|job|task)(?:\s+id)?\s*[:#=]\s*([A-Za-z0-9][\w.-]*)|\b(?:run|job)\s+id\s+([A-Za-z0-9][\w.-]*)|\b(?:run|job)\s+#(\d+)/i;
// "run ff3606fe" / "run 45123": an id behind a plain space. Hex of 6+ or digits of 5+, never ending mid-word and never a dotted decimal.
const RUN_SPACED = /\brun\s+([0-9a-f]{6,}|[0-9]{5,})(?![0-9a-z-]|\.[0-9])/i;
// "dispatch <digits>" and "workflow run <digits>" name the same id a bare Actions run id carries (three real STATUS lines, 2026-10-20).
const DISPATCH_RUN = /\b(?:dispatch|workflow\s+run)[\s:#=]*(\d{6,20})(?!\d)/i;
// https://host/o/r/actions/runs/<id>: the only URL path whose number is a run id.
const ACTIONS_RUN = /\/actions\/runs\/(\d{6,20})(?!\d)/;
// "watcher <id>" and a bare bg_<hex> background-task id (the harness's own background tasks).
const WATCHER_ID = /\bwatcher\s*(?:id\s*[:#=]?\s*)?((?:bg|watch|wt|task)_[0-9a-z]{3,32}|[0-9a-f]{4,32})(?![0-9a-z-])|\b(bg_[0-9a-f]{3,32})\b/i;
const LOG_RE = /`([^`\s]+\.(?:log|out|jsonl))`|(?:^|[\s(=:])((?:~?\/|\.{1,2}\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\.(?:log|out|jsonl))\b/i;

// An id carries a digit (or is a full 8-char sha); "facade" / "decade" spell an ordinary word.
const idLike = (s) => /\d/.test(s) || s.length >= 8;
// 202610202319: a compact date-time, not a run id.
const stampLike = (n) => n.length >= 10 && /^20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])/.test(n);

// A bare GitHub Actions run id: a standalone number of 9 to 12 digits. Never a date or time, a version like
// 2026.10.20-89466, a percentage, a size, or a number inside a URL path (only /actions/runs/<id> is one).
function bareRun(t) {
  const s = t.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, ' ');   // drop URL spans, so no path number survives
  for (const m of s.matchAll(/\d{4,}/g)) {
    const n = m[0];
    if (n.length < 9 || n.length > 12) continue;
    const end = m.index + n.length;
    const before = s[m.index - 1] || '', after = s[end] || '';
    if (before && /[\w/.:%&+\-=]/.test(before)) continue;      // inside a version, a path, an id or another number
    if (after && /[\w/:%&+\-]/.test(after)) continue;             // same, and a percentage
    if (after === '.' && /\d/.test(s[end + 1] || '')) continue;  // a decimal
    if (/^\s*(?:bytes?|[kmgt]i?b)\b/i.test(s.slice(end))) continue;   // a size
    if (stampLike(n)) continue;
    return n;
  }
  return null;
}

// Order of preference: an explicit `run id:` / `run #7`, then "run <id>" behind a space, then "dispatch <id>" /
// "workflow run <id>", then a run id in a GitHub URL, then a bare Actions run id.
function runId(t) {
  const r = RUN_ID.exec(t);
  if (r) return r[1] || r[2] || r[3];
  const s = RUN_SPACED.exec(t);
  if (s && idLike(s[1])) return s[1];
  const d = DISPATCH_RUN.exec(t);
  if (d) return d[1];
  const u = ACTIONS_RUN.exec(t);
  if (u) return u[1];
  return bareRun(t);
}

function integrationId(t) {
  const m = INTEGRATION_ID.exec(t); INTEGRATION_ID.lastIndex = 0;
  return m ? m[1] : null;
}

// -> { deploy, pid, path, run, watcher, integration, detached }; every field null/false when not named
export function jobRefs(text) {
  const t = String(text ?? '');
  const d = DEPLOY_ID.exec(t), p = PID_RE.exec(t), l = LOG_RE.exec(t), w = WATCHER_ID.exec(t);
  return {
    deploy: d ? d[1] : null,
    pid: p ? Number(p[1]) : null,
    path: l ? (l[1] || l[2]).replace(/[.,;:)]+$/, '') : null,
    run: runId(t),
    watcher: w ? (w[1] && idLike(w[1]) ? w[1] : w[2] || null) : null,
    integration: integrationId(t),
    detached: DETACHED_RE.test(t),
  };
}
export const hasRef = (r) => !!(r && (r.deploy || r.integration || r.pid || r.path || r.run || r.watcher));

// Does a STATUS blocked / waiting text wait on a job of the session's own (not on the owner)?
export function waitsOnOwnJob(text, kind = null) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t || /\?/.test(t) || OWNER_WORDS.test(t)) return false;
  const r = jobRefs(t);
  if (r.deploy) return true;   // "deploy <id>" is the deploy runner's job
  if (r.integration) return true;   // "integration <id>" is the lane's job (own-jobs.js watches the request)
  return (kind === 'waiting' || END_WORDS.test(t)) && (hasRef(r) || JOB_NOUN.test(t));
}

// Pure: what a STATUS blocked / waiting line says about the session's own job (round 9, item 11). No imports: stall.js and own-jobs.js both use it.
const OWNER_WORDS = /\b(?:you|your|owner|approval|approve|decision|decide|go-ahead|answer|permission|input|review|confirm|sign[- ]?off|credentials?|token)\b/i;
const END_WORDS = /\b(?:wait(?:ing)?|running|in progress|until|finish(?:es|ed|ing)?|complet(?:e|es|ed|ion)|ends?|done|to (?:end|finish)|still)\b/i;
const JOB_NOUN = /\b(?:run|job|process|build|tests?|test run|suite|export|import|sync|task|script|batch|pipeline|render|training|migration run|benchmark|scan|upload|download|crawl|score_matrix|matrix)\b/i;
export const DETACHED_RE = /\b(?:nohup|setsid|disown)\b|(?:^|[\s)])&\s*(?:$|[;&|)])|\bscreen -dm|\btmux (?:new|new-session)\b[^\n]*-d\b/i;
const DEPLOY_ID = /\bdeploy(?:ment)?(?:\s+id)?\s*[:#=]?\s*([0-9a-f]{3,16})\b/i;
const PID_RE = /\bpids?\s*[:=#]?\s*(\d{2,8})\b/i;
const RUN_ID = /\b(?:run|job|task)(?:\s+id)?\s*[:#=]\s*([A-Za-z0-9][\w.-]*)|\b(?:run|job)\s+id\s+([A-Za-z0-9][\w.-]*)|\b(?:run|job)\s+#(\d+)/i;
const LOG_RE = /`([^`\s]+\.(?:log|out|jsonl))`|(?:^|[\s(=:])((?:~?\/|\.{1,2}\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\.(?:log|out|jsonl))\b/i;

// -> { deploy, pid, path, run, detached }; every field null/false when not named
export function jobRefs(text) {
  const t = String(text ?? '');
  const d = DEPLOY_ID.exec(t), p = PID_RE.exec(t), l = LOG_RE.exec(t), r = RUN_ID.exec(t);
  return {
    deploy: d ? d[1] : null,
    pid: p ? Number(p[1]) : null,
    path: l ? (l[1] || l[2]).replace(/[.,;:)]+$/, '') : null,
    run: r ? (r[1] || r[2] || r[3]) : null,
    detached: DETACHED_RE.test(t),
  };
}
export const hasRef = (r) => !!(r && (r.deploy || r.pid || r.path || r.run));

// Does a STATUS blocked / waiting text wait on a job of the session's own (not on the owner)?
export function waitsOnOwnJob(text, kind = null) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t || /\?/.test(t) || OWNER_WORDS.test(t)) return false;
  const r = jobRefs(t);
  if (r.deploy) return true;   // "deploy <id>" is the deploy runner's job
  return (kind === 'waiting' || END_WORDS.test(t)) && (hasRef(r) || JOB_NOUN.test(t));
}


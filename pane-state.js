// The live state of one session's pane this tick (server.js pollOnce): offline, waiting, working, idle, or done when only background
// subagents spin under a hand-over STATUS turn. Pure, so the stop rules are tested directly (test/pane-state.test.js); the later idle -> done
// guess (turn markers, the done clock) stays in server.js.
import { stoppedBehindAgents } from './stall.js';

// Explicit permission / question prompts only; tested against the LAST lines.
export const WAIT_RE = /Do you want to |Would you like to (?:proceed|allow|run)|^\W*(?:1\.\s*)?Yes,? (?:allow|and|proceed)|^\s*[❯>›]\s*1\.\s*Yes\b|\(y\/n\)|\[y\/n\]|\(y\/N\)|\[Y\/n\]|Allow (?:command|this|once|always)|Allow\?|Approve\?|Esc to cancel|Enter to confirm|Press Enter to (?:continue|confirm|approve)|Run this command\?|Apply (?:this )?(?:patch|changes)\?|Proceed\?/i;
// Spinner / progress markers (NOT "Thinking On", which is MiniMax's status bar).
export const WORK_RE = /esc to interrupt|ctrl\+c to interrupt|Working \(|Thinking[….]|…\s*\(\d+(?:m \d+)?s\b|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+\S/;
export const WORKING_HOLD_MS = 4000;   // a pane that changed this recently still reads as working

const TRIM_RE = /^[\s│┃|╭╰─╮╯>❯›]+|[\s│┃|╮╯]+$/g;
export function findWaitReason(lines) {
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (WAIT_RE.test(lines[i])) { idx = i; break; }
  }
  if (idx < 0) return null;
  for (let i = idx; i >= Math.max(0, idx - 6); i--) {
    const l = lines[i].replace(TRIM_RE, '');
    if (/\?$/.test(l) && !/^\d+\./.test(l)) return l.slice(0, 120);
  }
  return lines[idx].replace(TRIM_RE, '').slice(0, 120);
}

// { offline, agent, tail (last non-blank lines), changeAt, now, reportedWait(), handedTurn(), runningAgents() }
//   reportedWait / handedTurn / runningAgents are lazy reporter reads (Claude only): a standing reported wait, the finished hand-over turn
//   (reporter.handedOverTurn), the count of running subagents.
// -> { state, waitReason, spinning, behindAgents, doneGuess }
//   spinning = real work this tick (not a repaint); behindAgents = done only because the spinner is the subagents'; doneGuess = when it stopped.
export function liveState({ offline, agent, tail, changeAt = 0, now, reportedWait = () => null, handedTurn = () => null, runningAgents = () => 0 }) {
  const out = { state: 'idle', waitReason: null, spinning: false, behindAgents: false, doneGuess: null };
  if (offline) { out.state = 'offline'; return out; }
  if (agent !== 'bash' && (out.waitReason = findWaitReason(tail)) !== null) { out.state = 'waiting'; return out; }
  // Claude with a live reporter: a permission request / notification it reported still stands (the pane has been still since)
  // even when the pane regex above missed it.
  const rw = agent === 'claude' ? reportedWait() : null;
  if (rw) return { ...out, state: 'waiting', waitReason: rw.message || 'needs input' };
  out.waitReason = null;
  const spinning = agent !== 'bash' && WORK_RE.test(tail.filter((l) => !/⏵⏵|bypass permissions|accept edits/.test(l)).join('\n'));
  const handed = agent === 'claude' ? handedTurn() : null;
  // only background subagents spin under a hand-over STATUS turn: a finished turn (stall, push, red dot), not work
  if (handed && stoppedBehindAgents(tail, handed.text, runningAgents())) return { ...out, state: 'done', behindAgents: true, doneGuess: handed.at || now };
  out.spinning = spinning;
  if (now - changeAt < WORKING_HOLD_MS || spinning) out.state = 'working';
  return out;
}

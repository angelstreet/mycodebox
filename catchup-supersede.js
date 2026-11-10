// Catch-up supersede planning (bug: a catch-up was cancelled by an OLDER or diverged ref and its hosts were dropped).
// Pure: `contains(newer, older)` says whether ref `newer` contains ref `older` (git merge-base --is-ancestor older newer):
// true | false | null (unknown). Only `true` ever cancels; false/unknown leave the queued request alone.
import { execFileSync } from 'node:child_process';

const uniq = (a) => [...new Set(a)];
const subset = (a, b) => (a || []).every((h) => (b || []).includes(h));

// existing: queued/running catch-ups of the env whose host set holds all of `want` (coveringCatchUps); d: the finished deploy
// (its ref is the ref of the new catch-up); want: hosts that need a catch-up at d.ref.
// Returns { queue, hosts, held, cancel, kept }:
//  held    - catch-ups that already deploy `want` at d.ref or at a ref that contains it (nothing new is queued)
//  cancel  - queued catch-ups whose ref d.ref contains, and whose hosts the survivor carries (union): never dropped
//  kept    - queued catch-ups at another ref that d.ref does not contain (older or diverged): left alone
//  hosts   - hosts of the new request (want + the hosts of every cancelled one) when queue is true
export function planCatchUps(existing, d, want, contains) {
  const ex = existing || [];
  const held = ex.filter((x) => x.ref === d.ref || contains(x.ref, d.ref) === true);
  const others = ex.filter((x) => !held.includes(x));
  const supers = others.filter((x) => x.state === 'queued' && contains(d.ref, x.ref) === true);
  const kept = others.filter((x) => !supers.includes(x));
  if (held.length) {
    // the survivor is a held one: a superseded request is cancelled only when its hosts are all inside a held host set
    const cancel = supers.filter((x) => held.some((h) => subset(x.hosts, h.hosts)));
    return { queue: false, hosts: [], held, cancel, kept: [...kept, ...supers.filter((x) => !cancel.includes(x))] };
  }
  return { queue: true, hosts: uniq([...(want || []), ...supers.flatMap((x) => x.hosts || [])]), held: [], cancel: supers, kept };
}

// git containment in `dir`; null when it cannot be decided (no repo, unknown ref).
export function gitContains(dir) {
  return (newer, older) => {
    if (!dir || !newer || !older) return null;
    if (newer === older) return true;
    try { execFileSync('git', ['-C', dir, 'merge-base', '--is-ancestor', older, newer], { stdio: 'ignore', timeout: 10000 }); return true; }
    catch (e) { return e.status === 1 ? false : null; }
  };
}

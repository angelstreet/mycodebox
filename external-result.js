// External-origin integration results (owner/manager 2026-11-02). A request queued for a Mac or cloud session (no live tmux session, no lane
// route/token) has nobody the lane can wake: a Mac session once waited ~7 h on `STATUS: waiting: integration <id>`. On every final state of such
// a request this module (1) writes the one-paragraph result to <state>/integration/external-results/<id>.txt for the owner to copy, (2) emits a
// manager event `<id>:external-result` (kind `external-result`, always wakes the manager, which relays it to the session), and (3) pushes the owner
// if the manager has not acknowledged within ackMs (10 min). Ack = <id>.ack newer than the .txt (POST /api/integration/external-results/<id>/ack).
// State lives in files, so the 10-min check survives a restart (sweep()).
import fs from 'node:fs';
import { join } from 'node:path';
import { isFinal, integrationText, normRequest } from './integration-notify.js';

export const ACK_MS = 10 * 60 * 1000;
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const isExternal = (r) => !!r && r.origin === 'external';
const ID_RE = /^[\w-]{1,64}$/;

// Pure: the paragraph (id, label, branch, state, sha, deploy version, what to do next).
export function externalResultText(r) {
  if (!r || !isFinal(r.state)) return null;
  const n = normRequest(r);
  const head = integrationText(r).split('\n')[0];
  const next = n.state === 'returned' ? 'Next: fix it on the branch, push it and queue it again (integrate request).'
    : n.state === 'merged_ci_red' || n.state === 'deploy_failed' ? 'Next: the manager decides; do not revert it yourself.'
    : n.state === 'cancelled' ? 'Next: queue it again if it is still wanted.' : 'Next: nothing, pull the target to continue.';
  const bits = [`label ${one(n.externalLabel) || 'external'}`, n.sha ? `sha ${String(n.sha).slice(0, 12)}` : '', n.version ? `deploy version ${one(n.version)}` : ''].filter(Boolean);
  return `${head} (${bits.join(', ')}). ${next}`.replace(/\.\s*\(/, ' (');
}

export function createExternalResult({ stateDir, managerEvent = async () => {}, ownerPush = () => {}, now = Date.now, ackMs = ACK_MS, log = () => {}, fsMod = fs } = {}) {
  const dir = join(stateDir, 'integration', 'external-results');
  const p = (id, ext) => join(dir, `${id}.${ext}`);
  const mtime = (f) => { try { return fsMod.statSync(f).mtimeMs; } catch { return 0; } };
  const touch = (f, t) => { fsMod.writeFileSync(f, ''); fsMod.utimesSync(f, t / 1000, t / 1000); };

  // call on every transition: only the final state of an external request does anything
  async function relay(request) {
    try {
      if (!isExternal(request) || !isFinal(request.state) || !ID_RE.test(String(request.id))) return { relayed: false };
      const text = externalResultText(request);
      fsMod.mkdirSync(dir, { recursive: true });
      const key = `${request.id}:${request.state}`;
      let prev = ''; try { prev = fsMod.readFileSync(p(request.id, 'state'), 'utf8'); } catch { /* first */ }
      if (prev === request.state) return { relayed: false, dup: true };
      fsMod.writeFileSync(p(request.id, 'state'), request.state);
      fsMod.writeFileSync(p(request.id, 'txt'), `${text}\n`);
      await Promise.resolve(managerEvent({ key: `${request.id}:external-result`, title: `External result ${request.id}: ${request.state} (${one(request.externalLabel) || 'external'})`, body: text, url: '/?integration=1', priority: request.state === 'merged_ci_red' || request.state === 'deploy_failed' || request.state === 'returned' ? 'high' : 'default', session: String(request.id) }));
      log({ type: 'external_result', id: request.id, state: request.state, key });
      return { relayed: true, text, file: p(request.id, 'txt') };
    } catch (e) { log({ type: 'external_result_failed', id: request?.id, error: String(e?.message || e).slice(0, 200) }); return { relayed: false, error: e.message }; }
  }

  function ack(id) {
    if (!ID_RE.test(String(id)) || !mtime(p(id, 'txt'))) return false;
    touch(p(id, 'ack'), Math.max(now(), mtime(p(id, 'txt'))));
    return true;
  }

  // push the owner once for every result the manager has not acknowledged within ackMs
  function sweep() {
    const pushed = [];
    let names = []; try { names = fsMod.readdirSync(dir); } catch { return pushed; }
    for (const f of names.filter((x) => x.endsWith('.txt'))) {
      const id = f.slice(0, -4), t = mtime(p(id, 'txt'));
      if (mtime(p(id, 'ack')) >= t || mtime(p(id, 'pushed')) >= t || now() - t < ackMs) continue;
      let text = ''; try { text = fsMod.readFileSync(p(id, 'txt'), 'utf8').trim(); } catch { continue; }
      try { ownerPush({ title: `Unrelayed integration result ${id}`, body: `${text}\nThe manager has not relayed it in ${Math.round(ackMs / 60000)} min; file ${p(id, 'txt')}.`.slice(0, 600), url: '/?integration=1', tag: `external-result-${id}`, priority: 'high', kind: 'integration' }); touch(p(id, 'pushed'), Math.max(now(), t)); pushed.push(id); } catch (e) { log({ type: 'external_result_push_failed', id, error: String(e?.message || e).slice(0, 160) }); }
    }
    return pushed;
  }
  return { relay, ack, sweep, dir };
}

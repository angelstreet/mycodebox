// The local tmux session an HTTP request on the loopback listener comes from, read from the operating system: the process that
// owns the client end of the TCP connection, then its parents up to a tmux pane. A name in the request body is what the caller
// says; this is where the request was made. null when it cannot be told (another user's process, a proxy, no pane above it).
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 3000 }, (e, stdout) => resolve(e ? '' : String(stdout))));

// parent pid from /proc/<pid>/stat (the command name may hold spaces and brackets: read after the last ')')
export async function parentOf(pid, read = readFile) {
  try {
    const s = String(await read(`/proc/${pid}/stat`, 'utf8'));
    const m = /^\)\s+\S+\s+(\d+)/.exec(s.slice(s.lastIndexOf(')')));
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

// panes: async () => [{ pid, name }] (every pane of every session). -> async (req) => session name | null
export function createPeerSession({ panes, exec = run, read = readFile, ss = 'ss', maxDepth = 64 } = {}) {
  return async function peerSession(req) {
    const rp = Number(req?.socket?.remotePort), lp = Number(req?.socket?.localPort);
    if (!Number.isInteger(rp) || !Number.isInteger(lp) || rp <= 0 || lp <= 0) return null;
    const out = await exec(ss, ['-Htnp', `sport = :${rp} and dport = :${lp}`]);
    const pids = [...new Set([...String(out).matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))];
    if (!pids.length) return null;
    let list; try { list = await panes(); } catch { return null; }
    const byPid = new Map((list || []).map((p) => [Number(p.pid), String(p.name)]));
    const found = new Set();
    for (const start of pids) {
      let pid = start, name = null;
      for (let i = 0; i < maxDepth && pid > 1; i++) {
        if (byPid.has(pid)) { name = byPid.get(pid); break; }
        pid = await parentOf(pid, read);
      }
      found.add(name);
    }
    return found.size === 1 ? [...found][0] : null;   // every process holding the connection must sit in the same session
  };
}

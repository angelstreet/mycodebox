// Stand-in for `codex app-server`: answers initialize and account/rateLimits/read, one JSON per line.
// FAKE_MODE: ok (default) | error (JSON-RPC error on the read) | hang (never answers) | die (exits at once)
import { createInterface } from 'node:readline';
const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'die') process.exit(3);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let sawInitialized = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { userAgent: 'fake' } });
  if (m.method === 'initialized') { sawInitialized = true; return; }
  if (m.method === 'account/rateLimits/read') {
    if (mode === 'hang') return;
    if (mode === 'error' || !sawInitialized) return out({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'not signed in' } });
    out({ jsonrpc: '2.0', method: 'noise/notification', params: {} });
    out({ jsonrpc: '2.0', id: m.id, result: { rateLimits: {
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1791100000 },
      secondary: { usedPercent: 32, windowDurationMins: 10080, resetsAt: 1791600000 },
      planType: 'plus' } } });
  }
});

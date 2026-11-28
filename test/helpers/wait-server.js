// Shared start-up wait for tests that spawn server.js: polls /api/sessions until it answers.
// Deadline default 60 s (a loaded box needs it), override with TEST_START_TIMEOUT_MS.
// On timeout the error carries the time waited and the server log.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitServer(url, log = () => '', { timeoutMs } = {}) {
  const limit = timeoutMs ?? (Number(process.env.TEST_START_TIMEOUT_MS) || 60000);
  const t0 = Date.now();
  for (;;) {
    try { if ((await fetch(`${url}/api/sessions`)).ok) return; } catch { /* not up yet */ }
    const waited = Date.now() - t0;
    if (waited > limit) throw new Error(`server did not start after ${waited} ms (limit ${limit} ms):\n${typeof log === 'function' ? log() : log}`);
    await sleep(100);
  }
}

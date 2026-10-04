// Langfuse prompt management for the AI reviewer's system prompt (TASK-44 phase 12).
// The prompt `ghosty-ai-reviewer` (label `production`) is fetched from the local Langfuse and cached for 10 minutes;
// when Langfuse is not configured, down, or has no such prompt, the hard-coded REVIEWER_SYSTEM is used and the
// call records no prompt version. A reviewer call never waits on more than one short fetch and never fails because of it.

export const PROMPT_NAME = 'ghosty-ai-reviewer';
export const PROMPT_LABEL = 'production';
const TTL_MS = 10 * 60000;
const MISS_TTL_MS = 60000;   // after a failed fetch, do not retry for a minute

// cfg = { langfuseUrl, publicKey, secretKey }. get() -> { text, name, version, source: 'langfuse' | 'fallback' }
export function createPromptSource({ cfg, fallback, name = PROMPT_NAME, label = PROMPT_LABEL, ttlMs = TTL_MS, fetchFn = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  let hit = null;      // last good fetch { text, version, at }
  let missAt = 0;
  const configured = !!(cfg?.langfuseUrl && cfg.publicKey && cfg.secretKey);
  const fb = () => ({ text: fallback, name: null, version: null, source: 'fallback' });
  const fromHit = () => ({ text: hit.text, name, version: hit.version, source: 'langfuse' });
  return {
    configured,
    async get() {
      if (!configured) return fb();
      const t = now();
      if (hit && t - hit.at < ttlMs) return fromHit();
      if (!hit && t - missAt < MISS_TTL_MS) return fb();
      try {
        const r = await fetchFn(`${cfg.langfuseUrl.replace(/\/+$/, '')}/api/public/v2/prompts/${encodeURIComponent(name)}?label=${encodeURIComponent(label)}`, {
          headers: { authorization: 'Basic ' + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64') }, signal: AbortSignal.timeout(3000),
        });
        if (!r.ok) throw new Error(`http ${r.status}`);
        const j = await r.json();
        if (j.type !== 'text' || typeof j.prompt !== 'string' || !j.prompt.trim() || !Number.isInteger(j.version)) throw new Error('not a text prompt');
        hit = { text: j.prompt, version: j.version, at: t };
        return fromHit();
      } catch (e) {
        missAt = t;
        if (hit) { hit.at = t - ttlMs + MISS_TTL_MS; return fromHit(); }   // a stale good prompt beats the fallback; retry in a minute
        return fb();
      }
    },
  };
}

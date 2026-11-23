// What /api/upload stores (owner 2026-11-23: ".md and .txt from my Mac make an error"). A Mac browser often sends a .md / .txt with
// no MIME type (the client then names it by extension, public/upload.js uploadType) or as text/plain; every text upload used to
// be saved as .md and a .txt was refused. The file keeps its own name after a unique prefix, so the agent sees
// "…-ai_bot_story_ep01_final_script.md", not a number.
export const UPLOAD_IMAGE = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const UPLOAD_TEXT_EXT = new Set(['md', 'markdown', 'txt', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml']);
export const UPLOAD_TEXT_TYPES = new Set(['text/markdown', 'text/x-markdown', 'text/plain', 'text/csv']);

// contentType: the request's (no parameters); name: the original file name (x-upload-name, may be empty)
// -> { ext, stem } (stem: a safe version of the original name without its extension, '' when none) or null (refused)
export function uploadTarget(contentType, name = '') {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  const base = String(name || '').split(/[\\/]/).pop();
  const m = /^(.*)\.([A-Za-z0-9]+)$/.exec(base);
  const nameExt = m ? m[2].toLowerCase() : '';
  const stem = (m ? m[1] : base).normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^[._]+|_+$/g, '').slice(0, 80);
  if (UPLOAD_IMAGE[ct]) return { ext: UPLOAD_IMAGE[ct], stem };
  if (!UPLOAD_TEXT_TYPES.has(ct)) return null;
  if (UPLOAD_TEXT_EXT.has(nameExt)) return { ext: nameExt, stem };
  return { ext: ct === 'text/plain' && !nameExt ? 'md' : ct === 'text/csv' ? 'csv' : ct === 'text/plain' ? 'txt' : 'md', stem };   // no name: the old behaviour (.md)
}

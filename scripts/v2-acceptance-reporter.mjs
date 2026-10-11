// node --test reporter for scripts/v2-acceptance.js: one JSON line per finished test (name, file, outcome, todo/skip).
// Only test names and file paths are emitted; assertion messages are cut short and never include captured output.
import { relative } from 'node:path';

export default async function* acceptanceReporter(source) {
  for await (const ev of source) {
    if (ev.type !== 'test:pass' && ev.type !== 'test:fail') continue;
    const d = ev.data;
    if (d.details?.type === 'suite') continue;
    const err = ev.type === 'test:fail' ? d.details?.error : null;
    yield `${JSON.stringify({
      outcome: ev.type === 'test:pass' ? 'pass' : 'fail', name: d.name, nesting: d.nesting,
      file: d.file ? relative(process.cwd(), d.file) : null, todo: d.todo ?? false, skip: d.skip ?? false,
      duration_ms: Math.round(d.details?.duration_ms ?? 0),
      error: err ? String(err.cause?.message ?? err.message ?? err).split('\n')[0].slice(0, 300) : null,
    })}\n`;
  }
}

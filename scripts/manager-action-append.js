#!/usr/bin/env node
// Append one validated JSON line to <state>/manager-actions.jsonl: `manager-action-append.js '{"at":"...","decision":"..."}'` (or JSON on stdin).
// Invalid JSON is refused with exit 2 and nothing is written. `at` is filled in when missing.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { appendJsonLine, oneJsonLine } from '../jsonl-append.js';

const state = process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty');
const text = process.argv[2] ?? readFileSync(0, 'utf8').trim();
try {
  const obj = JSON.parse(oneJsonLine(text));
  if (!obj.at) obj.at = new Date().toISOString();
  appendJsonLine(join(state, 'manager-actions.jsonl'), obj);
} catch (e) { console.error(`manager-action-append: ${e.message}`); process.exit(2); }

// Temp dirs for tests, tracked and removed when the importing test file ends. Unchecked mkdtemp() calls used to
// pile up in the system temp dir (codebox ran out of inodes); create dirs through tmp() instead of mkdtemp().
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const made = [];
export const tmp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
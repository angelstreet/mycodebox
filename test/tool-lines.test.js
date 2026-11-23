import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_LINE, toolName } from '../public/tool-lines.js';

test('tool lines: the session-file form and the pane form (cut, no closing paren) both group; prose and code do not', () => {
  assert.equal(toolName('`Bash cd /home/u/repo && npm test`'), 'Bash');
  assert.equal(toolName('`Bash(cd /home/u/repo/frontend; timeout 200 ./node_modul`'), 'Bash', 'pane form cut at 100 chars');
  assert.equal(toolName('`Skill(frontend-worktree-e2e)`'), 'Skill');
  assert.equal(toolName('`Read 3 files (ctrl+o to expand)`'), 'Read');
  assert.equal(toolName('`mcp__easel__chart`'), 'mcp__easel__chart');
  assert.equal(toolName('`npm test`'), '');
  assert.equal(toolName('`Bashful`x'), '');
  assert.equal(TOOL_LINE.test('Typecheck passes. Running lint and the size gate.'), false);
});

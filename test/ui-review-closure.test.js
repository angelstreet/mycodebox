// The exported reviewer holds every product file it imports (scripts/ui-review-closure.py, ui-review-lane.js). On 2026-11-26
// ui_review.py began importing a script outside the fixed export list and every graphical request came back on the crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { createUiReview } from '../ui-review-lane.js';
import { createDefaultGit } from '../integration-lane.js';
import { makeWorld } from './helpers-lane.js';
import { tmp } from './helpers-tmp.js';

const run = async (cmd, { cwd }) => {
  try { return { code: 0, out: execFileSync('bash', ['-c', `{ ${cmd}; } 2>&1`], { cwd, encoding: 'utf8' }) }; }
  catch (e) { return { code: e.status ?? 1, out: String(e.stdout || e.message) }; }
};
const reviewer = () => createUiReview({ stateDir: tmp('uir-state-'), git: createDefaultGit(), run });

// like the product: a script beside the review folder, which reaches into a package, lazily and relatively too
const BASE = {
  'scripts/review/ui_review_gate.py': `import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import ui_review
ui_review.report()
print('ui-review-gate: pass uir-1 every import found')
`,
  'scripts/review/ui_review.py': `import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from report_cli import report
`,
  'scripts/report_cli.py': `import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from shared.lib import gateway
def report():
    gateway.send()
`,
  'shared/__init__.py': '',
  'shared/lib/__init__.py': 'from .marker import MARK\n',
  'shared/lib/marker.py': 'MARK = 1\n',
  'shared/lib/gateway.py': `from pathlib import Path
from . import router
def send():
    from shared.other.late import go
    go()
    (Path(__file__).parent / 'allow.json').read_text()
`,
  'shared/lib/router.py': 'import json\n',
  'shared/lib/allow.json': '{}\n',
  'shared/other/late.py': 'def go():\n    pass\n',
  'shared/unused/big.py': '',
  'scripts/unused.py': '',
  'frontend/src/App.tsx': 'ok\n',
};

test('what the reviewer imports from outside the export list is exported with it, transitively', async () => {
  const w = makeWorld({ base: BASE });
  const cfg = { paths: ['^frontend/'], from: w.lane, ref: 'origin/main', repo: 'virtualpytest', timeoutMin: 2 };
  const u = await reviewer().review(cfg, { id: 'int-1', mode: 'nightly' });
  assert.equal(u.verdict, 'pass', u.summary);
  const { home } = await reviewer().exportReviewer(cfg, 'int-2');
  for (const f of ['scripts/report_cli.py', 'shared/lib/marker.py', 'shared/lib/router.py', 'shared/lib/allow.json', 'shared/other/late.py']) assert.ok(existsSync(join(home, f)), f);
  for (const f of ['shared/unused/big.py', 'scripts/unused.py', '.imports']) assert.ok(!existsSync(join(home, f)), `${f} is not needed`);
});

// The real product, when this host has it: every module of the exported reviewer imports with only the export on disk, and
// every import in the exported files that the product's tree can satisfy is satisfied by the export (lazy ones included).
const product = process.env.UI_REVIEW_PRODUCT_CLONE || join(os.homedir(), 'virtualpytest');
test('the real reviewer of the product imports from its export alone', { skip: !existsSync(join(product, 'scripts/review/ui_review_gate.py')) && 'no product clone here' }, async () => {
  const { home } = await reviewer().exportReviewer({ from: product, ref: 'origin/main' }, 'int-real');
  const probe = `import ast, pathlib, subprocess, sys, importlib
home, repo = pathlib.Path(sys.argv[1]), sys.argv[2]
sys.path[:0] = [str(home / 'scripts' / 'review'), str(home / 'scripts'), str(home)]
for f in sorted((home / 'scripts' / 'review').glob('*.py')):
    importlib.import_module(f.stem)
tree = set(subprocess.run(['git', '-C', repo, 'ls-tree', '-r', '--name-only', 'origin/main'], capture_output=True, text=True, check=True).stdout.split('\\n'))
todo, seen, missing = list((home / 'scripts' / 'review').glob('*.py')), set(), []
while todo:
    f = todo.pop()
    if f in seen: continue
    seen.add(f)
    for n in ast.walk(ast.parse(f.read_text())):
        if isinstance(n, ast.Import): names, bases = [a.name for a in n.names], None
        elif isinstance(n, ast.ImportFrom):
            m = n.module or ''
            names = [m] + [(m + '.' if m else '') + a.name for a in n.names]
            bases = [f.parents[n.level - 1]] if n.level else None
        else: continue
        for name in filter(None, names):
            for base in bases or [f.parent, home / 'scripts' / 'review', home / 'scripts', home]:
                stem = base.joinpath(*name.split('.')).relative_to(home).as_posix()
                for cand in (stem + '.py', stem + '/__init__.py'):
                    if cand in tree:
                        if (home / cand).is_file(): todo.append(home / cand)
                        else: missing.append(f'{f.relative_to(home)} imports {name}: {cand} is not exported')
print('\\n'.join(sorted(set(missing))))
sys.exit(1 if missing else 0)
`;
  const out = execFileSync('python3', ['-B', '-c', probe, home, product], { cwd: home, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.homedir() } });
  assert.equal(out.trim(), '');
});

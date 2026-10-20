import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDecision } from '../orchestration/task-contract.js';
import { MERGE_DEFAULTS, parseMergeAsk, testEvidence, gitFacts, mergeFloor, reasoningDecision, evaluateMerge, journalRecord, composeReply, migrationAdditive, migrationReasons } from '../merge-policy.js';
import { hardMatch } from '../stall.js';
import { makeRepo, commit, git } from './helpers-git.js';

const GREEN = 'All 1826/1826 tests pass on feat.';

// ---- parseMergeAsk ----
test('parseMergeAsk: branch tokens and targets', () => {
  assert.deepEqual(parseMergeAsk('merge task90-open and deploy once the host frees?'), { branch: 'task90-open', target: null });
  assert.deepEqual(parseMergeAsk('Shall I merge feature/x into main?'), { branch: 'feature/x', target: 'main' });
  assert.deepEqual(parseMergeAsk('merge the branch v2/r7-merge-policy onto develop.'), { branch: 'v2/r7-merge-policy', target: 'develop' });
  assert.deepEqual(parseMergeAsk('merge it now'), { branch: null, target: null });
  assert.deepEqual(parseMergeAsk('merge this branch to main'), { branch: null, target: 'main' });
  assert.deepEqual(parseMergeAsk('nothing here'), { branch: null, target: null });
});

// ---- testEvidence ----
test('testEvidence: green forms', () => {
  for (const t of ['1826/1826 pass', '40 passed', '12 passing', 'all green', 'tests are green', 'CI green', 'tests pass on feat', '0 failed, 12 passed', 'no failures, 40 passing']) {
    assert.equal(testEvidence(t).state, 'green', t);
  }
  assert.equal(testEvidence('1826/1826 pass').explicit, true);
  assert.equal(testEvidence('all green').explicit, false);
  assert.equal(testEvidence('0 failures. all green').state, 'green');
});
test('testEvidence: red wins, unknown otherwise', () => {
  for (const t of ['2 failed', '3 failing tests', 'build is red', 'FAIL test/x.test.js', 'broken', '1800/1826 pass', 'all green but 2 failed']) {
    assert.equal(testEvidence(t).state, 'red', t);
  }
  assert.match(testEvidence('x\n2 failed in foo').quote, /2 failed/);
  assert.equal(testEvidence('I refactored the module').state, 'unknown');
  assert.equal(testEvidence('').state, 'unknown');
});

// ---- gitFacts ----
test('gitFacts: clean branch', async () => {
  const repo = makeRepo();
  const f = await gitFacts({ cwd: repo, branch: 'feat' });
  assert.equal(f.ok, true);
  assert.equal(f.branch, 'feat'); assert.equal(f.target, 'main');
  assert.equal(f.repoName, 'proj');
  assert.deepEqual(f.conflicts, []); assert.deepEqual(f.files, ['src.js']);
  assert.equal(f.alreadyMerged, false); assert.equal(f.docsOnly, false);
  assert.match(f.branchSha, /^[0-9a-f]{40}$/);
});
test('gitFacts: the current branch when none is named; not a repo; unknown branch on main', async () => {
  const repo = makeRepo();
  assert.equal((await gitFacts({ cwd: repo, branch: 'nope' })).ok, false);   // a named branch that does not resolve is not replaced by the current one
  assert.equal((await gitFacts({ cwd: repo })).branch, 'feat');
  assert.equal((await gitFacts({ cwd: '/nonexistent-dir-xyz' })).ok, false);
  git(repo, 'checkout', '-q', 'main');
  const f = await gitFacts({ cwd: repo, branch: 'nope' });
  assert.equal(f.ok, false); assert.equal(f.error, 'branch not found');
});
test('gitFacts: conflicts, convention-only conflicts, already merged', async () => {
  const real = makeRepo({ files: { 'src.js': 'export const a = 1;\n' }, mainFiles: { 'src.js': 'export const a = 2;\n' } });
  const a = await gitFacts({ cwd: real, branch: 'feat' });
  assert.deepEqual(a.conflicts, ['src.js']); assert.equal(a.conventionOnly, false);
  const ver = makeRepo({ files: { 'VERSION.txt': '2\n', 'x.js': '1\n' }, mainFiles: { 'VERSION.txt': '3\n' } });
  const b = await gitFacts({ cwd: ver, branch: 'feat' });
  assert.deepEqual(b.conflicts, ['VERSION.txt']); assert.equal(b.conventionOnly, true);
  git(ver, 'checkout', '-q', 'main');
  git(ver, 'merge', '-q', '-X', 'ours', 'feat', '-m', 'merge');
  assert.equal((await gitFacts({ cwd: ver, branch: 'feat' })).alreadyMerged, true);
});
test('gitFacts: docs-only, sensitive paths and content', async () => {
  const docs = makeRepo({ files: { 'docs/a.md': 'x\n', 'README.md': 'y\n', 'VERSION.txt': '2\n' } });
  assert.equal((await gitFacts({ cwd: docs, branch: 'feat' })).docsOnly, true);
  for (const [file, why] of [['.env', 'secret'], ['.env.local', 'secret'], ['config/server.pem', 'secret'], ['my-secrets/a.txt', 'secret'], ['db/migrations/001.up', 'migration'], ['x/y.sql', 'migration'], ['etc/sudoers.d/x', 'sudoers'], ['deploy/app.service', 'systemd'], ['systemd/x', 'systemd']]) {
    const f = await gitFacts({ cwd: makeRepo({ files: { [file]: 'a\n' } }), branch: 'feat' });
    assert.ok(f.sensitive.some((s) => s.why === why && s.file === file), `${file} -> ${why}: ${JSON.stringify(f.sensitive)}`);
  }
  const fake = 'AKIA' + 'A'.repeat(16);
  const c = await gitFacts({ cwd: makeRepo({ files: { 'src.js': `const k = "${fake}";\n` } }), branch: 'feat' });
  assert.ok(c.sensitive.some((s) => s.why === 'secret-content'));
});

// ---- floor ----
test('mergeFloor: reasons', async () => {
  const repo = makeRepo();
  const facts = await gitFacts({ cwd: repo, branch: 'feat' });
  const green = testEvidence(GREEN);
  assert.deepEqual(mergeFloor(facts, green, {}), []);
  assert.match(mergeFloor(facts, testEvidence('2 failed'), {})[0], /^tests reported red: .*2 failed/);
  assert.deepEqual(mergeFloor(facts, testEvidence('done'), {}), ['no green test report on the branch']);
  assert.match(mergeFloor({ ...facts, conflicts: ['a.js', 'b.js'] }, green, {})[0], /^conflicts outside convention: a\.js, b\.js$/);
  assert.deepEqual(mergeFloor({ ...facts, conflicts: ['VERSION.txt'] }, green, {}), []);
  assert.match(mergeFloor(facts, green, { optOut: ['proj'] })[0], /opted out/);
  assert.match(mergeFloor(facts, green, { optOut: [facts.repo] })[0], /opted out/);
  assert.match(mergeFloor({ ...facts, alreadyMerged: true }, green, {})[0], /already merged/);
  assert.match(mergeFloor({ ok: false, error: 'not a git repository', repo: null }, green, {})[0], /not a git repo/);
  assert.match(mergeFloor({ ...facts, sensitive: [{ file: 'x/y.sql', why: 'migration' }] }, green, {})[0], /^touches a migration: x\/y\.sql$/);
  assert.match(mergeFloor({ ...facts, sensitive: [{ file: '.env', why: 'secret' }] }, green, {})[0], /^touches a secret\/credential path: \.env$/);
  assert.deepEqual(mergeFloor({ ...facts, docsOnly: true }, testEvidence('done'), {}), []);
});

// ---- migrations by effect (Q199) ----
test('migrationAdditive: SQL statements are read by effect, not by path', () => {
  const f = 'db/migrations/002.sql';
  assert.deepEqual(migrationAdditive(f, ['CREATE TABLE tasks (id serial PRIMARY KEY);']), { additive: true });
  assert.deepEqual(migrationAdditive(f, ['create unique index tasks_name on tasks (name);']), { additive: true });
  assert.deepEqual(migrationAdditive(f, ['ALTER TABLE tasks ADD COLUMN done_at timestamptz;']), { additive: true });
  assert.deepEqual(migrationAdditive(f, ['ALTER TABLE IF EXISTS "public"."tasks" ADD COLUMN IF NOT EXISTS done_at timestamptz;']), { additive: true });
  // comments and blank lines are ignored, a CREATE TABLE body may span lines
  assert.deepEqual(migrationAdditive(f, ['', '-- 002 new', '/* add the table */', 'CREATE TABLE tasks (', '  id serial PRIMARY KEY,', '  name text NOT NULL', ');']), { additive: true });
  // destructive shapes name themselves
  for (const [sql, why] of [['ALTER TABLE tasks DROP COLUMN name;', 'DROP COLUMN'], ['DROP TABLE tasks;', 'DROP TABLE'], ['DROP INDEX tasks_name;', 'DROP INDEX'],
    ['ALTER TABLE tasks ALTER COLUMN name TYPE varchar(9);', 'ALTER ... TYPE'], ['ALTER TABLE tasks RENAME TO job;', 'RENAME'],
    ['UPDATE tasks SET done_at = now();', 'UPDATE'], ["DELETE FROM tasks WHERE done_at IS NOT NULL;", 'DELETE'], ["INSERT INTO tasks (name) VALUES ('x');", 'INSERT'],
    ['TRUNCATE tasks;', 'TRUNCATE']]) {
    assert.deepEqual(migrationAdditive(f, [sql]), { additive: false, reason: why }, sql);
  }
  // one destructive statement anywhere is enough, and anything unreadable is not additive
  assert.deepEqual(migrationAdditive(f, ['CREATE TABLE a (id int);', '', 'ALTER TABLE a DROP COLUMN id;']), { additive: false, reason: 'DROP COLUMN' });
  assert.equal(migrationAdditive(f, ['REVOKE SELECT ON tasks FROM app;']).additive, false);
  assert.deepEqual(migrationAdditive(f, ['CREATE TABLE a (id int);']).additive, true);
  assert.deepEqual(migrationAdditive(f, ['-- only a comment', '', '   ']), { additive: true, empty: true });
  assert.deepEqual(migrationAdditive(f, null), { additive: false, reason: 'unreadable diff' });
  // GRANT is bookkeeping the migration carries, not a write
  assert.deepEqual(migrationAdditive(f, ['GRANT SELECT ON tasks TO app;']), { additive: true });
});
// The real file that was refused as "not additive: begin" (setup/db/migrations/20261020g_ai_benchmarks.sql, virtualpytest).
test('migrationAdditive: a real transaction-wrapped migration with policies and RLS is additive', () => {
  const f = 'setup/db/migrations/20261020g_ai_benchmarks.sql';
  const sql = [
    'BEGIN;',
    'CREATE TABLE IF NOT EXISTS ai_benchmarks (',
    '  id bigserial PRIMARY KEY,',
    '  name text NOT NULL,',
    '  score numeric(10,2)',
    ');',
    'CREATE INDEX IF NOT EXISTS ai_benchmarks_name ON ai_benchmarks (name);',
    'CREATE INDEX IF NOT EXISTS ai_benchmarks_score ON ai_benchmarks (score);',
    'CREATE INDEX IF NOT EXISTS ai_benchmarks_created ON ai_benchmarks (created_at);',
    'CREATE INDEX IF NOT EXISTS ai_benchmarks_model ON ai_benchmarks (model);',
    'ALTER TABLE ai_benchmarks ENABLE ROW LEVEL SECURITY;',
    'DROP POLICY IF EXISTS "ai_benchmarks_read" ON ai_benchmarks;',
    'CREATE POLICY "ai_benchmarks_read" ON ai_benchmarks FOR SELECT USING (true);',
    'COMMIT;',
  ];
  assert.deepEqual(migrationAdditive(f, sql), { additive: true });
  // the session and comment bookkeeping a migration carries
  assert.deepEqual(migrationAdditive(f, ['SET LOCAL search_path TO public;']), { additive: true });
  assert.deepEqual(migrationAdditive(f, ['SET search_path = public;']), { additive: true });
  assert.deepEqual(migrationAdditive(f, ["COMMENT ON TABLE ai_benchmarks IS 'benchmark rows';"]), { additive: true });
  // a role change is not a session setting
  assert.equal(migrationAdditive(f, ['SET ROLE admin;']).additive, false);
  // a BEGIN/COMMIT wrapper does not make a destructive file pass
  assert.deepEqual(migrationAdditive(f, ['BEGIN;', 'DROP TABLE ai_benchmarks;', 'COMMIT;']), { additive: false, reason: 'DROP TABLE' });
  assert.deepEqual(migrationAdditive(f, ['START TRANSACTION;', 'ALTER TABLE t DROP COLUMN c;', 'COMMIT;']), { additive: false, reason: 'DROP COLUMN' });
});
test('migrationAdditive: DROP POLICY is additive only as the re-create pattern', () => {
  const f = 'setup/db/migrations/20261020g_ai_benchmarks.sql';
  const create = 'CREATE POLICY "p" ON ai_benchmarks FOR SELECT USING (true);';
  // dropped, then created again with the same name on the same table
  assert.deepEqual(migrationAdditive(f, ['DROP POLICY IF EXISTS "p" ON ai_benchmarks;', create]), { additive: true });
  assert.deepEqual(migrationAdditive(f, ['DROP POLICY "p" ON ai_benchmarks;', create]), { additive: true });
  // dropped, and never created again
  assert.equal(migrationAdditive(f, ['DROP POLICY IF EXISTS "p" ON ai_benchmarks;']).additive, false);
  assert.match(migrationAdditive(f, ['DROP POLICY IF EXISTS "p" ON ai_benchmarks;']).reason, /^DROP POLICY/);
  // created under another name, or on another table: still only a drop
  assert.equal(migrationAdditive(f, ['DROP POLICY IF EXISTS "p" ON ai_benchmarks;', 'CREATE POLICY "other" ON ai_benchmarks FOR SELECT USING (true);']).additive, false);
  assert.equal(migrationAdditive(f, ['DROP POLICY IF EXISTS "p" ON ai_benchmarks;', 'CREATE POLICY "p" ON other_table FOR SELECT USING (true);']).additive, false);
  // created first, dropped after: the policy is gone at the end of the file
  assert.equal(migrationAdditive(f, [create, 'DROP POLICY "p" ON ai_benchmarks;']).additive, false);
  // DROP TABLE never has a re-create pattern
  assert.deepEqual(migrationAdditive(f, ['DROP TABLE ai_benchmarks;', create]), { additive: false, reason: 'DROP TABLE' });
});
test('migrationAdditive: a statement is read whole, whatever its markers', () => {
  const f = 'setup/db/migrations/20261020g_ai_benchmarks.sql';
  // a ';' inside a literal or a dollar-quoted body does not end the statement
  assert.deepEqual(migrationAdditive(f, ["COMMENT ON TABLE t IS 'a;b';"]), { additive: true });
  assert.deepEqual(migrationAdditive(f, ['CREATE FUNCTION f() RETURNS void AS $body$ SELECT 1; $body$ LANGUAGE sql;']), { additive: true });
  // a marker inside a literal or a comment does not hide a destructive statement
  assert.equal(migrationAdditive(f, ['-- DROP TABLE y', 'CREATE TABLE x (id int);']).additive, true);
  assert.equal(migrationAdditive(f, ["INSERT INTO t VALUES ('DROP TABLE y');"]).additive, false);
  assert.equal(migrationAdditive(f, ['/* nothing */ CREATE TABLE x (id int); DROP TABLE y;']).additive, false);
  // OR REPLACE rewrites an object that may already exist, so it is not additive even when it is a FUNCTION
  assert.deepEqual(migrationAdditive(f, ['CREATE OR REPLACE FUNCTION f() RETURNS void AS $body$ SELECT 1; $body$ LANGUAGE sql;']), { additive: false, reason: 'replaces an existing object' });
  assert.deepEqual(migrationAdditive(f, ['CREATE OR REPLACE VIEW v AS SELECT 1;']), { additive: false, reason: 'replaces an existing object' });
  // a statement we cannot read is not additive
  assert.deepEqual(migrationAdditive(f, ["INSERT INTO t VALUES ('unterminated);"]), { additive: false, reason: 'unbalanced quote' });
  assert.deepEqual(migrationAdditive(f, ['CREATE TABLE x (id int); /* unterminated']), { additive: false, reason: 'unterminated comment' });
  assert.deepEqual(migrationAdditive(f, ['CREATE FUNCTION f() AS $body$ SELECT 1;']), { additive: false, reason: 'unbalanced dollar quote' });
  // a psql meta-command is not SQL we read
  assert.equal(migrationAdditive(f, ['\\i /tmp/evil.sql']).additive, false);
  // ALTER TABLE is additive action by action
  assert.deepEqual(migrationAdditive(f, ['ALTER TABLE t ADD COLUMN c int NOT NULL DEFAULT 0;']), { additive: true });
  assert.deepEqual(migrationAdditive(f, ['ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0);']), { additive: true });
  assert.deepEqual(migrationAdditive(f, ['ALTER TABLE t FORCE ROW LEVEL SECURITY;']), { additive: true });
  assert.deepEqual(migrationAdditive(f, ['ALTER TABLE t ADD COLUMN c int, DROP COLUMN d;']), { additive: false, reason: 'DROP COLUMN' });
});
test('migrationAdditive: a non-SQL migration is additive only with the three ops', () => {
  const f = 'alembic/versions/003_add_col.py';
  assert.deepEqual(migrationAdditive(f, ['op.add_column("tasks", sa.Column("done_at", sa.DateTime(), nullable=True))']), { additive: true });
  assert.deepEqual(migrationAdditive(f, ['op.create_index("ix_tasks_name", "tasks", ["name"])']), { additive: true });
  assert.deepEqual(migrationAdditive(f, ['op.create_table(', '    "tasks",', '    sa.Column("id", sa.Integer(), primary_key=True),', ')', 'op.add_column("tasks", sa.Column("n", sa.Integer()))']), { additive: true });
  // module boilerplate around them is ignored, a destructive op is not
  assert.deepEqual(migrationAdditive(f, ['from alembic import op', 'import sqlalchemy as sa', 'revision = "003"', 'def upgrade():', '    op.add_column("tasks", sa.Column("n", sa.Integer()))']), { additive: true });
  assert.deepEqual(migrationAdditive(f, ['op.add_column("tasks", sa.Column("n", sa.Integer()))', 'op.drop_column("tasks", "old")']), { additive: false, reason: 'drop_column' });
  assert.deepEqual(migrationAdditive(f, ['op.execute("UPDATE tasks SET n = 0")']), { additive: false, reason: 'execute' });
  assert.equal(migrationAdditive(f, ['whatever()']).additive, false);
});
test('migrationReasons: additive needs the approval and the attestation; destructive never merges', async () => {
  const sql = 'CREATE TABLE tasks (id serial PRIMARY KEY);';
  const facts = (file, adds) => ({ sensitive: [{ file, why: 'migration' }], migrationAdds: { [file]: adds } });
  assert.deepEqual(migrationReasons({ sensitive: [] }), [], 'no migration, no reason');
  const add = facts('db/migrations/002.sql', [sql]);
  assert.deepEqual(migrationReasons(add), ['additive migration needs --approved-by manager --migration-applied (objects already in the target DB)']);
  assert.deepEqual(migrationReasons(add, { approvedBy: true }), ['additive migration needs --migration-applied (the manager attests the objects already exist in the target DB)']);
  assert.deepEqual(migrationReasons(add, { approvedBy: true, migrationApplied: true }), []);
  const drop = facts('db/migrations/002.sql', ['ALTER TABLE tasks DROP COLUMN name;']);
  const why = migrationReasons(drop, { approvedBy: true, migrationApplied: true });
  assert.deepEqual(why, ['migration is destructive: DROP COLUMN in db/migrations/002.sql']);
  assert.deepEqual(migrationReasons(facts('db/migrations/002.sql', null), { approvedBy: true, migrationApplied: true }), ['migration is destructive: unreadable diff in db/migrations/002.sql']);
  // gitFacts carries the added lines of a migration file
  const repo = makeRepo({ files: { 'db/migrations/002.sql': `${sql}\n` } });
  const f = await gitFacts({ cwd: repo, branch: 'feat' });
  assert.deepEqual(f.migrationAdds['db/migrations/002.sql'], [`CREATE TABLE tasks (id serial PRIMARY KEY);`]);
  assert.deepEqual(migrationReasons(f, { approvedBy: true, migrationApplied: true }), []);
});
test('reasoningDecision: confidence by evidence', () => {
  assert.equal(reasoningDecision({ docsOnly: true }, { state: 'unknown' }).confidence, 0.9);
  assert.equal(reasoningDecision({ docsOnly: false }, { state: 'green', explicit: true }).confidence, 0.9);
  assert.equal(reasoningDecision({ docsOnly: false }, { state: 'green', explicit: false }).confidence, 0.8);
  assert.equal(reasoningDecision({}, { state: 'green', explicit: true }).source, 'reasoning');
});

// ---- evaluateMerge ----
const ev = (repo, text, extra = {}) => evaluateMerge({ cwd: repo, text, session: 's1', config: {}, ...extra });
const jevReply = (choice, confidence, id = 'jev-1') => async () => ({ success: true, decision_id: id, answers: { choice: { choice, confidence } } });

test('evaluateMerge: green + clean merges on the manager reasoning; the journal record is a valid decision', async () => {
  const repo = makeRepo();
  const r = await ev(repo, `merge feat. ${GREEN}`);
  assert.equal(r.verdict, 'merge');
  assert.deepEqual(r.reasons, []);
  assert.equal(r.decision.source, 'reasoning');
  const rec = journalRecord(r, { id: 'abc', session: 's1', at: new Date('2026-10-14T10:00:00Z') });
  const v = validateDecision(rec);
  assert.deepEqual(v.errors, []);
  assert.equal(rec.decision_id, 'merge-abc'); assert.equal(rec.task_id, 'manager:s1'); assert.equal(rec.kind, 'merge'); assert.equal(rec.chosen, 'merge');
  assert.equal(rec.jev_decision_id, 'reasoning'); assert.equal(rec.policy_ref, 'OWNER_DECISIONS §14');
  assert.equal(rec.branch, 'feat'); assert.equal(rec.target, 'main'); assert.match(rec.branch_sha, /^[0-9a-f]{40}$/);
  assert.ok(rec.evidence.some((e) => e === 'merge-tree clean') && rec.evidence.some((e) => e.startsWith('tests: ')) && rec.evidence.some((e) => /^branch feat@[0-9a-f]{12} -> main@[0-9a-f]{12}$/.test(e)));
});
test('evaluateMerge: an escalation is journaled as a valid decision too', async () => {
  const r = await ev(makeRepo(), 'merge feat. 2 failed.');
  assert.equal(r.verdict, 'escalate');
  assert.match(r.reasons[0], /tests reported red/);
  const rec = journalRecord(r, { id: 'x', session: 's1', at: Date.now() });
  assert.deepEqual(validateDecision(rec).errors, []);
  assert.equal(rec.chosen, 'escalate');
  const bad = journalRecord(await ev('/nonexistent-dir-xyz', 'merge feat'), { id: 'y', session: null });
  assert.deepEqual(validateDecision(bad).errors, []);
});
test('evaluateMerge: unknown tests escalate; docs-only without a report merges', async () => {
  const r = await ev(makeRepo(), 'merge feat. I refactored the module.');
  assert.equal(r.verdict, 'escalate'); assert.match(r.reasons[0], /no green test report/);
  const d = await ev(makeRepo({ files: { 'docs/NOTES.md': 'x\n' } }), 'merge feat. Updated the notes.');
  assert.equal(d.verdict, 'merge'); assert.equal(d.decision.confidence, 0.9);
});
test('evaluateMerge: conflicts', async () => {
  const real = await ev(makeRepo({ files: { 'src.js': 'export const a = 1;\n' }, mainFiles: { 'src.js': 'export const a = 2;\n' } }), `merge feat. ${GREEN}`);
  assert.equal(real.verdict, 'escalate'); assert.match(real.reasons[0], /conflicts outside convention: src\.js/);
  const ver = await ev(makeRepo({ files: { 'VERSION.txt': '2\n', 'x.js': '1\n' }, mainFiles: { 'VERSION.txt': '3\n' } }), `merge feat. ${GREEN}`);
  assert.equal(ver.verdict, 'merge');
});
test('evaluateMerge: sensitive changes and an opted-out repo escalate', async () => {
  for (const file of ['.env', 'migrations/x.sql', 'systemd/x.service']) {
    const r = await ev(makeRepo({ files: { [file]: 'a\n' } }), `merge feat. ${GREEN}`);
    assert.equal(r.verdict, 'escalate', file);
    assert.match(r.reasons.join(' '), /touches/, file);
  }
  const o = await ev(makeRepo(), `merge feat. ${GREEN}`, { config: { mergeOptOut: ['proj'] } });
  assert.equal(o.verdict, 'escalate'); assert.match(o.reasons[0], /opted out/);
});
test('evaluateMerge: Jev decides when the floor passed', async () => {
  const repo = makeRepo();
  const asked = [];
  const yes = await ev(repo, `merge feat. ${GREEN}`, { jev: async (b) => { asked.push(b); return jevReply('merge', 0.93, 'd-9')(); } });
  assert.equal(yes.verdict, 'merge'); assert.equal(yes.decision.source, 'jev'); assert.equal(yes.decision.decision_id, 'd-9');
  assert.equal(asked[0].refs.point, 'merge');
  assert.equal(JSON.parse(asked[0].state).branch, 'feat');
  assert.equal(journalRecord(yes, { id: 'j' }).jev_decision_id, 'd-9');
  const no = await ev(repo, `merge feat. ${GREEN}`, { jev: jevReply('escalate', 0.62) });
  assert.equal(no.verdict, 'escalate'); assert.equal(no.reasons[0], 'Jev rates it escalate (0.62)');
  const low = await ev(repo, `merge feat. ${GREEN}`, { jev: jevReply('merge', 0.71) });
  assert.equal(low.verdict, 'escalate'); assert.equal(low.reasons[0], 'Jev confidence 0.71 below 0.85');
  for (const reply of [{ skipped: 'not configured' }, { error: 'http 500' }, null]) {
    const r = await ev(repo, `merge feat. ${GREEN}`, { jev: async () => reply });
    assert.equal(r.verdict, 'merge'); assert.equal(r.decision.source, 'reasoning');
  }
  const thrown = await ev(repo, `merge feat. ${GREEN}`, { jev: async () => { throw new Error('boom'); } });
  assert.equal(thrown.decision.source, 'reasoning');
});
test('evaluateMerge: Jev is not asked when the floor failed', async () => {
  let n = 0;
  const r = await ev(makeRepo(), 'merge feat. 2 failed', { jev: async () => { n++; return jevReply('merge', 0.99)(); } });
  assert.equal(r.verdict, 'escalate'); assert.equal(n, 0); assert.equal(r.decision.source, 'floor');
});
test('evaluateMerge: a word-only green report is below the default confidence without Jev', async () => {
  const r = await ev(makeRepo(), 'merge feat. All green.');
  assert.equal(r.verdict, 'escalate'); assert.match(r.reasons[0], /confidence 0\.80 below 0\.85/);
  const ok = await ev(makeRepo(), 'merge feat. All green.', { config: { mergeMinConfidence: 0.8 } });
  assert.equal(ok.verdict, 'merge');
});

// ---- composeReply ----
test('composeReply: merge, information and the pointer to the owner', () => {
  const r = composeReply({ info: [{ part: 'send the SRF 1 buffer path', answer: '/data/fake/srf1-buffer', source: 'docs/HANDOVER.md:3' }], merge: { repo: 'proj', branch: 'task90-open', target: 'main', rationale: 'merges cleanly, tests green' }, remaining: true });
  assert.match(r.text, /Send the SRF 1 buffer path: \/data\/fake\/srf1-buffer \(from docs\/HANDOVER\.md:3\)/);
  assert.match(r.text, /Merge: yes - the manager evaluated proj task90-open -> main: merges cleanly, tests green\. Request it with `integrate request task90-open`.*Do not merge it yourself\./);
  assert.match(r.text, /The rest of your question went to the owner: wait for their answer on it\.$/);
  assert.equal(hardMatch(r.text, { mergePresent: true }), null);
  assert.equal(composeReply({ info: [], merge: null, remaining: true }), null);
  assert.doesNotMatch(composeReply({ merge: { branch: 'b', target: 't', rationale: 'ok' } }).text, /rest of your question/);
});
test('composeReply: a line that trips the hard floor is dropped, never reworded', () => {
  const r = composeReply({ info: [{ part: 'send the file', answer: 'docs/credentials-notes.md', source: 'a.md:1' }, { part: 'send the dir', answer: 'docs/out', source: 'a.md:2' }], merge: { branch: 'fix-deploy-script', target: 'main', rationale: 'ok' }, remaining: true });
  assert.deepEqual(r.info, [1]);
  assert.equal(r.merge, false);
  assert.equal(hardMatch(r.text, { mergePresent: true }), null);
});

test('defaults are exported', () => {
  assert.deepEqual(MERGE_DEFAULTS, { mergeDecisions: true, mergeMinConfidence: 0.85, mergeOptOut: [], mergeConventionFiles: ['VERSION.txt'], infoAnswers: true, infoRoots: [] });
});

// ---- round 7 review fixes ----
test('M2: testEvidence does not green on non-test text; red and negation are local', () => {
  for (const t of ['Step 1/1 complete. I did not run the tests yet.', 'Round 2/2 done. Tests were not run.', 'Fixed 3/3 review comments; tests not run.', 'Progress 4/4 steps done; tests not run yet.',
    'not all tests pass', 'I have not run the tests. 12 passed lint checks', 'once the tests pass', 'I will pass on the deploy', 'tests pass on main, branch untested', 'All green: eslint only (no unit tests exist)', 'Did the tests pass?']) {
    assert.notEqual(testEvidence(t, { branch: 'feat' }).state, 'green', t);
  }
  assert.equal(testEvidence('Tests: 3 broken. CI is not red though.').state, 'red');
  assert.equal(testEvidence('tests pass on main', { branch: 'feat' }).state, 'unknown');
  assert.equal(testEvidence('tests pass on feat.', { branch: 'feat' }).state, 'green');
  assert.equal(testEvidence('Should I merge? All green.').state, 'green');
  assert.equal(testEvidence('All green, ok to merge?').state, 'unknown');
});
test('M3: docs-only is documentation, not generic .txt or test code', async () => {
  for (const [files, docs] of [[{ 'requirements.txt': 'a\n' }, false], [{ 'CMakeLists.txt': 'a\n' }, false], [{ 'test/a.test.js': 'a\n' }, false], [{ 'docs/run.sh': 'a\n' }, false],
    [{ 'README.md': 'a\n', 'docs/x.txt': 'a\n' }, true], [{ 'LICENSE': 'a\n' }, true]]) {
    assert.equal((await gitFacts({ cwd: makeRepo({ files }), branch: 'feat' })).docsOnly, docs, JSON.stringify(files));
  }
  const r = await ev(makeRepo({ files: { 'test/a.test.js': 'a\n' } }), 'merge feat. Updated tests.');
  assert.equal(r.verdict, 'escalate');
});
test('M4: a named branch that does not resolve is not replaced by the current branch', async () => {
  const r = await ev(makeRepo(), `merge no-such-branch. ${GREEN}`);
  assert.equal(r.verdict, 'escalate'); assert.deepEqual(r.reasons, ['branch not found']);
});
test('M5: opt-out matches a worktree\'s main repo name and the origin remote name', async () => {
  const repo = makeRepo({ name: 'orig-name' });
  git(repo, 'remote', 'add', 'origin', 'https://example.invalid/owner/remote-name.git');
  const wt = repo + '-wt';
  git(repo, 'worktree', 'add', '-q', '-b', 'wt-branch', wt);
  commit(wt, { 'w.js': '1\n' });
  const f = await gitFacts({ cwd: wt, branch: 'wt-branch' });
  assert.equal(f.repoName, 'orig-name-wt');
  assert.ok(f.repoNames.includes('orig-name') && f.repoNames.includes('remote-name'), JSON.stringify(f.repoNames));
  for (const name of ['orig-name', 'remote-name', 'orig-name-wt']) {
    assert.match(mergeFloor(f, testEvidence(GREEN), { optOut: [name] })[0], /opted out/, name);
  }
  assert.deepEqual(mergeFloor(f, testEvidence(GREEN), { optOut: ['other'] }), []);
});
test('M6: an unscannable diff and a new binary file fail closed', async () => {
  const big = await gitFacts({ cwd: makeRepo({ files: { 'big.js': 'ab\n'.repeat(1300000) } }), branch: 'feat' });
  assert.ok(big.scanError);
  assert.ok(mergeFloor(big, testEvidence(GREEN), {}).includes('diff too large or unreadable to scan'));
  const bin = await gitFacts({ cwd: makeRepo({ files: { 'x/data.bin': 'a\0b\0c', 'docs/shot.png': 'a\0b' } }), branch: 'feat' });
  assert.deepEqual(bin.binary, ['x/data.bin']);
  assert.match(mergeFloor(bin, testEvidence(GREEN), {}).join(), /adds a binary file: x\/data\.bin/);
});
test('M7: CI / deploy / infra and more secret file names are sensitive', async () => {
  const { sensitivePath } = await import('../merge-policy.js');
  for (const f of ['.github/workflows/ci.yml', '.gitlab-ci.yml', 'Jenkinsfile', '.circleci/config.yml', 'scripts/deploy.sh', 'scripts/safe-restart.sh', 'Dockerfile', 'docker-compose.yml', 'infra/main.tf', 'terraform/a.json', 'ansible/site.yml', 'k8s/app.yaml', 'helm/values.yaml', 'update_core.sh']) assert.equal(sensitivePath(f), 'deploy', f);
  for (const f of ['id_ed25519', 'keys/id_ecdsa', 'a.p12', 'a.pfx', 'a.jks', '.netrc', '.npmrc', '.pypirc', 'authorized_keys']) assert.equal(sensitivePath(f), 'secret', f);
  assert.equal(sensitivePath('docs/deploy-notes.md'), null);
  assert.equal(sensitivePath('src/app.js'), null);
});
test('M10: git facts are async', () => {
  assert.ok(gitFacts({ cwd: '/nonexistent-dir-xyz' }) instanceof Promise);
});
test('m3: the local target is checked too when it differs from origin/<target>; the reply names the repo', async () => {
  const repo = makeRepo({ files: { 'src.js': 'export const a = 1;\n' }, mainFiles: { 'src.js': 'export const a = 2;\n' } });
  git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'main~1').trim());   // origin/main is the base: clean against it
  const f = await gitFacts({ cwd: repo, branch: 'feat' });
  assert.deepEqual(f.conflicts, ['src.js']);   // the local main conflicts
  assert.match(f.targetShaLocal, /^[0-9a-f]{40}$/); assert.notEqual(f.targetShaLocal, f.targetSha);
  const rec = journalRecord(await ev(repo, `merge feat. ${GREEN}`), { id: 'z', session: 's' });
  assert.equal(rec.target_sha_local, f.targetShaLocal);
  assert.ok(rec.evidence.some((e) => /\(local main@[0-9a-f]{12}\)/.test(e)));
});
test('M1: an information-only reply is checked without the merge exemption', () => {
  assert.equal(composeReply({ info: [{ part: 'send the push main script path', answer: 'docs/push-main.md', source: 'a.md:1' }], merge: null }), null);
  assert.ok(composeReply({ info: [{ part: 'send the push main script path', answer: 'docs/push-main.md', source: 'a.md:1' }], merge: { branch: 'b', target: 't', rationale: 'ok' } }));
});

// ---- round 7 second review ----
test('R2-1: a fraction on another ref or a previous commit is not a report on the branch', () => {
  for (const t of ['Tests: 1826/1826 pass on main.', '1826/1826 tests pass on main', 'npm test: 12/12 pass (on the previous commit, before my last change)']) {
    assert.equal(testEvidence(t, { branch: 'feat' }).state, 'unknown', t);
  }
  assert.equal(testEvidence('1826/1826 pass on feat.', { branch: 'feat' }).state, 'green');
});
test('R2-3: Node runner summary is an explicit green', () => {
  const ok = testEvidence('ℹ tests 12\nℹ suites 0\nℹ pass 12\nℹ fail 0\nℹ cancelled 0');
  assert.deepEqual([ok.state, ok.explicit], ['green', true]);
  assert.equal(testEvidence('ℹ tests 12\nℹ pass 10\nℹ fail 2').state, 'red');
  assert.equal(testEvidence('ℹ pass 12').state, 'unknown');   // without a "fail 0" it is not a full report
  assert.equal(testEvidence('Tests: 6 failed: 0 retried, 1820 passed').state, 'red');   // a count before "failed" wins over the 0 after it
  assert.equal(testEvidence('6 failed = 0.3%; 1820 passed').state, 'red');
});
test('R2-6: scripts under docs/ are not docs', async () => {
  const { isDocFile } = await import('../merge-policy.js');
  for (const f of ['docs/x.ps1', 'docs/x.psm1', 'docs/x.bat', 'docs/x.cmd', 'docs/Makefile']) assert.equal(isDocFile(f), false, f);
  assert.equal(isDocFile('docs/guide.txt'), true);
});

test('infra paths: an explicit allowlist, tests and docs never count', async () => {
  const { sensitivePath, mergeFloor } = await import('../merge-policy.js');
  for (const f of ['test/foo-deploy.test.js', 'test/integration-self-deploy.test.js', 'docs/deploy.md', 'docs/v2/DEPLOY-NOTES.txt', 'README-deploy.md', 'integration-deploys.js', 'public/deployed.js', 'test/fixtures/Dockerfile', 'test/safe-restart.test.js', 'scripts/render-deploy-skill.md']) assert.equal(sensitivePath(f), null, f);
  for (const f of ['.github/workflows/ci.yml', 'scripts/deploy.sh', 'scripts/deploy-host.sh', 'scripts/safe-restart.sh', 'update_core.sh', 'deploy-runner.js', 'Dockerfile']) assert.equal(sensitivePath(f), 'deploy', f);
  for (const f of ['systemd/ghosty.service', 'x.timer', 'systemd/a.conf']) assert.equal(sensitivePath(f), 'systemd', f);
  // approveInfra drops only the infra reason
  const facts = { ok: true, branch: 'b', target: 'main', conflicts: [], docsOnly: false, files: [], binary: [], sensitive: [{ file: 'scripts/deploy.sh', why: 'deploy' }, { file: '.env', why: 'secret' }, { file: 'systemd/a.service', why: 'systemd' }] };
  const r = mergeFloor(facts, { state: 'green' }, { approveInfra: true });
  assert.equal(r.length, 2); assert.ok(r.every((x) => !/deploy\.sh/.test(x)));
  assert.equal(mergeFloor(facts, { state: 'green' }).length, 3);
});

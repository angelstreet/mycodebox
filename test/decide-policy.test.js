import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluatePush, evaluateDeploy, parsePushAsk, decisionRecord, rollbackText } from '../decide-policy.js';
import { composeReply } from '../merge-policy.js';
import { hardMatch } from '../stall.js';
import { validateDecision } from '../orchestration/task-contract.js';
import { makeRepo, git, commit } from './helpers-git.js';

const GREEN = 'Tests: 1826/1826 pass on feat.';
// a repo with a bare "origin" (a temp dir, no network): main and feat are pushed, then feat gets one more local commit
function withOrigin(opts = {}) {
  const repo = makeRepo(opts);
  const bare = join(mkdtempSync(join(tmpdir(), 'dec-origin-')), 'origin.git');
  git(repo, 'init', '-q', '--bare', bare);
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', 'origin', 'main', 'feat');
  git(repo, 'fetch', '-q', 'origin');
  return repo;
}
const more = (repo, files = { 'next.js': 'export const n = 1;\n' }) => commit(repo, files, 'more');

// ---- push ----
test('parsePushAsk: branch and destination from the text', () => {
  const pick = (t) => { const { branch, dest } = parsePushAsk(t); return { branch, dest }; };
  assert.deepEqual(pick('Should I git push -u origin feat to origin/main?'), { branch: 'feat', dest: 'main' });
  assert.deepEqual(pick('push feat?'), { branch: 'feat', dest: null });
  assert.deepEqual(pick('push and deploy?'), { branch: null, dest: null });
  assert.deepEqual(pick('push to main?'), { branch: null, dest: 'main' });
  assert.deepEqual(parsePushAsk('push feat and also push feat-old').branches, ['feat', 'feat-old']);
  assert.equal(parsePushAsk('Push the tag v1.2 to origin?').unparsed, 'v1.2');
  assert.equal(parsePushAsk('push the branch now').unparsed, null);
});

test('push: green tests and a fast-forward -> push, with a reply the hard floor accepts', async () => {
  const repo = withOrigin(); more(repo);
  const ev = await evaluatePush({ cwd: repo, text: `${GREEN}\n\nShall I push feat?`, session: 'api-worker' });
  assert.equal(ev.verdict, 'push', JSON.stringify(ev.reasons));
  assert.equal(ev.facts.dest, 'feat'); assert.equal(ev.facts.ahead, 1);
  assert.match(ev.rationale, /1 commit fast-forward origin\/feat, tests green/);
  const reply = composeReply({ push: { repo: ev.facts.repoName, branch: ev.facts.branch, dest: ev.facts.dest, rationale: ev.rationale } });
  assert.match(reply.text, /^Push: yes - proj feat -> origin\/feat: .*Push it now\.$/);
  assert.equal(reply.push, true);
  assert.equal(hardMatch(reply.text, { pushPresent: true }), null);
  const rec = decisionRecord('push', ev, { id: 'p1', session: 'api-worker' });
  assert.deepEqual(validateDecision(rec).errors, []);
  assert.equal(rec.kind, 'push'); assert.equal(rec.decision_id, 'push-p1'); assert.equal(rec.chosen, 'push');
});

test('push: not a fast-forward -> escalate "needs a force push"', async () => {
  const repo = withOrigin();
  git(repo, 'commit', '-q', '--amend', '-m', 'rewritten', '--allow-empty');
  const ev = await evaluatePush({ cwd: repo, text: `${GREEN}\n\nShall I push feat?` });
  assert.equal(ev.verdict, 'escalate');
  assert.match(ev.reasons[0], /needs a force push/);
});

test('push: red or unknown tests -> escalate; docs-only needs no test report', async () => {
  const repo = withOrigin(); more(repo);
  const red = await evaluatePush({ cwd: repo, text: '2 failed, 1824 passed.\n\nShall I push feat?' });
  assert.match(red.reasons[0], /tests reported red/);
  const unk = await evaluatePush({ cwd: repo, text: 'I changed the module.\n\nShall I push feat?' });
  assert.match(unk.reasons[0], /no green test report/);
  const docs = withOrigin(); more(docs, { 'docs/N.md': 'notes\n' });
  assert.equal((await evaluatePush({ cwd: docs, text: 'Shall I push feat?' })).verdict, 'push');
});

test('push: a secret, a migration or a deploy file -> escalate', async () => {
  for (const [file, re] of [['.env', /secret/], ['migrations/1.sql', /migration/], ['.github/workflows/ci.yml', /CI\/deploy/]]) {
    const repo = withOrigin(); more(repo, { [file]: 'a\n' });
    const ev = await evaluatePush({ cwd: repo, text: `${GREEN}\n\nShall I push feat?` });
    assert.equal(ev.verdict, 'escalate', file);
    assert.match(ev.reasons.join(' '), re, file);
  }
  const repo = withOrigin(); more(repo, { 'x.js': `export const k = '${'sk-' + 'a'.repeat(30)}';\n` });
  assert.match((await evaluatePush({ cwd: repo, text: `${GREEN}\n\nShall I push feat?` })).reasons.join(' '), /secret-looking content/);
});

test('push: nothing to push, unknown branch, opted-out repo, Jev escalate', async () => {
  const repo = withOrigin();
  assert.match((await evaluatePush({ cwd: repo, text: `${GREEN}\n\nShall I push feat?` })).reasons[0], /nothing to push/);
  more(repo);
  assert.match((await evaluatePush({ cwd: repo, text: 'Shall I push nope?' })).reasons[0], /branch nope not found/);
  assert.match((await evaluatePush({ cwd: repo, text: `${GREEN}\n\npush feat?`, config: { pushOptOut: ['proj'] } })).reasons[0], /opted out/);
  assert.match((await evaluatePush({ cwd: repo, text: `${GREEN}\n\npush feat?`, config: { mergeOptOut: ['proj'] } })).reasons[0], /opted out/);   // defaults to the merge list too
  const jev = async () => ({ success: true, decision_id: 'jv-9', answers: { choice: { choice: 'escalate', confidence: 0.9 } } });
  const e = await evaluatePush({ cwd: repo, text: `${GREEN}\n\npush feat?`, jev });
  assert.equal(e.verdict, 'escalate'); assert.equal(e.decision.source, 'jev');
  const ok = await evaluatePush({ cwd: repo, text: `${GREEN}\n\npush feat?`, jev: async (b) => { assert.equal(b.point ?? 'push', 'push'); return { success: true, decision_id: 'jv-8', answers: { choice: { choice: 'push', confidence: 0.95 } } }; } });
  assert.equal(ok.verdict, 'push'); assert.equal(ok.decision.decision_id, 'jv-8');
});

// ---- deploy ----
const SNAP = (extra = {}) => ({ ok: true, deploys: [], deployed: {}, envs: ['env-a', 'env-b'], ...extra });
const LEASES = (leases = []) => ({ ok: true, leases, waiters: [] });
const dcfg = { deployRunner: true };
// the "deployed now" ledger: the migration check needs a deployed commit to bound the range (the repo's first commit here)
const baseOf = (repo) => git(repo, 'rev-list', '--max-parents=0', 'HEAD').trim();
const ledger = (repo) => ({ 'env-a': { server: { ref: 'main', commit: baseOf(repo) } }, 'env-b': { server: { ref: 'main', commit: baseOf(repo) } } });
const dargs = (repo, o = {}) => ({ cwd: repo, text: `${GREEN}\n\nDeploy to env-a?`, session: 'api-worker', config: dcfg, deploys: SNAP({ deployed: ledger(repo) }), leases: LEASES(), envs: ['env-a', 'env-b'], branch: 'feat', ...o });

test('deploy: free env, green tests, no migration -> deploy reply with a rollback line', async () => {
  const repo = makeRepo();
  const sha = git(repo, 'rev-parse', 'feat').trim();
  const prev = git(repo, 'rev-parse', 'main').trim();
  const ev = await evaluateDeploy(dargs(repo, { ref: 'feat', deploys: SNAP({ deployed: { 'env-a': { server: { ref: 'main', commit: prev, version: 'main-1' } } } }) }));
  assert.equal(ev.verdict, 'deploy', JSON.stringify(ev.reasons));
  assert.equal(ev.facts.env, 'env-a'); assert.equal(ev.facts.scope, 'full'); assert.equal(ev.facts.sha, sha);
  assert.match(ev.facts.evidence, /tests green on feat/);
  assert.equal(ev.rollback, `Rollback: request a deploy of ${prev.slice(0, 12)} to env-a (full).`);
  const reply = composeReply({ deploy: { env: 'env-a', scope: 'full', ref: 'feat', sha, rationale: ev.rationale, rollback: ev.rollback } });
  assert.match(reply.text, new RegExp(`^Deploy: yes - env-a full feat@${sha.slice(0, 12)}: .*Request it through the deploy queue; the runner starts it when nothing blocks\\. Rollback: request a deploy of `));
  assert.equal(hardMatch(reply.text, { deployPresent: true }), null);
  assert.ok(hardMatch(reply.text), 'deploy words are hard when the deploy was not decided');
  const rec = decisionRecord('deploy', ev, { id: 'd1', session: 'api-worker' });
  assert.deepEqual(validateDecision(rec).errors, []);
  assert.equal(rec.kind, 'deploy'); assert.match(rec.rollback, /^Rollback: request a deploy of [0-9a-f]{12} to env-a/);
});

test('deploy: leased by another agent -> escalate naming it; a lease held by the session itself does not block', async () => {
  const repo = makeRepo();
  const other = await evaluateDeploy(dargs(repo, { ref: 'feat', leases: LEASES([{ id: 'l1', env: 'env-a', resource: '*', agent: 'codebox:other-worker', kind: 'server' }]) }));
  assert.equal(other.verdict, 'escalate');
  assert.deepEqual(other.reasons, ['env-a leased by codebox:other-worker (*)']);
  const mine = await evaluateDeploy(dargs(repo, { ref: 'feat', leases: LEASES([{ id: 'l2', env: 'env-a', resource: '*', agent: 'codebox:api-worker', kind: 'server' }]) }));
  assert.equal(mine.verdict, 'deploy', JSON.stringify(mine.reasons));
  // a host lease does not block a full deploy (update_core --skip-leased); a server lease does
  const host = await evaluateDeploy(dargs(repo, { ref: 'feat', leases: LEASES([{ id: 'l3', env: 'env-a', resource: 'host-1', agent: 'x', kind: 'host' }]) }));
  assert.equal(host.verdict, 'deploy');
  const srv = await evaluateDeploy(dargs(repo, { ref: 'feat', leases: LEASES([{ id: 'l4', env: 'env-a', resource: 'srv', agent: 'x', kind: 'server' }]) }));
  assert.match(srv.reasons[0], /env-a leased by x \(srv\)/);
  const elsewhere = await evaluateDeploy(dargs(repo, { ref: 'feat', leases: LEASES([{ id: 'l5', env: 'env-b', resource: '*', agent: 'x' }]) }));
  assert.equal(elsewhere.verdict, 'deploy');
});

test('deploy: a migration in the range -> escalate; so does a diff error', async () => {
  const repo = makeRepo({ files: { 'supabase/migrations/001_add.sql': 'select 1;\n', 'src.js': 'export const a = 1;\n' } });
  const mainSha = git(repo, 'rev-parse', 'main').trim();
  const ev = await evaluateDeploy(dargs(repo, { ref: 'feat', deploys: SNAP({ deployed: { 'env-a': { server: { ref: 'main', commit: mainSha } } } }) }));
  assert.equal(ev.verdict, 'escalate');
  assert.match(ev.reasons[0], /^contains a database migration: supabase\/migrations\/001_add\.sql/);
  // R8-5: no deployed commit in the ledger: the migration check cannot be bounded, so it escalates
  const ev2 = await evaluateDeploy(dargs(repo, { ref: 'feat', deploys: SNAP() }));
  assert.deepEqual(ev2.reasons, ['no deployed commit known: cannot bound the migration check']);
});

test('deploy: runner off, unknown env, which environment, state unavailable, opted out', async () => {
  const repo = makeRepo();
  assert.match((await evaluateDeploy(dargs(repo, { ref: 'feat', config: {} }))).reasons[0], /^deploy runner off: a deploy needs your approval tap$/);
  assert.deepEqual((await evaluateDeploy(dargs(repo, { ref: 'feat', text: `${GREEN}\n\nDeploy it?` }))).reasons, ['which environment?']);
  const one = await evaluateDeploy(dargs(repo, { ref: 'feat', text: `${GREEN}\n\nDeploy it?`, envs: ['env-a'], deploys: SNAP({ envs: ['env-a'], deployed: ledger(repo) }) }));
  assert.equal(one.verdict, 'deploy');   // the only env
  assert.match((await evaluateDeploy(dargs(repo, { ref: 'feat', deploys: null }))).reasons[0], /^deploy queue state unavailable/);
  assert.match((await evaluateDeploy(dargs(repo, { ref: 'feat', leases: { ok: false } }))).reasons[0], /^deploy queue state unavailable/);
  assert.match((await evaluateDeploy(dargs(repo, { ref: 'feat', config: { ...dcfg, deployOptOut: ['proj'] } }))).reasons[0], /opted out/);
  assert.match((await evaluateDeploy(dargs(repo, { ref: 'nope' }))).reasons[0], /ref nope not found/);
});

test('deploy: tests green only on a branch that is merged into the ref -> deploy; not merged -> escalate', async () => {
  const repo = makeRepo();
  // feat is not in main yet: green on feat only
  const notMerged = await evaluateDeploy(dargs(repo, { ref: 'main' }));
  assert.equal(notMerged.verdict, 'escalate');
  assert.match(notMerged.reasons[0], /no green test report on main or on feat merged into it/);
  git(repo, 'checkout', '-q', 'main'); git(repo, 'merge', '-q', '--no-ff', '-m', 'merge feat', 'feat'); git(repo, 'checkout', '-q', 'feat');
  const merged = await evaluateDeploy(dargs(repo, { ref: 'main' }));
  assert.equal(merged.verdict, 'deploy', JSON.stringify(merged.reasons));
  assert.match(merged.facts.evidence, /tests green on feat, which is merged into main/);
  const red = await evaluateDeploy(dargs(repo, { ref: 'main', text: '3 failed, 10 passed.\n\nDeploy to env-a?' }));
  assert.match(red.reasons[0], /tests reported red/);
});

test('deploy: decided against the branch when the same reply approves the merge', async () => {
  const repo = makeRepo();
  const ev = await evaluateDeploy(dargs(repo, { afterMerge: { branch: 'feat', target: 'main' } }));
  assert.equal(ev.verdict, 'deploy', JSON.stringify(ev.reasons));
  assert.equal(ev.facts.ref, 'main');
  assert.match(ev.facts.evidence, /tests green on feat; the merge into main is approved in this reply \(decided against the branch\)/);
});

test('rollbackText: previous release unknown', () => {
  assert.match(rollbackText('env-a', 'server', []), /^Rollback: the previous release is unknown for env-a \(server\)/);
  assert.match(rollbackText('env-a', 'server', [{ target: 'server', ref: 'main' }]), /previous release is unknown/, 'a moving ref name is never the rollback target');
});

test('composeReply: merge, push and deploy parts in one reply; each passes the floor only for the topics decided', () => {
  const r = composeReply({ merge: { repo: 'proj', branch: 'feat', target: 'main', rationale: 'merges cleanly' }, push: { repo: 'proj', branch: 'main', dest: 'main', rationale: 'lands the merge' },
    deploy: { env: 'env-a', scope: 'full', ref: 'main', sha: 'abcdef0123456789', rationale: 'tests green', rollback: 'Rollback: request a deploy of the previous release to env-a (full).' }, remaining: false });
  assert.deepEqual([r.merge, r.push, r.deploy], [true, true, true]);
  assert.match(r.text, /Merge: yes - .*Merge it now\. Push: yes - .*Push it now\. Deploy: yes - env-a full main@abcdef012345/);
  assert.equal(hardMatch(r.text, { mergePresent: true, pushPresent: true, deployPresent: true }), null);
});

// ---- round 8 review fixes ----
test('R8-3: two branches or two configured environments are never resolved by picking one', async () => {
  const repo = withOrigin(); more(repo);
  const two = await evaluatePush({ cwd: repo, text: `${GREEN}\n\nShould I push feat and also push feat-old?` });
  assert.equal(two.verdict, 'escalate'); assert.match(two.reasons[0], /^which branch\? the text names feat and feat-old/);
  const r2 = makeRepo();
  const envs = await evaluateDeploy(dargs(r2, { ref: 'feat', text: `${GREEN}\n\nDeploy main to env-b, env-a is fine?` }));
  assert.equal(envs.verdict, 'escalate'); assert.match(envs.reasons[0], /^which environment\? the text names env-a and env-b|^which environment\? the text names env-b and env-a/);
});

test('R8-4: a push that lands an approved merge still scans what local main carries beyond origin/main', async () => {
  const repo = withOrigin();
  git(repo, 'checkout', '-q', 'main'); commit(repo, { '.env': 'TOKEN=fake\n' }, 'local only'); git(repo, 'checkout', '-q', 'feat');
  const after = { branch: 'feat', target: 'main', tests: { state: 'green', explicit: true, quote: GREEN }, decision: { confidence: 0.9 }, facts: {} };
  const ev = await evaluatePush({ cwd: repo, text: 'Merge feat into main and push?', afterMerge: after });
  assert.equal(ev.verdict, 'escalate'); assert.match(ev.reasons.join(' '), /local main carries a secret\/credential path: \.env/);
  const clean = withOrigin();
  assert.equal((await evaluatePush({ cwd: clean, text: 'Merge feat into main and push?', afterMerge: after })).verdict, 'push');
  const big = withOrigin(); git(big, 'checkout', '-q', 'main'); commit(big, { 'logo.bin': Buffer.from([0, 1, 2, 255]).toString('latin1') }, 'binary'); git(big, 'checkout', '-q', 'feat');
  assert.equal((await evaluatePush({ cwd: big, text: 'Merge feat into main and push?', afterMerge: after })).verdict, 'escalate');
});

test('R8-7: pushing a tag or another ref escalates; only the branch itself can be pushed', async () => {
  const repo = withOrigin(); more(repo);
  const tag = await evaluatePush({ cwd: repo, text: `${GREEN}\n\nPush the tag v1.2 to origin?` });
  assert.equal(tag.verdict, 'escalate'); assert.match(tag.reasons[0], /v1\.2, which is not a branch I can resolve/);
  const other = await evaluatePush({ cwd: repo, text: `${GREEN}\n\nShall I push feat to main?` });
  assert.equal(other.verdict, 'escalate'); assert.match(other.reasons[0], /push to another ref \(feat -> origin\/main\): use the merge evaluation/);
  const rc = await evaluatePush({ cwd: repo, text: `${GREEN}\n\nShall I push the release candidate?` });
  assert.equal(rc.verdict, 'escalate');
  const remote = await evaluatePush({ cwd: repo, text: `${GREEN}\n\nShall I push to upstream?` });
  assert.match(remote.reasons[0], /another remote/);
});

test('R8-8: an unnamed test report counts for the ref only when the session HEAD is that ref', async () => {
  const repo = makeRepo();
  const unnamed = 'All tests pass: 1826 passed.';
  const notHead = await evaluateDeploy(dargs(repo, { ref: 'main', text: `${unnamed}\n\nDeploy to env-a?` }));
  assert.equal(notHead.verdict, 'escalate'); assert.match(notHead.reasons[0], /no green test report on main or on feat merged into it/);
  const head = await evaluateDeploy(dargs(repo, { ref: 'feat', text: `${unnamed}\n\nDeploy to env-a?` }));
  assert.equal(head.verdict, 'deploy', JSON.stringify(head.reasons));
  const named = await evaluateDeploy(dargs(repo, { ref: 'main', text: 'Tests: 1826/1826 pass on main.\n\nDeploy to env-a?' }));
  assert.equal(named.verdict, 'deploy', 'a report that names the ref counts for it');
});

test('R8-12: a target that is not a configured environment, or not a scope, escalates', async () => {
  const repo = makeRepo();
  const one = { envs: ['env-a'], deploys: SNAP({ envs: ['env-a'], deployed: ledger(repo) }) };
  for (const t of ['Deploy it to production?', 'Deploy it to prod?', 'Deploy it to staging?', 'Deploy it live?']) {
    const ev = await evaluateDeploy(dargs(repo, { ref: 'feat', text: `${GREEN}\n\n${t}`, ...one }));
    assert.equal(ev.verdict, 'escalate', t); assert.match(ev.reasons[0], /is not a configured environment/, t);
  }
  // R8-r3-4: app / api / site are no scope (default full); only an unknown target where the environment goes escalates
  for (const w of ['app', 'api', 'site', 'backend']) {
    const ok = await evaluateDeploy(dargs(repo, { ref: 'feat', text: `${GREEN}\n\nShall I deploy the ${w} to env-a?` }));
    assert.equal(ok.verdict, 'deploy', w); assert.equal(ok.facts.scope, 'full', w);
  }
  const where = await evaluateDeploy(dargs(repo, { ref: 'feat', text: `${GREEN}\n\nShall I deploy it to the backend?` }));
  assert.match(where.reasons[0], /"backend" is not a configured environment/);
  assert.equal((await evaluateDeploy(dargs(repo, { ref: 'feat', text: `${GREEN}\n\nDeploy the frontend to env-a?` }))).facts.scope, 'frontend');
});

test('R8-14/15: the typed rationale says "no blocking lease" and never echoes the session test quote', async () => {
  const repo = withOrigin(); more(repo);
  const d = await evaluateDeploy(dargs(makeRepo(), { ref: 'feat' }));
  assert.match(d.rationale, /no blocking lease on env-a/);
  const p = await evaluatePush({ cwd: repo, text: `${GREEN}\n\nShall I push feat?` });
  assert.doesNotMatch(p.rationale, /1826/); assert.match(p.tests.quote, /1826/, 'the quote stays in the tests evidence');
  assert.match(decisionRecord('push', p, { id: 'q', session: 's' }).evidence.join(' '), /1826/);
});

test('R8-17: deploy honours mergeOptOut like push', async () => {
  const repo = makeRepo();
  assert.match((await evaluateDeploy(dargs(repo, { ref: 'feat', config: { ...dcfg, mergeOptOut: ['proj'] } }))).reasons[0], /opted out/);
});

test('R8-r3-4: environment and target words are read only in the clause that names the deploy', async () => {
  const repo = makeRepo();
  const ok = await evaluateDeploy(dargs(repo, { ref: 'feat', text: `${GREEN}\n\nDeploy it to env-a? The live view looks fine.` }));
  assert.equal(ok.verdict, 'deploy', JSON.stringify(ok.reasons));
  const other = await evaluateDeploy(dargs(repo, { ref: 'feat', text: `${GREEN}\n\nThe staging page was checked by env-b earlier. Deploy it to env-a?` }));
  assert.equal(other.verdict, 'deploy'); assert.equal(other.facts.env, 'env-a', 'env-b outside the deploy clause is not a second target');
  const live = await evaluateDeploy(dargs(repo, { ref: 'feat', text: `${GREEN}\n\nDeploy it live?` }));
  assert.match(live.reasons[0], /"live" is not a configured environment/);
});

test('R8-r3-5: push <ref> to <other remote> escalates', async () => {
  const repo = withOrigin(); more(repo);
  for (const t of ['Push feat to upstream?', 'Shall I push feat to the fork?', 'push to upstream']) {
    const ev = await evaluatePush({ cwd: repo, text: `${GREEN}\n\n${t}` });
    assert.equal(ev.verdict, 'escalate', t); assert.match(ev.reasons[0], /push to another remote/, t);
  }
});

// ---- round 9 item 4: lab vs customer database -----------------------------------------------------------------------
const mig = (sql, extra = {}) => makeRepo({ files: { 'supabase/migrations/002_add.sql': sql, 'src.js': 'export const a = 1;\n', ...extra } });
const migArgs = (repo, o = {}) => dargs(repo, { ref: 'feat', deploys: SNAP({ deployed: { 'env-a': { server: { ref: 'main', commit: git(repo, 'rev-parse', 'main').trim() } } } }), ...o });
const ADD = 'CREATE TABLE notes (id int primary key, body text, owner_id int REFERENCES users(id) ON DELETE CASCADE);\nCREATE INDEX notes_owner ON notes (owner_id);\nALTER TABLE users ADD COLUMN IF NOT EXISTS nickname text;\nCREATE OR REPLACE VIEW v_notes AS SELECT * FROM notes;\nINSERT INTO settings (k, v) VALUES (\'a\', \'b\') ON CONFLICT DO NOTHING; -- seed\n';

test('analyzeMigrationSql: additive statements only', async () => {
  const { analyzeMigrationSql } = await import('../decide-policy.js');
  assert.deepEqual(analyzeMigrationSql(ADD), { additive: true, why: null });
  for (const bad of ['DROP TABLE t;', 'delete from t;', 'TRUNCATE t;', 'ALTER TABLE t DROP COLUMN c;', 'ALTER TABLE t RENAME TO u;', 'ALTER TABLE t ALTER COLUMN c TYPE bigint;', 'ALTER TABLE t ADD COLUMN c int, DROP COLUMN d;',
    'UPDATE t SET a = 1;', 'INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET a = 2;', 'CREATE TABLE t (a int); DROP INDEX i;', 'select 1;', 'do $$ begin end $$;', '', '-- only a comment']) {
    assert.equal(analyzeMigrationSql(bad).additive, false, bad);
  }
  assert.equal(analyzeMigrationSql("INSERT INTO t VALUES ('please DROP TABLE x;');").additive, true);   // inside a literal
});

test('deploy: an additive migration on a lab env is a deploy step and the reply names the files; customer env, destructive and edited migrations escalate', async () => {
  const repo = mig(ADD);
  const lab = await evaluateDeploy(migArgs(repo, { config: { ...dcfg, labEnvs: ['env-a'] } }));
  assert.equal(lab.verdict, 'deploy', JSON.stringify(lab.reasons));
  assert.deepEqual(lab.facts.migrations, ['supabase/migrations/002_add.sql']);
  assert.match(lab.rationale, /additive migration on the lab database env-a applied by the deploy queue: supabase\/migrations\/002_add\.sql/);
  const proc = await evaluateDeploy(migArgs(repo, { config: { ...dcfg, labEnvs: ['env-a'], migrationProcedure: { proj: 'scripts/migrate-lab.sh' } } }));
  assert.match(proc.rationale, /applied by scripts\/migrate-lab\.sh/);
  // not a lab env (default labEnvs is empty): customer databases stay with the owner
  for (const config of [dcfg, { ...dcfg, labEnvs: ['env-b'] }, { ...dcfg, labEnvs: [] }]) {
    const cust = await evaluateDeploy(migArgs(repo, { config }));
    assert.equal(cust.verdict, 'escalate'); assert.match(cust.reasons[0], /^contains a database migration: supabase\/migrations\/002_add\.sql/);
  }
  const bad = await evaluateDeploy(migArgs(mig('CREATE TABLE t (a int);\nDROP TABLE old;\n'), { config: { ...dcfg, labEnvs: ['env-a'] } }));
  assert.equal(bad.verdict, 'escalate'); assert.match(bad.reasons[0], /DROP in "DROP TABLE old"/);
  // an edit of a migration that is already in the deployed range base, a non-sql migration and a deletion are not additive
  const base = makeRepo({ base: { 'src.js': 'x\n', 'VERSION.txt': '1\n', 'db/migrations/001.sql': 'CREATE TABLE a (i int);\n' }, files: { 'db/migrations/001.sql': 'CREATE TABLE a (i int);\nCREATE TABLE b (i int);\n' } });
  const edit = await evaluateDeploy(migArgs(base, { config: { ...dcfg, labEnvs: ['env-a'] } }));
  assert.equal(edit.verdict, 'escalate'); assert.match(edit.reasons[0], /edits a migration that already exists/);
  const py = await evaluateDeploy(migArgs(makeRepo({ files: { 'app/migrations/0002_add.py': 'x = 1\n' } }), { config: { ...dcfg, labEnvs: ['env-a'] } }));
  assert.equal(py.verdict, 'escalate'); assert.match(py.reasons[0], /not a \.sql file/);
  const del = makeRepo({ base: { 'src.js': 'x\n', 'VERSION.txt': '1\n', 'db/migrations/001.sql': 'CREATE TABLE a (i int);\n' }, files: { 'src.js': 'y\n' } });
  git(del, 'rm', '-q', 'db/migrations/001.sql'); git(del, 'commit', '-q', '-m', 'drop migration');
  const gone = await evaluateDeploy(migArgs(del, { config: { ...dcfg, labEnvs: ['env-a'] } }));
  assert.equal(gone.verdict, 'escalate'); assert.match(gone.reasons[0], /deleted or unreadable/);
});

// m6: split or obfuscated spellings of a protected action ("mer ge into main", "pu sh to main", zero-width, hyphen/dot
// splits) are classed like the plain word, both by the manager's forbidden-topic filter (stall.js) and by the V2 task
// classifier (orchestration/policy.js). Rejoining is conservative: only when the joined token is a protected verb.
import test from 'node:test';
import assert from 'node:assert/strict';
import { forbiddenMatch, classifyStall, wouldSend, normalizeSplits } from '../stall.js';
import { restrictedTopics } from '../orchestration/policy.js';

const classes = (t) => restrictedTopics(t).map((x) => x.class).sort();
const ZW = '​', SHY = '­', WJ = '⁠';

const POSITIVES = [
  ['mer ge into main', 'merge_protected'],
  ['Please mer ge the branch into main', 'merge_protected'],
  ['Me rge to main now', 'merge_protected'],
  ['pu sh to main', 'merge_protected'],
  ['pu sh it to main now', 'merge_protected'],
  ['re base onto main', 'merge_protected'],
  [`mer${ZW}ge into main`, 'merge_protected'],
  [`mer${SHY}ge into main`, 'merge_protected'],
  ['mer-ge into main', 'merge_protected'],
  ['mer.ge into main', 'merge_protected'],
  ['de ploy it', 'deploy'],
  [`de${WJ}ploy it`, 'deploy'],
  ['de-ploy now', 'deploy'],
  ['d.e.p.l.o.y', 'deploy'],
  ['ｄｅｐｌｏｙ the build', 'deploy'],   // fullwidth: NFKC
  ['de lete the old rows', 'destructive'],
  // review round: nouns, wider separators, confusables, combining marks
  ['send the pass word', 'credentials'],
  ['email the cust omer', 'customer'],
  ['pay the in voice', 'money'],
  ['paste the api k ey here', 'credentials'],
  ['read the sec ret', 'credentials'],
  ['rotate the cre dential', 'credentials'],
  ['sh ip it to prod', 'deploy'],
  ['mer\tge into main', 'merge_protected'],
  ['mer  ge into main', 'merge_protected'],
  ['mer/ge into main', 'merge_protected'],
  ['mer*ge into main', 'merge_protected'],
  ['mer|ge into main', 'merge_protected'],
  ['m e r g e into main', 'merge_protected'],
  ['m\u0435rg\u0435 into main', 'merge_protected'],        // Cyrillic е
  ['d\u0435pl\u03BFy now', 'deploy'],                 // Cyrillic е, Greek ο
  ['\u0440ush to main', 'merge_protected'],              // Cyrillic р
  ['me\u0301rge into main', 'merge_protected'],          // combining acute
  ['d\u0323eploy now', 'deploy'],                        // combining dot below
];

test('split / zero-width / hyphen / dot spellings of protected verbs are forbidden in the manager filter', () => {
  for (const [t] of POSITIVES) assert.ok(forbiddenMatch(t), `${JSON.stringify(t)} -> forbiddenMatch`);
});

test('the V2 classifier derives the same class as for the plain spelling', () => {
  for (const [t, cls] of POSITIVES) assert.ok(classes(t).includes(cls), `${JSON.stringify(t)} -> ${cls} (got ${classes(t)})`);
});

test('the rule path never sends an answer to a split forbidden question', () => {
  const RULE = '─'.repeat(60);
  for (const q of ['Shall I continue and mer ge into main?', 'Should I continue and pu sh to main?', `Shall I continue and de${ZW}ploy?`]) {
    const plain = ['⏺ Bash(npm test)', '  ⎿  5 passed', '', `⏺ Everything else is ready.`, `  ${q}`, '', '✻ Baked for 3m 31s · done 3:59 PM', RULE, '❯ ', RULE];
    const s = classifyStall({ plain, raw: null, state: 'done' });
    assert.ok(s.forbidden, `${q} -> forbidden`);
    assert.equal(wouldSend(s).send, null, `${q} -> not sent`);
  }
});

test('normalizeSplits only rejoins when the joined token is a protected verb', () => {
  assert.equal(normalizeSplits('mer ge into main'), 'merge into main');
  assert.equal(normalizeSplits(`pu${ZW}sh to main`), 'push to main');
  assert.equal(normalizeSplits('the mer chant uses a de bug log'), 'the mer chant uses a de bug log');
  assert.equal(normalizeSplits('we pass words to the function'), 'we pass words to the function');
  assert.equal(normalizeSplits('pass word'), 'password');
  assert.equal(normalizeSplits('src/merge.js and pre-merge'), 'src/merge.js and pre-merge');
  assert.equal(normalizeSplits('e.g. push it'), 'e.g. push it');
});

test('negatives: normal prose stays unflagged; existing rules still decide the rest', () => {
  for (const t of ['implement merge sort', 'merge the two lists', 'the main function', 'push notifications for the app', 'the mer chant pays later',
    'a de bug log', 'summer gem into main', 'use emerge to build', 'pre-merge checks on the branch', 'a to ken gesture', 'café au lait in the main hall']) {
    assert.equal(classes(t).filter((c) => c !== 'money').length, 0, `${t} -> ${classes(t)}`);
  }
  for (const t of ['implement merge sort', 'merge the two lists', 'the main function', 'push notifications for the app', 'a de bug log', 'summer gem into main',
    'the mer chant', 'pre-merge checks', 'e.g. push it later', 'café au lait in the main hall']) {
    assert.equal(forbiddenMatch(t), null, t);
  }
  // Both filters now read "pass words" as a credential (the V2 pairwise join rule, shared): an extra owner tap.
  // "deploy key docs" names the deploy topic in the existing rules: still flagged (more owner taps is the safe side).
  assert.ok(forbiddenMatch('update the deploy key docs'));
  assert.ok(classes('update the deploy key docs').includes('deploy'));
});

test('variants stay linear on long adversarial input (bounded joins, no backtracking blow-up)', () => {
  for (const t of ['a '.repeat(20000), 'a-'.repeat(20000) + '!', 'm e r '.repeat(5000), '\u0301'.repeat(20000)]) {
    const t0 = Date.now();
    forbiddenMatch(t); restrictedTopics(t.slice(0, 4000));
    assert.ok(Date.now() - t0 < 2000, `${t.length} chars took ${Date.now() - t0} ms`);
  }
});

// Re-check round: any non-alphanumeric separator, invisible fillers, digits, line breaks, and every forbidden keyword.
test('F1 any 1-3 non-alphanumeric separator, fillers, digits: caught by the manager filter and the V2 classifier', () => {
  const seps = [',', ':', "'", '(', ')', '+', '=', ';', '&', '~', '#', '\\', '%', '^', '<', '`', '[', 'ㅤ', 'ᅟ', '⠀', ' '];
  const texts = [...seps.map((c) => `de${c}ploy it`), 'de(ploy) it', 'de2ploy it', 'dep1oy it', 'd3pl0y it', 'de9ploy it'];
  for (const t of texts) {
    assert.ok(forbiddenMatch(t), `${JSON.stringify(t)} -> forbiddenMatch`);
    assert.ok(classes(t).includes('deploy'), `${JSON.stringify(t)} -> deploy (got ${classes(t)})`);
  }
});

test('F2 a line break splitting one protected word is rejoined; the same-line windows stay', () => {
  for (const [t, cls] of [['Should I run the dep\nloy script now?', 'deploy'], ['mer\nge this into main?', 'merge_protected'], ['rotate the pass\nword', 'credentials']]) {
    assert.ok(forbiddenMatch(t), JSON.stringify(t));
    assert.ok(classes(t).includes(cls), `${JSON.stringify(t)} -> ${cls} (got ${classes(t)})`);
  }
  assert.equal(forbiddenMatch('merge the lists\nthen open main.js'), null, 'merge ... main across a line break is not one topic');
});

test('F3 a space inside any forbidden keyword: the split text is classed like the plain text, in both filters', () => {
  const pairs = [['merge into ma in', 'merge into main'], ['push to mas ter', 'push to master'], ['should I bu y it', 'should I buy it'],
    ['mo ney left', 'money left'], ['ki ll prod', 'kill prod'], ['dr op the table', 'drop the table'], ['re set --hard', 'reset --hard'],
    ['go li ve', 'go live'], ['re lease to prod', 'release to prod'], ['ship to sta ging', 'ship to staging'], ['push the ta gs', 'push the tags'],
    ['copy .e nv', 'copy .env'], ['add the ssh ke y', 'add the ssh key'], ['the bea rer header', 'the bearer header'],
    ['e mail the client', 'email the client'], ['pa y now', 'pay now'], ['ter raform apply', 'terraform apply']];
  for (const [split, plain] of pairs) {
    assert.ok(classes(plain).length, `fixture: ${plain} is restricted`);
    assert.equal(!!forbiddenMatch(split), !!forbiddenMatch(plain), `manager: ${split} vs ${plain}`);
    for (const c of classes(plain)) assert.ok(classes(split).includes(c), `V2: ${split} -> ${c} (got ${classes(split)})`);
  }
});

test('F3 in-context joins stay linear on 64 KB of keyword fragments', () => {
  for (const t of ['ma in '.repeat(11000), 'de ploy ma in\n'.repeat(5000), 'pa y '.repeat(13000)]) {
    const t0 = Date.now();
    forbiddenMatch(t); restrictedTopics(t.slice(0, 8000));
    assert.ok(Date.now() - t0 < 3000, `${t.length} chars took ${Date.now() - t0} ms`);
  }
});

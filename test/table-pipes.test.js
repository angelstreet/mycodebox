// Bug 1792615004567-bd7c32: an ASCII markdown table in a stop's closing text came out as
// `| option | what it does | | --- | --- | | context | is real |` — one giant line with the
// pipes visible, instead of a table. reflowPane only recognised the Unicode box-drawing
// `│` as a table row, so markdown's ASCII `|` rows were treated as prose and joined.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reflowPane } from '../public/buttons.js';
import { renderMd } from '../public/md.js';

const MD_TABLE = [
  'The differences:',
  '',
  '| option | what it does |',
  '| --- | --- |',
  '| context | is real |',
].join('\n');

test('an ASCII markdown table keeps its rows on separate lines', () => {
  const out = reflowPane(MD_TABLE).split('\n');
  assert.ok(out.includes('| option | what it does |'), 'header row survives on its own line');
  assert.ok(out.includes('| --- | --- |'), 'separator row survives so renderMd can detect the table');
  assert.ok(out.includes('| context | is real |'), 'body row survives on its own line');
});

test('no two table rows get merged into one line', () => {
  // the bug glued every row into a single line: "| a | b | | --- | --- | | c | d |".
  // count the lines that start with a pipe; it must be one per input row.
  const rowsIn = MD_TABLE.split('\n').filter((l) => l.startsWith('|')).length;
  const rowsOut = reflowPane(MD_TABLE).split('\n').filter((l) => l.trimStart().startsWith('|')).length;
  assert.equal(rowsOut, rowsIn, 'each table row keeps its own line');
  // and no row should contain a glued second separator
  assert.equal(reflowPane(MD_TABLE).includes('| --- | --- | |'), false, 'rows are not glued together');
});

test('the reflowed table renders as a real HTML table, not prose with pipes', () => {
  const html = renderMd(reflowPane(MD_TABLE));
  assert.ok(html.includes('<table>'), 'renderMd recognises it as a table');
  assert.equal(html.includes('| --- |'), false, 'no raw separator pipes left in the output');
});

test('a table row that the pane wrapped mid-cell still stays on its own line', () => {
  // narrow pane cut the row before its trailing pipe
  const wrapped = ['| context | is real if the persona each', 'ask question types |'].join('\n');
  const out = reflowPane(wrapped).split('\n');
  assert.equal(out.length, 2, `both halves keep their line, got: ${JSON.stringify(out)}`);
});

test('box-drawn tables (│) are unaffected', () => {
  const boxed = ['│ a │ b │', '│ c │ d │'].join('\n');
  assert.deepEqual(reflowPane(boxed).split('\n'), ['│ a │ b │', '│ c │ d │']);
});

test('prose around the table is still joined normally', () => {
  const mixed = ['B vs C is mostly', 'about who writes the prompts.', '', ...MD_TABLE.split('\n')].join('\n');
  const out = reflowPane(mixed).split('\n');
  assert.equal(out[0], 'B vs C is mostly about who writes the prompts.');
  assert.ok(out.includes('| option | what it does |'), 'table still intact after prose');
});
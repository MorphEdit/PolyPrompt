// #57: the frozen benchmark sample: seeded, deterministic, stratified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED, byCodePoint, mulberry32, shuffle } from '../src/bench/rng.js';
import { allocate, buildSample, sampleJson, skipReason } from '../src/bench/sample.js';
import { promptFor } from '../src/bench/prompts.js';
import { fixtureRows } from './bench-fixture.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('#57 mulberry32 is seeded and repeatable; shuffle is Fisher–Yates', () => {
  const r = mulberry32(SEED);
  assert.deepEqual([r(), r(), r()], [0.02845785580575466, 0.23895404138602316, 0.2033751884009689]);
  const again = mulberry32(20261118);
  assert.equal(again(), 0.02845785580575466);
  // [a,b,c]: i=2, j=floor(0.028×3)=0 -> [c,b,a]; i=1, j=floor(0.239×2)=0 -> [b,c,a].
  assert.deepEqual(shuffle(['a', 'b', 'c'], mulberry32(SEED)), ['b', 'c', 'a']);
});

test('#57 largest-remainder allocation, ties by Task_type in code-point order, capped at the eligible count', () => {
  assert.deepEqual(allocate({ 'Open QA': 50, 'Closed QA': 50, Brainstorming: 50 }, 100), { Brainstorming: 34, 'Closed QA': 33, 'Open QA': 33 });
  assert.deepEqual(allocate({ b: 1, a: 1, c: 1 }, 2), { a: 1, b: 1, c: 0 });
  // 100 × 7/9 = 77.78, 100 × 2/9 = 22.22 -> 78 / 22.
  assert.deepEqual(allocate({ x: 7, y: 2 }, 9), { x: 7, y: 2 }, 'fewer eligible than slots: all');
  assert.deepEqual(allocate({ x: 700, y: 200 }, 100), { x: 78, y: 22 });
  // Code points, not locale: 'Z' (U+005A) before 'a' (U+0061) before 'Ä' (U+00C4).
  assert.deepEqual(Object.keys(allocate({ Ä: 1, a: 1, Z: 1 }, 2)), ['Z', 'a', 'Ä']);
  assert.deepEqual(allocate({ Ä: 1, a: 1, Z: 1 }, 2), { Z: 1, a: 1, Ä: 0 });
  assert.ok(byCodePoint('Z', 'a') < 0);
});

test('#57 open skips: prompt text over 2000 characters (Instruction + "\\n\\n" + Input) or an empty Output', () => {
  assert.equal(skipReason({ Instruction: 'ก'.repeat(2000), Input: '', Output: 'x' }), null);
  assert.equal(skipReason({ Instruction: 'ก'.repeat(2001), Input: '', Output: 'x' }), 'too_long');
  assert.equal(skipReason({ Instruction: 'ก'.repeat(1000), Input: 'ข'.repeat(998), Output: 'x' }), null);
  assert.equal(skipReason({ Instruction: 'ก'.repeat(1000), Input: 'ข'.repeat(999), Output: 'x' }), 'too_long');
  assert.equal(skipReason({ Instruction: 'ก'.repeat(2000), Input: '   ', Output: 'x' }), null, 'a blank Input is not joined');
  assert.equal(skipReason({ Instruction: 'a', Input: null, Output: '' }), 'empty_output');
  assert.equal(skipReason({ Instruction: 'a', Input: null, Output: ' \n' }), 'empty_output');
  assert.equal(promptFor('open', { Instruction: ' a ', Input: ' b ' }), ' a \n\n b ');
  assert.equal(promptFor('open', { Instruction: 'a', Input: '  ' }), 'a');
});

test('#57 the sample of a small fixture has the known IDs: all mgsm, shuffled belebele, open skipped before stratified sampling', () => {
  const rows = fixtureRows();
  const sample = buildSample(rows);
  assert.equal(sample.seed, 20261118);
  assert.deepEqual(sample.sets.mgsm, ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']);
  assert.equal(sample.sets.belebele.length, 200);
  const excluded = Array.from({ length: 210 }, (_, i) => String(i)).filter((id) => !sample.sets.belebele.includes(id));
  assert.deepEqual(excluded, ['5', '37', '42', '49', '70', '75', '83', '118', '146', '170']);
  assert.deepEqual(sample.skipped, { open: [
    { id: '3', reason: 'too_long' }, { id: '7', reason: 'empty_output' },
    { id: '40', reason: 'too_long' }, { id: '41', reason: 'empty_output' },
  ] });
  assert.deepEqual(sample.sets.open, ['0', '2', '4', '8', '11', '12', '13', '16', '17', '18', '19', '22', '23', '24', '25', '26',
    '29', '30', '32', '33', '34', '35', '38', '43', '47', '49', '52', '56', '57', '59', '61', '62', '63', '64', '66', '69', '71',
    '72', '74', '75', '76', '77', '81', '82', '84', '85', '86', '87', '89', '90', '91', '92', '93', '94', '95', '96', '98', '100',
    '101', '102', '104', '105', '106', '108', '109', '110', '111', '112', '113', '114', '115', '116', '118', '119', '121', '122',
    '123', '124', '126', '128', '130', '131', '132', '134', '135', '136', '137', '138', '140', '141', '142', '143', '144', '146',
    '147', '148', '149', '150', '152', '153']);
  const per = {};
  for (const id of sample.sets.open) per[rows.open[Number(id)].Task_type] = (per[rows.open[Number(id)].Task_type] ?? 0) + 1;
  assert.deepEqual(per, { 'Open QA': 33, 'Closed QA': 33, Brainstorming: 34 });
  for (const list of Object.values(sample.sets)) assert.deepEqual(list, [...list].sort((a, b) => a - b));

  // Each set has its own generator: dropping the open rows changes nothing in belebele.
  assert.deepEqual(buildSample({ ...rows, open: [] }).sets.belebele, sample.sets.belebele);
  // Fewer than 100 eligible: all of them.
  assert.deepEqual(buildSample({ ...rows, open: rows.open.slice(0, 12) }).sets.open, ['0', '1', '2', '4', '5', '6', '8', '9', '10', '11']);
});

test('#57 the same seed gives byte-identical sample.json', () => {
  const a = sampleJson(buildSample(fixtureRows()));
  const b = sampleJson(buildSample(fixtureRows()));
  assert.equal(a, b);
  assert.ok(a.endsWith('}\n'));
  assert.equal(a, JSON.stringify(JSON.parse(a), null, 2) + '\n');
  assert.notEqual(sampleJson(buildSample(fixtureRows(), { seed: 1 })), a);
});

test('#57 the committed bench/sample.json has 250 mgsm, 200 belebele and 100 open IDs', () => {
  const text = readFileSync(path.join(root, 'bench', 'sample.json'), 'utf8');
  const sample = JSON.parse(text);
  assert.equal(text, sampleJson(sample));
  assert.equal(sample.seed, 20261118);
  assert.deepEqual(sample.sets.mgsm, Array.from({ length: 250 }, (_, i) => String(i)));
  assert.equal(sample.sets.belebele.length, 200);
  assert.equal(new Set(sample.sets.belebele).size, 200);
  assert.ok(sample.sets.belebele.every((id) => Number(id) >= 0 && Number(id) < 900));
  assert.equal(sample.sets.open.length, 100);
  assert.equal(sample.skipped.open.length > 0, true);
  const skipped = new Set(sample.skipped.open.map((s) => s.id));
  assert.ok(sample.sets.open.every((id) => !skipped.has(id)));
});

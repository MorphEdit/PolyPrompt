// #62: resuming a run with other --sets or --model must not keep the first
// run's meta.json, or the report drops / mislabels the new results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROMPTS } from '../src/bench/prompts.js';
import { runBench } from '../src/bench/run.js';
import { writeReport } from '../src/bench/report.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude', 'bench.mjs');
const rows = {
  mgsm: [
    { question: 'เป็ดวางไข่วันละ 16 ฟอง กินไป 3 ฟอง เหลือกี่ฟอง', answer_number: 13 },
    { question: 'มีแมว 4 ตัว แต่ละตัวมี 4 ขา รวมกี่ขา', answer_number: 16 },
  ],
  belebele: [],
  open: [{ Instruction: 'เขียนกลอนสั้น ๆ เกี่ยวกับฝน', Input: '', Output: 'ฝนตกพรำพรำ', Task_type: 'Creative writing' }],
};
const sample = { seed: 20261118, sets: { mgsm: ['0', '1'], belebele: [], open: ['0'] }, skipped: { open: [] } };
const translator = { async translate(text, src, tgt) { return tgt === 'en' ? `${text} (in English)` : text.replace('Answer:', 'คำตอบ:'); } };

async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'polyprompt-62-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  process.env.BENCH_CALLS = path.join(dir, 'calls.jsonl');
  process.env.BENCH_RULES = path.join(dir, 'rules.json');
  await writeFile(process.env.BENCH_RULES, JSON.stringify([
    { includes: 'เหลือกี่ฟอง', text: 'Answer: 13' },
    { includes: 'รวมกี่ขา', text: 'Answer: 16' },
    { includes: 'กลอน', text: 'ฝนตก' },
    { includes: 'Answer', text: 'A' },
  ]));
  const outDir = path.join(dir, 'results', 'X');
  const run = (opts) => runBench({ outDir, run: 'X', sample, rows, command: FAKE, cwd: path.join(dir, 'home'), modelManager: translator, ...opts });
  const meta = async () => JSON.parse(await readFile(path.join(outDir, 'meta.json'), 'utf8'));
  return { outDir, run, meta };
}

test('#62 resuming with other --sets adds them to meta.json (in set order) and REPORT.md', async (t) => {
  const { outDir, run, meta } = await setup(t);
  assert.equal((await run({ sets: ['open'] })).code, 0);
  const first = await meta();
  assert.equal((await run({ sets: ['mgsm'] })).code, 0);
  assert.ok(existsSync(path.join(outDir, 'mgsm.jsonl')));
  const m = await meta();
  assert.deepEqual(m.sets, ['mgsm', 'open']);
  assert.deepEqual(Object.keys(m.prompts).sort(), ['mgsm', 'open']);
  assert.equal(m.prompts.mgsm, PROMPTS.mgsm);
  assert.deepEqual(Object.keys(m.datasets).sort(), ['mgsm', 'open']);
  assert.equal(m.date, first.date, 'the first run keeps its date');
  const report = await readFile(await writeReport(outDir, sample), 'utf8');
  assert.match(report, /### mgsm/);
  assert.match(report, /mgsm: `/);
  assert.match(report, /Judge on `open`/);
});

for (const [flag, key, a, b] of [
  ['--model', 'model', 'claude-opus-5-5', 'claude-sonnet-5-5'],
  ['--judge-model', 'judgeModel', 'claude-opus-5-5', 'claude-sonnet-5-5'],
  ['--translator', 'translator', '4b', '12b'],
]) {
  test(`#62 resuming with another ${flag} is refused before any call and keeps meta.json`, async (t) => {
    const { outDir, run, meta } = await setup(t);
    assert.equal((await run({ sets: ['mgsm'], limit: 1, [key]: a })).code, 0);
    const before = await readFile(path.join(outDir, 'mgsm.jsonl'), 'utf8');
    const calls = await readFile(process.env.BENCH_CALLS, 'utf8');
    const res = await run({ sets: ['mgsm'], [key]: b });
    assert.equal(res.code, 1);
    assert.match(res.message, new RegExp(`${flag} ${a}`));
    assert.match(res.message, /new --run/);
    assert.equal(await readFile(path.join(outDir, 'mgsm.jsonl'), 'utf8'), before);
    assert.equal(await readFile(process.env.BENCH_CALLS, 'utf8'), calls);
    assert.equal((await meta())[key], a);
  });
}

test('#62 REPORT.md covers a set whose results exist even when an older meta.json leaves it out', async (t) => {
  const { outDir, run, meta } = await setup(t);
  assert.equal((await run({ sets: ['mgsm', 'open'] })).code, 0);
  const m = await meta();
  await writeFile(path.join(outDir, 'meta.json'), JSON.stringify({ ...m, sets: ['mgsm'] }), 'utf8');
  const report = await readFile(await writeReport(outDir, sample), 'utf8');
  assert.match(report, /### open/);
});

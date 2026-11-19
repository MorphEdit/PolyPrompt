// #63: --retry-failed must judge an `open` item whose A or B it just repaired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBench } from '../src/bench/run.js';
import { computeReport } from '../src/bench/report.js';
import { readLines } from '../src/bench/results.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude', 'bench.mjs');
const rows = { open: [{ Instruction: 'เขียนกลอนสั้น ๆ เกี่ยวกับฝน', Input: '', Output: 'ฝนตกพรำพรำ', Task_type: 'Creative writing' }] };
const sample = { seed: 20261118, sets: { open: ['0'] }, skipped: { open: [] } };

test('#63 --retry-failed judges an open item whose failed B it just repaired', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'polyprompt-bench-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const outDir = path.join(dir, 'results', 'r1');
  const rulesFile = path.join(dir, 'rules.json');
  process.env.BENCH_CALLS = path.join(dir, 'calls.jsonl');
  process.env.BENCH_RULES = rulesFile;
  const translator = { translate: async (text, src, tgt) => (tgt === 'en' ? `${text} (in English)` : text) };
  const run = (opts = {}) => runBench({
    outDir, run: 'r1', sample, rows, command: FAKE, cwd: path.join(dir, 'home'), modelManager: translator,
    claudeVersion: '9.9.9 (Claude Code)', machine: { cpu: 'test cpu', gpu: null, vram: null }, sets: ['open'], ...opts,
  });

  // First run: B fails, so the item is not judged.
  await writeFile(rulesFile, JSON.stringify([
    { includes: 'ฝน (in English)', text: 'boom', error: true },
    { includes: 'ฝน', text: 'กลอน A' },
  ]));
  assert.equal((await run()).code, 0);
  assert.deepEqual(await readLines(path.join(outDir, 'judge.jsonl')), []);

  // --retry-failed: B now succeeds, so both judge orders should run.
  await writeFile(rulesFile, JSON.stringify([
    { includes: '### คำตอบ 1\nกลอน A', text: '{"winner": 1, "reason": "x"}' },
    { includes: '### คำตอบ 1\nกลอน B', text: '{"winner": 2, "reason": "x"}' },
    { includes: 'ฝน (in English)', text: 'กลอน B' },
    { includes: 'ฝน', text: 'กลอน A' },
  ]));
  assert.equal((await run({ retryFailed: true })).code, 0);
  const open = (await readLines(path.join(outDir, 'open.jsonl'))).map((e) => e.value);
  assert.equal(open.filter((l) => l.condition === 'B').at(-1).error, null, 'B was repaired');
  const judge = await readLines(path.join(outDir, 'judge.jsonl'));
  assert.equal(judge.length, 2, 'both judge orders ran for the repaired item');
  assert.deepEqual(judge.map((e) => e.value.order).sort(), [1, 2]);
  const report = computeReport({ sets: ['open'], lines: { open: await readLines(path.join(outDir, 'open.jsonl')) }, judge, sample });
  assert.equal(report.sets.open.judge.notJudged, 0);

  // A further --retry-failed with nothing failed runs no judge call again.
  assert.equal((await run({ retryFailed: true })).code, 0);
  assert.equal((await readLines(path.join(outDir, 'judge.jsonl'))).length, 2, 'judged pairs are not rerun');
});

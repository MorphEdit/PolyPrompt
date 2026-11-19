// #60: after a model switch on --resume, modelUsage is cumulative for the
// session; the answering model must come from this turn's assistant events.
// Also the benchmark report: translation share ≤ 100%, a cost row and the
// GPU load at the start of a run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeRunner } from '../src/claude.js';
import { readEvent } from '../src/stream.js';
import { runBench } from '../src/bench/run.js';
import { COST_LABEL, computeReport, renderReport } from '../src/bench/report.js';
import { GPU_APPS_QUERY, GPU_QUERY, gpuLoad, gpuLoadText } from '../src/bench/gpu.js';
import { readLines } from '../src/bench/results.js';
import { pairedPct } from '../src/bench/stats.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude');
const SCRIPT = path.join(FIXTURES, 'script.mjs');
const BENCH = path.join(FIXTURES, 'bench.mjs');

const CUMULATIVE = { 'claude-opus-5-5': { inputTokens: 900, outputTokens: 400 }, 'claude-fable-5-2': { inputTokens: 10, outputTokens: 3 } };
const assistant = (model, text) => ({
  emit: { type: 'assistant', message: { role: 'assistant', ...(model ? { model } : {}), content: [{ type: 'text', text }] }, session_id: 'sess-1' },
});

async function runScript(t, events, model = 'claude-fable-5-2') {
  const dir = mkdtempSync(path.join(tmpdir(), 'polyprompt-60-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'script.json');
  writeFileSync(script, JSON.stringify([
    { emit: { type: 'system', subtype: 'init', session_id: 'sess-1' } },
    ...events,
    { emit: { type: 'result', subtype: 'success', is_error: false, result: 'two', session_id: 'sess-1', modelUsage: CUMULATIVE } },
  ]));
  process.env.FIXTURE_SCRIPT = script;
  process.env.FIXTURE_LOG = path.join(dir, 'log.json');
  return createClaudeRunner({ command: SCRIPT }).run({ prompt: 'say: two', sessionId: 'sess-1', model });
}

test('#60 answering model comes from this turn, not cumulative modelUsage', async (t) => {
  const res = await runScript(t, [assistant('claude-fable-5-2', 'two')]);
  assert.equal(res.text, 'two');
  assert.equal(res.model, 'claude-fable-5-2');
});

test('#60 the last assistant model of the turn wins; synthetic messages are ignored', async (t) => {
  const res = await runScript(t, [assistant('claude-haiku-5-5', 'one'), assistant('claude-fable-5-2', 'two'), assistant('<synthetic>', 'x')]);
  assert.equal(res.model, 'claude-fable-5-2');
});

test('#60 without a model on any assistant event, modelUsage is the fallback', async (t) => {
  const res = await runScript(t, [assistant(null, 'two')]);
  assert.equal(res.model, 'claude-opus-5-5');
});

test('#60 readEvent returns the assistant message model, or null', () => {
  const ev = (message) => readEvent({ type: 'assistant', message: { content: [], ...message } });
  assert.equal(ev({ model: 'claude-fable-5-2' }).model, 'claude-fable-5-2');
  assert.equal(ev({}).model, null);
  assert.equal(ev({ model: 7 }).model, null);
});

test('#60 translation time is wall-clock per step, so concurrent pieces keep the share ≤ 100%', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'polyprompt-60-bench-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const rules = path.join(dir, 'rules.json');
  process.env.BENCH_CALLS = path.join(dir, 'calls.jsonl');
  process.env.BENCH_RULES = rules;
  // Four lines -> four pieces translated back at once.
  await writeFile(rules, JSON.stringify([{ includes: '(in English)', text: 'First line\nSecond line\nThird line\nAnswer: 13' }]));
  const DELAY = 300;
  const translator = {
    concurrency: 4,
    async translate(text, src, tgt) {
      await new Promise((r) => setTimeout(r, DELAY));
      return tgt === 'en' ? `${text} (in English)` : text.replace('Answer:', 'คำตอบ:');
    },
  };
  const outDir = path.join(dir, 'r1');
  const rows = { mgsm: [{ question: 'เป็ดวางไข่วันละ 16 ฟอง กินไป 3 ฟอง เหลือกี่ฟอง', answer_number: 13 }] };
  const sample = { seed: 1, sets: { mgsm: ['0'] }, skipped: { open: [] } };
  const r = await runBench({
    outDir, run: 'r1', sets: ['mgsm'], sample, rows, command: BENCH, cwd: path.join(dir, 'home'), modelManager: translator,
    machine: { cpu: null, gpu: null, vram: null },
  });
  assert.equal(r.code, 0, r.message);
  const lines = await readLines(path.join(outDir, 'mgsm.jsonl'));
  const b = lines.find((e) => e.value.condition === 'B').value;
  assert.equal(b.finalAnswer, 'First line\nSecond line\nThird line\nคำตอบ: 13');
  assert.ok(b.ms.back >= DELAY - 20, `back ${b.ms.back}`);
  assert.ok(b.ms.back < 2 * DELAY, `four concurrent pieces count once: back ${b.ms.back}`);
  assert.ok(b.ms.forward + b.ms.back <= b.ms.total, `forward ${b.ms.forward} + back ${b.ms.back} > total ${b.ms.total}`);
  const report = computeReport({ sets: ['mgsm'], lines: { mgsm: lines }, sample });
  assert.ok(report.sets.mgsm.time.translationShare <= 1, `share ${report.sets.mgsm.time.translationShare}`);
  assert.ok(report.all.time.translationShare <= 1);
});

const usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, output_tokens: 5 };
const benchLine = (id, condition, totalCostUsd, line) => ({
  value: {
    set: 'mgsm', id, condition, usage, modelUsage: null, totalCostUsd, score: 1, scoreEnglish: condition === 'B' ? 1 : null,
    parsed: '1', parsedEnglish: condition === 'B' ? '1' : null, ms: { total: 1000, forward: 100, back: 100 }, error: null, fallback: null,
  },
  line,
});

test('#60 the token tables have an API-equivalent cost row: Σ totalCostUsd, A vs B, paired % and CI', () => {
  const lines = [
    benchLine('0', 'A', 0.01, 1), benchLine('0', 'B', 0.02, 2),
    benchLine('1', 'A', 0.03, 3), benchLine('1', 'B', 0.01, 4),
    benchLine('2', 'A', 0.02, 5), benchLine('2', 'B', null, 6),
  ];
  const report = computeReport({ sets: ['mgsm'], lines: { mgsm: lines }, sample: { skipped: { open: [] } } });
  const cost = report.sets.mgsm.tokens.cost;
  assert.equal(cost.A.median, 0.02);
  assert.equal(cost.B.median, 0.01);
  assert.equal(cost.pct, pairedPct([{ a: 0.01, b: 0.02 }, { a: 0.03, b: 0.01 }, { a: 0.02, b: 0 }]));
  assert.ok(Array.isArray(cost.ci));
  assert.ok(report.sets.mgsm.tokens.total, 'the token rows stay');
  const md = renderReport({ meta: { run: 'r1', machine: {} }, report, sample: {} });
  const rows = md.split('\n').filter((l) => l.startsWith(`| ${COST_LABEL} |`));
  assert.equal(rows.length, 2, 'one row in the set table and one in the all-sets table');
  assert.match(rows[0], /^\| API-equivalent cost \(USD\) \| 0\.0200 \| 0\.0200 \| 0\.0100 \| 0\.0100 \| -50\.0% \| \[/);
  assert.match(md, /full total \(incl\. cached system prompt\)/);
});

test('#60 the GPU load at start is read from nvidia-smi (best effort) and shown in the setup', async () => {
  const calls = [];
  const exec = async (file, argv) => {
    calls.push([file, argv]);
    if (argv === GPU_QUERY) return '87, 6144\n';
    return '1234, C:\\Games\\game.exe, 4096\r\n5678, python.exe, [N/A]\n';
  };
  const load = await gpuLoad(exec);
  assert.deepEqual(calls, [['nvidia-smi', GPU_QUERY], ['nvidia-smi', GPU_APPS_QUERY]]);
  assert.deepEqual(load, {
    utilizationPct: 87, memoryUsedMiB: 6144,
    processes: [{ pid: 1234, name: 'C:\\Games\\game.exe', memoryMiB: 4096 }, { pid: 5678, name: 'python.exe', memoryMiB: null }],
  });
  assert.equal(await gpuLoad(async () => null), null, 'no nvidia-smi');

  const report = computeReport({ sets: [], lines: {}, sample: { skipped: { open: [] } } });
  const md = (machine) => renderReport({ meta: { run: 'r1', machine }, report, sample: {} });
  assert.ok(md({ gpuLoad: load }).includes('- GPU load at start: utilisation 87%, memory used 6144 MiB; other GPU processes: C:\\Games\\game.exe (pid 1234, 4096 MiB), python.exe (pid 5678, n/a)'));
  assert.ok(md({ gpuLoad: null }).includes('- GPU load at start: n/a (nvidia-smi not available)'));
  assert.ok(md({}).includes('- GPU load at start: not recorded'));
  assert.equal(gpuLoadText({ utilizationPct: 0, memoryUsedMiB: 0, processes: [] }), 'utilisation 0%, memory used 0 MiB; other GPU processes: none');
});

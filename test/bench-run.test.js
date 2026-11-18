// #57: the token benchmark run, end to end with the real runner, the real
// runTurn and language detection, a fake `claude` (fixtures/claude/bench.mjs)
// and a fake translator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_FLAGS, buildArgs } from '../src/claude.js';
import { NOT_TRANSLATED_NOTE, TRANSLATE_FAILED } from '../src/pipeline.js';
import { NotTranslatedError } from '../src/translator.js';
import { JUDGE_PROMPT, PROMPTS } from '../src/bench/prompts.js';
import { abOrder, runBench } from '../src/bench/run.js';
import { mulberry32 } from '../src/bench/rng.js';
import { computeReport } from '../src/bench/report.js';
import { readLines } from '../src/bench/results.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude', 'bench.mjs');

const LINE_KEYS = ['set', 'id', 'condition', 'requestedModel', 'answeringModel', 'prompt', 'answer', 'finalAnswer', 'usage',
  'modelUsage', 'totalCostUsd', 'ms', 'parsed', 'score', 'parsedEnglish', 'scoreEnglish', 'fallback', 'error'];
const META_KEYS = ['run', 'date', 'seed', 'sets', 'model', 'judgeModel', 'translator', 'claudeArgs', 'claudeVersion', 'machine',
  'datasets', 'prompts', 'judgePrompt'];
const JUDGE_KEYS = ['id', 'order', 'judgeModel', 'answeringModel', 'prompt', 'answer', 'verdict', 'usage', 'modelUsage',
  'totalCostUsd', 'ms', 'error'];

const rows = {
  mgsm: [
    { question: 'เป็ดวางไข่วันละ 16 ฟอง กินไป 3 ฟอง เหลือกี่ฟอง', answer_number: 13 },
    { question: 'มีแมว 4 ตัว แต่ละตัวมี 4 ขา รวมกี่ขา', answer_number: 16 },
    { question: 'ซื้อส้ม 2 กิโล กิโลละ 50 บาท จ่ายกี่บาท', answer_number: 100 },
  ],
  belebele: [
    { flores_passage: 'แม่น้ำเจ้าพระยาไหลผ่านกรุงเทพมหานคร', question: 'แม่น้ำใดไหลผ่านกรุงเทพ', mc_answer1: 'เจ้าพระยา', mc_answer2: 'โขง', mc_answer3: 'ปิง', mc_answer4: 'น่าน', correct_answer_num: '1' },
    { flores_passage: 'ช้างเป็นสัตว์ประจำชาติไทย', question: 'สัตว์ประจำชาติไทยคืออะไร', mc_answer1: 'แมว', mc_answer2: 'ช้าง', mc_answer3: 'ม้า', mc_answer4: 'วัว', correct_answer_num: '2' },
  ],
  open: [
    { Instruction: 'เขียนกลอนสั้น ๆ เกี่ยวกับฝน', Input: '', Output: 'ฝนตกพรำพรำ', Task_type: 'Creative writing' },
    { Instruction: 'สรุปข้อความต่อไปนี้', Input: 'วันนี้อากาศดีมาก ผู้คนออกมาเดินเล่นในสวน', Output: 'อากาศดี คนเดินเล่น', Task_type: 'Summarization' },
  ],
};
const sample = { seed: 20261118, sets: { mgsm: ['0', '1', '2'], belebele: ['0', '1'], open: ['0', '1'] }, skipped: { open: [] } };

// Fake translator: forward marks the text, back turns "Answer:" into Thai and
// can change a number, throw (hard failure) or refuse (fallback).
function fakeTranslator() {
  const t = {
    calls: [],
    async translate(text, src, tgt) {
      t.calls.push({ text, src, tgt });
      if (text.includes('ฟองหาย')) throw new Error('model crashed');
      if (text.includes('NOBACK')) throw new NotTranslatedError('kept English');
      if (tgt === 'en') return `${text} (in English)`;
      return text.replace('Answer: 99', 'คำตอบ: 98').replace('Answer:', 'คำตอบ:');
    },
  };
  return t;
}

async function setup(t, rules = []) {
  const dir = await mkdtemp(path.join(tmpdir(), 'polyprompt-bench-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const calls = path.join(dir, 'calls.jsonl');
  const rulesFile = path.join(dir, 'rules.json');
  process.env.BENCH_CALLS = calls;
  process.env.BENCH_RULES = rulesFile;
  const env = {
    dir,
    outDir: path.join(dir, 'results', 'r1'),
    translator: fakeTranslator(),
    setRules: (r) => writeFile(rulesFile, JSON.stringify(r)),
    calls: async () => (await readLines(calls)).map((e) => e.value),
    lines: async (file) => (await readLines(path.join(env.outDir, file))).map((e) => e.value),
    run: (opts = {}) => runBench({
      outDir: env.outDir, run: 'r1', sample, rows, command: FAKE, cwd: path.join(dir, 'home'),
      modelManager: env.translator, claudeVersion: '9.9.9 (Claude Code)', machine: { cpu: 'test cpu', gpu: null, vram: null },
      ...opts,
    }),
  };
  await env.setRules(rules);
  return env;
}

test('#57 a run writes one schema line per item and condition in the seeded A/B order, with --no-session-persistence and no --resume', async (t) => {
  const env = await setup(t, [
    { includes: 'เหลือกี่ฟอง (in English)', text: 'Answer: 13 eggs' },
    { includes: 'เหลือกี่ฟอง', text: 'คิด: 16 - 3 = 13\nคำตอบ: 13 ฟอง' },
    { includes: 'รวมกี่ขา (in English)', text: 'Answer: 99' },
    { includes: 'รวมกี่ขา', text: 'คำตอบ: ๑๖' },
    { includes: 'กิโลละ 50 บาท (in English)', text: 'Answer: 100' },
    { includes: 'กิโลละ 50 บาท', text: 'Answer: 1,000 baht' },
    { includes: 'กรุงเทพ', text: 'คำตอบ: 1' },
    { includes: 'สัตว์ประจำชาติ', text: 'Answer: 2' },
  ]);
  const r = await env.run({ sets: ['mgsm', 'belebele'] });
  assert.deepEqual(r, { code: 0, message: `done: ${env.outDir}` });

  const mgsm = await env.lines('mgsm.jsonl');
  const belebele = await env.lines('belebele.jsonl');
  assert.equal(mgsm.length, 6);
  assert.equal(belebele.length, 4);
  for (const line of [...mgsm, ...belebele]) {
    assert.deepEqual(Object.keys(line).sort(), [...LINE_KEYS].sort());
    assert.deepEqual(Object.keys(line.ms).sort(), ['back', 'claude', 'forward', 'total']);
    assert.equal(line.error, null);
    assert.equal(line.requestedModel, 'claude-opus-5-5');
    assert.equal(line.answeringModel, 'claude-opus-5-5');
    assert.deepEqual(Object.keys(line.usage).sort(), ['cache_creation_input_tokens', 'cache_read_input_tokens', 'input_tokens', 'output_tokens']);
    assert.equal(line.usage.cache_read_input_tokens, 1000);
    assert.equal(line.totalCostUsd, 0.001);
    assert.ok(line.modelUsage['claude-opus-5-5']);
    assert.equal(typeof line.ms.total, 'number');
    assert.equal(typeof line.ms.claude, 'number');
  }

  // Seeded order: one draw per sampled item (full list, ascending) from a fresh generator.
  for (const [set, lines] of [['mgsm', mgsm], ['belebele', belebele]]) {
    const rng = mulberry32(20261118);
    const expected = sample.sets[set].flatMap((id) => (rng() < 0.5 ? [[id, 'A'], [id, 'B']] : [[id, 'B'], [id, 'A']]));
    assert.deepEqual(lines.map((l) => [l.id, l.condition]), expected, set);
    assert.deepEqual([...abOrder(sample.sets[set]).entries()].flatMap(([id, o]) => o.map((c) => [id, c])), expected);
  }

  const get = (lines, id, c) => lines.find((l) => l.id === id && l.condition === c);
  // A: the Thai prompt as is, Thai digits and units parsed.
  const a0 = get(mgsm, '0', 'A');
  assert.equal(a0.prompt, `${rows.mgsm[0].question}\n\nตอบโดยแสดงวิธีคิดสั้น ๆ แล้วจบด้วยบรรทัด "คำตอบ: <ตัวเลข>"`);
  assert.equal(a0.answer, 'คิด: 16 - 3 = 13\nคำตอบ: 13 ฟอง');
  assert.deepEqual([a0.finalAnswer, a0.parsed, a0.score, a0.parsedEnglish, a0.scoreEnglish, a0.fallback], [null, '13', 1, null, null, null]);
  assert.deepEqual([a0.ms.forward, a0.ms.back], [null, null]);
  assert.equal(get(mgsm, '1', 'A').parsed, '16');
  assert.deepEqual([get(mgsm, '2', 'A').parsed, get(mgsm, '2', 'A').score], ['1000', 0]);
  // B: the English text runTurn sent, Claude's English answer and the Thai answer the user sees.
  const b0 = get(mgsm, '0', 'B');
  assert.equal(b0.prompt, `${rows.mgsm[0].question} (in English)\n\nตอบโดยแสดงวิธีคิดสั้น ๆ แล้วจบด้วยบรรทัด "คำตอบ: <ตัวเลข>" (in English)`);
  assert.equal(b0.answer, 'Answer: 13 eggs');
  assert.equal(b0.finalAnswer, 'คำตอบ: 13 eggs');
  assert.deepEqual([b0.parsed, b0.score, b0.parsedEnglish, b0.scoreEnglish], ['13', 1, '13', 1]);
  assert.equal(typeof b0.ms.forward, 'number');
  assert.equal(typeof b0.ms.back, 'number');
  // The English and the Thai answer are parsed and scored apart.
  const b1 = get(mgsm, '1', 'B');
  assert.deepEqual([b1.parsed, b1.score, b1.parsedEnglish, b1.scoreEnglish], ['98', 0, '99', 0]);
  assert.deepEqual([get(belebele, '1', 'B').parsed, get(belebele, '1', 'B').score], ['2', 1]);
  assert.match(get(belebele, '0', 'A').prompt, /\n\n1\. เจ้าพระยา\n2\. โขง\n3\. ปิง\n4\. น่าน\n\nตอบด้วยบรรทัด "คำตอบ: <หมายเลข 1-4>"$/);

  // CLI args: the app's no-folder args plus --no-session-persistence, never --resume.
  const calls = await env.calls();
  assert.equal(calls.length, 10);
  for (const c of calls) {
    assert.deepEqual(c.argv, [...buildArgs(null, 'claude-opus-5-5', null), '--no-session-persistence']);
    assert.equal(c.argv.includes('--resume'), false);
  }

  const meta = JSON.parse(await readFile(path.join(env.outDir, 'meta.json'), 'utf8'));
  assert.deepEqual(Object.keys(meta).sort(), [...META_KEYS].sort());
  assert.equal(meta.run, 'r1');
  assert.equal(meta.seed, 20261118);
  assert.deepEqual(meta.sets, ['mgsm', 'belebele']);
  assert.deepEqual(meta.claudeArgs, calls[0].argv);
  assert.equal(meta.claudeVersion, '9.9.9 (Claude Code)');
  assert.deepEqual(meta.machine, { cpu: 'test cpu', gpu: null, vram: null });
  assert.equal(meta.datasets.mgsm.rev, 'b2f13d426afe3be8d69a7e739b36724db8b66bbc');
  assert.deepEqual(meta.prompts, { mgsm: PROMPTS.mgsm, belebele: PROMPTS.belebele });
  assert.equal(meta.judgePrompt, JUDGE_PROMPT);
  assert.ok(!Number.isNaN(Date.parse(meta.date)));

  // A rerun with the same --run makes no new calls and writes nothing.
  assert.equal((await env.run({ sets: ['mgsm', 'belebele'] })).code, 0);
  assert.equal((await env.calls()).length, 10);
  assert.equal((await env.lines('mgsm.jsonl')).length, 6);
});

test('#57 --limit takes the first N sampled IDs per set and keeps the full-list A/B order', async (t) => {
  const env = await setup(t);
  await env.run({ sets: ['mgsm', 'belebele'], limit: 1 });
  const ids = [...(await env.lines('mgsm.jsonl')), ...(await env.lines('belebele.jsonl'))].map((l) => `${l.id}${l.condition}`);
  const first = (set) => abOrder(sample.sets[set]).get('0').map((c) => `0${c}`);
  assert.deepEqual(ids, [...first('mgsm'), ...first('belebele')]);
});

test('#57 a Claude error or a hard B translation failure is an error line, left out of the pairs, and --retry-failed reruns only those', async (t) => {
  // Item 0's back translation fails hard ("ฟองหาย" in the answer); item 1's Claude call fails in A and B.
  const env = await setup(t, [
    { includes: 'รวมกี่ขา', text: 'boom', error: true },
    { includes: 'เหลือกี่ฟอง (in English)', text: 'Answer: 13 ฟองหาย' },
    { includes: 'เหลือกี่ฟอง', text: 'คำตอบ: 13' },
    { includes: 'กิโลละ', text: 'Answer: 100' },
  ]);
  await env.run({ sets: ['mgsm'] });
  let lines = await env.lines('mgsm.jsonl');
  assert.equal(lines.length, 6);
  const get = (id, c) => lines.filter((l) => l.id === id && l.condition === c).at(-1);
  const failedB = get('0', 'B');
  assert.deepEqual(failedB.error, { kind: 'translate_failed', message: TRANSLATE_FAILED });
  assert.equal(failedB.usage.cache_read_input_tokens, 1000, 'usage Claude returned is kept');
  assert.deepEqual([failedB.score, failedB.parsed, failedB.scoreEnglish], [null, null, null]);
  for (const c of ['A', 'B']) {
    assert.equal(get('1', c).error.kind, 'failed');
    assert.notEqual(get('1', c).error.message, TRANSLATE_FAILED);
    assert.equal(get('1', c).usage.input_tokens > 0, true, 'usage of the failed result');
  }
  let report = computeReport({ sets: ['mgsm'], lines: { mgsm: await readLines(path.join(env.outDir, 'mgsm.jsonl')) }, sample });
  assert.equal(report.sets.mgsm.n, 1, 'only item 2 is a pair');
  assert.deepEqual(report.failures.errors.map((e) => `${e.id}${e.condition}:${e.kind}`).sort(), ['0B:translate_failed', '1A:failed', '1B:failed']);

  // A plain rerun skips error lines too.
  const before = (await env.calls()).length;
  await env.run({ sets: ['mgsm'] });
  assert.equal((await env.calls()).length, before);

  // --retry-failed: only the pairs whose last line is an error, appended, in the seeded order.
  await env.setRules([
    { includes: 'รวมกี่ขา', text: 'คำตอบ: 16' },
    { includes: 'เหลือกี่ฟอง (in English)', text: 'Answer: 13' },
    { includes: 'กิโลละ', text: 'Answer: 100' },
  ]);
  await env.run({ sets: ['mgsm'], retryFailed: true });
  const retried = (await env.calls()).slice(before);
  assert.equal(retried.length, 3);
  lines = await env.lines('mgsm.jsonl');
  assert.equal(lines.length, 9);
  const order1 = abOrder(sample.sets.mgsm).get('1');
  assert.deepEqual(lines.slice(6).map((l) => `${l.id}${l.condition}`), ['0B', ...order1.map((c) => `1${c}`)]);
  assert.equal(get('0', 'B').error, null);
  report = computeReport({ sets: ['mgsm'], lines: { mgsm: await readLines(path.join(env.outDir, 'mgsm.jsonl')) }, sample });
  assert.equal(report.sets.mgsm.n, 3, 'the last line per pair wins');
  assert.deepEqual(report.failures.errors, []);

  // Nothing left to retry.
  await env.run({ sets: ['mgsm'], retryFailed: true });
  assert.equal((await env.calls()).length, before + 3);
});

test('#57 a translator fallback keeps the item and flags it', async (t) => {
  const env = await setup(t, [{ includes: 'เหลือกี่ฟอง', text: 'NOBACK Answer: 13' }]);
  await env.run({ sets: ['mgsm'], limit: 1 });
  const b = (await env.lines('mgsm.jsonl')).find((l) => l.condition === 'B');
  assert.equal(b.error, null);
  assert.equal(b.fallback.includes('แปลคำตอบไม่สำเร็จ'), true);
  assert.equal(b.finalAnswer, 'NOBACK Answer: 13');
  assert.deepEqual([b.score, b.scoreEnglish], [1, 1]);
  assert.notEqual(b.fallback, NOT_TRANSLATED_NOTE);
});

test('#57 an exhausted quota writes no line, starts nothing new, exits 2 and a rerun resumes', async (t) => {
  const env = await setup(t, [{ includes: 'รวมกี่ขา', stderr: 'Claude AI usage limit reached. Your limit will reset at 5pm.', exit: 1 }]);
  const r = await env.run({ sets: ['mgsm', 'belebele'] });
  assert.equal(r.code, 2);
  assert.match(r.message, /same --run r1/);
  const lines = await env.lines('mgsm.jsonl');
  assert.deepEqual(lines.map((l) => l.id), ['0', '0'], 'item 1 got no line, item 2 never started');
  const calls = await env.calls();
  assert.equal(calls.length, 3, 'two calls for item 0 and the one that hit the quota');
  assert.deepEqual(await env.lines('belebele.jsonl'), [], 'no later set started');

  await env.setRules([]);
  assert.equal((await env.run({ sets: ['mgsm', 'belebele'] })).code, 0);
  const after = await env.lines('mgsm.jsonl');
  assert.deepEqual(after.map((l) => l.id), ['0', '0', '1', '1', '2', '2']);
  assert.equal((await env.lines('belebele.jsonl')).length, 4);
  assert.equal((await env.calls()).length, 3 + 8);
});

test('#57 a quota hit in B (seen by the runner wrapper) also writes no line', async (t) => {
  const env = await setup(t, [{ includes: '(in English)', text: 'rate limit exceeded', error: true }]);
  const r = await env.run({ sets: ['mgsm'], limit: 1 });
  assert.equal(r.code, 2);
  const lines = await env.lines('mgsm.jsonl');
  assert.equal(lines.every((l) => l.condition === 'A'), true);
});

test('#57 a --model or --judge-model outside MODEL_FLAGS stops before any call', async (t) => {
  const env = await setup(t);
  for (const opts of [{ model: 'default' }, { model: 'claude-opus-4' }, { judgeModel: 'opus' }]) {
    const r = await env.run(opts);
    assert.equal(r.code, 1);
    for (const id of MODEL_FLAGS) assert.match(r.message, new RegExp(id));
  }
  assert.deepEqual(await env.calls(), []);
  await assert.rejects(readFile(path.join(env.outDir, 'meta.json')), { code: 'ENOENT' });
});

test('#57 the judge runs both orders blind, logs its own usage and counts a failed or unparseable verdict as a judge failure', async (t) => {
  const env = await setup(t, [
    // Judge calls (they contain the judge template), by item and order.
    { includes: 'คำตอบ 1\nกลอน A', text: 'คิดแล้ว {"winner": 1, "reason": "ไพเราะกว่า"}' },
    { includes: 'คำตอบ 1\nกลอน B', text: '{"winner": 2, "reason": "ไพเราะกว่า"}' },
    { includes: 'คำตอบ 1\nสรุป A', text: 'ไม่แน่ใจ' },
    { includes: 'คำตอบ 1\nสรุป B', text: '{"winner": "tie", "reason": "พอ ๆ กัน"}' },
    // Conditions.
    { includes: 'ฝน (in English)', text: 'กลอน B' },
    { includes: 'ฝน', text: 'กลอน A' },
    { includes: 'สรุป', text: 'สรุป A' },
  ]);
  // In B, item 1's answer "สรุป A" comes back unchanged, so make it different.
  env.translator.translate = async (text, src, tgt) => (tgt === 'en' ? `${text} (in English)` : text.replace('สรุป A', 'สรุป B'));
  const r = await env.run({ sets: ['open'], judgeModel: 'claude-sonnet-5-5' });
  assert.equal(r.code, 0);
  const open = await env.lines('open.jsonl');
  for (const l of open) assert.deepEqual([l.parsed, l.score, l.parsedEnglish, l.scoreEnglish], [null, null, null, null]);
  assert.equal(open.find((l) => l.id === '1' && l.condition === 'A').prompt, 'สรุปข้อความต่อไปนี้\n\nวันนี้อากาศดีมาก ผู้คนออกมาเดินเล่นในสวน');

  const judge = await env.lines('judge.jsonl');
  assert.equal(judge.length, 4);
  for (const j of judge) {
    assert.deepEqual(Object.keys(j).sort(), [...JUDGE_KEYS].sort());
    assert.equal(j.judgeModel, 'claude-sonnet-5-5');
    assert.equal(j.answeringModel, 'claude-sonnet-5-5');
    assert.equal(j.usage.cache_read_input_tokens, 1000);
    assert.doesNotMatch(j.prompt, /PolyPrompt|direct/i, 'blind');
    assert.match(j.prompt, /ฝนตกพรำพรำ|อากาศดี คนเดินเล่น/, 'the human reference');
  }
  const j = (id, order) => judge.find((x) => x.id === id && x.order === order);
  assert.match(j('0', 1).prompt, /### คำตอบ 1\nกลอน A\n\n### คำตอบ 2\nกลอน B/);
  assert.match(j('0', 2).prompt, /### คำตอบ 1\nกลอน B\n\n### คำตอบ 2\nกลอน A/);
  assert.deepEqual(j('0', 1).verdict, { winner: 1, reason: 'ไพเราะกว่า' });
  assert.equal(j('1', 1).verdict, null);

  const report = computeReport({
    sets: ['open'], lines: { open: await readLines(path.join(env.outDir, 'open.jsonl')) },
    judge: await readLines(path.join(env.outDir, 'judge.jsonl')), sample,
  });
  const s = report.sets.open.judge;
  assert.deepEqual([s.A, s.B, s.tie, s.failures.length], [1, 0, 0, 1], 'item 0: A in both orders; item 1: unparseable, not a tie');
  assert.deepEqual(report.failures.judge[0].reasons, ['unparseable']);
  // The judge's tokens stay out of the A/B totals.
  assert.equal(report.sets.open.n, 2);

  // Rerun: nothing new; --retry-failed does not rerun an unparseable (non-error) verdict.
  const n = (await env.calls()).length;
  await env.run({ sets: ['open'], judgeModel: 'claude-sonnet-5-5' });
  await env.run({ sets: ['open'], judgeModel: 'claude-sonnet-5-5', retryFailed: true });
  assert.equal((await env.calls()).length, n);
});

test('#57 an errored judge call is a judge failure and --retry-failed reruns it', async (t) => {
  const env = await setup(t, [
    { includes: '### คำตอบ 1', text: 'judge exploded', error: true },
    { includes: 'ฝน (in English)', text: 'กลอน B' },
    { includes: 'ฝน', text: 'กลอน A' },
  ]);
  await env.run({ sets: ['open'], limit: 1 });
  const read = async () => computeReport({
    sets: ['open'], lines: { open: await readLines(path.join(env.outDir, 'open.jsonl')) },
    judge: await readLines(path.join(env.outDir, 'judge.jsonl')), sample,
  });
  let s = (await read()).sets.open.judge;
  assert.deepEqual([s.A, s.B, s.tie, s.failures.length], [0, 0, 0, 1]);
  assert.deepEqual(s.failures[0].reasons, ['failed', 'failed']);

  // Order 1 says A (winner 1), order 2 says A (winner 2): an agreeing win for A.
  await env.setRules([
    { includes: '### คำตอบ 1\nกลอน A', text: '{"winner": 1, "reason": "x"}' },
    { includes: '### คำตอบ 1\nกลอน B', text: '{"winner": 2, "reason": "x"}' },
  ]);
  await env.run({ sets: ['open'], limit: 1, retryFailed: true });
  assert.equal((await env.lines('judge.jsonl')).length, 4);
  s = (await read()).sets.open.judge;
  assert.deepEqual([s.A, s.B, s.tie, s.failures.length], [1, 0, 0, 0]);
});

test('#57 npm run bench:tokens with a model outside MODEL_FLAGS exits non-zero before loading anything', async () => {
  const { execFile } = await import('node:child_process');
  const script = path.join(path.dirname(FAKE), '..', '..', 'scripts', 'bench-tokens.js');
  for (const args of [['--model', 'default'], ['--judge-model', 'claude-3-opus']]) {
    const out = await new Promise((resolve) => {
      execFile(process.execPath, [script, ...args], (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
    });
    assert.equal(out.code, 1, args.join(' '));
    for (const id of MODEL_FLAGS) assert.match(out.stderr, new RegExp(id));
    assert.equal(out.stdout, '');
  }
});

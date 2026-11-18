// #57: the report built from result lines: pairs, last line wins, tokens,
// quality (A vs B-Thai and A vs B-English), time, judge and failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LIMITATIONS, computeReport, renderReport, tokensOf, writeReport } from '../src/bench/report.js';
import { bootstrapCI, mcnemar, wilson } from '../src/bench/stats.js';

const usage = (input, write, read, output) => ({
  input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output,
});
let n = 0;
const line = (set, id, condition, { u = usage(10, 0, 100, 5), score = 1, scoreEnglish = condition === 'B' ? score : null, ms = 1000, fwd = 100, back = 100, error = null, fallback = null, parsed } = {}) => ({
  value: {
    set, id, condition, requestedModel: 'claude-opus-5-5', answeringModel: 'claude-opus-5-5', prompt: 'p', answer: 'a',
    finalAnswer: condition === 'B' ? 'a' : null, usage: u, modelUsage: null, totalCostUsd: null,
    ms: { claude: ms, forward: condition === 'B' ? fwd : null, back: condition === 'B' ? back : null, total: ms },
    parsed: parsed !== undefined ? parsed : error ? null : String(score), score: error ? null : score,
    parsedEnglish: condition === 'B' && !error ? String(scoreEnglish) : null, scoreEnglish: error ? null : scoreEnglish,
    fallback, error,
  },
  line: ++n,
});

// mgsm: 5 items. Item 4's B failed first, then was retried (last line wins).
function mgsmLines() {
  n = 0;
  return [
    line('mgsm', '0', 'A', { u: usage(100, 0, 1000, 50), score: 1, ms: 2000 }),
    line('mgsm', '0', 'B', { u: usage(40, 0, 1000, 30), score: 0, scoreEnglish: 1, ms: 4000, fwd: 500, back: 500 }),
    line('mgsm', '1', 'B', { u: usage(50, 10, 1000, 20), score: 1, ms: 3000, fwd: 300, back: 300 }),
    line('mgsm', '1', 'A', { u: usage(120, 10, 1000, 60), score: 1, ms: 1000 }),
    line('mgsm', '2', 'A', { u: usage(80, 0, 1000, 40), score: 0, ms: 3000 }),
    line('mgsm', '2', 'B', { u: usage(30, 0, 1000, 10), score: 1, scoreEnglish: 1, ms: 5000, fwd: 1000, back: 1000, fallback: 'note' }),
    line('mgsm', '3', 'A', { u: usage(90, 0, 1000, 40), score: 1, ms: 1000, parsed: '7' }),
    line('mgsm', '3', 'B', { error: { kind: 'failed', message: 'boom' }, u: null }),
    line('mgsm', '4', 'A', { u: usage(100, 0, 1000, 50), score: 1, ms: 2000 }),
    line('mgsm', '4', 'B', { error: { kind: 'translate_failed', message: 'x' } }),
    line('mgsm', '4', 'B', { u: usage(60, 0, 1000, 40), score: 0, scoreEnglish: 0, ms: 6000, fwd: 0, back: 0, parsed: null }),
  ];
}

test('#57 tokens of a line: uncached, cache write, cache read, output, message and total', () => {
  assert.deepEqual(tokensOf({ usage: usage(10, 20, 300, 4) }), { uncached: 10, cacheWrite: 20, cacheRead: 300, output: 4, message: 14, total: 334 });
  assert.deepEqual(tokensOf({ usage: null }), { uncached: 0, cacheWrite: 0, cacheRead: 0, output: 0, message: 0, total: 0 });
});

test('#57 the report counts only items whose last A and last B lines are non-error, and the math matches the definitions', () => {
  const r = computeReport({ sets: ['mgsm'], lines: { mgsm: mgsmLines() }, sample: { skipped: { open: [{ id: '9', reason: 'too_long' }] } } });
  const s = r.sets.mgsm;
  assert.equal(s.n, 4, 'items 0, 1, 2 and 4 (retried); item 3 has an error');

  // Message tokens: A = 150, 180, 120, 150 (Σ600); B = 70, 70, 40, 100 (Σ280).
  const msg = s.tokens.message;
  assert.equal(msg.A.median, 150);
  assert.equal(msg.A.mean, 150);
  assert.equal(msg.B.median, 70);
  assert.equal(msg.B.mean, 70);
  assert.equal(msg.pct, (100 * (280 - 600)) / 600);
  assert.deepEqual(msg.ci, bootstrapCI([{ a: 150, b: 70 }, { a: 180, b: 70 }, { a: 120, b: 40 }, { a: 150, b: 100 }]));
  // Full total adds the cache: A Σ = 600 + 10 + 4000, B Σ = 280 + 10 + 4000.
  assert.equal(s.tokens.total.pct, (100 * (4290 - 4610)) / 4610);
  assert.equal(s.tokens.cacheRead.pct, 0);
  assert.equal(s.tokens.uncached.A.median, 100);

  // Quality: A = 1,1,0,1 (3/4); B-Thai = 0,1,1,0 (2/4); B-English = 1,1,1,0 (3/4).
  const q = s.quality;
  assert.deepEqual([q.A.k, q.BThai.k, q.BEnglish.k, q.A.n], [3, 2, 3, 4]);
  assert.deepEqual(q.A.ci, wilson(3, 4));
  // A vs B-Thai: b = items 0 and 4, c = item 2. A vs B-English: b = item 4, c = item 2.
  assert.deepEqual(q.mcnemarThai, mcnemar(2, 1));
  assert.deepEqual(q.mcnemarEnglish, mcnemar(1, 1));
  assert.equal(q.mcnemarThai.p, 1);

  // Time: A totals 2,1,3,2 s -> median 2; B 4,3,5,6 s -> 4.5; translation share = 3600 / 18000.
  assert.equal(s.time.A, 2);
  assert.equal(s.time.B, 4.5);
  assert.equal(s.time.translationShare, 3600 / 18000);

  // Failures, with their line numbers.
  assert.deepEqual(r.failures.errors.map((e) => [e.id, e.condition, e.kind, e.line]), [['3', 'B', 'failed', 8]]);
  assert.deepEqual(r.failures.fallbacks.map((e) => [e.id, e.line]), [['2', 6]]);
  assert.deepEqual(r.failures.unparseable.map((e) => [e.id, e.which, e.line]), [['4', 'B-Thai', 11]]);
  assert.equal(r.failures.skipped.length, 1);
});

test('#57 judge outcomes: agreeing wins, ties, failures (not ties) and items not judged yet', () => {
  n = 0;
  const open = ['0', '1', '2', '3', '4'].flatMap((id) => [line('open', id, 'A', { score: null }), line('open', id, 'B', { score: null })]);
  let k = 0;
  const j = (id, order, winner, error = null) => ({
    value: { id, order, verdict: winner == null ? null : { winner, reason: '' }, error, usage: usage(1, 2, 3, 4) }, line: ++k,
  });
  const judge = [
    j('0', 1, 1), j('0', 2, 2), // A both times
    j('1', 1, 2), j('1', 2, 1), // B both times
    j('2', 1, 1), j('2', 2, 1), // position bias -> tie
    j('3', 1, 1), j('3', 2, null, { kind: 'failed', message: 'x' }), // failure
    j('4', 1, 'tie'), // order 2 missing -> not judged
    j('3', 1, 1), // a later line for 3/1 (still a failure through order 2)
  ];
  const r = computeReport({ sets: ['open'], lines: { open }, judge, sample: { skipped: { open: [] } } });
  const s = r.sets.open.judge;
  assert.deepEqual([s.A, s.B, s.tie, s.failures.length, s.notJudged], [1, 1, 1, 1, 1]);
  assert.deepEqual(r.failures.judge, [{ id: '3', lines: [8], reasons: ['failed'] }]);
  assert.equal(r.sets.open.quality, undefined, 'open is judged, not scored');
  // Judge tokens are not in the A/B totals.
  assert.equal(r.sets.open.tokens.total.A.mean, 115);
});

test('#57 REPORT.md has every section, the prompts, the setup and links to raw lines', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'polyprompt-report-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const meta = {
    run: 'r1', date: '2026-11-18T12:00:00.000Z', seed: 20261118, sets: ['mgsm'], model: 'claude-opus-5-5', judgeModel: 'claude-opus-5-5',
    translator: '4b', claudeArgs: ['-p', '--no-session-persistence'], claudeVersion: '2.1.300 (Claude Code)',
    machine: { cpu: 'Ryzen', gpu: 'RTX 4070', vram: '12282 MiB' },
    datasets: { mgsm: { repo: 'juletxara/mgsm', rev: 'b2f1', files: ['th/test-00000-of-00001.parquet'] } },
    prompts: { mgsm: '{question}\n\nตอบโดย' }, judgePrompt: 'JUDGE TEMPLATE',
  };
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
  await writeFile(path.join(dir, 'mgsm.jsonl'), mgsmLines().map((l) => JSON.stringify(l.value)).join('\n') + '\n{"broken');
  const file = await writeReport(dir, { seed: 20261118, skipped: { open: [{ id: '9', reason: 'too_long' }] } });
  const md = await readFile(file, 'utf8');
  for (const h of ['## Tokens', '## Quality', '## Time', '## Failures', '## Setup', '## Limitations']) assert.match(md, new RegExp(`^${h}$`, 'm'));
  assert.match(md, /message tokens only \(uncached input \+ output\)/);
  assert.match(md, /full total \(incl\. cached system prompt\)/);
  assert.match(md, /\| mgsm \| A vs B-Thai \| 2 \| 1 \| 1\.000 \|/);
  assert.match(md, /\| mgsm \| A vs B-English \| 1 \| 1 \| 1\.000 \|/);
  assert.match(md, /\| mgsm \| 4 \| 75\.0% \(3\/4\) \|/);
  assert.match(md, /\[mgsm\.jsonl:8\]\(mgsm\.jsonl#L8\)/);
  assert.match(md, /RTX 4070/);
  assert.match(md, /2\.1\.300 \(Claude Code\)/);
  assert.match(md, /juletxara\/mgsm` rev `b2f1`/);
  assert.match(md, /JUDGE TEMPLATE/);
  assert.match(md, /ตอบโดย/);
  assert.match(md, /too_long: 1/);
  for (const l of LIMITATIONS) assert.ok(md.includes(l));
  assert.equal(renderReport({ meta, report: computeReport({ sets: ['mgsm'], lines: { mgsm: [] }, sample: {} }) }).includes('n/a'), true);
});

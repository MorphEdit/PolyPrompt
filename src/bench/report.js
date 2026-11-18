// REPORT.md of a benchmark run, from meta.json and the result lines. The
// numbers come from computeReport (tested); renderReport only formats them.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isErrorLine, judgeKey, lastBy, pairKey, readLines } from './results.js';
import { gpuLoadText } from './gpu.js';
import { judgeOutcome } from './judge.js';
import { SCORED } from './run.js';
import { bootstrapCI, discordant, mcnemar, mean, median, pairedPct, wilson } from './stats.js';

const n0 = (v) => (typeof v === 'number' ? v : 0);

// Token figures of one line.
export function tokensOf(line) {
  const u = line.usage ?? {};
  const uncached = n0(u.input_tokens);
  const cacheWrite = n0(u.cache_creation_input_tokens);
  const cacheRead = n0(u.cache_read_input_tokens);
  const output = n0(u.output_tokens);
  return { uncached, cacheWrite, cacheRead, output, message: uncached + output, total: uncached + cacheWrite + cacheRead + output };
}

export const TOKEN_METRICS = [
  ['uncached', 'input: uncached'],
  ['cacheWrite', 'input: cache write'],
  ['cacheRead', 'input: cache read'],
  ['output', 'output'],
  ['message', 'message tokens only (uncached input + output)'],
  ['total', 'full total (incl. cached system prompt)'],
];

// A/B pairs of a set: ids whose last A line and last B line are both non-error.
export function pairsOf(entries) {
  const last = lastBy(entries, pairKey);
  const ids = [...new Set(entries.map((e) => e.value.id))].sort((a, b) => Number(a) - Number(b));
  const pairs = [];
  for (const id of ids) {
    const A = last.get(`${id}\u0000A`)?.value;
    const B = last.get(`${id}\u0000B`)?.value;
    if (A && B && !isErrorLine(A) && !isErrorLine(B)) pairs.push({ id, A, B });
  }
  return { pairs, last };
}

// Raw token sums weigh a cache read like an output token; the cost (the
// result's total_cost_usd) weighs them as billed.
export const COST_LABEL = 'API-equivalent cost (USD)';

function pairStats(p) {
  return {
    A: { median: median(p.map((x) => x.a)), mean: mean(p.map((x) => x.a)) },
    B: { median: median(p.map((x) => x.b)), mean: mean(p.map((x) => x.b)) },
    pct: pairedPct(p),
    ci: bootstrapCI(p),
  };
}

export function tokenStats(pairs) {
  const out = Object.fromEntries(TOKEN_METRICS.map(([key]) => [key, pairStats(pairs.map(({ A, B }) => ({ a: tokensOf(A)[key], b: tokensOf(B)[key] })))]));
  out.cost = pairStats(pairs.map(({ A, B }) => ({ a: n0(A.totalCostUsd), b: n0(B.totalCostUsd) })));
  return out;
}

export function qualityStats(pairs) {
  const n = pairs.length;
  const acc = (k) => ({ k, n, rate: n ? k / n : null, ci: wilson(k, n) });
  const sum = (f) => pairs.reduce((s, p) => s + (f(p) === 1 ? 1 : 0), 0);
  const thai = discordant(pairs.map((p) => ({ a: p.A.score, b: p.B.score })));
  const english = discordant(pairs.map((p) => ({ a: p.A.score, b: p.B.scoreEnglish })));
  return {
    A: acc(sum((p) => p.A.score)),
    BThai: acc(sum((p) => p.B.score)),
    BEnglish: acc(sum((p) => p.B.scoreEnglish)),
    mcnemarThai: mcnemar(thai.b, thai.c),
    mcnemarEnglish: mcnemar(english.b, english.c),
  };
}

export function timeStats(pairs) {
  const sumTotal = pairs.reduce((s, p) => s + n0(p.B.ms?.total), 0);
  const sumTranslate = pairs.reduce((s, p) => s + n0(p.B.ms?.forward) + n0(p.B.ms?.back), 0);
  return {
    A: median(pairs.map((p) => n0(p.A.ms?.total) / 1000)),
    B: median(pairs.map((p) => n0(p.B.ms?.total) / 1000)),
    translationShare: sumTotal ? sumTranslate / sumTotal : null,
  };
}

// Judge outcome per open pair, from the last judge line of each order.
export function judgeStats(pairs, judgeEntries) {
  const last = lastBy(judgeEntries, judgeKey);
  const out = { A: 0, B: 0, tie: 0, failures: [], notJudged: 0 };
  for (const { id } of pairs) {
    const j1 = last.get(`${id}\u00001`);
    const j2 = last.get(`${id}\u00002`);
    if (!j1 || !j2) {
      out.notJudged++;
      continue;
    }
    const bad = [j1, j2].filter((j) => isErrorLine(j.value) || !j.value.verdict);
    if (bad.length) {
      out.failures.push({ id, lines: bad.map((j) => j.line), reasons: bad.map((j) => (j.value.error ? j.value.error.kind : 'unparseable')) });
      continue;
    }
    out[judgeOutcome(j1.value.verdict.winner, j2.value.verdict.winner)]++;
  }
  return out;
}

// lines: { <set>: [{ value, line }] }, judge: [{ value, line }], sample: sample.json.
export function computeReport({ sets, lines, judge = [], sample }) {
  const out = { sets: {}, all: null, failures: { errors: [], fallbacks: [], unparseable: [], judge: [], skipped: sample?.skipped?.open ?? [] } };
  const allPairs = [];
  for (const set of sets) {
    const entries = lines[set] ?? [];
    const { pairs, last } = pairsOf(entries);
    allPairs.push(...pairs);
    const s = { n: pairs.length, tokens: tokenStats(pairs), time: timeStats(pairs) };
    if (SCORED.includes(set)) s.quality = qualityStats(pairs);
    if (set === 'open') {
      s.judge = judgeStats(pairs, judge);
      out.failures.judge.push(...s.judge.failures);
    }
    out.sets[set] = s;
    for (const e of [...last.values()].sort((a, b) => a.line - b.line)) {
      const v = e.value;
      const ref = { set, id: v.id, condition: v.condition, line: e.line };
      if (isErrorLine(v)) out.failures.errors.push({ ...ref, kind: v.error.kind, message: v.error.message });
      else {
        if (v.fallback) out.failures.fallbacks.push({ ...ref, note: v.fallback });
        if (SCORED.includes(set) && v.parsed === null) out.failures.unparseable.push({ ...ref, which: v.condition === 'B' ? 'B-Thai' : 'A' });
        if (SCORED.includes(set) && v.condition === 'B' && v.parsedEnglish === null) out.failures.unparseable.push({ ...ref, which: 'B-English' });
      }
    }
  }
  out.all = { n: allPairs.length, tokens: tokenStats(allPairs), time: timeStats(allPairs) };
  return out;
}

const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? 'n/a' : v.toFixed(d));
const pct = (v) => (v === null ? 'n/a' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const ci = (c, f = pct) => (c ? `[${f(c[0])}, ${f(c[1])}]` : 'n/a');
const rate = (a) => (a.rate === null ? 'n/a' : `${(100 * a.rate).toFixed(1)}% (${a.k}/${a.n})`);
const rateCi = (a) => ci(a.ci, (x) => `${(100 * x).toFixed(1)}%`);
const pval = (p) => (p >= 0.001 ? p.toFixed(3) : p.toExponential(2));
const link = (file, line) => `[${file}:${line}](${file}#L${line})`;
const block = (text) => ['```text', text, '```'].join('\n');

function tokenTable(t) {
  const rows = ['| tokens per item | A median | A mean | B median | B mean | B vs A (Σ) | 95% CI |', '|---|---:|---:|---:|---:|---:|---|'];
  for (const [key, label, d] of [...TOKEN_METRICS, ['cost', COST_LABEL, 4]]) {
    const m = t[key];
    rows.push(`| ${label} | ${fmt(m.A.median, d)} | ${fmt(m.A.mean, d)} | ${fmt(m.B.median, d)} | ${fmt(m.B.mean, d)} | ${pct(m.pct)} | ${ci(m.ci)} |`);
  }
  return rows.join('\n');
}

export const LIMITATIONS = [
  'The judge for the `open` set is Claude itself, so it may prefer answers written the way Claude writes.',
  'Token counts depend on the Claude Code version and its system prompt; the cached system prompt dominates the full total.',
  'Only Thai is tested. Other languages may translate better or worse.',
  'All results are for one Claude model (see Setup); other models may differ.',
  'The `open` sample is n=100 (fewer if items failed), so its judge counts have wide uncertainty.',
];

export function renderReport({ meta, report, sample }) {
  const out = [`# Token benchmark: ${meta.run}`, ''];
  out.push('A = Thai sent to Claude as typed. B = PolyPrompt (Thai → English → Claude → Thai). '
    + 'Only items whose last A line and last B line are both non-error count as pairs. '
    + '"B vs A (Σ)" is 100 × (ΣB − ΣA) / ΣA over the pairs (negative = B uses fewer tokens); CIs are 95% seeded bootstrap (10,000 resamples).', '');

  out.push('## Tokens', '');
  for (const [set, s] of Object.entries(report.sets)) out.push(`### ${set} (${s.n} pairs)`, '', tokenTable(s.tokens), '');
  out.push(`### all sets (${report.all.n} pairs)`, '', tokenTable(report.all.tokens), '');

  out.push('## Quality', '');
  const scored = Object.entries(report.sets).filter(([, s]) => s.quality);
  if (scored.length) {
    out.push('| set | pairs | A | 95% CI | B-Thai | 95% CI | B-English | 95% CI |', '|---|---:|---:|---|---:|---|---:|---|');
    for (const [set, s] of scored) {
      const q = s.quality;
      out.push(`| ${set} | ${s.n} | ${rate(q.A)} | ${rateCi(q.A)} | ${rate(q.BThai)} | ${rateCi(q.BThai)} | ${rate(q.BEnglish)} | ${rateCi(q.BEnglish)} |`);
    }
    out.push('', 'McNemar (exact, two-sided): b = A right / B wrong, c = A wrong / B right.', '');
    out.push('| set | comparison | b | c | p |', '|---|---|---:|---:|---:|');
    for (const [set, s] of scored) {
      for (const [label, m] of [['A vs B-Thai', s.quality.mcnemarThai], ['A vs B-English', s.quality.mcnemarEnglish]]) {
        out.push(`| ${set} | ${label} | ${m.b} | ${m.c} | ${pval(m.p)} |`);
      }
    }
    out.push('');
  }
  const open = report.sets.open;
  if (open) {
    const j = open.judge;
    out.push(`Judge on \`open\` (${open.n} pairs, both orders must agree for a win): A wins ${j.A}, B wins ${j.B}, ties ${j.tie}, judge failures ${j.failures.length}, not judged yet ${j.notJudged}.`, '');
  }

  out.push('## Time', '', '| set | A median (s) | B median (s) | B translation share |', '|---|---:|---:|---:|');
  for (const [set, s] of [...Object.entries(report.sets), ['all sets', report.all]]) {
    const share = s.time.translationShare === null ? 'n/a' : `${(100 * s.time.translationShare).toFixed(1)}%`;
    out.push(`| ${set} | ${fmt(s.time.A, 2)} | ${fmt(s.time.B, 2)} | ${share} |`);
  }
  out.push('');

  const f = report.failures;
  out.push('## Failures', '');
  out.push(`- errors (not counted as pairs): ${f.errors.length}`);
  for (const e of f.errors) out.push(`  - ${e.set} ${e.id} ${e.condition}: \`${e.kind}\` ${e.message} — ${link(`${e.set}.jsonl`, e.line)}`);
  out.push(`- translation fallbacks (kept): ${f.fallbacks.length}`);
  for (const e of f.fallbacks) out.push(`  - ${e.set} ${e.id} ${e.condition}: ${e.note} — ${link(`${e.set}.jsonl`, e.line)}`);
  out.push(`- unparseable answers (scored 0): ${f.unparseable.length}`);
  for (const e of f.unparseable) out.push(`  - ${e.set} ${e.id} ${e.which} — ${link(`${e.set}.jsonl`, e.line)}`);
  out.push(`- judge failures: ${f.judge.length}`);
  for (const e of f.judge) out.push(`  - open ${e.id}: ${e.reasons.join(', ')} — ${e.lines.map((l) => link('judge.jsonl', l)).join(', ')}`);
  out.push(`- skipped \`open\` items (before sampling): ${f.skipped.length}`);
  const reasons = {};
  for (const s of f.skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
  for (const [r, c] of Object.entries(reasons)) out.push(`  - ${r}: ${c}`);
  out.push('');

  out.push('## Setup', '');
  const m = meta.machine ?? {};
  out.push(`- date: ${meta.date}`, `- seed: ${meta.seed ?? sample?.seed}`, `- Claude model: ${meta.model} (judge: ${meta.judgeModel})`,
    `- Claude Code: ${meta.claudeVersion ?? 'n/a'}`, `- claude args: \`${(meta.claudeArgs ?? []).join(' ')}\``,
    `- translator: TranslateGemma ${meta.translator}`, `- machine: CPU ${m.cpu ?? 'n/a'}, GPU ${m.gpu ?? 'n/a'}, VRAM ${m.vram ?? 'n/a'}`,
    `- GPU load at start: ${'gpuLoad' in m ? gpuLoadText(m.gpuLoad) : 'not recorded'}`);
  for (const [set, d] of Object.entries(meta.datasets ?? {})) out.push(`- ${set}: \`${d.repo}\` rev \`${d.rev}\` (${d.files.join(', ')})`);
  out.push('', '### Prompts', '');
  for (const [set, p] of Object.entries(meta.prompts ?? {})) out.push(`${set}:`, '', block(p), '');
  if (meta.judgePrompt) out.push('judge:', '', block(meta.judgePrompt), '');

  out.push('## Limitations', '', ...LIMITATIONS.map((l) => `- ${l}`), '');
  return out.join('\n');
}

// Reads a run directory and writes its REPORT.md; resolves the file path.
export async function writeReport(dir, sample) {
  const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8'));
  const lines = {};
  for (const set of meta.sets) lines[set] = await readLines(path.join(dir, `${set}.jsonl`));
  const judge = await readLines(path.join(dir, 'judge.jsonl'));
  const report = computeReport({ sets: meta.sets, lines, judge, sample });
  const file = path.join(dir, 'REPORT.md');
  await writeFile(file, renderReport({ meta, report, sample }), 'utf8');
  return file;
}

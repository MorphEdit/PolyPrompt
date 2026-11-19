// Runs the token benchmark: each sampled item under A (Thai sent as typed)
// and B (the real runTurn pipeline), then the blind judge for `open`.
// Everything outside (datasets, translator, `claude` command) is passed in,
// so the tests run it with a fake `claude` and a fake translator.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { MODEL_FLAGS, buildArgs, createClaudeRunner } from '../claude.js';
import { detectLanguage } from '../lang.js';
import { ENGLISH, TRANSLATE_FAILED, createPending, runTurn } from '../pipeline.js';
import { newId } from '../store.js';
import { DATASETS } from './datasets.js';
import { createAppender, isErrorLine, judgeKey, lastBy, pairKey, readLines } from './results.js';
import { isQuotaError, parseAnswer, score } from './parse.js';
import { JUDGE_PROMPT, PROMPTS, expectedFor, judgePrompt, promptFor } from './prompts.js';
import { parseVerdict } from './judge.js';
import { SEED, mulberry32 } from './rng.js';

export const SETS = ['mgsm', 'belebele', 'open'];
export const SCORED = ['mgsm', 'belebele'];
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const EXTRA_ARGS = ['--no-session-persistence'];
export const USAGE_KEYS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
const deny = () => 'deny';

// An error message when `model` is not a full model ID of MODEL_FLAGS, else null.
export function checkModel(flag, model) {
  if (MODEL_FLAGS.includes(model)) return null;
  return `${flag} ${model} is not accepted. Use one of: ${MODEL_FLAGS.join(', ')}`;
}

export const quotaMessage = (run) =>
  `Claude's usage quota is used up. Rerun later with the same --run ${run} to resume where this run stopped.`;

// id -> ['A', 'B'] or ['B', 'A']: one draw per sampled item of the set (full
// list, ascending), from a fresh generator; < 0.5 means A first.
export function abOrder(ids, seed = SEED) {
  const rng = mulberry32(seed);
  return new Map(ids.map((id) => [id, rng() < 0.5 ? ['A', 'B'] : ['B', 'A']]));
}

export function pickUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return Object.fromEntries(USAGE_KEYS.map((k) => [k, typeof usage[k] === 'number' ? usage[k] : null]));
}

const errorOf = (err) => ({ kind: err?.kind ?? 'failed', message: err?.message ?? String(err) });

// Runs `fn` over `items` in order with up to `concurrency` at once; no new
// item starts once stopped() is true.
async function pool(items, concurrency, stopped, fn) {
  const queue = [...items];
  const worker = async () => {
    while (queue.length && !stopped()) await fn(queue.shift());
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// options: { outDir, run, sets, model, judgeModel, translator, limit,
// concurrency, retryFailed, sample, rows, command, timeoutMs, cwd,
// modelManager, detect, claudeVersion, machine, log, now }.
// Resolves { code: 0 | 1 | 2, message }.
export async function runBench({
  outDir, run, sets = SETS, model = DEFAULT_MODEL, judgeModel = DEFAULT_MODEL, translator = '4b',
  limit = null, concurrency = 1, retryFailed = false, sample, rows, command = 'claude', timeoutMs, cwd,
  modelManager, detect = detectLanguage, claudeVersion = null, machine = { cpu: null, gpu: null, vram: null },
  log = () => {}, now = () => performance.now(),
}) {
  const bad = checkModel('--model', model) ?? checkModel('--judge-model', judgeModel);
  if (bad) return { code: 1, message: bad };
  const unknown = sets.find((s) => !SETS.includes(s));
  if (unknown) return { code: 1, message: `unknown set: ${unknown} (use ${SETS.join(', ')})` };

  const runner = createClaudeRunner({ command, extraArgs: EXTRA_ARGS, ...(timeoutMs ? { timeoutMs } : {}), ...(cwd ? { cwd } : {}) });
  const claudeArgs = [...buildArgs(null, model, null), ...EXTRA_ARGS];
  const metaFile = path.join(outDir, 'meta.json');
  const datasetOf = (s) => ({ repo: DATASETS[s].repo, rev: DATASETS[s].rev, files: DATASETS[s].files.map((f) => f.path) });
  let meta;
  if (await exists(metaFile)) {
    // A resume: the run keeps its model, judge and translator (mixing them in
    // one set of pairs is no valid comparison); new sets join the run.
    meta = JSON.parse(await readFile(metaFile, 'utf8'));
    const given = { model, judgeModel, translator };
    const flags = { model: '--model', judgeModel: '--judge-model', translator: '--translator' };
    const changed = Object.keys(given).find((k) => meta[k] !== given[k]);
    if (changed) {
      return { code: 1, message: `run ${run} was started with ${flags[changed]} ${meta[changed]}; resume it with that or use a new --run` };
    }
    meta.sets = SETS.filter((s) => meta.sets.includes(s) || sets.includes(s));
    for (const s of sets) {
      meta.datasets[s] ??= datasetOf(s);
      meta.prompts[s] ??= PROMPTS[s];
    }
  } else {
    meta = {
      run, date: new Date().toISOString(), seed: SEED, sets, model, judgeModel, translator, claudeArgs, claudeVersion, machine,
      datasets: Object.fromEntries(sets.map((s) => [s, datasetOf(s)])),
      prompts: Object.fromEntries(sets.map((s) => [s, PROMPTS[s]])),
      judgePrompt: JUDGE_PROMPT,
    };
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');

  const append = createAppender();
  let quota = false;
  const stopped = () => quota;
  const ids = (set) => (limit ? sample.sets[set].slice(0, limit) : sample.sets[set]);
  // Pairs to run: without --retry-failed those with no line yet; with it, those whose last line is an error line.
  const due = (last, key) => (retryFailed ? isErrorLine(last.get(key)?.value) : !last.has(key));

  // Condition A: the Thai prompt straight to the runner.
  async function runA(set, id, prompt, expected) {
    const start = now();
    let res = null;
    let error = null;
    let failed = null;
    try {
      res = await runner.run({ prompt, model, folder: null, onPermission: deny });
    } catch (err) {
      if (isQuotaError(err)) return null;
      failed = err;
      error = errorOf(err);
    }
    const total = now() - start;
    const answer = res ? res.text : null;
    const parsed = !error && expected !== null ? parseAnswer(answer) : null;
    return {
      set, id, condition: 'A', requestedModel: model, answeringModel: res?.model ?? null, prompt, answer, finalAnswer: null,
      usage: pickUsage((res ?? failed)?.usage), modelUsage: (res ?? failed)?.modelUsage ?? null,
      totalCostUsd: (res ?? failed)?.totalCostUsd ?? null,
      ms: { claude: total, forward: null, back: null, total },
      parsed, score: !error && expected !== null ? score(parsed, expected) : null,
      parsedEnglish: null, scoreEnglish: null, fallback: null, error,
    };
  }

  // Condition B: the real runTurn with a fresh in-memory chat and timing wrappers.
  async function runB(set, id, prompt, expected) {
    const call = { prompt: null, res: null, err: null, ms: null };
    const ms = { forward: 0, back: 0 };
    let quotaHit = false;
    const wrappedRunner = {
      async run(opts) {
        call.prompt = opts.prompt;
        const start = now();
        try {
          call.res = await runner.run({ ...opts, onPermission: deny });
          return call.res;
        } catch (err) {
          call.err = err;
          if (isQuotaError(err)) quotaHit = true;
          throw err;
        } finally {
          call.ms = now() - start;
        }
      },
    };
    // Each step's time is wall-clock while at least one of its calls is in
    // flight, so pieces that translate concurrently are counted once.
    const inFlight = { forward: 0, back: 0 };
    const since = { forward: 0, back: 0 };
    const wrappedTranslator = {
      async translate(text, src, tgt) {
        const step = tgt === ENGLISH ? 'forward' : 'back';
        if (inFlight[step]++ === 0) since[step] = now();
        try {
          return await modelManager.translate(text, src, tgt);
        } finally {
          if (--inFlight[step] === 0) ms[step] += now() - since[step];
        }
      },
    };
    const message = { id: newId(), role: 'user', original: prompt, createdAt: new Date().toISOString() };
    const chat = { id: newId(), title: `bench ${set} ${id}`, folder: null, sessionId: null, messages: [message], permissions: [] };
    const deps = {
      chatStore: { save: async () => {} }, modelManager: wrappedTranslator, detect, runner: wrappedRunner,
      pending: createPending(), settings: { get: () => ({ claudeModel: model }) },
    };
    const start = now();
    await runTurn(deps, chat, message);
    const total = now() - start;
    if (quotaHit) return null;

    let error = null;
    if (message.error) {
      error = message.error.message === TRANSLATE_FAILED
        ? { kind: 'translate_failed', message: TRANSLATE_FAILED }
        : { kind: message.error.kind, message: message.error.message };
    }
    const reply = error ? null : chat.messages.find((m) => m.role === 'assistant') ?? null;
    const got = call.res ?? call.err;
    const answer = reply ? reply.english : null;
    const finalAnswer = reply ? reply.original : null;
    const scored = !error && expected !== null;
    const parsed = scored ? parseAnswer(finalAnswer) : null;
    const parsedEnglish = scored ? parseAnswer(answer) : null;
    return {
      set, id, condition: 'B', requestedModel: model, answeringModel: call.res?.model ?? null, prompt: call.prompt, answer, finalAnswer,
      usage: pickUsage(got?.usage), modelUsage: got?.modelUsage ?? null, totalCostUsd: got?.totalCostUsd ?? null,
      ms: { claude: call.ms, forward: ms.forward, back: ms.back, total },
      parsed, score: scored ? score(parsed, expected) : null,
      parsedEnglish, scoreEnglish: scored ? score(parsedEnglish, expected) : null,
      fallback: reply?.note ?? null, error,
    };
  }

  async function runSet(set) {
    const file = path.join(outDir, `${set}.jsonl`);
    const last = lastBy(await readLines(file), pairKey);
    const order = abOrder(sample.sets[set]);
    const work = ids(set)
      .map((id) => ({ id, conditions: order.get(id).filter((c) => due(last, `${id}\u0000${c}`)) }))
      .filter((w) => w.conditions.length);
    log(`${set}: ${work.length} item(s) to run`);
    await pool(work, concurrency, stopped, async ({ id, conditions }) => {
      const row = rows[set][Number(id)];
      const prompt = promptFor(set, row);
      const expected = expectedFor(set, row);
      for (const condition of conditions) {
        if (quota) return;
        const line = condition === 'A' ? await runA(set, id, prompt, expected) : await runB(set, id, prompt, expected);
        if (!line) {
          quota = true;
          return;
        }
        await append(file, line);
        log(`${set} ${id} ${condition}${line.error ? ` error: ${line.error.kind}` : line.score !== null ? ` score ${line.score}` : ''}`);
      }
    });
  }

  // The judge for `open`: both orders of each item whose last A and B lines are non-error.
  async function runJudge() {
    const file = path.join(outDir, 'judge.jsonl');
    const pairs = lastBy(await readLines(path.join(outDir, 'open.jsonl')), pairKey);
    const last = lastBy(await readLines(file), judgeKey);
    const work = [];
    for (const id of ids('open')) {
      const a = pairs.get(`${id}\u0000A`)?.value;
      const b = pairs.get(`${id}\u0000B`)?.value;
      if (!a || !b || isErrorLine(a) || isErrorLine(b)) continue;
      for (const order of [1, 2]) if (due(last, `${id}\u0000${order}`)) work.push({ id, order, a, b });
    }
    log(`judge: ${work.length} call(s) to run`);
    await pool(work, concurrency, stopped, async ({ id, order, a, b }) => {
      const row = rows.open[Number(id)];
      const [answer1, answer2] = order === 1 ? [a.answer, b.finalAnswer] : [b.finalAnswer, a.answer];
      const prompt = judgePrompt({ instruction: promptFor('open', row), reference: row.Output, answer1, answer2 });
      const start = now();
      let res = null;
      let error = null;
      let failed = null;
      try {
        res = await runner.run({ prompt, model: judgeModel, folder: null, onPermission: deny });
      } catch (err) {
        if (isQuotaError(err)) {
          quota = true;
          return;
        }
        failed = err;
        error = errorOf(err);
      }
      const got = res ?? failed;
      const line = {
        id, order, judgeModel, answeringModel: res?.model ?? null, prompt, answer: res ? res.text : null,
        verdict: res ? parseVerdict(res.text) : null, usage: pickUsage(got?.usage), modelUsage: got?.modelUsage ?? null,
        totalCostUsd: got?.totalCostUsd ?? null, ms: now() - start, error,
      };
      await append(file, line);
      log(`judge ${id} order ${order}${error ? ` error: ${error.kind}` : line.verdict ? ` winner ${line.verdict.winner}` : ' unparseable'}`);
    });
  }

  for (const set of sets) {
    if (quota) break;
    await runSet(set);
    if (set === 'open' && !quota) await runJudge();
  }
  if (quota) return { code: 2, message: quotaMessage(run) };
  return { code: 0, message: `done: ${outDir}` };
}

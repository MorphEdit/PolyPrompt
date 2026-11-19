// Token benchmark (npm run bench:tokens; not part of the tests): the same
// sampled Thai items sent to Claude directly (A) and through PolyPrompt (B).
// Usage: npm run bench:tokens -- [--sets mgsm,belebele,open] [--model <id>]
//   [--judge-model <id>] [--translator 4b] [--limit N] [--concurrency 1]
//   [--run <id>] [--retry-failed]
// Writes bench/results/<run>/; bench/sample.json is built once if missing.
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveCommand } from '../src/claude.js';
import { createModelManager } from '../src/model.js';
import { SIZES, downloadModel, isSize, loadTranslateGemma } from '../src/translator.js';
import { loadRows } from '../src/bench/datasets.js';
import { gpuLoad } from '../src/bench/gpu.js';
import { DEFAULT_MODEL, SETS, checkModel, runBench } from '../src/bench/run.js';
import { buildSample, sampleJson } from '../src/bench/sample.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_FILE = path.join(root, 'bench', 'sample.json');

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      sets: { type: 'string', default: SETS.join(',') },
      model: { type: 'string', default: DEFAULT_MODEL },
      'judge-model': { type: 'string', default: DEFAULT_MODEL },
      translator: { type: 'string', default: '4b' },
      limit: { type: 'string' },
      concurrency: { type: 'string', default: '1' },
      run: { type: 'string' },
      'retry-failed': { type: 'boolean', default: false },
    },
  }));
} catch (err) {
  fail(err.message);
}

const bad = checkModel('--model', args.model) ?? checkModel('--judge-model', args['judge-model']);
if (bad) fail(bad);
const sets = args.sets.split(',').map((s) => s.trim()).filter(Boolean);
const unknown = sets.find((s) => !SETS.includes(s));
if (unknown) fail(`unknown set: ${unknown} (use ${SETS.join(', ')})`);
if (!isSize(args.translator)) fail(`--translator must be one of: ${Object.keys(SIZES).join(', ')}`);
const positive = (flag, v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) fail(`${flag} must be a positive integer`);
  return n;
};
const limit = args.limit === undefined ? null : positive('--limit', args.limit);
const concurrency = positive('--concurrency', args.concurrency);
const run = args.run ?? new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
if (!/^[\w.-]+$/.test(run)) fail('--run may only use letters, digits, ".", "_" and "-"');

function exec(file, argv) {
  return new Promise((resolve) => {
    try {
      const target = resolveCommand(file, argv);
      execFile(target.file, target.args, { windowsHide: true, windowsVerbatimArguments: target.windowsVerbatimArguments }, (err, stdout) => {
        resolve(err ? null : stdout.trim());
      });
    } catch {
      resolve(null);
    }
  });
}

async function machine() {
  const gpu = await exec('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader']);
  const [name, vram] = gpu ? gpu.split('\n')[0].split(',').map((s) => s.trim()) : [null, null];
  // Before the translator loads, so its own GPU use is not counted.
  return { cpu: os.cpus()[0]?.model ?? null, gpu: name, vram, gpuLoad: await gpuLoad(exec) };
}

// The frozen sample: read when present, else built from all three sets once.
let sample;
try {
  sample = JSON.parse(await readFile(SAMPLE_FILE, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
  console.log('bench/sample.json is missing: building it from the pinned datasets');
  const all = {};
  for (const set of SETS) all[set] = await loadRows(set);
  sample = buildSample(all);
  await writeFile(SAMPLE_FILE, sampleJson(sample), 'utf8');
}

const rows = {};
try {
  for (const set of sets) rows[set] = await loadRows(set);
} catch (err) {
  fail(err.message);
}

const machineInfo = await machine();
const modelManager = createModelManager({
  load: async (onProgress, { size }) => {
    await downloadModel(size, () => {});
    return loadTranslateGemma(onProgress, { size });
  },
  size: args.translator,
  sizes: Object.keys(SIZES),
});
modelManager.start();
console.log(`loading TranslateGemma ${args.translator}…`);
await modelManager.translate('Hello', 'en', 'th'); // waits for the load and warms up

const result = await runBench({
  outDir: path.join(root, 'bench', 'results', run),
  run, sets, model: args.model, judgeModel: args['judge-model'], translator: args.translator,
  limit, concurrency, retryFailed: args['retry-failed'], sample, rows, modelManager,
  claudeVersion: await exec('claude', ['--version']),
  machine: machineInfo,
  log: (line) => console.log(line),
});
await modelManager.translator()?.dispose?.();
if (result.code) fail(result.message, result.code);
console.log(`${result.message}\nnext: npm run bench:report -- --run ${run}`);

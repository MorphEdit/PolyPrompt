import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPrompt, cleanOutput, createTranslator, downloadModel, isDownloaded, loadTranslateGemma,
  maxTokensFor, modelFileName, modelUri,
} from '../src/translator.js';
import { createModelManager } from '../src/model.js';

const TH_EN = 'You are a professional Thai (th) to English (en) translator. Your goal is to accurately convey '
  + 'the meaning and nuances of the original Thai text while adhering to English grammar, vocabulary, and '
  + 'cultural sensitivities.\nProduce only the English translation, without any additional explanations or '
  + 'commentary. Please translate the following Thai text into English:\n\n\nสวัสดี';

const EN_TH = 'You are a professional English (en) to Thai (th) translator. Your goal is to accurately convey '
  + 'the meaning and nuances of the original English text while adhering to Thai grammar, vocabulary, and '
  + 'cultural sensitivities.\nProduce only the Thai translation, without any additional explanations or '
  + 'commentary. Please translate the following English text into Thai:\n\n\nKeep a consistent schedule.';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'polyprompt-tg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function fakeComplete(reply) {
  const prompts = [];
  const complete = async (prompt) => {
    prompts.push(prompt);
    return typeof reply === 'function' ? reply(prompt) : reply;
  };
  return { complete, prompts };
}

test('th -> en sends exactly the TranslateGemma prompt and returns the trimmed text', async () => {
  const { complete, prompts } = fakeComplete('  Hello\n');
  const out = await createTranslator(complete).translate('สวัสดี', 'th', 'en');
  assert.deepEqual(prompts, [TH_EN]);
  assert.equal(out, 'Hello');
});

test('en -> th sends exactly the TranslateGemma prompt', async () => {
  const { complete, prompts } = fakeComplete('รักษาตารางเวลาให้สม่ำเสมอ');
  const out = await createTranslator(complete).translate('Keep a consistent schedule.', 'en', 'th');
  assert.deepEqual(prompts, [EN_TH]);
  assert.equal(buildPrompt('Keep a consistent schedule.', 'en', 'th'), EN_TH);
  assert.equal(out, 'รักษาตารางเวลาให้สม่ำเสมอ');
});

test('quotes the source lacks are removed, for every quote pair', () => {
  for (const [open, close] of [['"', '"'], ['“', '”'], ["'", "'"], ['「', '」'], ['«', '»']]) {
    assert.equal(cleanOutput('สวัสดี', `${open}Hello${close}`), 'Hello', open);
    assert.equal(cleanOutput('สวัสดี', ` ${open}Hello${close}\n`), 'Hello', open);
  }
});

test('quotes the source has are kept', () => {
  assert.equal(cleanOutput('"สวัสดี"', '"Hello"'), '"Hello"');
  assert.equal(cleanOutput('“สวัสดี”', '“Hello”'), '“Hello”');
  // Only a pair that wraps the whole output counts.
  assert.equal(cleanOutput('เขาพูดว่า สวัสดี', 'He said "hi" and "bye"'), 'He said "hi" and "bye"');
});

test('a preface line ending in a colon is dropped', () => {
  assert.equal(cleanOutput('สวัสดี', 'Here is the translation:\nHello'), 'Hello');
  assert.equal(cleanOutput('สวัสดี', 'Here is the translation:\n\n"Hello"'), '"Hello"');
  assert.equal(cleanOutput('Hello', 'นี่คือคำแปล：\nสวัสดี'), 'สวัสดี');
});

test('a preface is kept when the source has a line break or nothing follows it', () => {
  assert.equal(cleanOutput('ข้อ:\nหนึ่ง', 'Item:\nOne'), 'Item:\nOne');
  assert.equal(cleanOutput('หมายเหตุ:', 'Note:'), 'Note:');
});

test('a translator cleans its output: quotes and a preface are removed', async () => {
  const quoted = createTranslator(fakeComplete('"Hello"').complete);
  assert.equal(await quoted.translate('สวัสดี', 'th', 'en'), 'Hello');
  const preface = createTranslator(fakeComplete('Here is the translation:\nHello').complete);
  assert.equal(await preface.translate('สวัสดี', 'th', 'en'), 'Hello');
});

test('model files come from the mradermacher TranslateGemma repos', () => {
  assert.equal(modelFileName('4b'), 'translategemma-4b-it.Q4_K_M.gguf');
  assert.equal(modelUri('4b'), 'hf:mradermacher/translategemma-4b-it-GGUF/translategemma-4b-it.Q4_K_M.gguf');
  assert.equal(modelUri('12b'), 'hf:mradermacher/translategemma-12b-it-GGUF/translategemma-12b-it.Q4_K_M.gguf');
  assert.equal(modelUri('27b'), 'hf:mradermacher/translategemma-27b-it-GGUF/translategemma-27b-it.Q4_K_M.gguf');
});

test('a partial download (.ipull) is not a downloaded model', async (t) => {
  const cacheDir = await tempDir(t);
  await writeFile(path.join(cacheDir, modelFileName('4b') + '.ipull'), 'partial');
  assert.equal(isDownloaded('4b', { cacheDir }), false);
  await writeFile(path.join(cacheDir, modelFileName('4b')), 'whole');
  assert.equal(isDownloaded('4b', { cacheDir }), true);
  assert.equal(isDownloaded('12b', { cacheDir }), false);
  assert.equal(isDownloaded('1b', { cacheDir }), false);
});

// Fake node-llama-cpp: records what the loader does; nothing is downloaded or loaded.
function fakeLib({ reply = 'Hello', downloadFails = null, loadFails = null } = {}) {
  const log = { downloads: [], loads: [], generations: [], disposed: [] };
  const lib = {
    async createModelDownloader(opts) {
      log.downloads.push(opts);
      return {
        async download() {
          opts.onProgress({ totalSize: 100, downloadedSize: 40, estimatedTimeLeft: 0, averageSpeed: 0 });
          opts.onProgress({ totalSize: 100, downloadedSize: 100, estimatedTimeLeft: 0, averageSpeed: 0 });
          if (downloadFails) throw downloadFails;
          const file = path.join(opts.dirPath, opts.fileName);
          await writeFile(file, 'gguf');
          return file;
        },
      };
    },
    async getLlama() {
      return {
        async loadModel({ modelPath }) {
          log.loads.push(modelPath);
          if (loadFails) throw loadFails;
          return {
            async createContext() {
              return {
                getSequence: () => ({}),
                async dispose() { log.disposed.push('context'); },
              };
            },
            async dispose() { log.disposed.push('model'); },
          };
        },
      };
    },
    GemmaChatWrapper: class { constructor() { this.gemma = true; } },
    LlamaChat: class {
      constructor({ chatWrapper }) { this.wrapper = chatWrapper; }
      async generateResponse(history, options) {
        log.generations.push({ history, options, wrapper: this.wrapper });
        return { response: typeof reply === 'function' ? reply(history) : reply };
      }
      dispose() { log.disposed.push('chat'); }
    },
  };
  return { lib, log, importLib: async () => lib };
}

test('loader downloads a missing size with progress, then translates greedily with the Gemma template', async (t) => {
  const cacheDir = await tempDir(t);
  const { log, importLib } = fakeLib({ reply: ' "Hello" ' });
  const progress = [];
  const translator = await loadTranslateGemma((p) => progress.push(p), { size: '4b', cacheDir, importLib, offline: false });
  assert.equal(log.downloads.length, 1);
  assert.equal(log.downloads[0].modelUri, modelUri('4b'));
  assert.equal(log.downloads[0].dirPath, cacheDir);
  assert.equal(log.downloads[0].fileName, modelFileName('4b'));
  assert.deepEqual(progress, [0.4, 0.99, 1]);
  assert.deepEqual(log.loads, [path.join(cacheDir, modelFileName('4b'))]);

  assert.equal(await translator.translate('สวัสดี', 'th', 'en'), 'Hello');
  const [gen] = log.generations;
  assert.deepEqual(gen.history, [{ type: 'user', text: TH_EN }, { type: 'model', response: [] }]);
  assert.equal(gen.options.temperature, 0);
  assert.equal(gen.options.maxTokens, maxTokensFor('สวัสดี'));
  assert.equal(gen.wrapper.gemma, true);

  await translator.dispose();
  assert.deepEqual(log.disposed, ['chat', 'context', 'model']);
});

test('loader skips the download when the size is already in the cache', async (t) => {
  const cacheDir = await tempDir(t);
  await writeFile(path.join(cacheDir, modelFileName('12b')), 'gguf');
  const { log, importLib } = fakeLib();
  await loadTranslateGemma(() => {}, { size: '12b', cacheDir, importLib, offline: false });
  assert.equal(log.downloads.length, 0);
  assert.deepEqual(log.loads, [path.join(cacheDir, modelFileName('12b'))]);
});

test('downloadModel reports progress and leaves the complete file in the cache', async (t) => {
  const cacheDir = await tempDir(t);
  const { importLib } = fakeLib();
  const progress = [];
  const file = await downloadModel('27b', (p) => progress.push(p), { cacheDir, importLib, offline: false });
  assert.equal(file, path.join(cacheDir, modelFileName('27b')));
  assert.equal(readFileSync(file, 'utf8'), 'gguf');
  assert.deepEqual(progress, [0.4, 0.99, 1]);
  assert.equal(isDownloaded('27b', { cacheDir }), true);
});

test('a startup download failure gives the error state; retry loads again', async (t) => {
  const cacheDir = await tempDir(t);
  const failing = fakeLib({ downloadFails: new Error('network down') });
  const working = fakeLib();
  let lib = failing;
  const mm = createModelManager({ load: (p, { size }) => loadTranslateGemma(p, { size, cacheDir, importLib: lib.importLib, offline: false }) });
  mm.start();
  while (mm.status().state === 'loading') await new Promise((r) => setTimeout(r, 5));
  assert.equal(mm.status().state, 'error');
  assert.match(mm.status().error, /network down/);
  lib = working;
  mm.retry();
  assert.equal(mm.status().state, 'loading');
  while (mm.status().state === 'loading') await new Promise((r) => setTimeout(r, 5));
  assert.equal(mm.status().state, 'ready');
  assert.equal(await mm.translate('สวัสดี', 'th', 'en'), 'Hello');
});

test('with no network and no cache, loading fails and the model manager reports error', async (t) => {
  const cacheDir = await tempDir(t);
  const mm = createModelManager({ load: (p, { size }) => loadTranslateGemma(p, { size, offline: true, cacheDir }) });
  mm.start();
  while (mm.status().state === 'loading') await new Promise((r) => setTimeout(r, 5));
  assert.equal(mm.status().state, 'error');
  assert.match(mm.status().error, /not found/i);
});

test('a missing node-llama-cpp install fails with an actionable message', async (t) => {
  const cacheDir = await tempDir(t);
  await writeFile(path.join(cacheDir, modelFileName('4b')), 'gguf');
  const missing = Object.assign(new Error("Cannot find package 'node-llama-cpp'"), { code: 'ERR_MODULE_NOT_FOUND' });
  await assert.rejects(
    loadTranslateGemma(() => {}, { size: '4b', cacheDir, importLib: () => Promise.reject(missing) }),
    (err) => /not found: run npm ci/.test(err.message) && err.cause === missing,
  );
  const other = new Error('boom');
  await assert.rejects(loadTranslateGemma(() => {}, { size: '4b', cacheDir, importLib: () => Promise.reject(other) }), (err) => err === other);
});

test('the translator module never imports the NLLB library', () => {
  const src = readFileSync(new URL('../src/translator.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /transformers|nllb/i);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.dependencies['node-llama-cpp']);
  assert.equal(pkg.dependencies['@huggingface/transformers'], undefined);
});

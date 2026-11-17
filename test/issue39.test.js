import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { translateText } from '../src/text.js';
import { buildPrompt, loadTranslateGemma, modelFileName, NotTranslatedError, SEQUENCES } from '../src/translator.js';
import { createModelManager } from '../src/model.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake translator that records how many calls run at once and the order they start.
function concurrentTranslator({ concurrency, fn = (text) => text.toUpperCase() } = {}) {
  let active = 0;
  const t = {
    peak: 0,
    started: [],
    async translate(text) {
      t.started.push(text);
      active++;
      t.peak = Math.max(t.peak, active);
      // Later pieces finish first, so the output order cannot come from timing.
      await wait(5 + 20 / t.started.length);
      active--;
      return fn(text);
    },
  };
  if (concurrency !== undefined) t.concurrency = concurrency;
  return t;
}

// Fake translator that runs one call at a time.
const sequentialTranslator = (fn = (text) => text.toUpperCase()) => ({ concurrency: 1, async translate(text) { return fn(text); } });

test('#39 translateText runs independent paragraphs concurrently and keeps order', async () => {
  const text = 'First one here.\n\nSecond one here.\n\nThird one here.\n\nFourth one here.';
  const t = concurrentTranslator();
  const out = await translateText(t, text, 'en', 'th');
  assert.equal(out, text.toUpperCase());
  assert.ok(t.peak > 1, `expected concurrent pieces, peak concurrency was ${t.peak}`);
});

test('#39 translateText runs at most translator.concurrency pieces at once', async () => {
  const text = Array.from({ length: 9 }, (_, i) => `Paragraph number ${i} here.`).join('\n\n');
  for (const n of [1, 2, 3]) {
    const t = concurrentTranslator({ concurrency: n });
    assert.equal(await translateText(t, text, 'en', 'th'), text.toUpperCase());
    assert.equal(t.peak, n);
  }
});

test('#39 the concurrent result equals the sequential one, with Markdown, code, URLs and long runs', async () => {
  const long = Array.from({ length: 30 }, (_, i) => `Sentence ${i} is here.`).join(' ');
  const text = [
    '# Title here', '', '- **Bold item** and `code` here', '- see https://example.com/a now', '',
    '> quoted words', '', '```js\nconst x = 1;\n```', '', '| a cell | b cell |', '', long, '', '1. last one',
  ].join('\n');
  const fn = (s) => `[${s.toUpperCase()}]`;
  const seq = await translateText(sequentialTranslator(fn), text, 'en', 'th', { maxChars: 100 });
  const t = concurrentTranslator({ concurrency: 4, fn });
  const par = await translateText(t, text, 'en', 'th', { maxChars: 100 });
  assert.equal(par, seq);
  assert.ok(t.peak > 1);
  assert.match(par, /```js\nconst x = 1;\n```/);
  assert.match(par, /https:\/\/example\.com\/a/);
  assert.match(par, /`code`/);
});

test('#39 a degenerate piece still falls back sentence by sentence when run concurrently', async () => {
  const bad = 'One thing. Two thing.';
  const text = `Good words here.\n\n${bad}\n\nMore good words.`;
  const fn = (s) => (s === bad ? '!!!!!!!!!!!!!!!!!!!' : s.toUpperCase());
  const seq = await translateText(sequentialTranslator(fn), text, 'en', 'th');
  const par = await translateText(concurrentTranslator({ concurrency: 3, fn }), text, 'en', 'th');
  assert.equal(par, seq);
  assert.equal(par, 'GOOD WORDS HERE.\n\nONE THING. TWO THING.\n\nMORE GOOD WORDS.');
});

test('#39 an error in one piece rejects translateText and stops starting new pieces', async () => {
  const text = Array.from({ length: 8 }, (_, i) => `Paragraph number ${i} here.`).join('\n\n');
  const started = [];
  const t = {
    concurrency: 2,
    async translate(s) {
      started.push(s);
      await wait(5);
      if (s.includes('1')) throw new NotTranslatedError();
      return s;
    },
  };
  await assert.rejects(translateText(t, text, 'en', 'th'), NotTranslatedError);
  await wait(30);
  assert.ok(started.length < 8, `all ${started.length} pieces started after the error`);
});

// Fake node-llama-cpp: records context options, generations and disposals.
function fakeLib({ reply = (history) => history[0].text.split('\n').at(-1), contextFails = () => false, delay = 0 } = {}) {
  const log = { contexts: [], generations: [], disposed: [], active: 0, peak: 0 };
  const lib = {
    async getLlama() {
      return {
        async loadModel() {
          return {
            async createContext(opts) {
              log.contexts.push(opts);
              if (contextFails(opts)) throw new Error('context failed');
              return { getSequence: () => ({}), async dispose() { log.disposed.push('context'); } };
            },
            async dispose() { log.disposed.push('model'); },
          };
        },
      };
    },
    GemmaChatWrapper: class {},
    LlamaChat: class {
      async generateResponse(history, options) {
        assert.ok(!this.busy, 'two calls used one chat sequence at once');
        this.busy = true;
        log.generations.push({ history, options });
        log.active++;
        log.peak = Math.max(log.peak, log.active);
        try {
          if (log.gate) await log.gate;
          if (delay) await wait(delay);
          return { response: reply(history) };
        } finally {
          log.active--;
          this.busy = false;
        }
      }
      dispose() { log.disposed.push('chat'); }
    },
  };
  return { log, importLib: async () => lib };
}

async function cachedDir(t) {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'pp39-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  await writeFile(path.join(cacheDir, modelFileName('4b')), 'gguf');
  return cacheDir;
}

test('#39 loader creates the context with flash attention and >1 sequences, and warms up before resolving', async (t) => {
  const cacheDir = await cachedDir(t);
  const { log, importLib } = fakeLib();
  const translator = await loadTranslateGemma(() => {}, { size: '4b', cacheDir, importLib, offline: false });
  const opts = log.contexts[0];
  assert.equal(log.contexts.length, 1);
  assert.equal(opts.flashAttention, true, 'flashAttention not requested');
  assert.ok(opts.sequences > 1, `sequences was ${opts.sequences}`);
  assert.equal(opts.sequences, SEQUENCES);
  assert.equal(translator.concurrency, SEQUENCES);
  assert.equal(log.generations.length, 1, 'no warm-up translation ran before the loader resolved');
  assert.equal(log.generations[0].history[0].text, buildPrompt('Hi', 'en', 'th'));
  assert.equal(log.generations[0].options.maxTokens, 4);
});

test('#39 if flash attention or several sequences fail, the loader falls back to 1 sequence, logs it and still loads', async (t) => {
  const cacheDir = await cachedDir(t);
  const { log, importLib } = fakeLib({ contextFails: (opts) => opts.flashAttention || opts.sequences > 1 });
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const translator = await loadTranslateGemma(() => {}, { size: '4b', cacheDir, importLib, offline: false });
  assert.equal(log.contexts.length, 2);
  assert.deepEqual(log.contexts[1], { contextSize: { max: 8192 } });
  assert.equal(translator.concurrency, 1);
  assert.match(warnings.join('\n'), /1 sequence/);
  assert.equal(await translator.translate('Hello there', 'en', 'en'), 'Hello there');
});

test('#39 a failing fallback context disposes the model and rejects', async (t) => {
  const cacheDir = await cachedDir(t);
  const { log, importLib } = fakeLib({ contextFails: () => true });
  t.mock.method(console, 'warn', () => {});
  await assert.rejects(loadTranslateGemma(() => {}, { size: '4b', cacheDir, importLib, offline: false }), /context failed/);
  assert.deepEqual(log.disposed, ['model']);
});

test('#39 a failing warm-up only logs and the model still loads', async (t) => {
  const cacheDir = await cachedDir(t);
  let calls = 0;
  const { importLib } = fakeLib({
    reply: (history) => {
      if (calls++ === 0) throw new Error('gpu hiccup');
      return history[0].text.split('\n').at(-1);
    },
  });
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const translator = await loadTranslateGemma(() => {}, { size: '4b', cacheDir, importLib, offline: false });
  assert.match(warnings.join('\n'), /warm-up.*gpu hiccup/);
  assert.equal(await translator.translate('Hello there', 'en', 'en'), 'Hello there');
});

test('#39 the model manager reports ready only after the warm-up translation finished', async (t) => {
  const cacheDir = await cachedDir(t);
  const { log, importLib } = fakeLib();
  let open;
  log.gate = new Promise((r) => { open = r; });
  const mm = createModelManager({ load: (p, { size }) => loadTranslateGemma(p, { size, cacheDir, importLib, offline: false }) });
  mm.start();
  while (!log.generations.length) await wait(2);
  await wait(20);
  assert.equal(mm.status().state, 'loading', 'ready was reported before the warm-up finished');
  open();
  while (mm.status().state === 'loading') await wait(2);
  assert.equal(mm.status().state, 'ready');
  assert.equal(log.generations.length, 1);
});

test('#39 the loaded translator runs up to its sequences at once, one chat per sequence', async (t) => {
  const cacheDir = await cachedDir(t);
  const { log, importLib } = fakeLib({ delay: 5 });
  const translator = await loadTranslateGemma(() => {}, { size: '4b', cacheDir, importLib, offline: false, sequences: 2 });
  const texts = ['one two three', 'four five six', 'seven eight nine', 'ten eleven twelve', 'more words here'];
  const out = await Promise.all(texts.map((x) => translator.translate(x, 'en', 'en')));
  assert.deepEqual(out, texts);
  assert.equal(log.peak, 2);
  await translator.dispose();
  assert.deepEqual(log.disposed, ['chat', 'chat', 'context', 'model']);
});

test('#39 the model manager runs up to the translator concurrency of translations at once', async () => {
  const translator = concurrentTranslator({ concurrency: 3, fn: (s) => s });
  const mm = createModelManager({ load: async () => translator });
  mm.start();
  while (mm.status().state === 'loading') await wait(2);
  const items = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.deepEqual(await Promise.all(items.map((x) => mm.translate(x, 'en', 'th'))), items);
  assert.equal(translator.peak, 3);
});

test('#39 a size switch waits for running translations, and later ones wait for the switch', async () => {
  const events = [];
  const make = (name) => ({
    concurrency: 2,
    async translate(text) {
      events.push(`${name}:start:${text}`);
      await wait(10);
      events.push(`${name}:end:${text}`);
      return text;
    },
    async dispose() { events.push(`${name}:dispose`); },
  });
  const mm = createModelManager({ load: async (p, { size }) => { events.push(`load:${size}`); return make(size); } });
  mm.start();
  while (mm.status().state === 'loading') await wait(2);
  const first = [mm.translate('a', 'en', 'th'), mm.translate('b', 'en', 'th')];
  const { done } = mm.selectSize('12b');
  const after = mm.translate('c', 'en', 'th');
  await Promise.all([...first, done, after]);
  assert.deepEqual(events, [
    'load:4b', '4b:start:a', '4b:start:b', '4b:end:a', '4b:end:b',
    '4b:dispose', 'load:12b', '12b:start:c', '12b:end:c',
  ]);
});

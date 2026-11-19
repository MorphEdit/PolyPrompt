// Pipeline with the TranslateGemma era features: ISO codes, the Claude model
// setting, the 2000-char budget and translator switches mid-turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createModelManager } from '../src/model.js';
import { createPending, LOCAL_TRANSLATE, runTurn, TRANSLATE_FAILED } from '../src/pipeline.js';
import { createSettingsStore } from '../src/settings.js';
import { createChatStore } from '../src/store.js';
import { deferred, tick } from './helpers.js';

const THAI = (text) => (/[฀-๿]/.test(text) ? { kind: 'ok', lang: 'th' } : { kind: 'ok', lang: 'en' });

async function setup(t, { downloaded = ['4b', '12b'] } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'polyprompt-pm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const chatStore = createChatStore({ dir: path.join(dir, 'chats') });
  const settings = await createSettingsStore({ file: path.join(dir, 'settings.json') });
  // These tests cover the local translator pipeline: since #71 the benchmark's
  // LOCAL_TRANSLATE mode. Direct is the default since #67.
  await settings.update({ sendMode: 'translate' });
  const calls = [];
  const loads = [];
  const gates = [];
  const translatorFor = (size) => ({
    async translate(text, src, tgt) {
      calls.push({ size, text, src, tgt });
      if (gates.length) await gates.shift().promise;
      return `<${size}:${tgt}>${text}`;
    },
  });
  const modelManager = createModelManager({
    load: (onProgress, { size }) => {
      const d = deferred();
      loads.push({ size, ...d });
      return d.promise.then(() => translatorFor(size));
    },
    isDownloaded: (size) => downloaded.includes(size),
  });
  modelManager.start();
  loads[0].resolve();
  await tick();
  const runs = [];
  const runner = {
    reply: (p) => `Answer: ${p}`,
    async run(opts) {
      runs.push(opts);
      return { text: runner.reply(opts.prompt), sessionId: 's1' };
    },
  };
  const deps = { chatStore, modelManager, detect: THAI, runner, pending: createPending(), settings };
  async function turn(text, chat) {
    chat ??= await chatStore.create(text);
    const message = { id: `m${chat.messages.length}`, role: 'user', original: text, english: null, lang: null, createdAt: 'x' };
    chat.messages.push(message);
    await runTurn(deps, chat, message, LOCAL_TRANSLATE);
    return chat;
  }
  return { deps, chatStore, settings, modelManager, loads, calls, gates, runs, runner, turn, dir };
}

test('the pipeline uses ISO codes with the translator', async (t) => {
  const s = await setup(t);
  const chat = await s.turn('สวัสดี');
  assert.deepEqual(s.calls.map((c) => [c.src, c.tgt]), [['th', 'en'], ['en', 'th']]);
  assert.equal(chat.lang, 'th');
  assert.deepEqual(chat.messages.map((m) => m.lang), ['th', 'th']);
});

test('the Claude model setting reaches the runner and applies from the next message', async (t) => {
  const s = await setup(t);
  const chat = await s.turn('Hello there');
  assert.equal(s.runs[0].model, 'default');
  await s.settings.update({ claudeModel: 'claude-opus-5-5' });
  await s.turn('Next one', chat);
  assert.equal(s.runs[1].model, 'claude-opus-5-5');
  assert.equal(s.runs[1].sessionId, 's1', 'the same Claude session continues');
});

test('runTurn sends a multi-sentence answer of up to 2000 characters as one call', async (t) => {
  const s = await setup(t);
  const answer = Array.from({ length: 60 }, (_, i) => `Sentence ${i} is about topic ${i * 7}.`).join(' ');
  assert.ok(answer.length > 1500 && answer.length <= 2000, String(answer.length));
  s.runner.reply = () => answer;
  await s.turn('สวัสดี');
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1].text, answer);
});

test('an old chat with NLLB codes continues', async (t) => {
  const s = await setup(t);
  const id = '11111111-2222-4333-8444-777777777777';
  await writeFile(path.join(s.chatStore.dir, id + '.json'), JSON.stringify({
    id, title: 'old', sessionId: 's0', lang: 'tha_Thai',
    messages: [
      { id: 'a', role: 'user', original: 'สวัสดี', english: 'Hello', lang: 'tha_Thai', createdAt: 'x' },
      { id: 'b', role: 'assistant', original: 'ครับ', english: 'Yes', lang: 'tha_Thai', createdAt: 'x' },
    ],
  }));
  const chat = await s.chatStore.get(id);
  // "ok" is unsure for the real detector: the chat language (mapped to th) is used.
  s.deps.detect = (text) => (text === 'ok' ? { kind: 'unsure', lang: null } : THAI(text));
  await s.turn('ok', chat);
  assert.deepEqual([s.calls[0].src, s.calls[0].tgt], ['th', 'en']);
  const saved = await s.chatStore.get(id);
  assert.equal(saved.lang, 'th');
  assert.deepEqual(saved.messages.map((m) => m.lang), ['th', 'th', 'th', 'th']);
  assert.equal(s.runs[0].sessionId, 's0');
});

test('a turn that started before a switch translates back with the model loaded afterwards', async (t) => {
  const s = await setup(t);
  const claude = deferred();
  s.runner.run = async (opts) => {
    s.runs.push(opts);
    await claude.promise;
    return { text: 'Answer', sessionId: 's1' };
  };
  const done = s.turn('สวัสดี');
  while (s.runs.length === 0) await tick();
  assert.equal(s.calls[0].size, '4b');
  s.modelManager.selectSize('12b');
  claude.resolve();
  await tick();
  await tick();
  assert.equal(s.loads.at(-1).size, '12b');
  s.loads.at(-1).resolve();
  const chat = await done;
  assert.equal(s.calls[1].size, '12b');
  assert.equal(chat.messages[1].original, '<12b:th>Answer');
});

test('a turn waiting on a switch that ends in error shows the translate error', async (t) => {
  const s = await setup(t);
  const claude = deferred();
  s.runner.run = async (opts) => {
    s.runs.push(opts);
    await claude.promise;
    return { text: 'Answer', sessionId: 's1' };
  };
  const done = s.turn('สวัสดี');
  while (s.runs.length === 0) await tick();
  s.modelManager.selectSize('12b');
  claude.resolve();
  await tick();
  await tick();
  s.loads.at(-1).reject(new Error('oom'));
  await tick();
  await tick();
  s.loads.at(-1).reject(new Error('oom'));
  const chat = await done;
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.messages[0].error.message, TRANSLATE_FAILED);
});

test('runTurn with the default maxChars splits a back-translation over 2000 characters, in order', async (t) => {
  const s = await setup(t);
  assert.equal('maxChars' in s.deps, false);
  const answer = Array.from({ length: 100 }, (_, i) => `Sentence ${i} is about topic ${i * 7}.`).join(' ');
  assert.ok(answer.length > 2000, String(answer.length));
  s.runner.reply = () => answer;
  const chat = await s.turn('สวัสดี');
  const back = s.calls.slice(1);
  assert.ok(back.length > 1, String(back.length));
  assert.ok(back.every((c) => c.text.length <= 2000 && c.tgt === 'th'));
  assert.equal(back.map((c) => c.text).join(' '), answer);
  assert.equal(chat.messages.at(-1).original, back.map((c) => `<4b:th>${c.text}`).join(' '));
});

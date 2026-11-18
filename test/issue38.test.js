// #38: the Claude picker lists real model names (with Fable), passes full
// model IDs and shows which model answered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArgs, createClaudeRunner, ClaudeError } from '../src/claude.js';
import { createModelManager } from '../src/model.js';
import { createPending, runTurn } from '../src/pipeline.js';
import { createApp } from '../src/server.js';
import { createSettingsStore, isClaudeModel } from '../src/settings.js';
import { createChatStore } from '../src/store.js';
import { answeredByLabel, CLAUDE_OPTIONS, pickerLabel } from '../public/logic.js';
import { listen, request, tick } from './helpers.js';

const IDS = ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const fx = (name) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude', name);

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'polyprompt-38-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('#38 settings accept default and the full model IDs only', () => {
  for (const id of ['default', ...IDS]) assert.equal(isClaudeModel(id), true, id);
  for (const v of ['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-4', '', null]) assert.equal(isClaudeModel(v), false, String(v));
});

test('#38 PUT /api/settings takes the full IDs and answers 400 for aliases and others', async (t) => {
  const dir = await tempDir(t);
  const settings = await createSettingsStore({ file: path.join(dir, 'settings.json') });
  const modelManager = createModelManager({ load: async () => ({ translate: async (s) => s }), isDownloaded: () => true });
  modelManager.start();
  const server = createApp({ modelManager, settings, publicDir: dir });
  const { port } = await listen(server);
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const put = (claudeModel) => request(port, 'PUT', '/api/settings', {
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claudeModel }),
  });
  for (const id of [...IDS, 'default']) {
    const r = await put(id);
    assert.equal(r.status, 200, id);
    assert.equal(r.json.claudeModel, id);
  }
  for (const bad of ['opus', 'sonnet', 'haiku', 'fable', 'claude-fable-5-9', 'gpt']) {
    assert.equal((await put(bad)).status, 400, bad);
  }
  assert.equal(settings.get().claudeModel, 'default');
});

test('#38 runner passes --model <full id>, and no --model for default', () => {
  for (const id of IDS) {
    const args = buildArgs(null, id);
    assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', id]);
    assert.equal(args.filter((a) => a === '--model').length, 1);
  }
  assert.equal(buildArgs(null, 'default').includes('--model'), false);
  assert.equal(buildArgs(null, 'opus').includes('--model'), false, 'old aliases never reach claude');
});

test('#38 old alias values migrate to full IDs on read', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'settings.json');
  for (const [old, id] of [['opus', 'claude-opus-5-5'], ['sonnet', 'claude-sonnet-5-5'], ['haiku', 'claude-haiku-5-5']]) {
    await writeFile(file, JSON.stringify({ translatorSize: '12b', claudeModel: old }));
    assert.deepEqual((await createSettingsStore({ file })).get(), { translatorSize: '12b', claudeModel: id });
  }
});

test('#38 picker lists Fable and versioned names in order, each with a one-line Thai hint', () => {
  assert.deepEqual(CLAUDE_OPTIONS.map((o) => o.value), ['default', ...IDS]);
  assert.deepEqual(CLAUDE_OPTIONS.map((o) => o.label), ['ค่าเริ่มต้น', 'Fable 5.2', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']);
  for (const o of CLAUDE_OPTIONS) assert.match(o.hint, /^[^\n]*[฀-๿][^\n]*$/, o.value);
  assert.equal(pickerLabel({ translatorSize: '4b', claudeModel: 'claude-fable-5-2' }), 'แปล 4B · Claude Fable 5.2');
});

test('#38 the runner reports the model that answered from modelUsage', async () => {
  const answer = await createClaudeRunner({ command: fx('model-usage.mjs') }).run({ prompt: 'a', model: 'claude-fable-5-2' });
  assert.deepEqual(answer, {
    text: 'hi', sessionId: 's2', model: 'claude-opus-5-5',
    // #57: the result's modelUsage is passed on as well.
    modelUsage: {
      'claude-haiku-5-5': { inputTokens: 300, outputTokens: 12 },
      'claude-opus-5-5': { inputTokens: 40, outputTokens: 250 },
    },
  });
  const plain = await createClaudeRunner({ command: fx('ok.mjs') }).run({ prompt: 'a' });
  assert.equal('model' in plain, false, 'no modelUsage, no model');
});

test('#38 a model Claude refuses is a model_rejected error', async () => {
  await assert.rejects(
    createClaudeRunner({ command: fx('model-rejected.mjs') }).run({ prompt: 'a', model: 'claude-fable-5-2' }),
    (err) => err instanceof ClaudeError && err.kind === 'model_rejected' && /claude-fable-5-2/.test(err.message),
  );
});

test('#38 "ตอบโดย" shows the answering model when it is not the one picked', () => {
  assert.equal(answeredByLabel({ model: 'claude-opus-5-5', requestedModel: 'claude-fable-5-2' }), 'ตอบโดย claude-opus-5-5');
  assert.equal(answeredByLabel({ model: 'claude-opus-5-5', requestedModel: 'default' }), 'ตอบโดย claude-opus-5-5');
  assert.equal(answeredByLabel({ model: 'claude-opus-5-5', requestedModel: 'claude-opus-5-5' }), '');
  assert.equal(answeredByLabel({ original: 'old answer' }), '');
});

async function pipeline(t, run) {
  const dir = await tempDir(t);
  const chatStore = createChatStore({ dir: path.join(dir, 'chats') });
  const settings = await createSettingsStore({ file: path.join(dir, 'settings.json') });
  const modelManager = createModelManager({ load: async () => ({ translate: async (s) => s }), isDownloaded: () => true });
  modelManager.start();
  await tick();
  const runs = [];
  const runner = { run: (opts) => { runs.push(opts); return run(opts); } };
  const deps = { chatStore, modelManager, detect: () => ({ kind: 'ok', lang: 'en' }), runner, pending: createPending(), settings };
  async function turn(text) {
    const chat = await chatStore.create(text);
    const message = { id: 'm0', role: 'user', original: text, english: null, lang: null, createdAt: 'x' };
    chat.messages.push(message);
    await runTurn(deps, chat, message);
    return chatStore.get(chat.id);
  }
  return { settings, runs, turn };
}

test('#38 the answering model is stored with the assistant message', async (t) => {
  const s = await pipeline(t, async () => ({ text: 'Hi', sessionId: 's1', model: 'claude-opus-5-5' }));
  await s.settings.update({ claudeModel: 'claude-fable-5-2' });
  const chat = await s.turn('Hello');
  const reply = chat.messages.at(-1);
  assert.equal(reply.role, 'assistant');
  assert.equal(reply.model, 'claude-opus-5-5');
  assert.equal(reply.requestedModel, 'claude-fable-5-2');
  assert.equal(answeredByLabel(reply), 'ตอบโดย claude-opus-5-5');
});

test('#38 a refused model shows the error in the chat and puts the previous selection back', async (t) => {
  const s = await pipeline(t, async ({ model }) => { throw new ClaudeError('model_rejected', model); });
  await s.settings.update({ claudeModel: 'claude-sonnet-5-5' });
  await s.settings.update({ claudeModel: 'claude-fable-5-2' });
  const chat = await s.turn('Hello');
  assert.equal(s.runs[0].model, 'claude-fable-5-2');
  const last = chat.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.error.kind, 'model_rejected');
  assert.match(last.error.message, /claude-fable-5-2/);
  assert.equal(s.settings.get().claudeModel, 'claude-sonnet-5-5');
  assert.equal(JSON.parse(await readFile(s.settings.file, 'utf8')).claudeModel, 'claude-sonnet-5-5');
});

test('#38 a refused model is not reverted when the user already picked another one', async (t) => {
  const dir = await tempDir(t);
  const settings = await createSettingsStore({ file: path.join(dir, 'settings.json') });
  await settings.update({ claudeModel: 'claude-fable-5-2' });
  await settings.update({ claudeModel: 'claude-haiku-5-5' });
  await settings.revertClaudeModel('claude-fable-5-2');
  assert.equal(settings.get().claudeModel, 'claude-haiku-5-5');
  await settings.revertClaudeModel('claude-haiku-5-5');
  assert.equal(settings.get().claudeModel, 'claude-fable-5-2');
});

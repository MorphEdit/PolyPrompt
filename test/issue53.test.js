// #53: Fable 5.2 is a real model; old CLIs reject it with an update hint, and
// the harmless stderr `unrecognized_model` warning is not an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArgs, createClaudeRunner } from '../src/claude.js';
import { createModelManager } from '../src/model.js';
import { createPending, runTurn } from '../src/pipeline.js';
import { createApp } from '../src/server.js';
import { createSettingsStore, isClaudeModel } from '../src/settings.js';
import { createChatStore } from '../src/store.js';
import { CLAUDE_OPTIONS, LEGACY_CLAUDE_MODELS } from '../public/models.js';
import { listen, request, tick } from './helpers.js';

const fx = (name) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude', name);
const UPDATE_MESSAGE = 'Claude Code ในเครื่องเก่าเกินไปสำหรับโมเดลนี้ ให้รัน `claude update` แล้วลองใหม่';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pp53-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function translator() {
  const modelManager = createModelManager({ load: async () => ({ translate: async (s) => s }), isDownloaded: () => true });
  modelManager.start();
  await tick();
  return modelManager;
}

test('#53 Fable 5.2 is offered first among named models and passed as --model', () => {
  assert.equal(isClaudeModel('claude-fable-5-2'), true);
  assert.deepEqual(CLAUDE_OPTIONS[1], { value: 'claude-fable-5-2', label: 'Fable 5.2', hint: 'รุ่นใหม่ล่าสุด เก่งงานเขียนและงานยาก' });
  assert.equal(CLAUDE_OPTIONS.filter((o) => o.hint.includes('รุ่นใหม่ล่าสุด')).length, 1);
  const args = buildArgs(null, 'claude-fable-5-2');
  assert.equal(args[args.indexOf('--model') + 1], 'claude-fable-5-2');
});

test('#53 PUT /api/settings accepts claude-fable-5-2', async (t) => {
  const dir = await tempDir(t);
  const settings = await createSettingsStore({ file: path.join(dir, 'settings.json') });
  const server = createApp({ modelManager: await translator(), settings, publicDir: dir });
  const { port } = await listen(server);
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const r = await request(port, 'PUT', '/api/settings', {
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claudeModel: 'claude-fable-5-2' }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.claudeModel, 'claude-fable-5-2');
});

test('#53 a saved claude-fable-5-2 is not rewritten to 5.1', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'settings.json');
  assert.equal(LEGACY_CLAUDE_MODELS['claude-fable-5-2'], undefined);
  await writeFile(file, JSON.stringify({ translatorSize: '4b', claudeModel: 'claude-fable-5-2' }));
  assert.equal((await createSettingsStore({ file })).get().claudeModel, 'claude-fable-5-2');
});

test('#53 a too-old CLI gives the claude update message as a model_rejected error', async () => {
  await assert.rejects(
    createClaudeRunner({ command: fx('old-cli.mjs') }).run({ prompt: 'a', model: 'claude-fable-5-2' }),
    (err) => err.kind === 'model_rejected' && err.message === UPDATE_MESSAGE,
  );
});

test('#53 an unrecognized_model warning on stderr before a good answer is not an error', async () => {
  const answer = await createClaudeRunner({ command: fx('unrecognized-ok.mjs') }).run({ prompt: 'a', model: 'claude-fable-5-2' });
  assert.equal(answer.text, 'ok');
  assert.equal(answer.model, 'claude-fable-5-2');
});

test('#53 an unrecognized_model warning does not turn a login failure into a model refusal', async () => {
  await assert.rejects(
    createClaudeRunner({ command: fx('unrecognized-auth.mjs') }).run({ prompt: 'a', model: 'claude-fable-5-2' }),
    (err) => err.kind === 'not_logged_in',
  );
});

async function chatTurn(t, command) {
  const dir = await tempDir(t);
  const chatStore = createChatStore({ dir: path.join(dir, 'chats') });
  const settings = await createSettingsStore({ file: path.join(dir, 'settings.json') });
  await settings.update({ claudeModel: 'claude-sonnet-5-5' });
  await settings.update({ claudeModel: 'claude-fable-5-2' });
  const runner = createClaudeRunner({ command: fx(command) });
  const deps = { chatStore, modelManager: await translator(), detect: () => ({ kind: 'ok', lang: 'en' }), runner, pending: createPending(), settings };
  const chat = await chatStore.create('Hello');
  const message = { id: 'm0', role: 'user', original: 'Hello', english: null, lang: null, createdAt: 'x' };
  chat.messages.push(message);
  await runTurn(deps, chat, message);
  return { settings, chat: await chatStore.get(chat.id) };
}

test('#53 the chat shows the claude update message and the picker reverts', async (t) => {
  const { settings, chat } = await chatTurn(t, 'old-cli.mjs');
  const last = chat.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.deepEqual(last.error, { kind: 'model_rejected', message: UPDATE_MESSAGE });
  assert.equal(settings.get().claudeModel, 'claude-sonnet-5-5');
  assert.equal(JSON.parse(await readFile(settings.file, 'utf8')).claudeModel, 'claude-sonnet-5-5');
});

test('#53 the chat shows the answer when stderr only warns unrecognized_model', async (t) => {
  const { settings, chat } = await chatTurn(t, 'unrecognized-ok.mjs');
  const last = chat.messages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.equal(last.original, 'ok');
  assert.equal(chat.messages.some((m) => m.error), false);
  assert.equal(settings.get().claudeModel, 'claude-fable-5-2');
});

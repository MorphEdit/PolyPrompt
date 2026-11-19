// #67: direct mode ("ส่งตรง") sends the message as typed and is the default.
// Since #71 translate mode needs no local translator either (Claude Haiku
// translates the answer back); the tests on its old pipeline follow that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelManager } from '../src/model.js';
import {
  createPending, runTurn, ANSWER_NOT_TRANSLATED_NOTE, NOT_TRANSLATED_NOTE, UNSUPPORTED_NOTE,
} from '../src/pipeline.js';
import { createApp } from '../src/server.js';
import { encodeProjectDir } from '../src/sessions.js';
import { createSettingsStore } from '../src/settings.js';
import { createChatStore } from '../src/store.js';
import {
  canSend, retryEnabled, pickerLabel, sizeOptionsDisabled, showsEnglish, modelBannerShown, SEND_MODE_OPTIONS,
} from '../public/logic.js';
import { deferred, fakeLoader, listen, request, tick } from './helpers.js';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'polyprompt-67-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

const wait = () => new Promise((r) => setTimeout(r, 10));
async function until(fn) {
  for (let i = 0; i < 300 && !fn(); i++) await wait();
}

const close = (server) => new Promise((r) => { server.close(r); server.closeAllConnections(); });

// ---- AC1: the setting ----

test('a missing, unknown or absent sendMode means direct', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'settings.json');
  assert.equal((await createSettingsStore({ file })).get().sendMode, 'direct');
  await writeFile(file, JSON.stringify({ translatorSize: '12b', claudeModel: 'default' }));
  const old = await createSettingsStore({ file });
  assert.equal(old.get().sendMode, 'direct', 'an existing install without the key');
  assert.equal(old.get().translatorSize, '12b');
  await writeFile(file, JSON.stringify({ sendMode: 'fancy' }));
  assert.equal((await createSettingsStore({ file })).get().sendMode, 'direct');
});

test('translate round-trips through the settings file', async (t) => {
  const file = path.join(await tempDir(t), 'settings.json');
  const s = await createSettingsStore({ file });
  await s.update({ sendMode: 'translate' });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).sendMode, 'translate');
  assert.equal((await createSettingsStore({ file })).get().sendMode, 'translate');
  await s.update({ sendMode: 'direct' });
  assert.equal((await createSettingsStore({ file })).get().sendMode, 'direct');
});

// A turn-capable app: real settings file, fake runner, fake translator whose
// model manager loads only when `ready` is true (or is started later).
async function appSetup(t, { sendMode, ready = false, gateRunner = false } = {}) {
  const dir = await tempDir(t);
  const file = path.join(dir, 'settings.json');
  if (sendMode) await writeFile(file, JSON.stringify({ sendMode }));
  const settings = await createSettingsStore({ file });
  const calls = [];
  const loader = fakeLoader();
  const modelManager = createModelManager({ load: loader.load });
  const translator = { async translate(text, src, tgt) { calls.push([text, src, tgt]); return `<${tgt}>${text}`; } };
  if (ready) {
    modelManager.start();
    loader.calls[0].resolve(translator);
    await tick();
  }
  const runs = [];
  const gates = [];
  const runner = {
    async run(opts) {
      runs.push(opts);
      if (gateRunner) {
        const d = deferred();
        gates.push(d);
        await d.promise;
      }
      return { text: `ตอบ: ${opts.prompt}`, sessionId: 's1' };
    },
  };
  const chatStore = createChatStore({ dir: path.join(dir, 'chats') });
  const pending = createPending();
  const detect = (text) => (/[฀-๿]/.test(text) ? { kind: 'ok', lang: 'th' } : { kind: 'ok', lang: 'en' });
  const backs = [];
  const backTranslate = async ({ text, targetLang }) => { backs.push([text, targetLang]); return `<${targetLang}>${text}`; };
  const deps = { modelManager, chatStore, settings, runner, pending, detect, publicDir: dir, backTranslate };
  const server = createApp(deps);
  const { port } = await listen(server);
  t.after(() => close(server));
  const json = (method, p, body) => request(port, method, p, {
    headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { dir, file, settings, modelManager, loader, translator, calls, backs, runs, gates, chatStore, pending, deps, port, json };
}

// ---- AC2: a direct turn ----

test('a direct turn sends the text as typed, never translates and stores the reply as Claude wrote it', async (t) => {
  const s = await appSetup(t, { ready: true });
  const chat = await s.chatStore.create('สวัสดี');
  const message = { id: 'm1', role: 'user', original: 'สวัสดี ช่วยด้วย', english: null, lang: null, createdAt: 'x' };
  chat.messages.push(message);
  await runTurn({ ...s.deps, detect: () => ({ kind: 'unsupported' }) }, chat, message, 'direct');
  assert.equal(s.runs[0].prompt, 'สวัสดี ช่วยด้วย');
  assert.equal(s.calls.length, 0);
  const saved = await s.chatStore.get(chat.id);
  const reply = saved.messages[1];
  assert.equal(reply.original, 'ตอบ: สวัสดี ช่วยด้วย');
  assert.equal(reply.mode, 'direct');
  assert.equal(reply.english, undefined);
  assert.equal(reply.note, undefined);
  for (const note of [UNSUPPORTED_NOTE, NOT_TRANSLATED_NOTE, ANSWER_NOT_TRANSLATED_NOTE]) {
    assert.ok(!JSON.stringify(saved).includes(note));
  }
  assert.equal(saved.messages[0].english, null);
  assert.equal(showsEnglish(reply), false);
});

test('runTurn without a mode reads sendMode from settings; without settings it translates', async (t) => {
  const s = await appSetup(t, { ready: true });
  const chat = await s.chatStore.create('สวัสดี');
  const m1 = { id: 'm1', role: 'user', original: 'สวัสดี', english: null, lang: null, createdAt: 'x' };
  chat.messages.push(m1);
  await runTurn(s.deps, chat, m1);
  assert.equal(s.calls.length, 0, 'settings default: direct');

  const { settings, ...noSettings } = s.deps;
  const m2 = { id: 'm2', role: 'user', original: 'ขอบคุณ', english: null, lang: null, createdAt: 'x' };
  chat.messages.push(m2);
  await runTurn(noSettings, chat, m2);
  // No settings: translate (#71: sent as typed, asked for English).
  assert.equal(s.runs[1].prompt, 'ขอบคุณ');
  assert.equal(s.runs[1].replyInEnglish, true);
  assert.equal(s.runs[0].replyInEnglish, false);
  assert.equal(s.calls.length, 0, 'never the local translator');
  // The fake answer is already Thai: shown as is, no back-translation.
  assert.deepEqual(s.backs, []);
  // AC8: an old translate reply still shows its English original, the direct one does not.
  assert.equal(showsEnglish(chat.messages[1]), false);
  assert.equal(showsEnglish({ role: 'assistant', original: '<th>Hi', english: 'Hi', lang: 'th' }), true);
});

// ---- AC4: routes ----

test('a direct send and retry succeed while the translator is not loaded, starting at thinking', async (t) => {
  const s = await appSetup(t, { gateRunner: true });
  assert.equal(s.modelManager.isReady(), false);
  const r = await s.json('POST', '/api/messages', { text: 'สวัสดี' });
  assert.equal(r.status, 202);
  assert.equal(s.pending.get(r.json.chatId), 'thinking', 'never translating');
  const steps = new Set();
  const set = s.pending.set;
  s.pending.set = (id, step) => { steps.add(step); set(id, step); };
  await until(() => s.gates.length);
  s.gates.shift().reject(Object.assign(new Error('boom'), { kind: 'failed' }));
  await until(() => !s.pending.get(r.json.chatId));
  let chat = await s.chatStore.get(r.json.chatId);
  assert.ok(chat.messages[0].error);

  const retry = await s.json('POST', `/api/chats/${chat.id}/messages/${chat.messages[0].id}/retry`);
  assert.equal(retry.status, 202);
  assert.equal(s.pending.get(chat.id), 'thinking');
  await until(() => s.gates.length);
  s.gates.shift().resolve();
  await until(() => !s.pending.get(chat.id));
  chat = await s.chatStore.get(chat.id);
  assert.equal(chat.messages[1].original, 'ตอบ: สวัสดี');
  assert.equal(s.calls.length, 0);
  assert.ok(!steps.has('translating') && !steps.has('translating_back'));
  assert.equal(s.loader.calls.length, 0, 'the translator was never loaded');
});

test('#71: a translate send and retry succeed while the translator is not ready, and load nothing', async (t) => {
  const s = await appSetup(t, { sendMode: 'translate', gateRunner: true });
  assert.equal(s.modelManager.isReady(), false);
  const r = await s.json('POST', '/api/messages', { text: 'สวัสดี' });
  assert.equal(r.status, 202);
  assert.equal(s.pending.get(r.json.chatId), 'thinking', 'never translating');
  await until(() => s.gates.length);
  s.gates.shift().reject(Object.assign(new Error('boom'), { kind: 'failed' }));
  await until(() => !s.pending.get(r.json.chatId));
  let chat = await s.chatStore.get(r.json.chatId);
  assert.ok(chat.messages[0].error);
  const retry = await s.json('POST', `/api/chats/${chat.id}/messages/${chat.messages[0].id}/retry`);
  assert.equal(retry.status, 202);
  await until(() => s.gates.length);
  s.gates.shift().resolve();
  await until(() => !s.pending.get(chat.id));
  chat = await s.chatStore.get(chat.id);
  assert.equal(chat.messages[1].original, 'ตอบ: สวัสดี');
  assert.deepEqual(s.runs.map((o) => [o.prompt, o.replyInEnglish]), [['สวัสดี', true], ['สวัสดี', true]]);
  assert.equal(s.calls.length, 0);
  assert.equal(s.loader.calls.length, 0, 'the translator was never loaded');
});

test('a direct request whose turn starts after a switch to translate stays direct', async (t) => {
  const s = await appSetup(t, { gateRunner: true });
  // Hold the chat save so the switch lands between the request and the turn.
  const save = s.chatStore.save;
  const hold = deferred();
  let held = false;
  s.chatStore.save = async (chat) => {
    if (!held) { held = true; await hold.promise; }
    return save(chat);
  };
  const sent = s.json('POST', '/api/messages', { text: 'สวัสดี' });
  for (let i = 0; i < 50 && !held; i++) await new Promise((r) => setTimeout(r, 5));
  await s.settings.update({ sendMode: 'translate' });
  hold.resolve();
  const r = await sent;
  assert.equal(r.status, 202);
  await until(() => s.gates.length);
  s.gates.shift().resolve();
  await until(() => !s.pending.get(r.json.chatId));
  const chat = await s.chatStore.get(r.json.chatId);
  assert.equal(s.runs[0].prompt, 'สวัสดี');
  assert.equal(chat.messages[1].mode, 'direct');
  assert.equal(s.calls.length, 0);
});

// ---- AC1 (API) and AC5: lazy translator ----

test('sendMode goes through the settings API; switching to translate starts no translator load (#71)', async (t) => {
  const s = await appSetup(t);
  let r = await s.json('GET', '/api/settings');
  assert.equal(r.json.sendMode, 'direct');
  assert.equal(s.loader.calls.length, 0);
  assert.equal((await s.json('PUT', '/api/settings', { sendMode: 'nope' })).status, 400);
  r = await s.json('PUT', '/api/settings', { sendMode: 'translate' });
  assert.equal(r.status, 200);
  assert.equal(r.json.sendMode, 'translate');
  assert.equal(JSON.parse(await readFile(s.file, 'utf8')).sendMode, 'translate');
  assert.equal(s.loader.calls.length, 0, 'no translator load');
  assert.equal((await s.json('GET', '/api/settings')).json.sendMode, 'translate');
  await s.json('PUT', '/api/settings', { sendMode: 'direct' });
  await s.json('PUT', '/api/settings', { sendMode: 'translate' });
  assert.equal(s.loader.calls.length, 0);
});

test('startup downloads nothing in either mode; switching to translate starts no download (#71)', async (t) => {
  const { start } = await import('../src/main.js');
  for (const sendMode of ['direct', 'translate']) {
    const dir = await tempDir(t);
    const settingsFile = path.join(dir, 'settings.json');
    if (sendMode === 'translate') await writeFile(settingsFile, JSON.stringify({ sendMode }));
    const downloads = [];
    const loads = [];
    // The real loader downloads a missing file first: a fake one that does the same.
    const download = (size) => { downloads.push(size); return new Promise(() => {}); };
    const load = (onProgress, { size }) => { loads.push(size); return download(size); };
    const server = await start({ port: 0, load, download, downloaded: () => false, chatsDir: path.join(dir, 'chats'), settingsFile });
    t.after(() => close(server));
    await tick();
    if (sendMode === 'direct') {
      assert.deepEqual(downloads, [], 'direct: no download at startup');
      assert.deepEqual(loads, []);
      const r = await request(server.address().port, 'PUT', '/api/settings', {
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sendMode: 'translate' }),
      });
      assert.equal(r.status, 200);
      assert.deepEqual(downloads, [], 'switching to translate starts nothing');
      assert.deepEqual(loads, []);
    } else {
      assert.deepEqual(downloads, [], 'translate: no download at startup');
      assert.deepEqual(loads, []);
    }
  }
});

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sessions');
const OLD = '11111111-aaaa-4aaa-8aaa-111111111111';

test('in direct mode opening an old session starts the translator load; listing does not', async (t) => {
  const s = await appSetup(t);
  const folder = path.join(s.dir, 'work');
  await mkdir(folder);
  const projectDir = path.join(s.dir, 'projects', encodeProjectDir(folder));
  await mkdir(projectDir, { recursive: true });
  for (const name of await readdir(FIXTURES)) await copyFile(path.join(FIXTURES, name), path.join(projectDir, name));
  const server = createApp({ ...s.deps, projectsDir: path.join(s.dir, 'projects'), sessionCacheDir: path.join(s.dir, 'cache') });
  const { port } = await listen(server);
  t.after(() => close(server));
  const q = `folder=${encodeURIComponent(folder)}`;

  assert.equal((await request(port, 'GET', `/api/claude-sessions?${q}`)).status, 200);
  assert.equal(s.loader.calls.length, 0, 'listing loads nothing');

  let r = await request(port, 'GET', `/api/claude-sessions/${OLD}?${q}`);
  assert.equal(r.status, 200);
  assert.ok(r.json.done < r.json.total);
  assert.equal(s.loader.calls.length, 1, 'opening starts the load');
  assert.equal(s.calls.length, 0);

  s.loader.calls[0].resolve(s.translator);
  await tick();
  r = await request(port, 'GET', `/api/claude-sessions/${OLD}?${q}`);
  for (let i = 0; i < 100 && r.json.done < r.json.total; i++) {
    await new Promise((res) => setTimeout(res, 10));
    r = await request(port, 'GET', `/api/claude-sessions/${OLD}?${q}`);
  }
  assert.equal(r.json.done, r.json.total);
  assert.ok(s.calls.length > 0, 'the next load translates');
  assert.equal(s.loader.calls.length, 1);
});

// ---- AC6 / AC7: front-end logic ----

test('in both modes sending and retrying ignore the translator state (#71)', () => {
  for (const modelState of ['loading', 'error', undefined]) {
    assert.equal(canSend({ text: 'hi', pending: false, modelState, lastMessageHasError: false, sendMode: 'direct' }), true);
    assert.equal(retryEnabled({ pending: false, modelState, sendMode: 'direct' }), true);
    assert.equal(canSend({ text: 'hi', pending: false, modelState, lastMessageHasError: false, sendMode: 'translate' }), true);
    assert.equal(retryEnabled({ pending: false, modelState, sendMode: 'translate' }), true);
  }
  // Everything else is as before.
  assert.equal(canSend({ text: ' ', pending: false, modelState: 'loading', lastMessageHasError: false, sendMode: 'direct' }), false);
  assert.equal(canSend({ text: 'hi', pending: 'thinking', modelState: 'ready', lastMessageHasError: false, sendMode: 'direct' }), false);
  assert.equal(canSend({ text: 'hi', pending: false, modelState: 'loading', lastMessageHasError: true, sendMode: 'direct' }), false);
  assert.equal(retryEnabled({ pending: true, modelState: 'loading', sendMode: 'direct' }), false);
  assert.equal(canSend({ text: 'hi', pending: false, modelState: 'ready', lastMessageHasError: false, sendMode: 'translate' }), true);
  assert.equal(retryEnabled({ pending: false, modelState: 'ready', sendMode: 'translate' }), true);
});

test('the picker label follows the mode; sizes and banner do not (#71)', () => {
  assert.deepEqual(SEND_MODE_OPTIONS.map((o) => o.label), ['ส่งตรง (แนะนำ)', 'ตอบเป็นอังกฤษแล้วแปลกลับ']);
  assert.equal(pickerLabel({ translatorSize: '4b', claudeModel: 'claude-opus-5-5', sendMode: 'direct' }), 'ส่งตรง · Claude Opus 5.5');
  assert.equal(pickerLabel({ translatorSize: '12b', claudeModel: 'default', sendMode: 'translate' }), 'แปลกลับ · Claude ค่าเริ่มต้น');
  assert.equal(sizeOptionsDisabled({ pending: false, modelState: 'ready', sendMode: 'direct' }), false);
  assert.equal(sizeOptionsDisabled({ pending: false, modelState: 'ready', sendMode: 'translate' }), false);
  assert.equal(modelBannerShown({ sendMode: 'direct' }), false);
  assert.equal(modelBannerShown({ sendMode: 'direct', sessionWaiting: true }), true);
  assert.equal(modelBannerShown({ sendMode: 'translate' }), false);
  assert.equal(modelBannerShown({ sendMode: 'translate', sessionWaiting: true }), true);
});

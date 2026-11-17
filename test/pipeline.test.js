import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeError } from '../src/claude.js';
import { createModelManager } from '../src/model.js';
import { TRANSLATE_FAILED, UNSUPPORTED_NOTE, createPending } from '../src/pipeline.js';
import { createApp } from '../src/server.js';
import { createChatStore } from '../src/store.js';
import { deferred, fakeLoader, listen, tick } from './helpers.js';

function call(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath,
      headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}

// Fake detector: exact text -> result; anything else is English.
function fakeDetect(table = {}) {
  const calls = [];
  const detect = (text) => {
    calls.push(text);
    if (!Object.hasOwn(table, text)) return { kind: 'ok', lang: 'en' };
    if (!table[text]) throw new Error('detector broke');
    return table[text];
  };
  return { detect, calls };
}

// Fake translator: tags text with its target; `gate` (if set) blocks each call.
function fakeTranslator() {
  const t = {
    calls: [],
    gate: null,
    fail: false,
    async translate(text, src, tgt) {
      t.calls.push([text, src, tgt]);
      if (t.gate) await t.gate();
      if (t.fail) throw new Error('boom');
      return `<${tgt}>${text}`;
    },
  };
  return t;
}

// Fake runner: answers with `reply` and returns the next session id.
function fakeRunner() {
  const r = {
    calls: [],
    gate: null,
    error: null,
    reply: (prompt) => `Answer to: ${prompt}`,
    sessionFor: (n) => `s${n}`,
    async run(opts) {
      r.calls.push(opts);
      if (r.gate) await r.gate();
      if (r.error) throw r.error;
      return { text: r.reply(opts.prompt), sessionId: r.sessionFor(r.calls.length) };
    },
  };
  return r;
}

async function setup(t, { ready = true, table } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'polyprompt-pipe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const chatStore = createChatStore({ dir });
  const loader = fakeLoader();
  const modelManager = createModelManager({ load: loader.load });
  modelManager.start();
  const translator = fakeTranslator();
  if (ready) {
    loader.calls[0].resolve(translator);
    await tick();
  }
  const detector = fakeDetect(table);
  const runner = fakeRunner();
  const pending = createPending();
  const server = createApp({ modelManager, chatStore, publicDir: dir, detect: detector.detect, runner, pending });
  const { port } = await listen(server);
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const api = {
    send: (body) => call(port, 'POST', '/api/messages', body),
    retry: (chatId, messageId) => call(port, 'POST', `/api/chats/${chatId}/messages/${messageId}/retry`),
    get: (chatId) => call(port, 'GET', '/api/chats/' + chatId),
    del: (chatId) => call(port, 'DELETE', '/api/chats/' + chatId),
    async idle(chatId) {
      for (let i = 0; i < 400; i++) {
        const r = await api.get(chatId);
        if (r.json.pendingStep === null) return r.json;
        await new Promise((res) => setTimeout(res, 5));
      }
      throw new Error('turn did not finish');
    },
    async turn(body) {
      const r = await api.send(body);
      assert.equal(r.status, 202);
      return { ...r.json, chat: await api.idle(r.json.chatId) };
    },
  };
  return { api, dir, chatStore, modelManager, loader, translator, detector, runner, pending };
}

const THAI = { 'สวัสดี': { kind: 'ok', lang: 'th' }, 'ok': { kind: 'unsure', lang: null },
  'Bonjour tout le monde': { kind: 'ok', lang: 'fr' }, 'Sawubona': { kind: 'unsupported', lang: null } };

test('Thai message is translated to English, sent to Claude, and translated back', async (t) => {
  const { api, translator, runner } = await setup(t, { table: THAI });
  const { chatId, messageId, chat } = await api.turn({ text: 'สวัสดี' });
  assert.deepEqual(translator.calls[0], ['สวัสดี', 'th', 'en']);
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].prompt, '<en>สวัสดี');
  assert.equal(runner.calls[0].sessionId, null);
  assert.deepEqual(translator.calls[1], ['Answer to: <en>สวัสดี', 'en', 'th']);
  assert.equal(chat.id, chatId);
  assert.equal(chat.lang, 'th');
  assert.equal(chat.sessionId, 's1');
  assert.equal(chat.messages.length, 2);
  const [u, a] = chat.messages;
  assert.equal(u.id, messageId);
  assert.deepEqual([u.role, u.original, u.english, u.lang], ['user', 'สวัสดี', '<en>สวัสดี', 'th']);
  assert.equal(u.error, undefined);
  assert.equal(a.role, 'assistant');
  assert.equal(a.english, 'Answer to: <en>สวัสดี');
  assert.equal(a.original, '<th>Answer to: <en>สวัสดี');
  assert.equal(a.lang, 'th');
  assert.equal(a.note, undefined);
});

test('English message: translator never called, answer shown untranslated', async (t) => {
  const { api, translator, runner } = await setup(t);
  const { chat } = await api.turn({ text: 'Hello there' });
  assert.equal(translator.calls.length, 0);
  assert.equal(runner.calls[0].prompt, 'Hello there');
  const [u, a] = chat.messages;
  assert.deepEqual([u.english, u.lang], ['Hello there', 'en']);
  assert.deepEqual([a.original, a.english, a.lang], ['Answer to: Hello there', 'Answer to: Hello there', 'en']);
  assert.equal(chat.lang, 'en');
});

test('code blocks, inline code and URLs survive back-translation unchanged', async (t) => {
  const { api, runner } = await setup(t, { table: THAI });
  const fence = '```js\nconst x = 1;\n```';
  runner.reply = () => `Use \`npm start\` then see https://example.com/a?b=1 here.\n\n${fence}\n\nDone.`;
  const { chat } = await api.turn({ text: 'สวัสดี' });
  const shown = chat.messages[1].original;
  assert.ok(shown.includes(fence));
  assert.ok(shown.includes('`npm start`'));
  assert.ok(shown.includes('https://example.com/a?b=1'));
  assert.ok(shown.includes('<th>'));
});

test('second message resumes the stored session; stored id follows the runner', async (t) => {
  const { api, runner } = await setup(t);
  runner.sessionFor = () => 'first';
  const { chatId } = await api.turn({ text: 'One' });
  runner.sessionFor = () => 'second';
  const { chat } = await api.turn({ chatId, text: 'Two' });
  assert.equal(runner.calls[0].sessionId, null);
  assert.equal(runner.calls[1].sessionId, 'first');
  assert.equal(chat.sessionId, 'second');
  assert.equal(chat.messages.length, 4);
  // A new chat starts without a session.
  await api.turn({ text: 'Fresh' });
  assert.equal(runner.calls[2].sessionId, null);
});

test('empty or whitespace text is 400 and nothing is called', async (t) => {
  const { api, dir, translator, detector, runner } = await setup(t);
  for (const body of [{}, { text: '' }, { text: '   \n\t' }, { text: 5 }, 'not json']) {
    assert.equal((await api.send(body)).status, 400);
  }
  assert.equal(detector.calls.length, 0);
  assert.equal(translator.calls.length, 0);
  assert.equal(runner.calls.length, 0);
  assert.deepEqual((await createChatStore({ dir }).list()), []);
});

test('model not ready: send and retry are 503', async (t) => {
  const { api, chatStore, detector, runner } = await setup(t, { ready: false });
  assert.equal((await api.send({ text: 'Hello' })).status, 503);
  const chat = await chatStore.create('x');
  chat.messages.push({ id: 'm1', role: 'user', original: 'x', english: 'x', lang: 'en',
    error: { kind: 'failed', message: 'x' }, createdAt: new Date().toISOString() });
  await chatStore.save(chat);
  assert.equal((await api.retry(chat.id, 'm1')).status, 503);
  assert.equal(detector.calls.length + runner.calls.length, 0);
});

test('unknown chat is 404 for send and retry; unknown message is 404', async (t) => {
  const { api } = await setup(t);
  const unknown = '44444444-4444-4444-8444-444444444444';
  assert.equal((await api.send({ chatId: unknown, text: 'Hi there' })).status, 404);
  assert.equal((await api.retry(unknown, 'm1')).status, 404);
  const { chatId } = await api.turn({ text: 'Hello' });
  assert.equal((await api.retry(chatId, 'nope')).status, 404);
});

test('pendingStep goes translating -> thinking -> translating_back, with 409s while pending', async (t) => {
  const { api, dir, translator, runner } = await setup(t, { table: THAI });
  const gates = [];
  const gate = () => { const d = deferred(); gates.push(d); return d.promise; };
  translator.gate = gate;
  runner.gate = gate;
  const r = await api.send({ text: 'สวัสดี' });
  assert.equal(r.status, 202);
  const { chatId } = r.json;
  const waitGate = async (n) => { while (gates.length < n) await tick(); };

  await waitGate(1);
  assert.equal((await api.get(chatId)).json.pendingStep, 'translating');
  assert.equal((await api.send({ chatId, text: 'more' })).status, 409);
  const file = path.join(dir, chatId + '.json');
  const before = await readFile(file, 'utf8');
  assert.equal((await api.del(chatId)).status, 409);
  assert.equal(await readFile(file, 'utf8'), before);
  gates[0].resolve();

  await waitGate(2);
  assert.equal((await api.get(chatId)).json.pendingStep, 'thinking');
  assert.equal((await api.send({ chatId, text: 'more' })).status, 409);
  assert.equal((await api.del(chatId)).status, 409);
  gates[1].resolve();

  await waitGate(3);
  assert.equal((await api.get(chatId)).json.pendingStep, 'translating_back');
  assert.equal((await api.del(chatId)).status, 409);
  gates[2].resolve();

  const chat = await api.idle(chatId);
  assert.equal(chat.pendingStep, null);
  assert.equal(chat.messages.length, 2);
  assert.equal((await api.del(chatId)).status, 204);
});

for (const kind of ['cli_missing', 'not_logged_in', 'timeout', 'failed']) {
  test(`runner failure ${kind}: user message kept with the error, no answer, session unchanged`, async (t) => {
    const { api, runner } = await setup(t);
    const { chatId } = await api.turn({ text: 'First' });
    runner.error = new ClaudeError(kind);
    const { messageId, chat } = await api.turn({ chatId, text: 'Second' });
    assert.equal(chat.messages.length, 3);
    const last = chat.messages[2];
    assert.equal(last.id, messageId);
    assert.equal(last.role, 'user');
    assert.deepEqual(last.error, { kind, message: new ClaudeError(kind).message });
    assert.equal(chat.sessionId, 's1');
    assert.equal((await api.send({ chatId, text: 'Third' })).status, 409);
  });
}

test('translation failure sets a failed error', async (t) => {
  const { api, translator, runner } = await setup(t, { table: THAI });
  translator.fail = true;
  const { chat } = await api.turn({ text: 'สวัสดี' });
  assert.equal(chat.messages.length, 1);
  assert.deepEqual(chat.messages[0].error, { kind: 'failed', message: TRANSLATE_FAILED });
  assert.equal(runner.calls.length, 0);
  assert.equal(chat.sessionId, null);
});

test('a GET racing the end of a turn never shows a stale chat as finished', async (t) => {
  const { api, chatStore, translator, pending } = await setup(t, { table: THAI });
  const d = deferred();
  translator.gate = () => d.promise;
  translator.fail = true;
  const { chatId } = (await api.send({ text: 'สวัสดี' })).json;
  while (pending.get(chatId) !== 'translating') await tick();
  // The GET reads the file while the turn is still running, then the turn ends.
  const get = chatStore.get;
  const read = deferred();
  const release = deferred();
  chatStore.get = async (id) => {
    const chat = await get(id);
    read.resolve();
    await release.promise;
    return chat;
  };
  const response = api.get(chatId);
  await read.promise;
  chatStore.get = get;
  d.resolve();
  while (pending.get(chatId) !== null) await tick();
  release.resolve();
  const { json } = await response;
  if (json.pendingStep === null) assert.ok(json.messages[0].error, 'finished chat must carry its error');
  else assert.equal(json.messages[0].error, undefined);
  assert.deepEqual((await api.idle(chatId)).messages[0].error, { kind: 'failed', message: TRANSLATE_FAILED });
});

test('a failed final save leaves no answer, the old session and a retryable error', async (t) => {
  const { api, chatStore, runner } = await setup(t, { table: THAI });
  const save = chatStore.save;
  let failNext = false;
  chatStore.save = async (chat) => {
    if (failNext && chat.messages.length > 1) {
      failNext = false;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return save(chat);
  };
  failNext = true;
  const { chatId, messageId, chat } = await api.turn({ text: 'สวัสดี' });
  assert.deepEqual(chat.messages.map((m) => m.role), ['user']);
  assert.equal(chat.messages[0].error.kind, 'failed');
  assert.equal(chat.sessionId, null);
  assert.equal(chat.lang, null);
  assert.equal((await api.retry(chatId, messageId)).status, 202);
  const after = await api.idle(chatId);
  assert.deepEqual(after.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(after.messages[0].error, undefined);
  assert.equal(after.sessionId, 's2');
  assert.equal(runner.calls.length, 2);
});

test('a throwing detector fails the turn without crashing the server', async (t) => {
  const { api } = await setup(t, { table: { boom: null } });
  const r = await api.turn({ text: 'boom' });
  assert.equal(r.chat.messages[0].error.kind, 'failed');
  assert.equal((await api.send({ text: 'Still alive' })).status, 202);
});

test('retry re-runs the same message; on success the error is gone and the answer follows', async (t) => {
  const { api, runner, detector, translator } = await setup(t, { table: THAI });
  runner.error = new ClaudeError('timeout');
  const { chatId, messageId } = await api.turn({ text: 'สวัสดี' });
  runner.error = null;
  translator.calls.length = 0;
  const r = await api.retry(chatId, messageId);
  assert.equal(r.status, 202);
  const chat = await api.idle(chatId);
  assert.equal(chat.messages.length, 2);
  assert.equal(chat.messages[0].id, messageId);
  assert.equal(chat.messages[0].error, undefined);
  assert.equal(chat.messages[1].role, 'assistant');
  assert.equal(chat.messages[1].original, '<th>Answer to: <en>สวัสดี');
  assert.equal(detector.calls.length, 2);
  assert.deepEqual(translator.calls[0], ['สวัสดี', 'th', 'en']);
  assert.equal(runner.calls.length, 2);
  assert.equal(chat.sessionId, 's2');
});

test('retry failure replaces the error', async (t) => {
  const { api, runner } = await setup(t);
  runner.error = new ClaudeError('timeout');
  const { chatId, messageId } = await api.turn({ text: 'Hello' });
  runner.error = new ClaudeError('not_logged_in');
  assert.equal((await api.retry(chatId, messageId)).status, 202);
  const chat = await api.idle(chatId);
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.messages[0].error.kind, 'not_logged_in');
});

test('retry of a non-last or non-failed message is 409', async (t) => {
  const { api, runner } = await setup(t);
  const first = await api.turn({ text: 'Hello' });
  const { chatId } = first;
  // Last message is the assistant answer; the user message is neither last nor failed.
  assert.equal((await api.retry(chatId, first.messageId)).status, 409);
  assert.equal((await api.retry(chatId, first.chat.messages[1].id)).status, 409);
  runner.error = new ClaudeError('failed');
  const second = await api.turn({ chatId, text: 'Again' });
  assert.equal((await api.retry(chatId, first.messageId)).status, 409);
  // Pending: retry is 409 too.
  runner.error = null;
  const d = deferred();
  runner.gate = () => d.promise;
  assert.equal((await api.retry(chatId, second.messageId)).status, 202);
  assert.equal((await api.retry(chatId, second.messageId)).status, 409);
  d.resolve();
  await api.idle(chatId);
});

test('retrying a turn marked by markInterrupted succeeds', async (t) => {
  const { api, chatStore, runner } = await setup(t);
  const chat = await chatStore.create('Hello');
  chat.messages.push({ id: 'm1', role: 'user', original: 'Hello', english: null, lang: null,
    createdAt: new Date().toISOString() });
  await chatStore.save(chat);
  assert.deepEqual(await chatStore.markInterrupted(), [chat.id]);
  assert.equal((await api.retry(chat.id, 'm1')).status, 202);
  const got = await api.idle(chat.id);
  assert.equal(got.messages.length, 2);
  assert.equal(got.messages[0].error, undefined);
  assert.equal(got.messages[1].original, 'Answer to: Hello');
  assert.equal(runner.calls.length, 1);
});

test('unsure detection uses the chat lang, or English when none, and keeps the chat lang', async (t) => {
  const { api, translator, runner } = await setup(t, { table: THAI });
  // New chat, unsure: English, no translation, chat lang stays null.
  const fresh = await api.turn({ text: 'ok' });
  assert.equal(translator.calls.length, 0);
  assert.equal(fresh.chat.messages[0].lang, 'en');
  assert.equal(fresh.chat.lang, null);

  const { chatId } = await api.turn({ text: 'สวัสดี' });
  translator.calls.length = 0;
  const { chat } = await api.turn({ chatId, text: 'ok' });
  assert.deepEqual(translator.calls[0], ['ok', 'th', 'en']);
  assert.equal(translator.calls[1][2], 'th');
  assert.equal(chat.messages[2].lang, 'th');
  assert.equal(chat.messages[3].lang, 'th');
  assert.equal(chat.lang, 'th');

  // Switching to another confident language answers in it and updates the chat.
  translator.calls.length = 0;
  const switched = await api.turn({ chatId, text: 'Bonjour tout le monde' });
  assert.deepEqual(translator.calls[0], ['Bonjour tout le monde', 'fr', 'en']);
  assert.equal(translator.calls[1][2], 'fr');
  assert.equal(switched.chat.messages[5].lang, 'fr');
  assert.equal(switched.chat.lang, 'fr');
  assert.equal(runner.calls.at(-1).prompt, '<en>Bonjour tout le monde');
});

test('unsupported language: sent as typed, English answer with a Thai note, chat lang unchanged', async (t) => {
  const { api, translator, runner } = await setup(t, { table: THAI });
  const { chatId } = await api.turn({ text: 'สวัสดี' });
  translator.calls.length = 0;
  const { chat } = await api.turn({ chatId, text: 'Sawubona' });
  assert.equal(translator.calls.length, 0);
  assert.equal(runner.calls.at(-1).prompt, 'Sawubona');
  const [u, a] = chat.messages.slice(2);
  assert.deepEqual([u.lang, u.english, u.original], [null, 'Sawubona', 'Sawubona']);
  assert.equal(a.lang, 'en');
  assert.equal(a.english, 'Answer to: Sawubona');
  assert.equal(a.original, a.english);
  assert.equal(a.note, UNSUPPORTED_NOTE);
  assert.equal(chat.lang, 'th');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createModelManager } from '../src/model.js';
import { createApp } from '../src/server.js';
import { createChatStore } from '../src/store.js';
import { fakeLoader, listen, request } from './helpers.js';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'polyprompt-chats-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function startApp(t, dir, extra = {}) {
  const chatStore = createChatStore({ dir });
  const modelManager = createModelManager({ load: fakeLoader().load });
  const server = createApp({ modelManager, chatStore, publicDir: dir, ...extra });
  const { port } = await listen(server);
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return { chatStore, port };
}

async function seed(store, text, messages) {
  const chat = await store.create(text);
  chat.messages = messages;
  return store.save(chat);
}

const user = (id, extra = {}) => ({
  id, role: 'user', original: 'สวัสดี', english: 'Hello', lang: 'th',
  createdAt: '2026-01-01T00:00:00.000Z', ...extra,
});
const assistant = (id) => ({
  id, role: 'assistant', original: 'ครับ', english: 'Yes', lang: 'th',
  createdAt: '2026-01-01T00:00:01.000Z',
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('GET /api/chats lists chats newest first', async (t) => {
  const dir = await tempDir(t);
  const { chatStore, port } = await startApp(t, dir);
  let r = await request(port, 'GET', '/api/chats');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, []);
  const a = await seed(chatStore, 'first', []);
  await wait(5);
  const b = await seed(chatStore, 'second', []);
  r = await request(port, 'GET', '/api/chats');
  assert.deepEqual(r.json, [
    { id: b.id, title: 'second', updatedAt: b.updatedAt },
    { id: a.id, title: 'first', updatedAt: a.updatedAt },
  ]);
});

test('GET /api/chats skips corrupt files with a warning', async (t) => {
  const dir = await tempDir(t);
  const { chatStore, port } = await startApp(t, dir);
  const good = await seed(chatStore, 'good', []);
  await writeFile(path.join(dir, '11111111-1111-4111-8111-111111111111.json'), '{oops');
  await writeFile(path.join(dir, '22222222-2222-4222-8222-222222222222.json'),
    JSON.stringify({ id: '22222222-2222-4222-8222-222222222222' }));
  const warnings = [];
  t.mock.method(console, 'warn', (...a) => warnings.push(a.join(' ')));
  const r = await request(port, 'GET', '/api/chats');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.map((c) => c.id), [good.id]);
  assert.equal(warnings.length, 2);
});

test('GET /api/chats/:id returns the chat plus pendingStep, 404 when unknown', async (t) => {
  const dir = await tempDir(t);
  const { chatStore, port } = await startApp(t, dir);
  const chat = await seed(chatStore, 'hi', [user('m1'), assistant('m2')]);
  let r = await request(port, 'GET', '/api/chats/' + chat.id);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ...chat, pendingStep: null });
  r = await request(port, 'GET', '/api/chats/44444444-4444-4444-8444-444444444444');
  assert.equal(r.status, 404);
});

test('pendingStep comes from the pending registry', async (t) => {
  const dir = await tempDir(t);
  const steps = new Map();
  const { chatStore, port } = await startApp(t, dir, { pending: { get: (id) => steps.get(id) ?? null } });
  const chat = await seed(chatStore, 'hi', [user('m1')]);
  steps.set(chat.id, 'thinking');
  const r = await request(port, 'GET', '/api/chats/' + chat.id);
  assert.equal(r.json.pendingStep, 'thinking');
});

test('chats survive a restart, including a failed user message', async (t) => {
  const dir = await tempDir(t);
  const first = await startApp(t, dir);
  const err = { kind: 'cli_missing', message: 'ติดตั้ง Claude Code' };
  const a = await seed(first.chatStore, 'a', [user('m1'), assistant('m2')]);
  const b = await seed(first.chatStore, 'b', [user('m1', { error: err })]);
  const listBefore = (await request(first.port, 'GET', '/api/chats')).json;
  assert.equal(listBefore.length, 2);

  const second = await startApp(t, dir);
  assert.deepEqual((await request(second.port, 'GET', '/api/chats')).json, listBefore);
  const gotA = (await request(second.port, 'GET', '/api/chats/' + a.id)).json;
  assert.deepEqual(gotA.messages, a.messages);
  const gotB = (await request(second.port, 'GET', '/api/chats/' + b.id)).json;
  assert.deepEqual(gotB.messages, b.messages);
  assert.deepEqual(gotB.messages[0].error, err);
});

test('DELETE /api/chats/:id removes the chat; unknown id is 404', async (t) => {
  const dir = await tempDir(t);
  const { chatStore, port } = await startApp(t, dir);
  const keep = await seed(chatStore, 'keep', []);
  const gone = await seed(chatStore, 'gone', [user('m1')]);
  let r = await request(port, 'DELETE', '/api/chats/' + gone.id);
  assert.equal(r.status, 204);
  assert.equal(r.body, '');
  assert.deepEqual(await readdir(dir), [keep.id + '.json']);
  r = await request(port, 'GET', '/api/chats');
  assert.deepEqual(r.json.map((c) => c.id), [keep.id]);
  assert.equal((await request(port, 'GET', '/api/chats/' + gone.id)).status, 404);
  assert.equal((await request(port, 'DELETE', '/api/chats/' + gone.id)).status, 404);
});

test('DELETE while a reply is pending is 409 and leaves the file unchanged', async (t) => {
  const dir = await tempDir(t);
  const { chatStore, port } = await startApp(t, dir, { pending: { get: () => 'translating' } });
  const chat = await seed(chatStore, 'busy', [user('m1')]);
  const file = path.join(dir, chat.id + '.json');
  const before = await readFile(file);
  const r = await request(port, 'DELETE', '/api/chats/' + chat.id);
  assert.equal(r.status, 409);
  assert.ok(r.json.error);
  assert.ok((await readFile(file)).equals(before));
});

test('ids that try to leave the chat directory are 404', async (t) => {
  const root = await tempDir(t);
  const dir = path.join(root, 'chats');
  const { port } = await startApp(t, dir);
  const outside = path.join(root, 'x.json');
  const content = JSON.stringify({ id: 'x', title: 'secret', messages: [] });
  await writeFile(outside, content);
  for (const p of ['../x', '..%2Fx', '..%2fx', '%2e%2e%2fx', '..%5Cx', '..\\x', 'x']) {
    for (const method of ['GET', 'DELETE']) {
      const r = await request(port, method, '/api/chats/' + p);
      assert.ok([400, 404].includes(r.status), `${method} ${p} -> ${r.status}`);
      assert.ok(!r.body.includes('secret'), p);
    }
  }
  assert.equal(await readFile(outside, 'utf8'), content);
});

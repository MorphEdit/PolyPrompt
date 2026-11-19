import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createChatStore, INTERRUPTED_MESSAGE, isValidId, makeTitle, TITLE_MAX } from '../src/store.js';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'polyprompt-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Clock that moves one second per call so updatedAt values differ.
function clock(start = Date.parse('2026-01-01T00:00:00.000Z')) {
  let t = start;
  return () => new Date((t += 1000));
}

function captureWarn(t) {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  return warnings;
}

const userMsg = (id, extra = {}) => ({
  id, role: 'user', original: 'สวัสดี', english: 'Hello', lang: 'th',
  createdAt: '2026-01-01T00:00:00.000Z', ...extra,
});
const assistantMsg = (id) => ({
  id, role: 'assistant', original: 'สวัสดีครับ', english: 'Hello there', lang: 'th',
  createdAt: '2026-01-01T00:00:01.000Z',
});

test('creates the directory when missing', async (t) => {
  const dir = path.join(await tempDir(t), 'nested', 'chats');
  const store = createChatStore({ dir });
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await readdir(dir), []);
});

test('create gives an empty chat with a safe id and a truncated title', async (t) => {
  const dir = await tempDir(t);
  const store = createChatStore({ dir, now: clock() });
  const chat = await store.create('  hello   world  ');
  assert.ok(isValidId(chat.id));
  assert.deepEqual(Object.keys(chat).sort(),
    ['createdAt', 'id', 'lang', 'messages', 'sessionId', 'title', 'updatedAt']);
  assert.equal(chat.title, 'hello world');
  assert.equal(chat.sessionId, null);
  assert.equal(chat.lang, null);
  assert.deepEqual(chat.messages, []);
  assert.deepEqual(await readdir(dir), [chat.id + '.json']);
  assert.notEqual((await store.create('x')).id, chat.id);

  const long = 'ก'.repeat(TITLE_MAX + 10);
  assert.equal(makeTitle(long), 'ก'.repeat(TITLE_MAX) + '…');
  assert.equal(makeTitle('a\nb'), 'a b');
});

test('create → save → get round-trips the exact file shape', async (t) => {
  const dir = await tempDir(t);
  const store = createChatStore({ dir, now: clock() });
  const chat = await store.create('สวัสดี');
  const createdAt = chat.createdAt;
  chat.sessionId = 'sess-1';
  chat.lang = 'th';
  chat.messages.push(userMsg('m1'), { ...assistantMsg('m2'), note: 'หมายเหตุ' });
  chat.messages.push(userMsg('m3', { error: { kind: 'timeout', message: 'หมดเวลา' } }));
  const before = chat.updatedAt;
  await store.save(chat);
  assert.ok(chat.updatedAt > before, 'save bumps updatedAt');
  assert.equal(chat.createdAt, createdAt);

  assert.deepEqual(await store.get(chat.id), chat);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, chat.id + '.json'), 'utf8')), chat);
  // No temp files left behind.
  assert.deepEqual(await readdir(dir), [chat.id + '.json']);
});

test('list is newest updatedAt first with id, title and updatedAt only', async (t) => {
  const dir = await tempDir(t);
  const store = createChatStore({ dir, now: clock() });
  const a = await store.create('a');
  const b = await store.create('b');
  const c = await store.create('c');
  await store.save(a);
  const list = await store.list();
  assert.deepEqual(list.map((x) => x.id), [a.id, c.id, b.id]);
  assert.deepEqual(list[0], { id: a.id, title: 'a', updatedAt: a.updatedAt });
});

test('corrupt files and files missing id or messages are skipped with a warning', async (t) => {
  const dir = await tempDir(t);
  const store = createChatStore({ dir, now: clock() });
  const good = await store.create('good');
  const badJson = '11111111-1111-4111-8111-111111111111';
  const noMessages = '22222222-2222-4222-8222-222222222222';
  const noId = '33333333-3333-4333-8333-333333333333';
  await writeFile(path.join(dir, badJson + '.json'), '{ not json');
  await writeFile(path.join(dir, noMessages + '.json'), JSON.stringify({ id: noMessages, title: 'x' }));
  await writeFile(path.join(dir, noId + '.json'), JSON.stringify({ messages: [] }));
  const warnings = captureWarn(t);
  assert.deepEqual((await store.list()).map((x) => x.id), [good.id]);
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some((w) => w.includes(badJson)));
  assert.ok(warnings.some((w) => w.includes(noMessages)));
  assert.equal(await store.get(badJson), null);
  assert.equal(await store.get(noMessages), null);
});

test('get and remove return null/false for unknown or invalid ids', async (t) => {
  const dir = await tempDir(t);
  const store = createChatStore({ dir: path.join(dir, 'chats') });
  // A file just outside the chat dir must never be reachable.
  const outside = path.join(dir, 'x.json');
  await writeFile(outside, JSON.stringify({ id: 'x', messages: [] }));
  for (const id of ['../x', '..%2Fx', '..\\x', 'x', '', 'ABC', null, undefined, '/etc/passwd']) {
    assert.equal(await store.get(id), null, String(id));
    assert.equal(await store.remove(id), false, String(id));
  }
  await assert.rejects(store.save({ id: '../x', messages: [] }), /invalid chat id/);
  assert.equal(await store.get('44444444-4444-4444-8444-444444444444'), null);
  assert.ok(JSON.parse(await readFile(outside, 'utf8')));
});

test('remove deletes the file', async (t) => {
  const dir = await tempDir(t);
  const store = createChatStore({ dir });
  const chat = await store.create('bye');
  assert.equal(await store.remove(chat.id), true);
  assert.equal(await store.get(chat.id), null);
  assert.deepEqual(await readdir(dir), []);
  assert.equal(await store.remove(chat.id), false);
});

test('markInterrupted fails only chats ending in a user message without error', async (t) => {
  const dir = await tempDir(t);
  const store = createChatStore({ dir, now: clock() });
  const make = async (messages) => {
    const chat = await store.create('t');
    chat.messages = messages;
    return store.save(chat);
  };
  const cut = await make([userMsg('m1'), assistantMsg('m2'), userMsg('m3')]);
  const answered = await make([userMsg('m1'), assistantMsg('m2')]);
  const failed = await make([userMsg('m1', { error: { kind: 'timeout', message: 'old' } })]);
  const empty = await make([]);
  const raw = (id) => readFile(path.join(dir, id + '.json'), 'utf8');
  const untouched = {};
  for (const c of [answered, failed, empty]) untouched[c.id] = await raw(c.id);
  await writeFile(path.join(dir, '55555555-5555-4555-8555-555555555555.json'), 'garbage');
  captureWarn(t);

  const marked = await createChatStore({ dir, now: clock() }).markInterrupted();
  assert.deepEqual(marked, [cut.id]);
  const got = await store.get(cut.id);
  assert.deepEqual(got.messages.at(-1).error, { kind: 'failed', message: INTERRUPTED_MESSAGE });
  assert.match(INTERRUPTED_MESSAGE, /[฀-๿]/);
  assert.deepEqual(got.messages.slice(0, 2), cut.messages.slice(0, 2));
  for (const [id, text] of Object.entries(untouched)) assert.equal(await raw(id), text);
  assert.deepEqual(await store.markInterrupted(), []);
});

test('old chats with NLLB codes load with ISO codes; the mapped values are written on the next save', async (t) => {
  const dir = await tempDir(t);
  const id = '11111111-2222-4333-8444-555555555555';
  const old = {
    id, title: 'old', createdAt: 'x', updatedAt: 'x', sessionId: 's1', lang: 'tha_Thai',
    messages: [
      { id: 'm1', role: 'user', original: 'สวัสดี', english: 'Hello', lang: 'tha_Thai', createdAt: 'x' },
      { id: 'm2', role: 'assistant', original: 'ครับ', english: 'Yes', lang: 'tha_Thai', createdAt: 'x' },
      { id: 'm3', role: 'user', original: 'ok', english: 'ok', lang: 'eng_Latn', createdAt: 'x' },
      { id: 'm4', role: 'user', original: 'x', english: 'x', lang: null, createdAt: 'x' },
      { id: 'm5', role: 'user', original: 'x', english: 'x', lang: 'th', createdAt: 'x' },
    ],
  };
  await writeFile(path.join(dir, id + '.json'), JSON.stringify(old));
  const store = createChatStore({ dir, now: clock() });
  const chat = await store.get(id);
  assert.equal(chat.lang, 'th');
  assert.deepEqual(chat.messages.map((m) => m.lang), ['th', 'th', 'en', null, 'th']);
  const onDisk = () => readFile(path.join(dir, id + '.json'), 'utf8').then(JSON.parse);
  assert.equal((await onDisk()).lang, 'tha_Thai', 'not written on read');
  await store.save(chat);
  const saved = await onDisk();
  assert.equal(saved.lang, 'th');
  assert.deepEqual(saved.messages.map((m) => m.lang), ['th', 'th', 'en', null, 'th']);
});

test('an old chat language translate mode cannot answer in becomes null; message langs keep the ISO code', async (t) => {
  const dir = await tempDir(t);
  const id = '11111111-2222-4333-8444-666666666666';
  await writeFile(path.join(dir, id + '.json'), JSON.stringify({
    id, title: 'old', sessionId: null, lang: 'zul_Latn',
    messages: [{ id: 'm1', role: 'user', original: 'x', english: 'x', lang: 'amh_Ethi', createdAt: 'x' }],
  }));
  const chat = await createChatStore({ dir }).get(id);
  assert.equal(chat.lang, null);
  assert.equal(chat.messages[0].lang, 'am');
});

test('#71: a chat language outside TranslateGemma (Amharic, Lao) is kept: Claude Haiku translates into it', async (t) => {
  const dir = await tempDir(t);
  for (const [id, lang, want] of [['11111111-2222-4333-8444-666666666667', 'amh_Ethi', 'am'], ['11111111-2222-4333-8444-666666666668', 'lo', 'lo']]) {
    await writeFile(path.join(dir, id + '.json'), JSON.stringify({ id, title: 'old', sessionId: null, lang, messages: [] }));
    assert.equal((await createChatStore({ dir }).get(id)).lang, want);
  }
});

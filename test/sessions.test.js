// #35: old Claude Code sessions of a folder (list, open with translation,
// continue), tested with the fixture JSONL files in fixtures/sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelManager } from '../src/model.js';
import { createPending } from '../src/pipeline.js';
import { createApp } from '../src/server.js';
import { encodeProjectDir, listSessions, parseSession, stripWrappers } from '../src/sessions.js';
import { createChatStore } from '../src/store.js';
import { deferred, fakeLoader, listen, request, tick } from './helpers.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sessions');
const OLD = '11111111-aaaa-4aaa-8aaa-111111111111';
const NEW = '22222222-bbbb-4bbb-8bbb-222222222222';
const EMPTY = '33333333-cccc-4ccc-8ccc-333333333333';
const USED = '44444444-dddd-4ddd-8ddd-444444444444';

test('the project folder name replaces every character outside A–Z, a–z and 0–9 with "-"', () => {
  assert.equal(encodeProjectDir('C:\\Users\\dabch\\.polyprompt\\claude-home'), 'C--Users-dabch--polyprompt-claude-home');
  assert.equal(encodeProjectDir('/home/me/my.app_v2 test/ทดสอบ'), '-home-me-my-app-v2-test------');
});

// A temp dir with a work folder whose path has a dot, an underscore, a space
// and Thai letters, and its Claude Code project dir holding the fixtures.
async function setup(t, { gate } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'polyprompt-sessions-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const folder = path.join(base, 'my.proj_v2 งาน');
  await mkdir(folder);
  const projectsDir = path.join(base, 'projects');
  const projectDir = path.join(projectsDir, encodeProjectDir(folder));
  await mkdir(projectDir, { recursive: true });
  for (const name of await readdir(FIXTURES)) await copyFile(path.join(FIXTURES, name), path.join(projectDir, name));
  const chatStore = createChatStore({ dir: path.join(base, 'chats') });
  const translator = {
    calls: [],
    gate,
    async translate(text, src, tgt) {
      translator.calls.push([text, src, tgt]);
      if (translator.gate) await translator.gate();
      return `<${tgt}>${text}`;
    },
  };
  const runner = { calls: [], async run(opts) { runner.calls.push(opts); return { text: 'ok', sessionId: opts.sessionId }; } };
  const cacheDir = path.join(base, 'cache');
  const start = async () => {
    const loader = fakeLoader();
    const modelManager = createModelManager({ load: loader.load });
    modelManager.start();
    loader.calls[0].resolve(translator);
    await tick();
    const pending = createPending();
    const server = createApp({ modelManager, chatStore, publicDir: base, runner, pending, projectsDir, sessionCacheDir: cacheDir,
      detect: () => ({ kind: 'ok', lang: 'en' }) });
    const { port } = await listen(server);
    t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
    return { port, pending, get: (p) => request(port, 'GET', p) };
  };
  return { base, folder, projectDir, projectsDir, chatStore, translator, runner, start, cacheDir };
}

const listUrl = (folder) => `/api/claude-sessions?folder=${encodeURIComponent(folder)}`;
const openUrl = (id, folder) => `/api/claude-sessions/${id}?folder=${encodeURIComponent(folder)}`;
const send = (port, body) => request(port, 'POST', '/api/messages', {
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('the list reads the encoded project dir, newest first, skips empty and used sessions and malformed lines', async (t) => {
  const s = await setup(t);
  await s.chatStore.save({ ...(await s.chatStore.create('x')), sessionId: 'other', resumedFrom: USED });
  const { get } = await s.start();
  const r = await get(listUrl(s.folder));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, [
    { id: NEW, title: 'Add a dark mode toggle', updatedAt: '2026-03-01T09:05:00.000Z' },
    { id: OLD, title: 'Fix the login bug', updatedAt: '2026-01-01T10:00:09.000Z' },
  ]);
  // A session used as a chat's sessionId is hidden too.
  await s.chatStore.save({ ...(await s.chatStore.create('y')), sessionId: OLD });
  assert.deepEqual((await get(listUrl(s.folder))).json.map((x) => x.id), [NEW]);
});

test('the list: a folder with no project dir gives [], bad folders 400/404', async (t) => {
  const s = await setup(t);
  const { get } = await s.start();
  const other = path.join(s.base, 'other');
  await mkdir(other);
  assert.deepEqual((await get(listUrl(other))).json, []);
  assert.equal((await get(listUrl('relative'))).status, 400);
  assert.equal((await get('/api/claude-sessions')).status, 400);
  assert.equal((await get(listUrl(path.join(s.base, 'missing')))).status, 404);
});

test('an unreadable session file is skipped and does not stop the rest', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const s = await setup(t);
  await chmod(path.join(s.projectDir, `${OLD}.jsonl`), 0o000);
  const list = await listSessions(s.projectsDir, s.folder);
  assert.deepEqual(list.map((x) => x.id), [USED, NEW]);
});

test('parseSession strips wrapper blocks, joins assistant lines and attaches tool calls as activity', () => {
  assert.equal(stripWrappers('<system-reminder>x</system-reminder>\nHello'), 'Hello');
  assert.equal(stripWrappers('[Request interrupted by user]'), '');
  const text = '{"type":"user","message":{"role":"user","content":"Q"}}\n'
    + '{"type":"assistant","message":{"content":[{"type":"text","text":"A1"},{"type":"tool_use","id":"t","name":"Bash","input":{"command":"npm test"}}]}}\n'
    + '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"ok"}]}}\n'
    + '{"type":"assistant","message":{"content":[{"type":"text","text":"A2"}]}}\n'
    + '[1,2\n';
  const parsed = parseSession(text);
  assert.equal(parsed.unknown, true);
  assert.deepEqual(parsed.messages, [
    { role: 'user', english: 'Q', activity: [] },
    { role: 'assistant', english: 'A1\n\nA2', activity: [{ text: '🔧 รัน `npm test`', detail: 'npm test', output: 'ok' }] },
  ]);
});

test('opening a session translates to Thai progressively, newest first, caches per session and language, creates no chat', async (t) => {
  const gate = deferred();
  const s = await setup(t, { gate: () => gate.promise });
  const first = await s.start();
  let r = await first.get(openUrl(OLD, s.folder));
  assert.equal(r.status, 200);
  assert.equal(r.json.id, OLD);
  assert.equal(r.json.folder, s.folder);
  assert.equal(r.json.total, 2);
  assert.equal(r.json.done, 0);
  assert.equal(r.json.note, undefined);
  assert.deepEqual(r.json.messages.map((m) => [m.role, m.english, m.original]), [
    ['user', 'Fix the login bug', null],
    ['assistant', 'I will read the file.\n\nFixed it.', null],
  ]);
  assert.deepEqual(r.json.messages[1].activity, [{ text: '🔍 กำลังอ่าน `src/login.js`', detail: 'src/login.js', output: 'export function login() {}' }]);
  s.translator.gate = null;
  gate.resolve();
  for (let i = 0; i < 200 && r.json.done < r.json.total; i++) {
    await new Promise((res) => setTimeout(res, 10));
    r = await first.get(openUrl(OLD, s.folder));
  }
  assert.equal(r.json.done, r.json.total);
  assert.deepEqual(r.json.messages.map((m) => m.original), ['<th>Fix the login bug', '<th>I will read the file.\n\n<th>Fixed it.']);
  // Newest first.
  assert.equal(s.translator.calls[0][0].startsWith('I will read the file.'), true);
  assert.ok(s.translator.calls.every(([, src, tgt]) => src === 'en' && tgt === 'th'));
  assert.deepEqual(await s.chatStore.list(), []);

  // Reopening (even after a restart) does not translate again.
  const calls = s.translator.calls.length;
  const second = await s.start();
  r = await second.get(openUrl(OLD, s.folder));
  assert.equal(r.json.done, r.json.total);
  assert.equal(s.translator.calls.length, calls);
  assert.ok((await readdir(s.cacheDir)).includes(`${OLD}.th.json`));
});

test('a session with an unknown format shows what can be parsed plus a Thai note', async (t) => {
  const s = await setup(t);
  const { get } = await s.start();
  let r = await get(openUrl(NEW, s.folder));
  assert.equal(r.status, 200);
  assert.match(r.json.note, /แสดงไม่ได้/);
  assert.deepEqual(r.json.messages.map((m) => m.english), ['Add a dark mode toggle', 'Done: added the toggle.']);
  // Let the background translation finish before the temp dir goes.
  for (let i = 0; i < 200 && r.json.done < r.json.total; i++) {
    await new Promise((res) => setTimeout(res, 10));
    r = await get(openUrl(NEW, s.folder));
  }
  assert.equal(r.json.done, r.json.total);
  assert.match(r.json.note, /แสดงไม่ได้/);
});

test('opening: bad id 400, unknown session 404, bad folder 400/404', async (t) => {
  const s = await setup(t);
  const { get } = await s.start();
  assert.equal((await get(openUrl('bad.id', s.folder))).status, 400);
  assert.equal((await get(openUrl('a%20b', s.folder))).status, 400);
  assert.equal((await get(openUrl('99999999-0000-4000-8000-000000000000', s.folder))).status, 404);
  assert.equal((await get(`/api/claude-sessions/${OLD}`)).status, 400);
  assert.equal((await get(openUrl(OLD, path.join(s.base, 'missing')))).status, 404);
});

test('sending in an old session creates a chat with that folder and resumes the session id', async (t) => {
  const s = await setup(t);
  const { port, pending, get } = await s.start();
  const r = await send(port, { text: 'Continue please', folder: s.folder, resumeSessionId: OLD });
  assert.equal(r.status, 202);
  while (pending.get(r.json.chatId)) await new Promise((res) => setTimeout(res, 5));
  assert.equal(s.runner.calls.length, 1);
  assert.equal(s.runner.calls[0].sessionId, OLD);
  assert.equal(s.runner.calls[0].folder, s.folder);
  const chat = await s.chatStore.get(r.json.chatId);
  assert.equal(chat.folder, s.folder);
  assert.equal(chat.resumedFrom, OLD);
  assert.equal(chat.sessionId, OLD);
  assert.deepEqual((await get(listUrl(s.folder))).json.map((x) => x.id), [USED, NEW]);
  // Already continued: 409.
  assert.equal((await send(port, { text: 'again', folder: s.folder, resumeSessionId: OLD })).status, 409);
});

test('resumeSessionId is rejected with 400 (format, no folder, with chatId) and 404 (no such session file)', async (t) => {
  const s = await setup(t);
  const { port } = await s.start();
  assert.equal((await send(port, { text: 'x', folder: s.folder, resumeSessionId: '../etc' })).status, 400);
  assert.equal((await send(port, { text: 'x', folder: s.folder, resumeSessionId: 42 })).status, 400);
  assert.equal((await send(port, { text: 'x', resumeSessionId: OLD })).status, 400);
  const chat = await s.chatStore.create('x');
  assert.equal((await send(port, { text: 'x', chatId: chat.id, folder: s.folder, resumeSessionId: OLD })).status, 400);
  assert.equal((await send(port, { text: 'x', chatId: chat.id, resumeSessionId: OLD })).status, 400);
  assert.equal((await send(port, { text: 'x', folder: s.folder, resumeSessionId: '99999999-0000-4000-8000-000000000000' })).status, 404);
  const other = path.join(s.base, 'other');
  await mkdir(other);
  assert.equal((await send(port, { text: 'x', folder: other, resumeSessionId: OLD })).status, 404);
  await writeFile(path.join(s.base, 'note.txt'), '');
  assert.equal((await send(port, { text: 'x', folder: path.join(s.base, 'note.txt'), resumeSessionId: OLD })).status, 404);
  assert.equal((await s.chatStore.list()).length, 1);
});

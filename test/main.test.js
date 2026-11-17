import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChatStore, INTERRUPTED_MESSAGE } from '../src/store.js';
import { request } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'polyprompt-main-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('entry point prints the 127.0.0.1 URL and serves before the model is ready', { timeout: 10000 }, async (t) => {
  const chatsDir = await tempDir(t);
  const child = spawn(process.execPath, [path.join(root, 'src', 'main.js')], {
    // Offline with an empty cache: the real loader must never download in tests.
    env: {
      ...process.env,
      PORT: '0',
      CHATS_DIR: chatsDir,
      POLYPROMPT_OFFLINE: '1',
      POLYPROMPT_CACHE_DIR: path.join(tmpdir(), 'polyprompt-no-cache'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', (code) => reject(new Error('exited ' + code + ': ' + out)));
  });
  assert.ok(port > 0);
  assert.equal((await request(port, 'GET', '/')).status, 200);
  const { model } = (await request(port, 'GET', '/api/status')).json;
  assert.ok(['loading', 'error'].includes(model.state));
});

test('start() listens on 127.0.0.1 only', async (t) => {
  const { start } = await import('../src/main.js');
  const server = await start({ port: 0, load: () => new Promise(() => {}), chatsDir: await tempDir(t) });
  t.after(() => server.close());
  assert.equal(server.address().address, '127.0.0.1');
});

test('start() marks interrupted turns failed before listening', async (t) => {
  const { start } = await import('../src/main.js');
  const chatsDir = await tempDir(t);
  const store = createChatStore({ dir: chatsDir });
  const chat = await store.create('hi');
  chat.messages.push({ id: 'm1', role: 'user', original: 'hi', english: 'hi', lang: 'eng_Latn',
    createdAt: new Date().toISOString() });
  await store.save(chat);
  const server = await start({ port: 0, load: () => new Promise(() => {}), chatsDir });
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const r = await request(server.address().port, 'GET', '/api/chats/' + chat.id);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.messages[0].error, { kind: 'failed', message: INTERRUPTED_MESSAGE });
  assert.equal(r.json.pendingStep, null);
});

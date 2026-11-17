import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
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
  // Chats in a subfolder so the default settings file lands in this temp dir.
  const chatsDir = path.join(await tempDir(t), 'chats');
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
  const dir = await tempDir(t);
  const server = await start({ port: 0, load: () => new Promise(() => {}), chatsDir: dir, settingsFile: path.join(dir, 'settings.json') });
  t.after(() => server.close());
  assert.equal(server.address().address, '127.0.0.1');
});

test('start() marks interrupted turns failed before listening', async (t) => {
  const { start } = await import('../src/main.js');
  const chatsDir = await tempDir(t);
  const store = createChatStore({ dir: chatsDir });
  const chat = await store.create('hi');
  chat.messages.push({ id: 'm1', role: 'user', original: 'hi', english: 'hi', lang: 'en',
    createdAt: new Date().toISOString() });
  await store.save(chat);
  const server = await start({ port: 0, load: () => new Promise(() => {}), chatsDir, settingsFile: path.join(chatsDir, 'settings.json') });
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const r = await request(server.address().port, 'GET', '/api/chats/' + chat.id);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.messages[0].error, { kind: 'failed', message: INTERRUPTED_MESSAGE });
  assert.equal(r.json.pendingStep, null);
});

const close = (server) => new Promise((r) => { server.close(r); server.closeAllConnections(); });

test('settings default to settings.json next to the chats dir and are read back after a restart', async (t) => {
  const { start } = await import('../src/main.js');
  const dir = await tempDir(t);
  const chatsDir = path.join(dir, 'chats');
  const loads = [];
  const load = (onProgress, { size }) => { loads.push(size); return Promise.resolve({ translate: async (s) => s }); };
  const opts = { port: 0, load, download: async () => {}, downloaded: (s) => s === '4b' || s === '12b', chatsDir };
  let server = await start(opts);
  let port = server.address().port;
  let r = await request(port, 'GET', '/api/settings');
  assert.deepEqual(r.json, { translatorSize: '4b', claudeModel: 'default', downloadedSizes: ['4b', '12b'] });
  r = await request(port, 'PUT', '/api/settings', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ claudeModel: 'claude-haiku-5-5', translatorSize: '12b' }),
  });
  assert.equal(r.status, 200);
  for (let i = 0; i < 100 && (await request(port, 'GET', '/api/settings')).json.translatorSize !== '12b'; i++) {
    await new Promise((res) => setTimeout(res, 10));
  }
  await new Promise((res) => setTimeout(res, 50));
  await close(server);
  const saved = JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.deepEqual(saved, { translatorSize: '12b', claudeModel: 'claude-haiku-5-5' });

  server = await start(opts);
  t.after(() => close(server));
  port = server.address().port;
  for (let i = 0; i < 100 && (await request(port, 'GET', '/api/status')).json.model.state !== 'ready'; i++) {
    await new Promise((res) => setTimeout(res, 10));
  }
  r = await request(port, 'GET', '/api/settings');
  assert.deepEqual(r.json, { translatorSize: '12b', claudeModel: 'claude-haiku-5-5', downloadedSizes: ['4b', '12b'] });
  assert.equal((await request(port, 'GET', '/api/status')).json.model.size, '12b');
  assert.deepEqual(loads, ['4b', '12b', '12b']);
});

test('start() takes an explicit settingsFile', async (t) => {
  const { start } = await import('../src/main.js');
  const dir = await tempDir(t);
  const settingsFile = path.join(dir, 'custom', 'my-settings.json');
  const server = await start({ port: 0, load: () => new Promise(() => {}), chatsDir: path.join(dir, 'chats'), settingsFile });
  t.after(() => close(server));
  const r = await request(server.address().port, 'PUT', '/api/settings', {
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claudeModel: 'claude-sonnet-5-5' }),
  });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(readFileSync(settingsFile, 'utf8')).claudeModel, 'claude-sonnet-5-5');
  assert.equal(existsSync(path.join(dir, 'settings.json')), false);
});

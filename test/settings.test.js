import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createModelManager } from '../src/model.js';
import { createApp } from '../src/server.js';
import { createSettingsStore } from '../src/settings.js';
import { deferred, listen, request, tick } from './helpers.js';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'polyprompt-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('a missing settings file means the defaults and is not written', async (t) => {
  const file = path.join(await tempDir(t), 'settings.json');
  const s = await createSettingsStore({ file });
  assert.deepEqual(s.get(), { translatorSize: '4b', claudeModel: 'default', sendMode: 'direct' });
  assert.equal(existsSync(file), false);
});

test('updates persist and are read back', async (t) => {
  const file = path.join(await tempDir(t), 'nested', 'settings.json');
  const s = await createSettingsStore({ file });
  await s.update({ claudeModel: 'claude-haiku-5-5' });
  await s.update({ translatorSize: '12b' });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { translatorSize: '12b', claudeModel: 'claude-haiku-5-5', sendMode: 'direct' });
  const again = await createSettingsStore({ file });
  assert.deepEqual(again.get(), { translatorSize: '12b', claudeModel: 'claude-haiku-5-5', sendMode: 'direct' });
});

test('unknown values in the file fall back to the defaults', async (t) => {
  const file = path.join(await tempDir(t), 'settings.json');
  await writeFile(file, JSON.stringify({ translatorSize: '70b', claudeModel: 'gpt' }));
  assert.deepEqual((await createSettingsStore({ file })).get(), { translatorSize: '4b', claudeModel: 'default', sendMode: 'direct' });
  await writeFile(file, 'not json');
  assert.deepEqual((await createSettingsStore({ file })).get(), { translatorSize: '4b', claudeModel: 'default', sendMode: 'direct' });
});

// App with a fake model manager setup and a real settings file in a temp dir.
async function setup(t, { downloaded = ['4b'] } = {}) {
  const dir = await tempDir(t);
  const file = path.join(dir, 'settings.json');
  const settings = await createSettingsStore({ file });
  const have = new Set(downloaded);
  const loads = [];
  const downloads = [];
  const modelManager = createModelManager({
    load: (onProgress, { size }) => {
      const d = deferred();
      loads.push({ size, ...d });
      return d.promise.then(() => ({ translate: async (s) => s }));
    },
    download: (size) => {
      const d = deferred();
      downloads.push({ size, ...d });
      return d.promise.then(() => have.add(size));
    },
    isDownloaded: (size) => have.has(size),
    size: settings.get().translatorSize,
    onLoaded: (size) => settings.update({ translatorSize: size }),
  });
  modelManager.start();
  const server = createApp({ modelManager, settings, publicDir: dir });
  const { port } = await listen(server);
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const put = (body) => request(port, 'PUT', '/api/settings', {
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const get = (p = '/api/settings') => request(port, 'GET', p);
  return { file, settings, modelManager, loads, downloads, put, get, have };
}

test('GET /api/settings returns both choices and the downloaded sizes', async (t) => {
  const s = await setup(t);
  const r = await s.get();
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { translatorSize: '4b', claudeModel: 'default', sendMode: 'direct', downloadedSizes: ['4b'] });
});

test('PUT /api/settings rejects bad bodies with 400 and applies nothing', async (t) => {
  const s = await setup(t);
  s.loads[0].resolve();
  await tick();
  for (const body of ['[]', 'null', '"x"', 'nope', {}, { other: 1 }, { claudeModel: 'claude-opus-5-5', other: 1 },
    { claudeModel: 'gpt' }, { translatorSize: '8b' }, { translatorSize: 4 }, { claudeModel: 'claude-opus-5-5', translatorSize: 'x' }]) {
    const r = await s.put(body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(existsSync(s.file), false);
  assert.equal(s.loads.length, 1);
  assert.equal(s.downloads.length, 0);
});

test('PUT claudeModel saves at once and survives a restart', async (t) => {
  const s = await setup(t);
  const r = await s.put({ claudeModel: 'claude-opus-5-5' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { translatorSize: '4b', claudeModel: 'claude-opus-5-5', sendMode: 'direct', downloadedSizes: ['4b'] });
  assert.equal((await s.get()).json.claudeModel, 'claude-opus-5-5');
  assert.equal((await createSettingsStore({ file: s.file })).get().claudeModel, 'claude-opus-5-5');
});

test('PUT translatorSize is saved only after the new size loads', async (t) => {
  const s = await setup(t);
  s.loads[0].resolve();
  await tick();
  let r = await s.put({ translatorSize: '12b', claudeModel: 'claude-sonnet-5-5' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { translatorSize: '4b', claudeModel: 'claude-sonnet-5-5', sendMode: 'direct', downloadedSizes: ['4b'] });
  r = await s.get('/api/status');
  assert.deepEqual(r.json, {
    model: { state: 'ready', progress: 1, error: null, size: '4b' },
    switch: { size: '12b', state: 'downloading', progress: 0, error: null },
  });
  assert.equal((await createSettingsStore({ file: s.file })).get().translatorSize, '4b', 'a restart now keeps 4b');

  s.downloads[0].resolve();
  await tick();
  r = await s.get('/api/status');
  assert.deepEqual(r.json, { model: { state: 'loading', progress: 0, error: null, size: '12b' }, switch: null });
  assert.equal((await s.get()).json.translatorSize, '4b');
  s.loads[1].resolve();
  await tick();
  await tick();
  r = await s.get();
  assert.deepEqual(r.json, { translatorSize: '12b', claudeModel: 'claude-sonnet-5-5', sendMode: 'direct', downloadedSizes: ['4b', '12b'] });
  for (let i = 0; i < 100 && (await createSettingsStore({ file: s.file })).get().translatorSize !== '12b'; i++) {
    await new Promise((res) => setTimeout(res, 20));
  }
  assert.equal((await createSettingsStore({ file: s.file })).get().translatorSize, '12b');
});

test('PUT translatorSize answers 409 while a download or a load runs, applying nothing', async (t) => {
  const s = await setup(t, { downloaded: ['4b', '12b'] });
  // Startup load.
  let r = await s.put({ translatorSize: '12b', claudeModel: 'claude-haiku-5-5' });
  assert.equal(r.status, 409);
  assert.equal(existsSync(s.file), false, 'claudeModel not applied either');
  s.loads[0].reject(new Error('x'));
  await tick();
  // Retry load.
  s.modelManager.retry();
  assert.equal((await s.put({ translatorSize: '12b' })).status, 409);
  s.loads[1].resolve();
  await tick();
  // Background download.
  assert.equal((await s.put({ translatorSize: '27b' })).status, 200);
  assert.equal((await s.put({ translatorSize: '12b' })).status, 409);
  // The Claude model alone can still change.
  assert.equal((await s.put({ claudeModel: 'claude-haiku-5-5' })).status, 200);
});

test('PUT translatorSize is accepted in the error state', async (t) => {
  const s = await setup(t, { downloaded: ['4b', '12b'] });
  s.loads[0].reject(new Error('x'));
  await tick();
  const r = await s.put({ translatorSize: '12b' });
  assert.equal(r.status, 200);
  assert.equal(s.loads.at(-1).size, '12b');
  assert.equal((await s.get('/api/status')).json.model.state, 'loading');
});

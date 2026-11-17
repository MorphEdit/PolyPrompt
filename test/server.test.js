import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelManager } from '../src/model.js';
import { createApp, requireModelReady } from '../src/server.js';
import { fakeLoader, listen, request, tick } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');

async function startApp(t) {
  const loader = fakeLoader();
  const modelManager = createModelManager({ load: loader.load });
  const server = createApp({ modelManager, publicDir });
  const address = await listen(server);
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  modelManager.start();
  return { loader, modelManager, server, port: address.port, address };
}

test('listens on 127.0.0.1 only', async (t) => {
  const { address } = await startApp(t);
  assert.equal(address.address, '127.0.0.1');
});

test('GET /api/status reports loading progress, then ready', async (t) => {
  const { loader, port } = await startApp(t);
  let r = await request(port, 'GET', '/api/status');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { model: { state: 'loading', progress: 0, error: null } });
  loader.calls[0].onProgress(0.25);
  r = await request(port, 'GET', '/api/status');
  assert.deepEqual(r.json, { model: { state: 'loading', progress: 0.25, error: null } });
  loader.calls[0].onProgress(0.75);
  r = await request(port, 'GET', '/api/status');
  assert.equal(r.json.model.progress, 0.75);
  loader.calls[0].resolve({ translate: async (s) => s });
  await tick();
  r = await request(port, 'GET', '/api/status');
  assert.deepEqual(r.json, { model: { state: 'ready', progress: 1, error: null } });
});

test('load failure gives error, server keeps answering, retry restarts loading', async (t) => {
  const { loader, port } = await startApp(t);
  loader.calls[0].reject(new Error('download failed'));
  await tick();
  let r = await request(port, 'GET', '/api/status');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { model: { state: 'error', progress: 0, error: 'download failed' } });

  r = await request(port, 'POST', '/api/model/retry');
  assert.equal(r.status, 202);
  assert.equal(loader.calls.length, 2);
  r = await request(port, 'GET', '/api/status');
  assert.equal(r.json.model.state, 'loading');

  loader.calls[1].resolve({ translate: async (s) => s });
  await tick();
  r = await request(port, 'GET', '/api/status');
  assert.equal(r.json.model.state, 'ready');

  r = await request(port, 'POST', '/api/model/retry');
  assert.equal(r.status, 202);
  assert.equal(loader.calls.length, 2);
  assert.equal((await request(port, 'GET', '/api/status')).json.model.state, 'ready');
});

test('retry while loading is a no-op', async (t) => {
  const { loader, port } = await startApp(t);
  loader.calls[0].onProgress(0.5);
  const r = await request(port, 'POST', '/api/model/retry');
  assert.equal(r.status, 202);
  assert.equal(loader.calls.length, 1);
  assert.deepEqual((await request(port, 'GET', '/api/status')).json.model,
    { state: 'loading', progress: 0.5, error: null });
});

test('unknown /api routes return 404 JSON', async (t) => {
  const { port } = await startApp(t);
  for (const [method, p] of [['GET', '/api/nope'], ['POST', '/api/status'], ['GET', '/api']]) {
    const r = await request(port, method, p);
    assert.equal(r.status, 404, method + ' ' + p);
    assert.match(r.headers['content-type'], /application\/json/);
    assert.ok(r.json.error);
  }
});

test('GET / serves public/index.html', async (t) => {
  const { port } = await startApp(t);
  const r = await request(port, 'GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.equal(r.body, await readFile(path.join(publicDir, 'index.html'), 'utf8'));
  const r2 = await request(port, 'GET', '/index.html');
  assert.equal(r2.body, r.body);
});

test('path traversal does not escape public/', async (t) => {
  const { port } = await startApp(t);
  for (const p of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json',
    '/%2e%2e%2fpackage.json', '/..%5cpackage.json', '/foo/../../package.json']) {
    const r = await request(port, 'GET', p);
    assert.notEqual(r.status, 200, p);
    assert.ok(!r.body.includes('polyprompt'), p);
  }
});

test('requireModelReady answers 503 JSON unless the model is ready', () => {
  const fakeRes = () => ({
    status: null, body: '',
    writeHead(s) { this.status = s; },
    end(b = '') { this.body += b; },
  });
  let res = fakeRes();
  assert.equal(requireModelReady(res, { isReady: () => false }), false);
  assert.equal(res.status, 503);
  assert.ok(JSON.parse(res.body).error);
  res = fakeRes();
  assert.equal(requireModelReady(res, { isReady: () => true }), true);
  assert.equal(res.status, null);
});

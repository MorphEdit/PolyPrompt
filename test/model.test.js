import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelManager, placeholderLoad } from '../src/model.js';
import { fakeLoader, tick } from './helpers.js';

test('reports loading with progress, then ready with the translator', async () => {
  const { load, calls } = fakeLoader();
  const m = createModelManager({ load });
  m.start();
  assert.equal(calls.length, 1);
  assert.deepEqual(m.status(), { state: 'loading', progress: 0, error: null });
  assert.equal(m.isReady(), false);
  assert.equal(m.translator(), null);
  calls[0].onProgress(0.4);
  assert.deepEqual(m.status(), { state: 'loading', progress: 0.4, error: null });
  const translator = { translate: async (t) => t };
  calls[0].resolve(translator);
  await tick();
  assert.deepEqual(m.status(), { state: 'ready', progress: 1, error: null });
  assert.equal(m.isReady(), true);
  assert.equal(m.translator(), translator);
});

test('start is non-blocking and only loads once', () => {
  const { load, calls } = fakeLoader();
  const m = createModelManager({ load });
  assert.equal(m.start(), undefined);
  m.start();
  assert.equal(calls.length, 1);
});

test('rejected load gives error state; retry restarts loading', async () => {
  const { load, calls } = fakeLoader();
  const m = createModelManager({ load });
  m.start();
  calls[0].reject(new Error('no internet'));
  await tick();
  assert.deepEqual(m.status(), { state: 'error', progress: 0, error: 'no internet' });
  m.retry();
  assert.equal(calls.length, 2);
  assert.deepEqual(m.status(), { state: 'loading', progress: 0, error: null });
  calls[1].resolve({ translate: async (t) => t });
  await tick();
  assert.equal(m.status().state, 'ready');
});

test('a load that throws synchronously also gives error state', async () => {
  const m = createModelManager({ load: () => { throw new Error('boom'); } });
  m.start();
  await tick();
  assert.deepEqual(m.status(), { state: 'error', progress: 0, error: 'boom' });
});

test('retry is a no-op while loading or ready', async () => {
  const { load, calls } = fakeLoader();
  const m = createModelManager({ load });
  m.start();
  m.retry();
  assert.equal(calls.length, 1);
  calls[0].resolve({ translate: async (t) => t });
  await tick();
  m.retry();
  assert.equal(calls.length, 1);
  assert.equal(m.status().state, 'ready');
});

test('placeholder loader rejects with a clear message', async () => {
  const m = createModelManager({ load: placeholderLoad });
  m.start();
  await tick();
  assert.deepEqual(m.status(), {
    state: 'error', progress: 0, error: 'translation model not implemented yet',
  });
});

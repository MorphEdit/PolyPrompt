import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressTracker } from '../src/translator.js';

test('progress is aggregated across files, non-decreasing, within 0..1, ending at 1', () => {
  const seen = [];
  const t = createProgressTracker((p) => seen.push(p));
  t.event({ status: 'initiate', file: 'config.json' });
  t.event({ status: 'progress', file: 'a.onnx', loaded: 50, total: 100 });
  // A new, larger file starts: the raw ratio drops (50/1100) but reported progress must not.
  t.event({ status: 'progress', file: 'b.onnx', loaded: 0, total: 1000 });
  t.event({ status: 'progress', file: 'a.onnx', loaded: 100, total: 100 });
  t.event({ status: 'progress', file: 'b.onnx', loaded: 1000, total: 1000 });
  t.event({ status: 'done', file: 'b.onnx' });
  t.done();
  assert.deepEqual(seen.slice(0, 2), [0.5, 0.5]);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], `non-decreasing at ${i}`);
  for (const p of seen) assert.ok(p >= 0 && p <= 1);
  assert.ok(seen.slice(0, -1).every((p) => p < 1), 'stays below 1 until done');
  assert.equal(seen.at(-1), 1);
});

test('expectedBytes keeps a small first file from jumping progress ahead', () => {
  const seen = [];
  const t = createProgressTracker((p) => seen.push(p), { expectedBytes: 1000 });
  t.event({ status: 'progress', file: 'config.json', loaded: 10, total: 10 });
  assert.equal(seen.at(-1), 0.01);
  t.event({ status: 'progress', file: 'model.onnx', loaded: 490, total: 990 });
  assert.equal(seen.at(-1), 0.5);
});

test('importing the translator module does not load transformers.js', async () => {
  const mod = await import('../src/translator.js');
  assert.equal(typeof mod.loadNllbTranslator, 'function');
  assert.ok(!Object.keys(mod).some((k) => k === 'pipeline'));
});

test('with no network and no cache, loading fails and the model manager reports error', { timeout: 60000 }, async () => {
  const os = await import('node:os');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { loadNllbTranslator } = await import('../src/translator.js');
  const { createModelManager } = await import('../src/model.js');
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'polyprompt-empty-'));
  try {
    const mm = createModelManager({ load: (p) => loadNllbTranslator(p, { offline: true, cacheDir }) });
    mm.start();
    while (mm.status().state === 'loading') await new Promise((r) => setTimeout(r, 20));
    assert.equal(mm.status().state, 'error');
    assert.match(mm.status().error, /local_files_only|not found/i);
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test('a missing transformers.js install fails with an actionable message', async () => {
  const { loadNllbTranslator } = await import('../src/translator.js');
  const missing = Object.assign(new Error("Cannot find package '@huggingface/transformers'"), { code: 'ERR_MODULE_NOT_FOUND' });
  await assert.rejects(
    loadNllbTranslator(() => {}, { importLib: () => Promise.reject(missing) }),
    (err) => /not found: run npm ci/.test(err.message) && err.cause === missing,
  );
  const other = new Error('boom');
  await assert.rejects(loadNllbTranslator(() => {}, { importLib: () => Promise.reject(other) }), (err) => err === other);
});

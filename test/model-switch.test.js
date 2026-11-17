import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelManager } from '../src/model.js';
import { deferred, tick } from './helpers.js';

// Fake sizes: load/download calls are recorded and settled by the test.
function fakes({ downloaded = ['4b'] } = {}) {
  const have = new Set(downloaded);
  const loads = [];
  const downloads = [];
  const saved = [];
  const live = new Set(); // models in memory
  const log = [];
  const translatorFor = (size) => ({
    size,
    async translate(text) {
      log.push(`${size}:${text}`);
      return `${size}:${text}`;
    },
    async dispose() { live.delete(size); },
  });
  const mm = createModelManager({
    load: (onProgress, { size }) => {
      const d = deferred();
      loads.push({ size, onProgress, ...d });
      return d.promise.then(() => {
        live.add(size);
        assert.ok(live.size <= 1, `two models in memory: ${[...live]}`);
        return translatorFor(size);
      });
    },
    download: (size, onProgress) => {
      const d = deferred();
      downloads.push({ size, onProgress, ...d });
      return d.promise.then(() => have.add(size));
    },
    isDownloaded: (size) => have.has(size),
    size: '4b',
    onLoaded: (size) => { saved.push(size); },
  });
  return { mm, loads, downloads, saved, live, log, have };
}

async function ready(f) {
  f.mm.start();
  f.loads[0].resolve();
  await tick();
  assert.equal(f.mm.status().state, 'ready');
}

test('a not-downloaded size downloads first while the old translator keeps serving, then switches', async () => {
  const f = fakes();
  await ready(f);
  assert.equal(f.mm.selectSize('12b').result, 'started');
  assert.deepEqual(f.downloads.map((d) => d.size), ['12b']);
  assert.equal(f.mm.status().state, 'ready');
  assert.equal(f.mm.status().size, '4b');
  assert.deepEqual(f.mm.switchStatus(), { size: '12b', state: 'downloading', progress: 0, error: null });
  f.downloads[0].onProgress(0.3);
  assert.equal(f.mm.switchStatus().progress, 0.3);
  assert.equal(f.mm.isBusy(), true);
  assert.equal(await f.mm.translate('a', 'en', 'th'), '4b:a', 'old model serves during the download');

  f.downloads[0].resolve();
  await tick();
  assert.equal(f.mm.switchStatus(), null);
  assert.deepEqual(f.mm.status(), { state: 'loading', progress: 0, error: null, size: '12b' });
  assert.equal(f.loads.length, 2);
  assert.equal(f.loads[1].size, '12b');
  assert.deepEqual(f.saved, ['4b'], 'not saved before it loads');
  f.loads[1].resolve();
  await tick();
  assert.deepEqual(f.mm.status(), { state: 'ready', progress: 1, error: null, size: '12b' });
  assert.deepEqual(f.saved, ['4b', '12b']);
  assert.equal(await f.mm.translate('b', 'en', 'th'), '12b:b');
  assert.deepEqual([...f.live], ['12b']);
});

test('a download failure keeps the old model and reports switch failed', async () => {
  const f = fakes();
  await ready(f);
  f.mm.selectSize('27b');
  f.downloads[0].onProgress(0.5);
  f.downloads[0].reject(Object.assign(new Error('write failed'), { code: 'ENOSPC' }));
  await tick();
  assert.equal(f.mm.status().state, 'ready');
  assert.equal(f.mm.status().size, '4b');
  const sw = f.mm.switchStatus();
  assert.equal(sw.size, '27b');
  assert.equal(sw.state, 'failed');
  assert.match(sw.error, /พื้นที่ดิสก์ไม่พอ/);
  assert.equal(f.loads.length, 1, 'nothing loaded');
  assert.equal(f.mm.isBusy(), false);
  assert.equal(await f.mm.translate('a', 'en', 'th'), '4b:a');

  // Picking it again retries the download; the failed entry is cleared.
  f.mm.selectSize('27b');
  assert.equal(f.downloads.length, 2);
  assert.equal(f.mm.switchStatus().state, 'downloading');
});

test('a load failure reverts to the previous size, which stays saved', async () => {
  const f = fakes({ downloaded: ['4b', '12b'] });
  await ready(f);
  f.mm.selectSize('12b');
  await tick();
  f.loads[1].reject(new Error('failed to allocate memory'));
  await tick();
  assert.equal(f.loads.length, 3);
  assert.equal(f.loads[2].size, '4b');
  assert.deepEqual(f.mm.status(), { state: 'loading', progress: 0, error: null, size: '4b' });
  f.loads[2].resolve();
  await tick();
  assert.equal(f.mm.status().state, 'ready');
  assert.equal(f.mm.status().size, '4b');
  assert.equal(f.mm.savedSize(), '4b');
  assert.ok(!f.saved.includes('12b'));
  const sw = f.mm.switchStatus();
  assert.equal(sw.state, 'failed');
  assert.equal(sw.size, '12b');
  assert.match(sw.error, /หน่วยความจำไม่พอ/);
});

test('if the revert also fails, the model state is error and retry loads the saved size', async () => {
  const f = fakes({ downloaded: ['4b', '12b'] });
  await ready(f);
  f.mm.selectSize('12b');
  await tick();
  f.loads[1].reject(new Error('out of memory'));
  await tick();
  f.loads[2].reject(new Error('out of memory'));
  await tick();
  assert.equal(f.mm.status().state, 'error');
  assert.match(f.mm.status().error, /หน่วยความจำไม่พอ/);
  await assert.rejects(f.mm.translate('a', 'en', 'th'));
  f.mm.retry();
  assert.equal(f.loads.at(-1).size, '4b');
});

test('a downloaded size switches without downloading', async () => {
  const f = fakes({ downloaded: ['4b', '27b'] });
  await ready(f);
  f.mm.selectSize('27b');
  assert.equal(f.downloads.length, 0);
  assert.equal(f.mm.status().state, 'loading');
  assert.equal(f.mm.status().size, '27b');
  assert.equal(f.mm.switchStatus(), null);
  await tick();
  f.loads[1].resolve();
  await tick();
  assert.equal(f.mm.status().size, '27b');
  assert.equal(f.mm.status().state, 'ready');
});

test('picking the loaded size does nothing', async () => {
  const f = fakes();
  await ready(f);
  assert.equal(f.mm.selectSize('4b').result, 'unchanged');
  assert.equal(f.loads.length, 1);
  assert.equal(f.downloads.length, 0);
});

test('size picks are refused while a download or any load runs', async () => {
  const f = fakes({ downloaded: ['4b', '12b'] });
  f.mm.start();
  assert.equal(f.mm.selectSize('12b').result, 'busy', 'startup load');
  f.loads[0].reject(new Error('x'));
  await tick();
  assert.equal(f.mm.status().state, 'error');
  assert.equal(f.mm.isBusy(), false, 'error state accepts picks');
  f.mm.retry();
  assert.equal(f.mm.selectSize('12b').result, 'busy', 'retry load');
  f.loads[1].resolve();
  await tick();
  f.mm.selectSize('27b');
  assert.equal(f.mm.selectSize('12b').result, 'busy', 'background download');
  assert.equal(f.downloads.length, 1);
});

test('in the error state a pick loads that size with no revert; a failure stays in error', async () => {
  const f = fakes({ downloaded: ['4b', '12b'] });
  f.mm.start();
  f.loads[0].reject(new Error('x'));
  await tick();
  f.mm.selectSize('12b');
  assert.equal(f.mm.status().state, 'loading');
  assert.equal(f.loads[1].size, '12b');
  f.loads[1].reject(new Error('y'));
  await tick();
  assert.equal(f.loads.length, 2, 'no revert');
  assert.equal(f.mm.status().state, 'error');
  f.mm.selectSize('12b');
  f.loads[2].resolve();
  await tick();
  assert.equal(f.mm.status().state, 'ready');
  assert.deepEqual(f.saved, ['12b']);
});

test('in-flight translations finish on the old model; ones requested during the load use the new one', async () => {
  const f = fakes({ downloaded: ['4b', '12b'] });
  await ready(f);
  // Gate the old translator so a call is in flight when the switch is requested.
  const gate = deferred();
  const loaded = f.mm.translator();
  const original = loaded.translate;
  loaded.translate = async (text, ...rest) => { await gate.promise; return original(text, ...rest); };

  const inFlight = f.mm.translate('first', 'en', 'th');
  const queued = f.mm.translate('second', 'en', 'th');
  f.mm.selectSize('12b');
  assert.equal(f.mm.status().state, 'loading');
  const during = f.mm.translate('third', 'en', 'th');
  await tick();
  assert.equal(f.loads.length, 1, 'switch waits for the queue');
  gate.resolve();
  assert.equal(await inFlight, '4b:first');
  assert.equal(await queued, '4b:second');
  await tick();
  assert.equal(f.loads.length, 2);
  f.loads[1].resolve();
  assert.equal(await during, '12b:third');
});

test('translations waiting on a switch that ends in error fail', async () => {
  const f = fakes({ downloaded: ['4b', '12b'] });
  await ready(f);
  f.mm.selectSize('12b');
  const waiting = f.mm.translate('x', 'en', 'th');
  await tick();
  f.loads[1].reject(new Error('a'));
  await tick();
  f.loads[2].reject(new Error('b'));
  await assert.rejects(waiting);
  assert.equal(f.mm.status().state, 'error');
});

test('downloadedSizes lists the sizes whose file is complete', async () => {
  const f = fakes({ downloaded: ['4b', '27b'] });
  assert.deepEqual(f.mm.downloadedSizes(), ['4b', '27b']);
});

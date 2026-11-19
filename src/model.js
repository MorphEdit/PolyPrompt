// Translation-model manager: one loaded model at a time, translations run
// through a queue (up to translator.concurrency at once, loads alone), and the
// translator size can be switched.
//
// Injected (so tests use fakes):
//   load(onProgress, { size }) -> translator { translate(text, src, tgt), dispose?(), concurrency? };
//     downloads the size first when it is missing.
//   download(size, onProgress) -> resolves once the size's file is complete.
//   isDownloaded(size) -> boolean.
//   sizes: every size that can be picked.
//   onLoaded(size): called after a size loaded (the app saves it then).

const LABEL = { '4b': '4B', '12b': '12B', '27b': '27B' };
const sizeLabel = (size) => LABEL[size] ?? String(size).toUpperCase();
const messageOf = (err) => (err && err.message) || String(err);

// Short Thai message for a failed download or load.
export function downloadError(size, err) {
  if (err?.code === 'ENOSPC' || /ENOSPC|no space/i.test(messageOf(err))) {
    return `ดาวน์โหลดโมเดลแปลภาษา ${sizeLabel(size)} ไม่สำเร็จ: พื้นที่ดิสก์ไม่พอ`;
  }
  return `ดาวน์โหลดโมเดลแปลภาษา ${sizeLabel(size)} ไม่สำเร็จ: ${messageOf(err)}`;
}

export function loadError(size, err) {
  const memory = /memory|alloc|VRAM|InsufficientMemory/i.test(`${err?.name} ${messageOf(err)}`);
  return memory
    ? `หน่วยความจำไม่พอสำหรับโมเดลแปลภาษา ${sizeLabel(size)}`
    : `โหลดโมเดลแปลภาษา ${sizeLabel(size)} ไม่สำเร็จ: ${messageOf(err)}`;
}

export function createModelManager({
  load,
  download = async () => {},
  isDownloaded = () => true,
  size: savedSize = '4b',
  sizes = ['4b', '12b', '27b'],
  onLoaded = () => {},
}) {
  let state = 'loading';
  let progress = 0;
  let error = null;
  let size = savedSize;
  let translator = null;
  let switchInfo = null;
  let started = false;
  let token = 0;

  // FIFO task queue; a task starts synchronously when it may run. Exclusive
  // tasks (loads) run alone; shared tasks (translations) run up to the loaded
  // translator's concurrency at once.
  const tasks = [];
  let active = 0;
  let exclusive = false;
  const sharedLimit = () => Math.max(1, translator?.concurrency ?? 1);
  function enqueue(fn, { shared = false } = {}) {
    return new Promise((resolve, reject) => {
      tasks.push({ fn, shared, resolve, reject });
      pump();
    });
  }
  function pump() {
    while (tasks.length && !exclusive) {
      const { shared } = tasks[0];
      if (shared ? active >= sharedLimit() : active > 0) return;
      const { fn, resolve, reject } = tasks.shift();
      active++;
      exclusive = !shared;
      let result;
      try {
        result = Promise.resolve(fn());
      } catch (err) {
        result = Promise.reject(err);
      }
      result.then(resolve, reject).finally(() => {
        active--;
        if (!shared) exclusive = false;
        pump();
      });
    }
  }

  const progressFor = (t) => (p) => {
    if (t !== token || state !== 'loading') return;
    const n = Number(p);
    if (Number.isFinite(n)) progress = Math.min(1, Math.max(0, n));
  };

  // Never keep two models in memory: the old one goes before the next loads.
  async function unload() {
    const old = translator;
    translator = null;
    try {
      await old?.dispose?.();
    } catch (err) {
      console.error('could not unload the translation model:', err);
    }
  }

  async function loadSize(target) {
    const t = ++token;
    state = 'loading';
    progress = 0;
    error = null;
    size = target;
    translator = await load(progressFor(t), { size: target });
    progress = 1;
    state = 'ready';
    savedSize = target;
    try {
      await onLoaded(target);
    } catch (err) {
      console.error('could not save the translator size:', err);
    }
  }

  // Loads `target` once the queue is idle. On failure reloads `revertTo` when
  // given (the switch error goes to switchInfo), else ends in the error state.
  function begin(target, revertTo = null) {
    state = 'loading';
    progress = 0;
    error = null;
    size = target;
    return enqueue(async () => {
      if (translator) await unload();
      try {
        return await loadSize(target);
      } catch (err) {
        console.error(`could not load translator ${target}:`, err);
        if (!revertTo) {
          state = 'error';
          error = loadError(target, err);
          return;
        }
        switchInfo = { size: target, state: 'failed', progress: 0, error: loadError(target, err) };
      }
      await unload();
      try {
        await loadSize(revertTo);
      } catch (err) {
        console.error(`could not reload translator ${revertTo}:`, err);
        state = 'error';
        error = loadError(revertTo, err);
      }
    });
  }

  function backgroundDownload(target, revertTo) {
    switchInfo = { size: target, state: 'downloading', progress: 0, error: null };
    const info = switchInfo;
    const onProgress = (p) => {
      const n = Number(p);
      if (switchInfo === info && Number.isFinite(n)) info.progress = Math.min(1, Math.max(0, n));
    };
    let pending;
    try {
      pending = Promise.resolve(download(target, onProgress));
    } catch (err) {
      pending = Promise.reject(err);
    }
    return pending.then(
      () => {
        if (switchInfo !== info) return;
        switchInfo = null;
        return begin(target, revertTo);
      },
      (err) => {
        console.error(`could not download translator ${target}:`, err);
        if (switchInfo === info) switchInfo = { ...info, state: 'failed', error: downloadError(target, err) };
      },
    );
  }

  // Never busy before the first start: no send mode loads the translator,
  // so a size pick may come first (see selectSize).
  const busy = () => started && (state === 'loading' || switchInfo?.state === 'downloading');

  return {
    start() {
      if (started) return;
      started = true;
      begin(savedSize);
    },
    // Retry loads the saved size again.
    retry() {
      if (state === 'error') begin(savedSize);
    },
    status() {
      return { state, progress, error, size };
    },
    switchStatus() {
      return switchInfo && { ...switchInfo };
    },
    isReady() {
      return state === 'ready';
    },
    // False until the first load starts (start, or a size pick).
    isStarted: () => started,
    // True while a size download or any load runs: size picks are refused.
    isBusy: busy,
    savedSize: () => savedSize,
    // Sizes whose complete model file is in the cache.
    downloadedSizes: () => sizes.filter((s) => isDownloaded(s)),
    translator() {
      return state === 'ready' ? translator : null;
    },
    // Runs one translation on whatever model is loaded when its turn in the
    // queue comes; fails when no model is loaded then.
    translate(text, srcLang, tgtLang) {
      return enqueue(() => {
        if (!translator) throw new Error('translation model is not loaded');
        return translator.translate(text, srcLang, tgtLang);
      }, { shared: true });
    },
    // Starts a size change in the background. Returns 'busy' (nothing done),
    // 'unchanged' (already loaded) or 'started'. The returned `done` promise
    // settles when the change has ended (for tests).
    selectSize(target) {
      // Not loaded yet: the pick starts the first load, of that size (the
      // loader downloads a missing file first).
      if (!started) {
        started = true;
        return { result: 'started', done: begin(target) };
      }
      if (busy()) return { result: 'busy', done: Promise.resolve() };
      if (target === size && state === 'ready') {
        switchInfo = null;
        return { result: 'unchanged', done: Promise.resolve() };
      }
      switchInfo = null;
      if (state === 'error') return { result: 'started', done: begin(target) };
      const previous = size;
      if (isDownloaded(target)) return { result: 'started', done: begin(target, previous) };
      return { result: 'started', done: backgroundDownload(target, previous) };
    },
  };
}

// Placeholder loader that always fails (kept for tests of the error path).
export async function placeholderLoad() {
  throw new Error('translation model not implemented yet');
}

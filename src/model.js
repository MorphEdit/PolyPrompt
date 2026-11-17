// Translation-model state manager. The loader is injected so tests can use
// fakes and the real transformers.js loader can be plugged in later.
export function createModelManager({ load }) {
  let state = 'loading';
  let progress = 0;
  let error = null;
  let translator = null;
  let generation = 0;
  let started = false;

  function begin() {
    const gen = ++generation;
    state = 'loading';
    progress = 0;
    error = null;
    translator = null;
    const onProgress = (p) => {
      if (gen !== generation || state !== 'loading') return;
      const n = Number(p);
      if (Number.isFinite(n)) progress = Math.min(1, Math.max(0, n));
    };
    let pending;
    try {
      pending = Promise.resolve(load(onProgress));
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.then(
      (t) => {
        if (gen !== generation) return;
        translator = t;
        progress = 1;
        state = 'ready';
      },
      (err) => {
        if (gen !== generation) return;
        state = 'error';
        error = (err && err.message) || String(err);
      },
    );
  }

  return {
    start() {
      if (started) return;
      started = true;
      begin();
    },
    retry() {
      if (state === 'error') begin();
    },
    status() {
      return { state, progress, error };
    },
    isReady() {
      return state === 'ready';
    },
    translator() {
      return state === 'ready' ? translator : null;
    },
  };
}

// Placeholder used by `npm start` until the transformers.js loader exists.
export async function placeholderLoad() {
  throw new Error('translation model not implemented yet');
}

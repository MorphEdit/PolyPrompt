// Local NLLB-200 translator via transformers.js. The library is imported
// inside the loader so importing this module never downloads anything.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = process.env.POLYPROMPT_CACHE_DIR || path.join(root, '.cache', 'models');
export const MODEL_ID = 'Xenova/nllb-200-distilled-600M';
export const DTYPE = 'q8';
// Sum of the q8 model files (~912 MB). Files report their size only once their
// download starts, so this keeps early small files from jumping progress ahead.
export const EXPECTED_BYTES = 911_959_084;

// Turns transformers.js progress events into one aggregate 0..1 value across
// files. The value never decreases and stays below 1 until done() is called.
export function createProgressTracker(onProgress = () => {}, { expectedBytes = 0 } = {}) {
  const files = new Map();
  let last = 0;
  return {
    event(info) {
      if (!info || info.status !== 'progress' || !info.file) return;
      files.set(info.file, { loaded: Number(info.loaded) || 0, total: Number(info.total) || 0 });
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      total = Math.max(total, expectedBytes);
      if (total > 0) last = Math.max(last, Math.min(0.99, loaded / total));
      onProgress(last);
    },
    done() {
      last = 1;
      onProgress(1);
    },
  };
}

// Model-manager loader: resolves to { translate(text, srcLang, tgtLang) }.
// Set POLYPROMPT_OFFLINE=1 to forbid network access (cache only).
export async function loadNllbTranslator(
  onProgress,
  { offline = process.env.POLYPROMPT_OFFLINE === '1', cacheDir = CACHE_DIR } = {},
) {
  const tracker = createProgressTracker(onProgress, { expectedBytes: EXPECTED_BYTES });
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = cacheDir;
  env.allowRemoteModels = !offline;
  const pipe = await pipeline('translation', MODEL_ID, {
    dtype: DTYPE,
    progress_callback: (info) => tracker.event(info),
  });
  tracker.done();
  return {
    async translate(text, srcLang, tgtLang) {
      const [out] = await pipe(text, { src_lang: srcLang, tgt_lang: tgtLang });
      return out.translation_text;
    },
  };
}

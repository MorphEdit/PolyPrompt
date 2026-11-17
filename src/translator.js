// Local TranslateGemma translator via node-llama-cpp (GGUF). The library is
// imported inside the loader so importing this module never downloads anything.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { languageName } from './lang.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = process.env.POLYPROMPT_CACHE_DIR || path.join(root, '.cache', 'models');

// TranslateGemma sizes (Q4_K_M quantisation, none gated). bytes is the GGUF size.
export const SIZES = {
  '4b': { bytes: 2_489_909_760 },
  '12b': { bytes: 7_300_794_112 },
  '27b': { bytes: 16_546_704_480 },
};
export const DEFAULT_SIZE = '4b';
export const isSize = (size) => typeof size === 'string' && Object.hasOwn(SIZES, size);

export const modelFileName = (size) => `translategemma-${size}-it.Q4_K_M.gguf`;
export const modelUri = (size) => `hf:mradermacher/translategemma-${size}-it-GGUF/${modelFileName(size)}`;

// A download in progress is written to `<file>.ipull` and renamed when complete,
// so the final file only exists once it is whole.
export function isDownloaded(size, { cacheDir = CACHE_DIR } = {}) {
  return isSize(size) && existsSync(path.join(cacheDir, modelFileName(size)));
}

// TranslateGemma's documented single-user-message prompt.
export function buildPrompt(text, srcLang, tgtLang) {
  const src = languageName(srcLang);
  const tgt = languageName(tgtLang);
  return `You are a professional ${src} (${srcLang}) to ${tgt} (${tgtLang}) translator. `
    + `Your goal is to accurately convey the meaning and nuances of the original ${src} text `
    + `while adhering to ${tgt} grammar, vocabulary, and cultural sensitivities.\n`
    + `Produce only the ${tgt} translation, without any additional explanations or commentary. `
    + `Please translate the following ${src} text into ${tgt}:\n\n\n${text}`;
}

const QUOTE_PAIRS = [['"', '"'], ['“', '”'], ["'", "'"], ['「', '」'], ['«', '»']];

const wrappedIn = (text, [open, close]) =>
  text.length >= open.length + close.length && text.startsWith(open) && text.endsWith(close);

// Trims the model output, removes a quote pair the source piece lacks and a
// preface line such as "Here is the translation:".
export function cleanOutput(src, out) {
  let text = String(out ?? '').trim();
  const source = String(src ?? '').trim();
  for (const pair of QUOTE_PAIRS) {
    if (wrappedIn(text, pair) && !wrappedIn(source, pair)) {
      text = text.slice(pair[0].length, -pair[1].length).trim();
      break;
    }
  }
  if (!/\n/.test(source)) {
    const m = /^([^\n]*[:：])[^\S\n]*\n([\s\S]*\S[\s\S]*)$/.exec(text);
    if (m) text = m[2].trim();
  }
  return text;
}

// Wraps a raw generator `complete(prompt) -> text` as a translator.
export function createTranslator(complete, { dispose = async () => {} } = {}) {
  return {
    async translate(text, srcLang, tgtLang) {
      return cleanOutput(text, await complete(buildPrompt(text, srcLang, tgtLang)));
    },
    dispose,
  };
}

const importLibrary = () => import('node-llama-cpp');

async function loadLibrary(importLib) {
  try {
    return await importLib();
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    throw new Error('Translation library node-llama-cpp not found: run npm ci', { cause: err });
  }
}

// Downloads the size's GGUF into cacheDir unless it is already there; a
// partial file resumes. onProgress gets 0..1. Resolves to the file path.
export async function downloadModel(
  size,
  onProgress = () => {},
  { cacheDir = CACHE_DIR, offline = process.env.POLYPROMPT_OFFLINE === '1', importLib = importLibrary } = {},
) {
  const file = path.join(cacheDir, modelFileName(size));
  if (isDownloaded(size, { cacheDir })) return file;
  if (offline) throw new Error(`model file not found: ${file} (POLYPROMPT_OFFLINE=1)`);
  const { createModelDownloader } = await loadLibrary(importLib);
  const downloader = await createModelDownloader({
    modelUri: modelUri(size),
    dirPath: cacheDir,
    fileName: modelFileName(size),
    deleteTempFileOnCancel: false,
    onProgress({ totalSize, downloadedSize }) {
      const total = totalSize || SIZES[size].bytes;
      onProgress(Math.min(0.99, downloadedSize / total));
    },
  });
  const out = await downloader.download();
  onProgress(1);
  return out;
}

// One llama.cpp runtime for the app's lifetime (GPU detection runs once).
let llamaPromise = null;
function sharedLlama(lib) {
  llamaPromise ??= Promise.resolve(lib.getLlama()).catch((err) => {
    llamaPromise = null;
    throw err;
  });
  return llamaPromise;
}

// Model-manager loader: downloads the size if missing, then loads it.
// node-llama-cpp picks CUDA, Vulkan or Metal when available, else the CPU.
export async function loadTranslateGemma(onProgress = () => {}, { size = DEFAULT_SIZE, ...opts } = {}) {
  const importLib = opts.importLib ?? importLibrary;
  const file = await downloadModel(size, onProgress, opts);
  const lib = await loadLibrary(importLib);
  const llama = await (importLib === importLibrary ? sharedLlama(lib) : lib.getLlama());
  const model = await llama.loadModel({ modelPath: file });
  let context;
  try {
    context = await model.createContext({ contextSize: { max: 8192 } });
  } catch (err) {
    await model.dispose();
    throw err;
  }
  const chat = new lib.LlamaChat({ contextSequence: context.getSequence(), chatWrapper: new lib.GemmaChatWrapper() });
  const complete = async (prompt) => {
    const res = await chat.generateResponse(
      [{ type: 'user', text: prompt }, { type: 'model', response: [] }],
      { temperature: 0, maxTokens: 2048 },
    );
    return res.response;
  };
  return createTranslator(complete, {
    async dispose() {
      chat.dispose();
      await context.dispose();
      await model.dispose();
    },
  });
}

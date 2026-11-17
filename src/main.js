import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeRunner } from './claude.js';
import { detectLanguage } from './lang.js';
import { createModelManager } from './model.js';
import { createApp } from './server.js';
import { createSettingsStore } from './settings.js';
import { createChatStore } from './store.js';
import { SIZES, downloadModel, isDownloaded, loadTranslateGemma } from './translator.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOST = '127.0.0.1';

// Builds deps, marks interrupted turns failed and listens on HOST; resolves to the listening server.
export async function start({
  port = Number(process.env.PORT ?? 3210),
  load = (onProgress, { size }) => loadTranslateGemma(onProgress, { size }),
  download = (size, onProgress) => downloadModel(size, onProgress),
  downloaded = (size) => isDownloaded(size),
  chatsDir = process.env.CHATS_DIR ?? path.join(root, 'data', 'chats'),
  settingsFile = path.join(path.dirname(chatsDir), 'settings.json'),
} = {}) {
  const settings = await createSettingsStore({ file: settingsFile });
  const modelManager = createModelManager({
    load,
    download,
    isDownloaded: downloaded,
    sizes: Object.keys(SIZES),
    size: settings.get().translatorSize,
    onLoaded: (size) => settings.update({ translatorSize: size }),
  });

  const chatStore = createChatStore({ dir: chatsDir });
  await chatStore.markInterrupted();

  const app = createApp({
    modelManager,
    chatStore,
    settings,
    runner: createClaudeRunner(),
    detect: detectLanguage,
    publicDir: path.join(root, 'public'),
  });

  return new Promise((resolve, reject) => {
    app.once('error', reject);
    app.listen(port, HOST, () => {
      const { address, port } = app.address();
      console.log(`http://${address}:${port}`);
      modelManager.start();
      resolve(app);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start();
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelManager, placeholderLoad } from './model.js';
import { createApp } from './server.js';
import { createChatStore } from './store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOST = '127.0.0.1';

// Builds deps, marks interrupted turns failed and listens on HOST; resolves to the listening server.
export async function start({
  port = Number(process.env.PORT ?? 3210),
  load = placeholderLoad,
  chatsDir = process.env.CHATS_DIR ?? path.join(root, 'data', 'chats'),
} = {}) {
  // Swap placeholderLoad for the real transformers.js loader here.
  const modelManager = createModelManager({ load });

  const chatStore = createChatStore({ dir: chatsDir });
  await chatStore.markInterrupted();

  const app = createApp({
    modelManager,
    chatStore,
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

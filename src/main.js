import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelManager, placeholderLoad } from './model.js';
import { createApp } from './server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3210);

// Swap placeholderLoad for the real transformers.js loader here.
const modelManager = createModelManager({ load: placeholderLoad });

const app = createApp({
  modelManager,
  publicDir: path.join(root, 'public'),
});

app.listen(PORT, HOST, () => {
  console.log(`http://${HOST}:${app.address().port}`);
  modelManager.start();
});

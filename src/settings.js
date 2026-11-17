// App-wide settings (translator size, Claude model) in one JSON file.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { renameRetry } from './store.js';
import { DEFAULT_SIZE, isSize } from './translator.js';

export const CLAUDE_MODELS = ['default', 'opus', 'sonnet', 'haiku'];
export const DEFAULTS = { translatorSize: DEFAULT_SIZE, claudeModel: 'default' };

export const isClaudeModel = (v) => CLAUDE_MODELS.includes(v);

// Unknown or missing values fall back to the defaults.
function clean(data) {
  const obj = data && typeof data === 'object' ? data : {};
  return {
    translatorSize: isSize(obj.translatorSize) ? obj.translatorSize : DEFAULTS.translatorSize,
    claudeModel: isClaudeModel(obj.claudeModel) ? obj.claudeModel : DEFAULTS.claudeModel,
  };
}

// Reads the file once; get() is synchronous afterwards. update() writes only
// what changed. A missing or unreadable file means the defaults.
export async function createSettingsStore({ file }) {
  let current = { ...DEFAULTS };
  try {
    current = clean(JSON.parse(await readFile(file, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`settings file ${file} unusable, using defaults: ${err.message}`);
  }
  let writing = Promise.resolve();

  async function write(snapshot) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot, null, 2));
    try {
      await renameRetry(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  return {
    file,
    get: () => ({ ...current }),
    async update(patch) {
      const next = clean({ ...current, ...patch });
      if (next.translatorSize === current.translatorSize && next.claudeModel === current.claudeModel) return { ...current };
      current = next;
      const snapshot = { ...current };
      writing = writing.catch(() => {}).then(() => write(snapshot));
      await writing;
      return { ...current };
    },
  };
}

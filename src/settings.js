// App-wide settings (send mode, translator size, Claude model) in one JSON file.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { renameRetry } from './store.js';
import { DEFAULT_SIZE, isSize } from './translator.js';
import { CLAUDE_OPTIONS, LEGACY_CLAUDE_MODELS } from '../public/models.js';

export const CLAUDE_MODELS = CLAUDE_OPTIONS.map((o) => o.value);
export const SEND_MODES = ['direct', 'translate'];
export const DEFAULTS = { translatorSize: DEFAULT_SIZE, claudeModel: 'default', sendMode: 'direct' };

export const isClaudeModel = (v) => CLAUDE_MODELS.includes(v);
export const isSendMode = (v) => SEND_MODES.includes(v);

// Unknown or missing values fall back to the defaults; old aliases
// (opus, sonnet, haiku) become their full model IDs.
function clean(data) {
  const obj = data && typeof data === 'object' ? data : {};
  const claudeModel = Object.hasOwn(LEGACY_CLAUDE_MODELS, obj.claudeModel)
    ? LEGACY_CLAUDE_MODELS[obj.claudeModel]
    : obj.claudeModel;
  return {
    translatorSize: isSize(obj.translatorSize) ? obj.translatorSize : DEFAULTS.translatorSize,
    claudeModel: isClaudeModel(claudeModel) ? claudeModel : DEFAULTS.claudeModel,
    sendMode: isSendMode(obj.sendMode) ? obj.sendMode : DEFAULTS.sendMode,
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
  // The Claude model chosen before the current one, for revertClaudeModel().
  let previousClaudeModel = DEFAULTS.claudeModel;

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

  async function update(patch) {
    const next = clean({ ...current, ...patch });
    if (Object.keys(next).every((k) => next[k] === current[k])) return { ...current };
    if (next.claudeModel !== current.claudeModel) previousClaudeModel = current.claudeModel;
    current = next;
    const snapshot = { ...current };
    writing = writing.catch(() => {}).then(() => write(snapshot));
    await writing;
    return { ...current };
  }

  return {
    file,
    get: () => ({ ...current }),
    update,
    // Claude refused `model`: go back to the model chosen before it, unless
    // the user has picked another one meanwhile.
    async revertClaudeModel(model) {
      if (current.claudeModel !== model) return { ...current };
      const back = previousClaudeModel === model ? DEFAULTS.claudeModel : previousClaudeModel;
      return update({ claudeModel: back });
    },
  };
}

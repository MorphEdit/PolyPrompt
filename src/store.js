import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const TITLE_MAX = 50;
export const INTERRUPTED_MESSAGE = 'การตอบกลับถูกขัดจังหวะ กรุณากดส่งใหม่';

// Chat ids are lowercase UUIDs, so an id can never name a path outside dir.
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isValidId = (id) => typeof id === 'string' && ID_RE.test(id);
export const newId = () => randomUUID();

export function makeTitle(text) {
  const flat = String(text).trim().replace(/\s+/g, ' ');
  const chars = Array.from(flat);
  return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX).join('') + '…' : flat;
}

// Windows refuses to replace a file another handle is reading (EPERM/EACCES/
// EBUSY), e.g. while the page polls the chat; such renames are retried briefly.
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
async function renameRetry(from, to, tries = 20) {
  for (let i = 1; ; i++) {
    try {
      return await rename(from, to);
    } catch (err) {
      if (i >= tries || !BUSY.has(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 5 * i));
    }
  }
}

const isChat = (c) => c !== null && typeof c === 'object'
  && typeof c.id === 'string' && Array.isArray(c.messages);

export function createChatStore({ dir = 'data/chats', now = () => new Date() } = {}) {
  const ready = mkdir(dir, { recursive: true });
  const file = (id) => path.join(dir, id + '.json');

  // Reads and checks one chat file; null (with a warning) when unusable.
  async function read(name) {
    let text;
    try {
      text = await readFile(path.join(dir, name), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    let chat;
    try {
      chat = JSON.parse(text);
    } catch (err) {
      console.warn(`skipping chat file ${name}: invalid JSON (${err.message})`);
      return null;
    }
    if (!isChat(chat)) {
      console.warn(`skipping chat file ${name}: missing id or messages`);
      return null;
    }
    return chat;
  }

  async function readAll() {
    await ready;
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json') && isValidId(n.slice(0, -5)));
    const chats = await Promise.all(names.map(read));
    return chats.filter(Boolean);
  }

  async function save(chat) {
    if (!isValidId(chat?.id)) throw new Error('invalid chat id');
    await ready;
    chat.updatedAt = now().toISOString();
    const tmp = path.join(dir, `.${chat.id}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(chat, null, 2));
    try {
      await renameRetry(tmp, file(chat.id));
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return chat;
  }

  return {
    dir,

    async list() {
      const chats = await readAll();
      return chats
        .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },

    async get(id) {
      if (!isValidId(id)) return null;
      await ready;
      return read(id + '.json');
    },

    async create(firstText) {
      const at = now().toISOString();
      const chat = {
        id: newId(),
        title: makeTitle(firstText),
        createdAt: at,
        updatedAt: at,
        sessionId: null,
        lang: null,
        messages: [],
      };
      return save(chat);
    },

    save,

    // Returns true when a file was removed, false when the id is unknown.
    async remove(id) {
      if (!isValidId(id)) return false;
      await ready;
      try {
        await rm(file(id));
        return true;
      } catch (err) {
        if (err.code === 'ENOENT') return false;
        throw err;
      }
    },

    // Marks turns cut off by a stop or crash as failed; returns their chat ids.
    async markInterrupted() {
      const marked = [];
      for (const chat of await readAll()) {
        const last = chat.messages.at(-1);
        if (!last || last.role !== 'user' || last.error) continue;
        last.error = { kind: 'failed', message: INTERRUPTED_MESSAGE };
        await save(chat);
        marked.push(chat.id);
      }
      return marked;
    },
  };
}

// Old Claude Code sessions of a folder: listed from
// ~/.claude/projects/<encoded folder>/<sessionId>.jsonl and shown read only,
// translated to Thai with a per-session, per-language disk cache. The JSONL
// format is internal to Claude Code, so everything is parsed defensively.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { activityLine, truncateOutput } from './activity.js';
import { resultText } from './stream.js';
import { makeTitle, renameRetry } from './store.js';
import { translateText } from './text.js';

export const SESSION_LANG = 'th';
export const UNKNOWN_NOTE = 'บางส่วนของแชตนี้แสดงไม่ได้ (รูปแบบไฟล์ไม่รู้จัก)';
export const FAILED_NOTE = 'แปลบางข้อความไม่สำเร็จ จึงแสดงเป็นภาษาอังกฤษ';

const SESSION_ID = /^[A-Za-z0-9-]{1,200}$/;
export const isValidSessionId = (id) => typeof id === 'string' && SESSION_ID.test(id);

export function defaultProjectsDir() {
  return process.env.CLAUDE_PROJECTS_DIR || path.join(homedir(), '.claude', 'projects');
}

// Claude Code's project folder name: every character outside A–Z, a–z and
// 0–9 becomes "-" (per UTF-16 unit, as Claude Code does it).
export function encodeProjectDir(folder) {
  return String(folder).replace(/[^A-Za-z0-9]/g, '-');
}

export const sessionFile = (projectsDir, folder, id) => path.join(projectsDir, encodeProjectDir(folder), `${id}.jsonl`);

// Wrapper blocks Claude Code adds around or instead of what the user typed.
const WRAPPERS = /<(system-reminder|command-name|command-message|command-args|command-contents|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)>[\s\S]*?<\/\1>/g;
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;

export function stripWrappers(text) {
  const s = String(text).replace(WRAPPERS, '').trim();
  return INTERRUPTED.test(s) ? '' : s;
}

const KNOWN_BLOCKS = new Set(['text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking', 'image', 'document']);

// Parses one session file: { messages: [{ role, english, activity }], title,
// updatedAt, unknown }. Unparseable lines are skipped and set `unknown`.
export function parseSession(text) {
  const messages = [];
  const tools = new Map();
  let updatedAt = null;
  let unknown = false;
  let current = null; // the assistant message being built
  for (const raw of String(text).split('\n')) {
    if (!raw.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      unknown = true;
      continue;
    }
    if (!ev || typeof ev !== 'object') {
      unknown = true;
      continue;
    }
    if (typeof ev.timestamp === 'string' && !Number.isNaN(Date.parse(ev.timestamp))) {
      if (!updatedAt || Date.parse(ev.timestamp) > Date.parse(updatedAt)) updatedAt = new Date(ev.timestamp).toISOString();
    }
    if (ev.type !== 'user' && ev.type !== 'assistant') continue;
    if (ev.isMeta || ev.isSidechain) continue;
    const content = ev.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : null;
    if (!blocks) {
      unknown = true;
      continue;
    }
    if (blocks.some((b) => !KNOWN_BLOCKS.has(b?.type))) unknown = true;
    if (ev.type === 'user') {
      for (const b of blocks) {
        if (b?.type !== 'tool_result') continue;
        const line = tools.get(b.tool_use_id);
        if (line) Object.assign(line, truncateOutput(resultText(b.content)));
      }
      const typed = stripWrappers(blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n'));
      if (typed) {
        messages.push({ role: 'user', english: typed, activity: [] });
        current = null;
      }
    } else {
      if (!current) {
        current = { role: 'assistant', english: '', activity: [] };
        messages.push(current);
      }
      for (const b of blocks) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          current.english = current.english ? `${current.english}\n\n${b.text}` : b.text;
        } else if (b?.type === 'tool_use' && typeof b.name === 'string') {
          const line = activityLine(b.name, b.input && typeof b.input === 'object' ? b.input : {});
          if (b.id) tools.set(b.id, line);
          current.activity.push(line);
        }
      }
    }
  }
  const first = messages.find((m) => m.role === 'user');
  return { messages, title: first ? makeTitle(first.english) : null, updatedAt, unknown };
}

// [{ id, title, updatedAt }] newest first; sessions with no real user
// message and those in `exclude` (used by saved chats) are left out. A file
// that can't be read is skipped.
export async function listSessions(projectsDir, folder, exclude = new Set()) {
  const dir = path.join(projectsDir, encodeProjectDir(folder));
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (['ENOENT', 'ENOTDIR'].includes(err.code)) return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    const id = name.slice(0, -'.jsonl'.length);
    if (!name.endsWith('.jsonl') || !isValidSessionId(id) || exclude.has(id)) continue;
    try {
      const file = path.join(dir, name);
      const parsed = parseSession(await readFile(file, 'utf8'));
      if (!parsed.title) continue;
      const updatedAt = parsed.updatedAt ?? (await stat(file)).mtime.toISOString();
      out.push({ id, title: parsed.title, updatedAt });
    } catch (err) {
      console.warn(`skipping Claude Code session ${name}: ${err.message}`);
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function sessionExists(projectsDir, folder, id) {
  try {
    return (await stat(sessionFile(projectsDir, folder, id))).isFile();
  } catch {
    return false;
  }
}

const hash = (text) => createHash('sha256').update(text).digest('hex');

// Opens sessions read only and translates their messages in the background,
// newest first. get() never waits for a translation.
export function createSessionViewer({ projectsDir = defaultProjectsDir(), cacheDir, modelManager, maxChars = 2000, lang = SESSION_LANG }) {
  const caches = new Map(); // `${id}.${lang}` -> Promise<{ [hash]: translation }>
  const jobs = new Map(); // key -> running promise
  const failed = new Map(); // key -> Set of hashes that failed this run

  const cacheFile = (key) => path.join(cacheDir, `${key}.json`);

  function loadCache(key) {
    if (!caches.has(key)) {
      caches.set(key, readFile(cacheFile(key), 'utf8')
        .then((text) => {
          const data = JSON.parse(text);
          return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
        })
        .catch(() => ({})));
    }
    return caches.get(key);
  }

  async function saveCache(key, cache) {
    await mkdir(cacheDir, { recursive: true });
    const tmp = path.join(cacheDir, `.${key}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(cache));
    try {
      await renameRetry(tmp, cacheFile(key));
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  function startJob(key, messages, cache) {
    if (jobs.has(key) || !modelManager.isReady()) return;
    const bad = failed.get(key) ?? new Set();
    failed.set(key, bad);
    const translator = { translate: (text, src, tgt) => modelManager.translate(text, src, tgt) };
    const todo = messages.filter((m) => m.english && !Object.hasOwn(cache, hash(m.english)) && !bad.has(hash(m.english))).reverse();
    if (!todo.length) return;
    const job = (async () => {
      for (const m of todo) {
        const h = hash(m.english);
        if (Object.hasOwn(cache, h)) continue;
        try {
          cache[h] = await translateText(translator, m.english, 'en', lang, { maxChars });
        } catch (err) {
          console.error('could not translate a Claude Code session message:', err?.message ?? err);
          bad.add(h);
          continue;
        }
        try {
          await saveCache(key, cache);
        } catch (err) {
          console.error('could not save session translations:', err);
        }
      }
    })().finally(() => jobs.delete(key));
    jobs.set(key, job);
  }

  return {
    // { id, folder, messages: [{ role, english, original, activity }], done, total, note? }
    async get(folder, id) {
      const parsed = parseSession(await readFile(sessionFile(projectsDir, folder, id), 'utf8'));
      const key = `${id}.${lang}`;
      const cache = await loadCache(key);
      const bad = failed.get(key) ?? new Set();
      let done = 0;
      let total = 0;
      let anyFailed = false;
      const messages = parsed.messages.map((m) => {
        let original = m.english ? null : '';
        if (m.english) {
          total++;
          const h = hash(m.english);
          if (Object.hasOwn(cache, h)) original = cache[h];
          else if (bad.has(h)) {
            original = m.english;
            anyFailed = true;
          }
          if (original !== null) done++;
        }
        return { role: m.role, english: m.english, original, activity: m.activity };
      });
      if (done < total) {
        // Opening a session that needs translating loads the translator (a
        // no-op once started); the next poll translates once it is ready.
        if (!modelManager.isReady()) modelManager.start?.();
        startJob(key, parsed.messages, cache);
      }
      const notes = [];
      if (parsed.unknown) notes.push(UNKNOWN_NOTE);
      if (anyFailed) notes.push(FAILED_NOTE);
      const body = { id, folder, messages, done, total };
      if (notes.length) body.note = notes.join(' ');
      return body;
    },
    // Resolves once the running translation (if any) is finished; for tests.
    idle: (id) => jobs.get(`${id}.${lang}`) ?? Promise.resolve(),
  };
}

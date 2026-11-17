import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { FolderError, checkFolder, listFolders } from './folders.js';
import { detectLanguage } from './lang.js';
import { DECISIONS, createPending, runTurn } from './pipeline.js';
import { createSessionViewer, defaultProjectsDir, isValidSessionId, listSessions, sessionExists } from './sessions.js';
import { isClaudeModel } from './settings.js';
import { newId } from './store.js';
import { isSize } from './translator.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

// Answers 503 when the translation model is not ready. Returns true when the
// request may proceed.
export function requireModelReady(res, modelManager) {
  if (modelManager.isReady()) return true;
  sendError(res, 503, 'translation model is not ready');
  return false;
}

// The id is passed raw (still percent-encoded); the chat store rejects
// anything that is not a valid chat id.
const CHAT_PATH = /^\/api\/chats\/(?<id>[^/]+)$/;

const RETRY_PATH = /^\/api\/chats\/(?<id>[^/]+)\/messages\/(?<messageId>[^/]+)\/retry$/;

const PERMISSION_PATH = /^\/api\/chats\/(?<id>[^/]+)\/permissions\/(?<requestId>[^/]+)$/;
const STOP_PATH = /^\/api\/chats\/(?<id>[^/]+)\/stop$/;
const SESSION_PATH = /^\/api\/claude-sessions\/(?<sessionId>[^/]+)$/;

// Thai messages of the folder, permission, stop and old-session routes.
const ERR = {
  chatNotFound: 'ไม่พบแชตนี้',
  folderWithChat: 'เลือกโฟลเดอร์ได้เฉพาะตอนเริ่มแชตใหม่เท่านั้น',
  folderMissing: 'ไม่พบโฟลเดอร์ของแชตนี้ (อาจถูกลบหรือย้าย) จึงส่งต่อไม่ได้ กรุณาเริ่มแชตใหม่',
  badSessionId: 'รหัสแชตเก่าของ Claude Code ไม่ถูกต้อง',
  resumeNeedsFolder: 'ต้องส่งโฟลเดอร์มาพร้อมกับแชตเก่าที่จะทำต่อ',
  resumeWithChat: 'ทำต่อแชตเก่าได้เฉพาะตอนเริ่มแชตใหม่เท่านั้น',
  sessionNotFound: 'ไม่พบแชตเก่านี้ในโฟลเดอร์ที่เลือก',
  sessionUsed: 'แชตเก่านี้ถูกทำต่อใน PolyPrompt แล้ว',
  badDecision: 'คำตอบต้องเป็น allow, allow_chat หรือ deny',
  noRequest: 'ไม่พบคำขออนุญาตนี้ หรือคำขอนี้ถูกตอบไปแล้ว',
  badToken: 'โทเคนของคำขออนุญาตไม่ถูกต้องหรือถูกใช้ไปแล้ว',
  notRunning: 'ตอนนี้ไม่มี Claude ทำงานอยู่ในแชตนี้',
};

// Runs fn; a FolderError is answered with its status and gives undefined.
async function folderOr(res, fn) {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof FolderError)) throw err;
    if (res) sendError(res, err.status, err.message);
    return undefined;
  }
}

// Pending-reply registry { get(chatId) -> step|null, set, clear } (see pipeline.js).
const pendingOf = (deps) => deps.pending;

const MAX_BODY = 1_000_000;

async function readJson(req) {
  let body = '';
  for await (const chunk of req.setEncoding('utf8')) {
    body += chunk;
    if (body.length > MAX_BODY) return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function settingsBody(deps) {
  const { translatorSize, claudeModel } = deps.settings.get();
  return { translatorSize, claudeModel, downloadedSizes: deps.modelManager.downloadedSizes() };
}

const SETTING_CHECKS = { translatorSize: isSize, claudeModel: isClaudeModel };

// Returns an error message for an invalid PUT /api/settings body, else null.
function settingsBodyError(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'body must be an object';
  const keys = Object.keys(body);
  if (keys.length === 0) return 'translatorSize or claudeModel is required';
  for (const key of keys) {
    if (!Object.hasOwn(SETTING_CHECKS, key)) return `unknown setting: ${key}`;
    if (!SETTING_CHECKS[key](body[key])) return `invalid ${key}`;
  }
  return null;
}

// Starts the turn in the background; the pending entry is already set.
function startTurn(deps, chat, message) {
  runTurn(deps, chat, message).catch((err) => console.error(err));
}

// API routes: { method, path (string, or RegExp with named groups), handler(ctx) }
// where ctx = { req, res, params, query (URLSearchParams), deps }. Later issues append entries here.
export const routes = [
  {
    method: 'GET',
    path: '/api/status',
    handler: ({ res, deps }) => sendJson(res, 200, {
      model: deps.modelManager.status(),
      switch: deps.modelManager.switchStatus(),
    }),
  },
  {
    method: 'GET',
    path: '/api/settings',
    handler: ({ res, deps }) => sendJson(res, 200, settingsBody(deps)),
  },
  {
    method: 'PUT',
    path: '/api/settings',
    handler: async ({ req, res, deps }) => {
      const body = await readJson(req);
      const invalid = settingsBodyError(body);
      if (invalid) return sendError(res, 400, invalid);
      const { modelManager } = deps;
      const size = body.translatorSize;
      if (size !== undefined && modelManager.isBusy() && size !== modelManager.status().size) {
        return sendError(res, 409, 'the translator size is already changing');
      }
      if (body.claudeModel !== undefined) await deps.settings.update({ claudeModel: body.claudeModel });
      // The size is saved by the model manager once it has loaded.
      if (size !== undefined) modelManager.selectSize(size).done.catch((err) => console.error(err));
      sendJson(res, 200, settingsBody(deps));
    },
  },
  {
    method: 'POST',
    path: '/api/model/retry',
    handler: ({ res, deps }) => {
      deps.modelManager.retry();
      sendJson(res, 202, { model: deps.modelManager.status() });
    },
  },
  {
    method: 'GET',
    path: '/api/chats',
    handler: async ({ res, deps }) => sendJson(res, 200, await deps.chatStore.list()),
  },
  {
    method: 'GET',
    path: CHAT_PATH,
    handler: async ({ res, params, deps }) => {
      // Read the step before the file: a turn saves before it clears its step,
      // so a null step here means the file read below is already final.
      const pendingStep = pendingOf(deps).get(params.id) ?? null;
      const live = pendingOf(deps).live?.(params.id) ?? null;
      const chat = await deps.chatStore.get(params.id);
      if (!chat) return sendError(res, 404, 'chat not found');
      sendJson(res, 200, { ...chat, pendingStep, live });
    },
  },
  {
    method: 'DELETE',
    path: CHAT_PATH,
    handler: async ({ res, params, deps }) => {
      const chat = await deps.chatStore.get(params.id);
      if (!chat) return sendError(res, 404, 'chat not found');
      if (pendingOf(deps).get(chat.id) != null) return sendError(res, 409, 'a reply is pending in this chat');
      if (!(await deps.chatStore.remove(chat.id))) return sendError(res, 404, 'chat not found');
      res.writeHead(204);
      res.end();
    },
  },
  {
    method: 'POST',
    path: '/api/messages',
    handler: async ({ req, res, deps }) => {
      const body = await readJson(req);
      const text = body?.text;
      if (typeof text !== 'string' || !text.trim()) return sendError(res, 400, 'text is required');
      const chatId = body.chatId;
      if (chatId != null && typeof chatId !== 'string') return sendError(res, 400, 'chatId must be a string');
      const { folder: rawFolder, resumeSessionId } = body;
      if (rawFolder != null && chatId != null) return sendError(res, 400, ERR.folderWithChat);
      if (resumeSessionId != null) {
        if (!isValidSessionId(resumeSessionId)) return sendError(res, 400, ERR.badSessionId);
        if (chatId != null) return sendError(res, 400, ERR.resumeWithChat);
        if (rawFolder == null) return sendError(res, 400, ERR.resumeNeedsFolder);
      }
      let folder = null;
      if (rawFolder != null) {
        folder = await folderOr(res, () => checkFolder(rawFolder));
        if (folder === undefined) return;
      }
      if (resumeSessionId != null) {
        if (!(await sessionExists(deps.projectsDir, folder, resumeSessionId))) return sendError(res, 404, ERR.sessionNotFound);
        if ((await deps.chatStore.usedSessionIds()).has(resumeSessionId)) return sendError(res, 409, ERR.sessionUsed);
      }
      if (!requireModelReady(res, deps.modelManager)) return;
      const pending = pendingOf(deps);
      let chat;
      if (chatId != null) {
        chat = await deps.chatStore.get(chatId);
        if (!chat) return sendError(res, 404, 'chat not found');
        if (pending.get(chat.id) != null) return sendError(res, 409, 'a reply is pending in this chat');
        if (chat.messages.at(-1)?.error) return sendError(res, 409, 'the last message failed; retry or delete the chat');
        // A chat whose folder was deleted or moved can be read, not continued.
        if (chat.folder && (await folderOr(null, () => checkFolder(chat.folder))) === undefined) {
          return sendError(res, 409, ERR.folderMissing);
        }
      } else {
        chat = await deps.chatStore.create(text, {
          folder,
          sessionId: resumeSessionId ?? null,
          resumedFrom: resumeSessionId ?? null,
        });
      }
      // Claim the chat before any await so concurrent sends and deletes see it.
      pending.set(chat.id, 'translating');
      const message = {
        id: newId(), role: 'user', original: text, english: null, lang: null,
        createdAt: new Date().toISOString(),
      };
      chat.messages.push(message);
      try {
        await deps.chatStore.save(chat);
      } catch (err) {
        pending.clear(chat.id);
        throw err;
      }
      sendJson(res, 202, { chatId: chat.id, messageId: message.id });
      startTurn(deps, chat, message);
    },
  },
  {
    method: 'POST',
    path: RETRY_PATH,
    handler: async ({ res, params, deps }) => {
      if (!requireModelReady(res, deps.modelManager)) return;
      const pending = pendingOf(deps);
      const chat = await deps.chatStore.get(params.id);
      if (!chat) return sendError(res, 404, 'chat not found');
      const message = chat.messages.find((m) => m.id === params.messageId);
      if (!message) return sendError(res, 404, 'message not found');
      if (pending.get(chat.id) != null) return sendError(res, 409, 'a reply is pending in this chat');
      if (chat.messages.at(-1) !== message || message.role !== 'user' || !message.error) {
        return sendError(res, 409, 'only the last failed user message can be retried');
      }
      pending.set(chat.id, 'translating');
      delete message.error;
      try {
        await deps.chatStore.save(chat);
      } catch (err) {
        pending.clear(chat.id);
        throw err;
      }
      sendJson(res, 202, { chatId: chat.id, messageId: message.id });
      startTurn(deps, chat, message);
    },
  },
  {
    method: 'POST',
    path: PERMISSION_PATH,
    handler: async ({ req, res, params, deps }) => {
      const body = await readJson(req);
      if (!DECISIONS.includes(body?.decision)) return sendError(res, 400, ERR.badDecision);
      const chat = await deps.chatStore.get(params.id);
      if (!chat) return sendError(res, 404, ERR.chatNotFound);
      const turn = pendingOf(deps).turn(chat.id);
      if (!turn) {
        const used = pendingOf(deps).answered?.(chat.id).has(params.requestId);
        return used ? sendError(res, 403, ERR.badToken) : sendError(res, 404, ERR.noRequest);
      }
      const outcome = await turn.answer(params.requestId, body.token, body.decision);
      if (outcome === 'not_found') return sendError(res, 404, ERR.noRequest);
      if (outcome === 'forbidden') return sendError(res, 403, ERR.badToken);
      sendJson(res, 200, {});
    },
  },
  {
    method: 'POST',
    path: STOP_PATH,
    handler: async ({ res, params, deps }) => {
      const chat = await deps.chatStore.get(params.id);
      if (!chat) return sendError(res, 404, ERR.chatNotFound);
      // Only the thinking step runs claude; the translation steps finish as usual.
      const turn = pendingOf(deps).turn(chat.id);
      if (!turn?.running || pendingOf(deps).get(chat.id) !== 'thinking') return sendError(res, 409, ERR.notRunning);
      turn.stop();
      sendJson(res, 202, {});
    },
  },
  {
    method: 'GET',
    path: '/api/folders',
    handler: async ({ res, query }) => {
      const body = await folderOr(res, () => listFolders(query.get('path')));
      if (body) sendJson(res, 200, body);
    },
  },
  {
    method: 'GET',
    path: '/api/claude-sessions',
    handler: async ({ res, query, deps }) => {
      const folder = await folderOr(res, () => checkFolder(query.get('folder')));
      if (folder === undefined) return;
      const used = await deps.chatStore.usedSessionIds();
      sendJson(res, 200, await listSessions(deps.projectsDir, folder, used));
    },
  },
  {
    method: 'GET',
    path: SESSION_PATH,
    handler: async ({ res, params, query, deps }) => {
      if (!isValidSessionId(params.sessionId)) return sendError(res, 400, ERR.badSessionId);
      const folder = await folderOr(res, () => checkFolder(query.get('folder')));
      if (folder === undefined) return;
      if (!(await sessionExists(deps.projectsDir, folder, params.sessionId))) return sendError(res, 404, ERR.sessionNotFound);
      sendJson(res, 200, await deps.sessions.get(folder, params.sessionId));
    },
  },
];

function matchRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (typeof route.path === 'string') {
      if (route.path === pathname) return { route, params: {} };
    } else {
      const m = route.path.exec(pathname);
      if (m) return { route, params: m.groups ?? {} };
    }
  }
  return null;
}

async function serveStatic(req, res, publicDir, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, 'method not allowed');
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendError(res, 400, 'bad path');
  }
  if (decoded.includes('\0')) return sendError(res, 400, 'bad path');
  const root = path.resolve(publicDir);
  // Normalise as a URL path first so ".." can never climb above the root.
  let file = path.join(root, path.posix.normalize('/' + decoded.replaceAll('\\', '/')));
  if (file !== root && !file.startsWith(root + path.sep)) {
    return sendError(res, 404, 'not found');
  }
  try {
    let info = await stat(file);
    if (info.isDirectory()) {
      file = path.join(file, 'index.html');
      info = await stat(file);
    }
    if (!info.isFile()) return sendError(res, 404, 'not found');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  } catch {
    sendError(res, 404, 'not found');
  }
}

// The server binds to 127.0.0.1, but a web page in the user's own browser can
// still reach it: by DNS rebinding (foreign Host header) or by a cross-site
// request (foreign Origin header). Only the app's own origins are let through.
function allowedHosts(port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

// Returns true when the request comes from the app's own page (or a non-browser
// client that sends no Origin).
export function isTrustedRequest(req) {
  const hosts = allowedHosts(req.socket.localPort);
  const host = (req.headers.host ?? '').toLowerCase();
  if (!hosts.includes(host)) return false;
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return hosts.some((h) => origin.toLowerCase() === `http://${h}`);
}

// deps: { modelManager, publicDir, chatStore, settings?, runner?, detect?, pending?, maxChars?,
// projectsDir? (Claude Code's ~/.claude/projects), sessionCacheDir? (old-session translations) }.
export function createApp(options) {
  const deps = { detect: detectLanguage, ...options };
  deps.pending ??= createPending();
  deps.projectsDir ??= defaultProjectsDir();
  deps.sessions ??= createSessionViewer({
    projectsDir: deps.projectsDir,
    cacheDir: deps.sessionCacheDir ?? path.join(path.dirname(path.resolve(deps.chatStore?.dir ?? 'data/chats')), 'claude-sessions'),
    modelManager: deps.modelManager,
    maxChars: deps.maxChars,
  });
  return http.createServer(async (req, res) => {
    try {
      const { pathname, searchParams } = new URL(req.url, 'http://127.0.0.1');
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        if (!isTrustedRequest(req)) return sendError(res, 403, 'forbidden');
        const found = matchRoute(req.method, pathname);
        if (!found) return sendError(res, 404, 'not found');
        return await found.route.handler({ req, res, params: found.params, query: searchParams, deps });
      }
      return await serveStatic(req, res, deps.publicDir, pathname);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendError(res, 500, 'internal error');
      else res.end();
    }
  });
}

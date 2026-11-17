import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { detectLanguage } from './lang.js';
import { createPending, runTurn } from './pipeline.js';
import { newId } from './store.js';

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

// Starts the turn in the background; the pending entry is already set.
function startTurn(deps, chat, message) {
  runTurn(deps, chat, message).catch((err) => console.error(err));
}

// API routes: { method, path (string, or RegExp with named groups), handler(ctx) }
// where ctx = { req, res, params, deps }. Later issues append entries here.
export const routes = [
  {
    method: 'GET',
    path: '/api/status',
    handler: ({ res, deps }) => sendJson(res, 200, { model: deps.modelManager.status() }),
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
      const chat = await deps.chatStore.get(params.id);
      if (!chat) return sendError(res, 404, 'chat not found');
      sendJson(res, 200, { ...chat, pendingStep });
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
      if (!requireModelReady(res, deps.modelManager)) return;
      const pending = pendingOf(deps);
      let chat;
      if (chatId != null) {
        chat = await deps.chatStore.get(chatId);
        if (!chat) return sendError(res, 404, 'chat not found');
        if (pending.get(chat.id) != null) return sendError(res, 409, 'a reply is pending in this chat');
        if (chat.messages.at(-1)?.error) return sendError(res, 409, 'the last message failed; retry or delete the chat');
      } else {
        chat = await deps.chatStore.create(text);
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

// deps: { modelManager, publicDir, chatStore, runner?, detect?, pending?, maxChars? }.
export function createApp(options) {
  const deps = { detect: detectLanguage, ...options };
  deps.pending ??= createPending();
  return http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://127.0.0.1');
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        if (!isTrustedRequest(req)) return sendError(res, 403, 'forbidden');
        const found = matchRoute(req.method, pathname);
        if (!found) return sendError(res, 404, 'not found');
        return await found.route.handler({ req, res, params: found.params, deps });
      }
      return await serveStatic(req, res, deps.publicDir, pathname);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendError(res, 500, 'internal error');
      else res.end();
    }
  });
}

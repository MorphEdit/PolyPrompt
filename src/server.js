import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

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

// Pending-reply registry { get(chatId) -> step|null }; filled in by the send pipeline.
const noPending = { get: () => null };
const pendingOf = (deps) => deps.pending ?? noPending;

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
      const chat = await deps.chatStore.get(params.id);
      if (!chat) return sendError(res, 404, 'chat not found');
      sendJson(res, 200, { ...chat, pendingStep: pendingOf(deps).get(chat.id) ?? null });
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

// deps: { modelManager, publicDir, chatStore, pending?, ...more added by later issues }.
export function createApp(deps) {
  return http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://127.0.0.1');
      if (pathname === '/api' || pathname.startsWith('/api/')) {
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

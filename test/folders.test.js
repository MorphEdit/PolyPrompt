// #35: the folder picker API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FolderError, checkFolder, folderRoots, listFolders, normalizeFolder } from '../src/folders.js';
import { createModelManager } from '../src/model.js';
import { createApp } from '../src/server.js';
import { createChatStore } from '../src/store.js';
import { fakeLoader, listen, request, tick } from './helpers.js';

async function tree(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'polyprompt-folders-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'beta'));
  await mkdir(path.join(dir, 'Alpha'));
  await mkdir(path.join(dir, 'ฟอนต์ ใหม่'));
  await writeFile(path.join(dir, 'file.txt'), 'x');
  return dir;
}

async function app(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'polyprompt-folders-app-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const loader = fakeLoader();
  const modelManager = createModelManager({ load: loader.load });
  modelManager.start();
  loader.calls[0].resolve({ translate: async (s) => s });
  await tick();
  const server = createApp({ modelManager, chatStore: createChatStore({ dir: path.join(dir, 'chats') }), publicDir: dir,
    runner: { run: async () => ({ text: 'ok', sessionId: 's1' }) }, projectsDir: path.join(dir, 'projects') });
  const { port } = await listen(server);
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return { port, get: (q) => request(port, 'GET', '/api/folders' + q) };
}

const q = (p) => `?path=${encodeURIComponent(p)}`;

test('GET /api/folders lists only subdirectories, sorted, with a normalized path and parent', async (t) => {
  const dir = await tree(t);
  const { get } = await app(t);
  const r = await get(q(path.join(dir, 'beta', '..', '.') + path.sep));
  assert.equal(r.status, 200);
  assert.equal(r.json.path, path.resolve(dir));
  assert.equal(r.json.parent, path.dirname(path.resolve(dir)));
  assert.deepEqual(r.json.folders.map((f) => f.name), ['Alpha', 'beta', 'ฟอนต์ ใหม่'].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(r.json.folders.map((f) => f.path), r.json.folders.map((f) => path.join(dir, f.name)));
});

test('GET /api/folders without a path returns the roots; a root has no parent', async (t) => {
  const { get } = await app(t);
  const r = await get('');
  assert.equal(r.status, 200);
  assert.equal(r.json.parent, null);
  const roots = folderRoots();
  assert.deepEqual(r.json.folders, roots);
  if (process.platform === 'win32') {
    assert.ok(roots.every((x) => /^[A-Z]:\\$/.test(x.path)));
    assert.ok(roots.some((x) => x.path.toUpperCase() === path.parse(process.cwd()).root.toUpperCase()));
  } else {
    assert.deepEqual(roots, [{ name: '/', path: '/' }]);
  }
  const root = await get(q(roots[0].path));
  assert.equal(root.status, 200);
  assert.equal(root.json.parent, null);
  assert.deepEqual(folderRoots({ platform: 'linux' }), [{ name: '/', path: '/' }]);
  assert.deepEqual(folderRoots({ platform: 'win32', exists: (p) => p === 'C:\\' || p === 'E:\\' }).map((x) => x.path), ['C:\\', 'E:\\']);
});

test('GET /api/folders: 400 for relative or invalid paths, 404 for missing ones and files, with Thai messages', async (t) => {
  const dir = await tree(t);
  const { get } = await app(t);
  for (const bad of ['relative/path', 'beta', '.', '..', process.platform === 'win32' ? 'C:foo' : 'foo\\bar']) {
    const r = await get(q(bad));
    assert.equal(r.status, 400, bad);
    assert.match(r.json.error, /[\u0E00-\u0E7F]/);
  }
  assert.equal((await get('?path=%00')).status, 400);
  let r = await get(q(path.join(dir, 'nope')));
  assert.equal(r.status, 404);
  assert.match(r.json.error, /[\u0E00-\u0E7F]/);
  r = await get(q(path.join(dir, 'file.txt')));
  assert.equal(r.status, 404);
});

test('an unreadable folder gives 403 (to open, or as a chat folder) but is still listed by its parent', async () => {
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  const dirent = (name, dir) => ({ name, isDirectory: () => dir, isSymbolicLink: () => false });
  const fs = {
    stat: async () => ({ isDirectory: () => true }),
    readdir: async (p) => {
      if (p.endsWith('locked')) throw denied;
      return [dirent('locked', true), dirent('open', true), dirent('a.txt', false)];
    },
    opendir: async () => { throw denied; },
  };
  const root = path.resolve('/x');
  const listed = await listFolders(root, { fs });
  assert.deepEqual(listed.folders.map((f) => f.name), ['locked', 'open']);
  const err = await listFolders(path.join(root, 'locked'), { fs }).catch((e) => e);
  assert.ok(err instanceof FolderError);
  assert.equal(err.status, 403);
  assert.equal((await checkFolder(root, { fs }).catch((e) => e)).status, 403);
  const eperm = { ...fs, stat: async () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); } };
  assert.equal((await listFolders(root, { fs: eperm }).catch((e) => e)).status, 403);
});

test('normalizeFolder resolves dots and rejects drive-relative Windows paths', () => {
  assert.equal(normalizeFolder('C:\\a\\b\\..\\c\\', { platform: 'win32' }), 'C:\\a\\c');
  assert.equal(normalizeFolder('/a/./b/../c/', { platform: 'linux' }), '/a/c');
  for (const bad of ['C:foo', '\\foo', 'foo', '', '   ']) {
    assert.throws(() => normalizeFolder(bad, { platform: 'win32' }), (e) => e.status === 400, bad);
  }
  assert.throws(() => normalizeFolder(42), (e) => e.status === 400);
});

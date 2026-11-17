// Folder picker: the app lists folders itself, because the browser's own
// file dialog can't return a real path. Errors carry an HTTP status and a
// Thai message.
import { existsSync } from 'node:fs';
import { opendir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export class FolderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const INVALID = 'ที่อยู่โฟลเดอร์ไม่ถูกต้อง ต้องเป็นที่อยู่เต็ม (เช่น C:\\Users\\me\\project)';
const MISSING = 'ไม่พบโฟลเดอร์นี้';
const UNREADABLE = 'ไม่มีสิทธิ์เปิดโฟลเดอร์นี้';

const win = (platform) => platform === 'win32';

// Normalized absolute path, or a 400 FolderError.
export function normalizeFolder(input, { platform = process.platform } = {}) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new FolderError(400, INVALID);
  const p = win(platform) ? path.win32 : path.posix;
  // On Windows a path like "\foo" (current drive) or "C:foo" is not absolute enough.
  const absolute = win(platform) ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(input) : p.isAbsolute(input);
  if (!absolute) throw new FolderError(400, INVALID);
  return p.resolve(input);
}

function fsError(err) {
  if (err instanceof FolderError) return err;
  if (['EACCES', 'EPERM'].includes(err?.code)) return new FolderError(403, UNREADABLE);
  if (['ENOENT', 'ENOTDIR'].includes(err?.code)) return new FolderError(404, MISSING);
  return new FolderError(400, INVALID);
}

const defaultFs = { stat, readdir, opendir };

// Checks that `input` is an existing, readable folder; returns its normalized path.
export async function checkFolder(input, { fs = defaultFs, platform } = {}) {
  const folder = normalizeFolder(input, { platform });
  try {
    if (!(await fs.stat(folder)).isDirectory()) throw new FolderError(404, MISSING);
    const dir = await fs.opendir(folder);
    await dir.close();
  } catch (err) {
    throw fsError(err);
  }
  return folder;
}

// The picker roots: the existing drive roots on Windows, `/` elsewhere.
export function folderRoots({ platform = process.platform, exists = existsSync } = {}) {
  if (!win(platform)) return [{ name: '/', path: '/' }];
  const roots = [];
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (exists(root)) roots.push({ name: root, path: root });
  }
  return roots;
}

// GET /api/folders body: the roots for no path, else the folder's subfolders.
export async function listFolders(input, { fs = defaultFs, platform = process.platform, exists } = {}) {
  if (input == null || input === '') {
    return { path: null, parent: null, home: homedir(), folders: folderRoots({ platform, exists }) };
  }
  const folder = normalizeFolder(input, { platform });
  const p = win(platform) ? path.win32 : path.posix;
  let entries;
  try {
    if (!(await fs.stat(folder)).isDirectory()) throw new FolderError(404, MISSING);
    entries = await fs.readdir(folder, { withFileTypes: true });
  } catch (err) {
    throw fsError(err);
  }
  const folders = [];
  for (const e of entries) {
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink?.()) {
      try {
        isDir = (await fs.stat(p.join(folder, e.name))).isDirectory();
      } catch {
        isDir = false;
      }
    }
    // A subfolder that can't be read is still listed; opening it gives 403.
    if (isDir) folders.push({ name: e.name, path: p.join(folder, e.name) });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  const parent = p.dirname(folder);
  return { path: folder, parent: parent === folder ? null : parent, home: homedir(), folders };
}

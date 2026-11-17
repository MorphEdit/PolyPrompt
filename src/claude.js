// Claude Code CLI runner: sends one prompt (on stdin) to `claude -p` and
// returns the answer text and session id. Kept small so the provider can be
// swapped later.

import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const INSTALL_LOGIN_HINT = 'ติดตั้ง Claude Code แล้วเปิดเทอร์มินัล พิมพ์ `claude` และ `/login` เพื่อเข้าสู่ระบบ';
const MESSAGES = {
  cli_missing: `ไม่พบ Claude Code (คำสั่ง claude) — ${INSTALL_LOGIN_HINT}`,
  not_logged_in: `Claude Code ยังไม่ได้เข้าสู่ระบบ — ${INSTALL_LOGIN_HINT}`,
  timeout: 'Claude ไม่ตอบภายในเวลาที่กำหนด กรุณาลองส่งใหม่',
  failed: 'เรียก Claude ไม่สำเร็จ',
};
const AUTH = /log ?in|auth/i;
const NODE_SCRIPT = /\.[cm]?js$/i;
// Args reaching cmd.exe (fallback for unparsable .cmd shims) are only our
// fixed flags, SYSTEM_PROMPT and the session id; anything else is refused.
const CMD_SAFE_ARG = /^[\w.:\/=-]*$/;

// Replaces Claude Code's coding-agent prompt. A fixed constant with no
// cmd.exe metacharacters, so the .cmd fallback may pass it quoted.
export const SYSTEM_PROMPT = 'You are Claude, a helpful general assistant in a chat. '
  + 'You have no access to files, folders, tools or the computer you run on. '
  + 'Answer from your own knowledge and what the user writes in the chat.';

// Working directory for every `claude` run: owned by the app and outside the
// PolyPrompt repo, so Claude Code sees no git state or CLAUDE.md and keeps
// these sessions apart from the developer's own.
export function defaultClaudeHome() {
  return process.env.CLAUDE_HOME_DIR || path.join(homedir(), '.polyprompt', 'claude-home');
}

export class ClaudeError extends Error {
  constructor(kind, detail) {
    super(detail ? `${MESSAGES[kind]} (${detail})` : MESSAGES[kind]);
    this.kind = kind;
  }
}

// Claude models the picker offers; 'default' (or anything else) adds no
// --model flag, so Claude Code uses its own default.
export const MODEL_FLAGS = ['opus', 'sonnet', 'haiku'];

export function buildArgs(sessionId, model = 'default') {
  // `--tools ""` is the strictest option in `claude --help`: it removes every
  // built-in tool, unlike --disallowedTools which only blocks listed names.
  // --strict-mcp-config without --mcp-config also loads no MCP server tools.
  // --setting-sources user skips project/local settings; auth is user-level.
  const args = [
    '-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config',
    '--setting-sources', 'user', '--system-prompt', SYSTEM_PROMPT,
  ];
  if (MODEL_FLAGS.includes(model)) args.push('--model', model);
  if (sessionId) args.push('--resume', sessionId);
  return args;
}

// Find `command` on PATH using PATHEXT (Windows only).
function whichWin(command) {
  const exts = path.extname(command) ? [''] : (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';');
  const dirs = path.isAbsolute(command) || /[\\/]/.test(command)
    ? ['']
    : (process.env.PATH || '').split(';').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.resolve(dir, command + ext);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

// Turn `command` into a file + args that spawn() can start with shell: false.
// - `*.js` / `*.mjs` / `*.cjs`: run with this Node.
// - Windows `.cmd` / `.bat` shim: npm shims are parsed for their node entry
//   script (`"%dp0%\...\cli.js"`) and run with Node; otherwise the shim runs
//   through `cmd.exe /d /s /c` with only CMD_SAFE_ARG args. The prompt is
//   on stdin in every case, so user text never reaches a shell.
export function resolveCommand(command, args) {
  if (NODE_SCRIPT.test(command)) return { file: process.execPath, args: [command, ...args] };
  if (process.platform !== 'win32') return { file: command, args };
  const found = whichWin(command);
  if (!found || !/\.(cmd|bat)$/i.test(found)) return { file: found || command, args };
  const m = readFileSync(found, 'utf8').match(/"%dp0%\\([^"]+\.[cm]?js)"/i);
  if (m) {
    const script = path.join(path.dirname(found), m[1]);
    if (existsSync(script)) return { file: process.execPath, args: [script, ...args] };
  }
  if (!args.every((a) => a === SYSTEM_PROMPT || CMD_SAFE_ARG.test(a))) throw new ClaudeError('failed', 'unsafe argument');
  const line = [found, ...args].map((a) => `"${a}"`).join(' ');
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

// Kill the child and, on Windows, its whole process tree (a .cmd shim's
// cmd.exe would otherwise leave the real CLI running).
function killTree(child) {
  return new Promise((resolve) => {
    if (process.platform === 'win32' && child.pid) {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => resolve());
    } else {
      child.kill('SIGKILL');
      resolve();
    }
  });
}

function parseResult(stdout) {
  try {
    const data = JSON.parse(stdout.trim());
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

export function createClaudeRunner({ command = 'claude', timeoutMs = 300000, cwd = defaultClaudeHome() } = {}) {
  function run({ prompt, sessionId, model } = {}) {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = resolveCommand(command, buildArgs(sessionId, model));
        mkdirSync(cwd, { recursive: true });
      } catch (err) {
        return reject(err instanceof ClaudeError ? err : new ClaudeError('failed', err.message));
      }
      const child = spawn(target.file, target.args, {
        cwd,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: target.windowsVerbatimArguments || false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        // Settle only after the kill finished, so the tree is gone when we reject.
        timedOut = true;
        killTree(child).then(() => finish(new ClaudeError('timeout')));
      }, timeoutMs);

      child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
      child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
      child.stdin.on('error', () => {}); // child may exit before reading stdin
      child.on('error', (err) => {
        finish(err.code === 'ENOENT' ? new ClaudeError('cli_missing') : new ClaudeError('failed', err.message));
      });
      child.on('close', (code) => {
        if (timedOut) return;
        const data = parseResult(stdout);
        const resultText = data && typeof data.result === 'string' ? data.result : '';
        const ok = code === 0 && data && data.is_error !== true && typeof data.result === 'string';
        if (ok) return finish(null, { text: data.result, sessionId: data.session_id ?? null });
        // On Windows cmd.exe reports a missing command with exit code 9009.
        if (process.platform === 'win32' && code === 9009 && !data) return finish(new ClaudeError('cli_missing'));
        if (AUTH.test(stderr) || AUTH.test(resultText)) return finish(new ClaudeError('not_logged_in'));
        const detail = code !== 0 ? `exit ${code}` : data ? 'is_error' : 'invalid JSON';
        finish(new ClaudeError('failed', detail));
      });
      child.stdin.end(prompt ?? '', 'utf8');
    });
  }
  return { run };
}

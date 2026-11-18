// Claude Code CLI runner: sends one prompt (on stdin, stream-json) to
// `claude -p`, streams its activity and permission requests, and returns the
// answer text and session id. The protocol itself lives in stream.js.

import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { CLAUDE_OPTIONS } from '../public/models.js';
import { activityLine, truncateOutput } from './activity.js';
import { parseLine, permissionResponseLine, readEvent, unsupportedResponseLine, userLine } from './stream.js';

const INSTALL_LOGIN_HINT = 'ติดตั้ง Claude Code แล้วเปิดเทอร์มินัล พิมพ์ `claude` และ `/login` เพื่อเข้าสู่ระบบ';
const MESSAGES = {
  cli_missing: `ไม่พบ Claude Code (คำสั่ง claude) — ${INSTALL_LOGIN_HINT}`,
  not_logged_in: `Claude Code ยังไม่ได้เข้าสู่ระบบ — ${INSTALL_LOGIN_HINT}`,
  timeout: 'Claude ไม่ตอบภายในเวลาที่กำหนด กรุณาลองส่งใหม่',
  failed: 'เรียก Claude ไม่สำเร็จ',
  model_rejected: 'Claude ไม่รับโมเดลที่เลือก (อาจไม่มีโมเดลนี้ หรือบัญชีนี้ใช้ไม่ได้) จึงกลับไปใช้โมเดลก่อนหน้า กรุณาลองส่งใหม่',
  cli_too_old: 'Claude Code ในเครื่องเก่าเกินไปสำหรับโมเดลนี้ ให้รัน `claude update` แล้วลองใหม่',
  folder_missing: 'ไม่พบโฟลเดอร์ของแชตนี้ (อาจถูกลบหรือย้าย) จึงส่งต่อไม่ได้ กรุณาเริ่มแชตใหม่',
};
const AUTH = /log ?in|auth/i;
// `claude -p --model <unknown>` answers is_error with api_error_status 404
// and "There's an issue with the selected model (...)". A newer CLI also
// prints a harmless `unrecognized_model` line on stderr for models it does
// not know yet, even when the run succeeds, so stderr alone proves nothing.
const MODEL_REJECTED = /selected model/i;
// An older CLI refuses a newer model: "Claude Code 2.1.150 does not support
// this model; version 2.1.290 or newer is required. Run 'claude update' ...".
const CLI_TOO_OLD = /does not support this model|or newer is required/i;
const NODE_SCRIPT = /\.[cm]?js$/i;
// Args reaching cmd.exe (fallback for unparsable .cmd shims) are only our
// fixed flags, the comma-separated tool lists, SYSTEM_PROMPT and the session
// id; anything else is refused.
const CMD_SAFE_ARG = /^[\w.:\/=,-]*$/;

// Replaces Claude Code's coding-agent prompt. A fixed constant with no
// cmd.exe metacharacters, so the .cmd fallback may pass it quoted.
export const SYSTEM_PROMPT = 'You are Claude, a helpful general assistant in a chat. '
  + 'You can search the web and fetch web pages. '
  + 'You have no access to files, folders, commands or the computer you run on. '
  + 'Answer from your own knowledge, the web and what the user writes in the chat.';

// Working directory for every `claude` run: owned by the app and outside the
// PolyPrompt repo, so Claude Code sees no git state or CLAUDE.md and keeps
// these sessions apart from the developer's own.
export function defaultClaudeHome() {
  return process.env.CLAUDE_HOME_DIR || path.join(homedir(), '.polyprompt', 'claude-home');
}

export class ClaudeError extends Error {
  // text overrides the kind's message (same kind, more specific wording).
  constructor(kind, detail, text = MESSAGES[kind]) {
    super(detail ? `${text} (${detail})` : text);
    this.kind = kind;
  }
}

// Full model IDs the picker offers (public/models.js); 'default' (or
// anything else) adds no --model flag, so Claude Code uses its own default.
export const MODEL_FLAGS = CLAUDE_OPTIONS.map((o) => o.value).filter((v) => v !== 'default');

// Tools a chat without a folder gets: the web only.
export const WEB_TOOLS = 'WebSearch,WebFetch';
// Tools a folder chat runs without a permission card: reading and the web.
export const FOLDER_ALLOWED_TOOLS = 'Read,Glob,Grep,LS,NotebookRead,WebSearch,WebFetch';

// Never bypassPermissions: every other tool call reaches the app as a
// can_use_tool control_request (--permission-prompt-tool stdio, as the Agent
// SDK does), unless the folder's own Claude Code settings allow it. Without
// it the real CLI denies such calls silently (permission_denials).
export function buildArgs(sessionId, model = 'default', folder = null) {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-prompt-tool', 'stdio',
  ];
  if (folder) {
    // Normal Claude Code in the folder: default prompt, settings, MCP and tools.
    args.push('--allowedTools', FOLDER_ALLOWED_TOOLS);
  } else {
    // --tools limits the built-in tools to the web ones; --strict-mcp-config
    // without --mcp-config loads no MCP server tools; --setting-sources user
    // skips project/local settings (auth is user-level).
    args.push(
      '--tools', WEB_TOOLS, '--allowedTools', WEB_TOOLS, '--strict-mcp-config',
      '--setting-sources', 'user', '--system-prompt', SYSTEM_PROMPT,
    );
  }
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

// The model that answered: the modelUsage key with the most output tokens
// (Claude Code may also list a small helper model), or null.
export function answeringModel(data) {
  const usage = data?.modelUsage;
  if (!usage || typeof usage !== 'object') return null;
  let best = null;
  let most = -1;
  for (const [id, u] of Object.entries(usage)) {
    const out = Number(u?.outputTokens) || 0;
    if (out > most) { best = id; most = out; }
  }
  return best;
}

// Usage figures of a parsed result event, only those it has (so a result
// without them resolves the same object as before).
function usageOf(result) {
  const out = {};
  if (result?.usage) out.usage = result.usage;
  if (result?.modelUsage) out.modelUsage = result.modelUsage;
  if (result?.total_cost_usd != null) out.totalCostUsd = result.total_cost_usd;
  if (result?.duration_ms != null) out.durationMs = result.duration_ms;
  return out;
}

function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// Runs one turn. Options:
// - prompt, sessionId, model: as before; folder: the chat's work folder (cwd
//   and Claude Code's defaults) or null for the general assistant;
// - signal: aborting it stops the turn (open requests are denied first) and
//   resolves { text so far, sessionId, stopped: true };
// - onSession(id): the session id, from the first event that carries one;
// - onActivity(line): a new activity line { text, detail }; its output is
//   filled in later on the same object;
// - onPermission({ requestId, toolName, input }) -> 'allow' | 'deny' (or a
//   promise of it). The idle timeout is paused while a request is open.
// Resolves { text, sessionId } (the text Claude wrote, joined), plus model,
// usage, modelUsage, totalCostUsd and durationMs when the result event has them.
// A `failed` error after a result event or stderr output carries that text as
// err.output (and the result's usage figures, when any).
// extraArgs are appended after buildArgs (the benchmark's
// --no-session-persistence); the app passes none.
export function createClaudeRunner({ command = 'claude', timeoutMs = 300000, cwd = defaultClaudeHome(), graceMs = 300, extraArgs = [] } = {}) {
  function run({ prompt, sessionId, model, folder = null, signal, onSession, onActivity, onPermission } = {}) {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = resolveCommand(command, [...buildArgs(sessionId, model, folder), ...extraArgs]);
        if (folder) {
          if (!isDirectory(folder)) throw new ClaudeError('folder_missing');
        } else {
          mkdirSync(cwd, { recursive: true });
        }
      } catch (err) {
        return reject(err instanceof ClaudeError ? err : new ClaudeError('failed', err.message));
      }
      if (signal?.aborted) return resolve({ text: '', sessionId: null, stopped: true });
      const child = spawn(target.file, target.args, {
        cwd: folder || cwd,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: target.windowsVerbatimArguments || false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const closed = new Promise((r) => child.on('close', r));
      const texts = [];
      const tools = new Map(); // tool_use id -> activity line
      const open = new Map(); // permission request id -> tool input
      let streamedSession = null;
      let result = null;
      let junk = false;
      let buffer = '';
      let stderr = '';
      let settled = false;
      let ended = false; // timed out or stopped: the close handler stays out
      let timer = null;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        if (err) reject(err);
        else resolve(value);
      };
      const write = (text) => {
        if (!child.stdin.writableEnded && !child.stdin.destroyed) child.stdin.write(text, 'utf8');
      };
      // Idle timeout: re-armed by every stream event, paused while a
      // permission request waits for the user.
      const arm = () => {
        clearTimeout(timer);
        if (ended || settled || open.size > 0) return;
        timer = setTimeout(() => {
          if (ended || settled) return;
          ended = true;
          // Settle only after the kill finished, so the tree is gone when we reject.
          killTree(child).then(() => finish(new ClaudeError('timeout')));
        }, timeoutMs);
      };

      function answer(requestId, behavior) {
        if (!open.has(requestId)) return;
        const input = open.get(requestId);
        open.delete(requestId);
        write(permissionResponseLine(requestId, behavior === 'allow' ? 'allow' : 'deny', input));
        arm();
      }

      function handle(text) {
        if (!text.trim()) return;
        const ev = parseLine(text);
        if (!ev) {
          junk = true;
          return;
        }
        if (ended) return;
        const e = readEvent(ev);
        if (e.sessionId && !streamedSession) {
          streamedSession = e.sessionId;
          onSession?.(e.sessionId);
        }
        if (e.kind === 'permission') {
          open.set(e.requestId, e.input);
          clearTimeout(timer);
          Promise.resolve()
            .then(() => (onPermission ? onPermission({ requestId: e.requestId, toolName: e.toolName, input: e.input }) : 'deny'))
            .then((behavior) => answer(e.requestId, behavior), () => answer(e.requestId, 'deny'));
          return;
        }
        if (e.kind === 'control' && e.requestId) write(unsupportedResponseLine(e.requestId));
        else if (e.kind === 'assistant') {
          texts.push(...e.texts);
          for (const use of e.toolUses) {
            const line = activityLine(use.name, use.input);
            if (use.id) tools.set(use.id, line);
            onActivity?.(line);
          }
        } else if (e.kind === 'tool_results') {
          for (const r of e.results) {
            const line = tools.get(r.id);
            if (line) Object.assign(line, truncateOutput(r.output));
          }
        } else if (e.kind === 'result') {
          result = { ...e, sessionId: e.sessionId ?? streamedSession };
          child.stdin.end();
        }
        arm();
      }

      // Stop: deny the open requests, close stdin, give `claude` a moment to
      // read the answers, then kill the tree.
      function stop() {
        if (ended || settled) return;
        ended = true;
        clearTimeout(timer);
        for (const id of [...open.keys()]) answer(id, 'deny');
        child.stdin.end();
        const grace = new Promise((r) => setTimeout(r, graceMs));
        Promise.race([closed, grace])
          .then(() => killTree(child))
          .then(() => finish(null, { text: texts.join('\n\n'), sessionId: streamedSession, stopped: true }));
      }
      signal?.addEventListener('abort', stop, { once: true });

      child.stdout.setEncoding('utf8').on('data', (d) => {
        buffer += d;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const text = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          handle(text);
        }
      });
      child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
      child.stdin.on('error', () => {}); // child may exit before reading stdin
      child.on('error', (err) => {
        finish(err.code === 'ENOENT' ? new ClaudeError('cli_missing') : new ClaudeError('failed', err.message));
      });
      child.on('close', (code) => {
        if (ended) return;
        handle(buffer);
        buffer = '';
        if (ended) return;
        const resultText = result?.text ?? '';
        const ok = code === 0 && result && !result.isError && typeof result.text === 'string';
        if (ok) {
          const answer = { text: texts.length ? texts.join('\n\n') : result.text, sessionId: result.sessionId ?? null };
          const answered = answeringModel(result);
          return finish(null, { ...(answered ? { ...answer, model: answered } : answer), ...usageOf(result) });
        }
        // On Windows cmd.exe reports a missing command with exit code 9009.
        if (process.platform === 'win32' && code === 9009 && !result) return finish(new ClaudeError('cli_missing'));
        // model_rejected kind, so the pipeline reverts the picker as well.
        if (CLI_TOO_OLD.test(stderr) || CLI_TOO_OLD.test(resultText)) {
          return finish(new ClaudeError('model_rejected', null, MESSAGES.cli_too_old));
        }
        if (MODEL_REJECTED.test(stderr) || MODEL_REJECTED.test(resultText)) {
          return finish(new ClaudeError('model_rejected', model));
        }
        if (AUTH.test(stderr) || AUTH.test(resultText)) return finish(new ClaudeError('not_logged_in'));
        const detail = code !== 0 ? `exit ${code}` : result ? 'is_error' : junk ? 'invalid JSON' : 'no result';
        const err = new ClaudeError('failed', detail);
        if (result || stderr) {
          err.output = [resultText, stderr].filter(Boolean).join('\n');
          Object.assign(err, usageOf(result));
        }
        finish(err);
      });
      arm();
      write(userLine(prompt));
    });
  }
  return { run };
}

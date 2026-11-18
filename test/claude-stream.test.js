// #35: the runner against a fake `claude` speaking stream-json and the
// control_request / control_response permission protocol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOLDER_ALLOWED_TOOLS, SYSTEM_PROMPT, WEB_TOOLS, buildArgs, createClaudeRunner, resolveCommand } from '../src/claude.js';
import { DENY_MESSAGE } from '../src/stream.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude');
const SCRIPT = path.join(fixtures, 'script.mjs');
const win = process.platform === 'win32';

// Writes the steps and a log path into a temp dir; returns { log, dir, read }.
function scripted(t, steps) {
  const dir = mkdtempSync(path.join(tmpdir(), 'polyprompt-stream-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'script.json');
  writeFileSync(script, JSON.stringify(steps));
  const log = path.join(dir, 'log.json');
  process.env.FIXTURE_SCRIPT = script;
  process.env.FIXTURE_LOG = log;
  return { dir, read: () => JSON.parse(readFileSync(log, 'utf8')) };
}

const init = (sid = 'sess-1') => ({ emit: { type: 'system', subtype: 'init', session_id: sid } });
const say = (text) => ({ emit: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, session_id: 'sess-1' } });
const use = (id, name, input) => ({ emit: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } } });
const toolResult = (id, content) => ({ emit: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } } });
const result = (text = 'done', sid = 'sess-1') => ({ emit: { type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid } });

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('args without a folder: web tools only, general-assistant prompt, stream-json, host permission prompts', () => {
  const argv = buildArgs('s1', 'claude-haiku-5-5');
  assert.equal(argv[argv.indexOf('--input-format') + 1], 'stream-json');
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(argv[argv.indexOf('--permission-prompt-tool') + 1], 'stdio');
  assert.equal(argv[argv.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  assert.equal(argv[argv.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch');
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.equal(argv[argv.indexOf('--setting-sources') + 1], 'user');
  assert.equal(argv[argv.indexOf('--system-prompt') + 1], SYSTEM_PROMPT);
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-haiku-5-5');
  assert.equal(argv[argv.indexOf('--resume') + 1], 's1');
  assert.ok(!argv.some((a) => /bypass|dangerously/i.test(a)));
  assert.ok(!argv.includes('--permission-mode'));
});

test('args with a folder: default Claude Code prompt and settings, read-only and web tools allowed', () => {
  const argv = buildArgs('s1', 'default', path.resolve('/some/folder'));
  assert.equal(argv[argv.indexOf('--input-format') + 1], 'stream-json');
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(argv[argv.indexOf('--permission-prompt-tool') + 1], 'stdio');
  assert.equal(argv[argv.indexOf('--allowedTools') + 1], FOLDER_ALLOWED_TOOLS);
  assert.deepEqual(FOLDER_ALLOWED_TOOLS.split(','), ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebSearch', 'WebFetch']);
  for (const flag of ['--tools', '--strict-mcp-config', '--setting-sources', '--system-prompt', '--model']) {
    assert.ok(!argv.includes(flag), flag);
  }
  assert.ok(!argv.some((a) => /bypass|dangerously/i.test(a)));
  assert.equal(argv[argv.indexOf('--resume') + 1], 's1');
});

test('the reworded system prompt mentions the web tools and no longer says Claude has no tools', () => {
  assert.match(SYSTEM_PROMPT, /search the web/i);
  assert.doesNotMatch(SYSTEM_PROMPT, /no access to[^.]*tools/i);
  assert.match(SYSTEM_PROMPT, /no access to files, folders, commands/i);
  assert.doesNotMatch(SYSTEM_PROMPT, /[&|<>^%!"()]/);
  assert.equal(WEB_TOOLS, 'WebSearch,WebFetch');
});

test('Windows: comma-separated tool lists pass the .cmd fallback whitelist; shell characters still do not', { skip: !win }, () => {
  const shim = path.join(fixtures, 'ok-plain.cmd');
  let r = resolveCommand(shim, buildArgs('s1', 'claude-opus-5-5'));
  assert.ok(r.args.at(-1).includes('"--tools" "WebSearch,WebFetch"'));
  r = resolveCommand(shim, buildArgs('s1', 'claude-opus-5-5', 'C:\\work\\my-app'));
  assert.ok(r.args.at(-1).includes('"--allowedTools" "Read,Glob,Grep,LS,NotebookRead,WebSearch,WebFetch"'));
  assert.throws(() => resolveCommand(shim, ['--resume', 'a,b&calc']));
});

test('activity lines stream with outputs; text between tool calls is joined; session id comes from the first event', async (t) => {
  const { read } = scripted(t, [
    init('sess-9'),
    say('Let me look.'),
    use('t1', 'Read', { file_path: 'src/app.js' }),
    toolResult('t1', [{ type: 'text', text: 'file body' }]),
    use('t2', 'WebSearch', { query: 'node streams' }),
    toolResult('t2', 'x'.repeat(25_000)),
    say('All done.'),
    result('All done.', 'sess-9'),
  ]);
  const sessions = [];
  const lines = [];
  const res = await createClaudeRunner({ command: SCRIPT }).run({
    prompt: 'hi', onSession: (s) => sessions.push(s), onActivity: (l) => lines.push(l),
  });
  assert.deepEqual(res, { text: 'Let me look.\n\nAll done.', sessionId: 'sess-9' });
  assert.deepEqual(sessions, ['sess-9']);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, '🔍 กำลังอ่าน `src/app.js`');
  assert.equal(lines[0].detail, 'src/app.js');
  assert.equal(lines[0].output, 'file body');
  assert.equal(lines[1].text, '🌐 ค้นเว็บ: node streams');
  assert.equal(lines[1].output.length, 20_000);
  assert.equal(lines[1].truncated, true);
  const { stdin } = read();
  assert.deepEqual(JSON.parse(stdin[0]), { type: 'user', message: { role: 'user', content: 'hi' } });
});

test('a control_request waits for onPermission; allow and deny are written back in the protocol format', async (t) => {
  const edit = { file_path: 'a.txt', old_string: 'x', new_string: 'y' };
  const { read } = scripted(t, [
    init(),
    { ask: { id: 'r1', tool: 'Edit', input: edit } },
    { ask: { id: 'r2', tool: 'Bash', input: { command: 'rm -rf build' } } },
    result('ok'),
  ]);
  const asked = [];
  const res = await createClaudeRunner({ command: SCRIPT }).run({
    prompt: 'go',
    onPermission: async (req) => {
      asked.push(req);
      return req.toolName === 'Edit' ? 'allow' : 'deny';
    },
  });
  assert.equal(res.text, 'ok');
  assert.deepEqual(asked.map((r) => [r.requestId, r.toolName]), [['r1', 'Edit'], ['r2', 'Bash']]);
  assert.deepEqual(asked[0].input, edit);
  const { responses } = read();
  assert.deepEqual(responses, [
    { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: edit } },
    { subtype: 'success', request_id: 'r2', response: { behavior: 'deny', message: DENY_MESSAGE } },
  ]);
});

test('idle timeout: a stream that keeps sending events is not cut off, silence is', async (t) => {
  const steps = [init()];
  for (let i = 0; i < 8; i++) steps.push({ wait: 100 }, say(`step ${i}`));
  steps.push(result('fine'));
  scripted(t, steps);
  // 800 ms in total, but never 400 ms without an event.
  const res = await createClaudeRunner({ command: SCRIPT, timeoutMs: 400 }).run({ prompt: 'a' });
  assert.match(res.text, /step 7/);

  const { read } = scripted(t, [init(), say('thinking'), { hang: true }]);
  const err = await createClaudeRunner({ command: SCRIPT, timeoutMs: 300 }).run({ prompt: 'a' }).then(() => null, (e) => e);
  assert.equal(err?.kind, 'timeout');
  const { pid } = read();
  await waitFor(() => !isRunning(pid));
});

test('the idle timeout is paused while a permission request is open', async (t) => {
  scripted(t, [init(), { ask: { id: 'r1', tool: 'Bash', input: { command: 'npm test' } } }, result('after')]);
  const res = await createClaudeRunner({ command: SCRIPT, timeoutMs: 200 }).run({
    prompt: 'a',
    onPermission: () => new Promise((r) => setTimeout(() => r('allow'), 700)),
  });
  assert.equal(res.text, 'after');
});

test('stop: denies the open request, kills claude and resolves the text and session so far', async (t) => {
  const { read } = scripted(t, [
    init('sess-stop'), say('Working on it.'),
    { ask: { id: 'r1', tool: 'Write', input: { file_path: 'x', content: 'y' } } },
    { hang: true },
  ]);
  const controller = new AbortController();
  let asked;
  const opened = new Promise((r) => { asked = r; });
  const run = createClaudeRunner({ command: SCRIPT }).run({
    prompt: 'a', signal: controller.signal,
    onPermission: () => { asked(); return new Promise(() => {}); },
  });
  await opened;
  controller.abort();
  const res = await run;
  assert.deepEqual(res, { text: 'Working on it.', sessionId: 'sess-stop', stopped: true });
  const log = read();
  assert.deepEqual(log.responses, [{ subtype: 'success', request_id: 'r1', response: { behavior: 'deny', message: DENY_MESSAGE } }]);
  await waitFor(() => !isRunning(log.pid));
});

test('a folder run uses the folder as cwd; a missing folder fails with a Thai message', async (t) => {
  const { dir, read } = scripted(t, [result('x')]);
  await createClaudeRunner({ command: SCRIPT }).run({ prompt: 'a', folder: dir });
  const log = read();
  assert.equal(path.resolve(log.cwd), path.resolve(dir));
  assert.equal(log.argv[log.argv.indexOf('--allowedTools') + 1], FOLDER_ALLOWED_TOOLS);
  assert.ok(!log.argv.includes('--system-prompt'));

  const gone = path.join(dir, 'gone');
  const err = await createClaudeRunner({ command: SCRIPT }).run({ prompt: 'a', folder: gone }).then(() => null, (e) => e);
  assert.equal(err?.kind, 'folder_missing');
  assert.match(err.message, /โฟลเดอร์/);
  assert.equal(existsSync(gone), false, 'the folder is never created');
});

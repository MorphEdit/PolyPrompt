import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeRunner, buildArgs } from '../src/claude.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude');
const fx = (name) => path.join(fixtures, name);
const win = process.platform === 'win32';

function logFile() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'polyprompt-claude-')), 'log');
  process.env.FIXTURE_LOG = file;
  return file;
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid, ms = 2000) {
  const end = Date.now() + ms;
  while (isRunning(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return !isRunning(pid);
}

async function rejectsKind(promise, kind) {
  const err = await promise.then(() => assert.fail('expected rejection'), (e) => e);
  assert.equal(err.kind, kind, err.message);
  assert.ok(err.message);
  return err;
}

test('success resolves text and sessionId from the JSON output', async () => {
  const res = await createClaudeRunner({ command: fx('ok.mjs') }).run({ prompt: 'hello' });
  assert.deepEqual(res, { text: 'hi', sessionId: 's2' });
});

test('prompt arrives on stdin unchanged (as a stream-json user line) and is not in argv', async () => {
  const log = logFile();
  const prompt = '"; rm -rf / $(x) `y` & | > %PATH% ^ สวัสดี\nline2';
  await createClaudeRunner({ command: fx('ok.mjs') }).run({ prompt });
  const { argv, stdin } = JSON.parse(readFileSync(log, 'utf8'));
  assert.deepEqual(JSON.parse(stdin), { type: 'user', message: { role: 'user', content: prompt } });
  assert.ok(!argv.some((a) => a.includes('rm -rf') || a.includes('$(x)')));
});

test('argv: -p, stream-json in and out, web tools only, resume only with sessionId', async () => {
  const runner = createClaudeRunner({ command: fx('ok.mjs') });
  let log = logFile();
  await runner.run({ prompt: 'a' });
  let { argv } = JSON.parse(readFileSync(log, 'utf8'));
  assert.deepEqual(argv, buildArgs());
  assert.ok(argv.includes('-p'));
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(argv[argv.indexOf('--input-format') + 1], 'stream-json');
  assert.equal(argv[argv.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  assert.ok(!argv.includes('--resume') && !argv.includes('-r'));

  log = logFile();
  await runner.run({ prompt: 'a', sessionId: 's1' });
  ({ argv } = JSON.parse(readFileSync(log, 'utf8')));
  assert.equal(argv[argv.indexOf('--resume') + 1], 's1');
  assert.ok(argv.includes('-p') && argv.includes('--tools'));
});

test('missing command → cli_missing with install/login message', async () => {
  const err = await rejectsKind(
    createClaudeRunner({ command: 'polyprompt-no-such-command-xyz' }).run({ prompt: 'a' }),
    'cli_missing',
  );
  assert.match(err.message, /Claude Code/);
  assert.match(err.message, /\/login/);
});

test('"Please run /login" on stderr with non-zero exit → not_logged_in', async () => {
  const err = await rejectsKind(createClaudeRunner({ command: fx('login.mjs') }).run({ prompt: 'a' }), 'not_logged_in');
  assert.match(err.message, /\/login/);
  assert.match(err.message, /claude/);
});

test('auth error in result text → not_logged_in', async () => {
  await rejectsKind(createClaudeRunner({ command: fx('auth-result.mjs') }).run({ prompt: 'a' }), 'not_logged_in');
});

test('non-zero exit, is_error and non-JSON output → failed', async () => {
  for (const name of ['exit-fail.mjs', 'is-error.mjs', 'not-json.mjs']) {
    await rejectsKind(createClaudeRunner({ command: fx(name) }).run({ prompt: 'a' }), 'failed');
  }
});

test('process that never exits → timeout, and it is killed', async () => {
  const log = logFile();
  await rejectsKind(createClaudeRunner({ command: fx('hang.mjs'), timeoutMs: 200 }).run({ prompt: 'a' }), 'timeout');
  const pid = Number(readFileSync(log, 'utf8'));
  assert.ok(pid > 0);
  assert.ok(await waitGone(pid), 'fixture still running');
});

test('Windows: npm-style .cmd shim runs its node script with prompt on stdin', { skip: !win }, async () => {
  const log = logFile();
  const prompt = '"; rm -rf / $(x) & | >';
  const res = await createClaudeRunner({ command: fx('ok-npm.cmd') }).run({ prompt, sessionId: 's1' });
  assert.deepEqual(res, { text: 'hi', sessionId: 's2' });
  const { argv, stdin } = JSON.parse(readFileSync(log, 'utf8'));
  assert.deepEqual(JSON.parse(stdin), { type: 'user', message: { role: 'user', content: prompt } });
  assert.deepEqual(argv, buildArgs('s1'));
});

test('Windows: other .cmd shim runs via cmd.exe with prompt on stdin', { skip: !win }, async () => {
  const log = logFile();
  const prompt = '"; rm -rf / $(x) & | > %PATH%';
  const res = await createClaudeRunner({ command: fx('ok-plain.cmd') }).run({ prompt, sessionId: 's1' });
  assert.deepEqual(res, { text: 'hi', sessionId: 's2' });
  const { argv, stdin } = JSON.parse(readFileSync(log, 'utf8'));
  assert.deepEqual(JSON.parse(stdin), { type: 'user', message: { role: 'user', content: prompt } });
  assert.deepEqual(argv, buildArgs('s1'));
});

test('Windows: .cmd shim refuses a session id with shell characters', { skip: !win }, async () => {
  await rejectsKind(createClaudeRunner({ command: fx('ok-plain.cmd') }).run({ prompt: 'a', sessionId: 'x & calc' }), 'failed');
});

test('Windows: timeout through a .cmd shim kills the whole process tree', { skip: !win }, async () => {
  const log = logFile();
  await rejectsKind(createClaudeRunner({ command: fx('hang.cmd'), timeoutMs: 1000 }).run({ prompt: 'a' }), 'timeout');
  assert.ok(existsSync(log), 'fixture did not start');
  const pid = Number(readFileSync(log, 'utf8'));
  assert.ok(await waitGone(pid), 'grandchild still running');
});

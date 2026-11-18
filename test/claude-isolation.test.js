import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeRunner, defaultClaudeHome, SYSTEM_PROMPT } from '../src/claude.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude');
const fx = (name) => path.join(fixtures, name);
const win = process.platform === 'win32';

function insideGitRepo(dir) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function logFile() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'polyprompt-iso-')), 'log');
  process.env.FIXTURE_LOG = file;
  return file;
}

const readLog = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('#23/#35: claude runs outside any git repo with a general-assistant system prompt and web tools only', async () => {
  const log = logFile();
  await createClaudeRunner({ command: fx('ok.mjs') }).run({ prompt: 'สวัสดี' });
  const { argv, cwd } = readLog(log);

  assert.equal(path.resolve(cwd), path.resolve(defaultClaudeHome()));
  assert.equal(insideGitRepo(cwd), false, `claude was spawned inside a git repo: ${cwd}`);
  assert.equal(argv[argv.indexOf('--system-prompt') + 1], SYSTEM_PROMPT);
  assert.equal(argv[argv.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.equal(argv[argv.indexOf('--setting-sources') + 1], 'user');
});

test('system prompt is a general assistant, not a coding agent', () => {
  assert.match(SYSTEM_PROMPT, /general/i);
  assert.doesNotMatch(SYSTEM_PROMPT, /PolyPrompt|repo|git|code/i);
});

test('default session directory is outside the PolyPrompt repo', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const rel = path.relative(repo, defaultClaudeHome());
  assert.ok(rel.startsWith('..') || path.isAbsolute(rel), defaultClaudeHome());
});

test('session directory is created if missing and reused for a follow-up (resume)', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'polyprompt-home-'));
  const home = path.join(base, 'nested', 'claude-home');
  try {
    const runner = createClaudeRunner({ command: fx('ok.mjs'), cwd: home });
    const log = logFile();
    const first = await runner.run({ prompt: 'a' });
    assert.ok(existsSync(home));
    const firstCwd = readLog(log).cwd;
    await runner.run({ prompt: 'b', sessionId: first.sessionId });
    const { argv, cwd } = readLog(log);
    assert.equal(path.resolve(firstCwd), path.resolve(home));
    assert.equal(path.resolve(cwd), path.resolve(home));
    assert.equal(argv[argv.indexOf('--resume') + 1], first.sessionId);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('Windows: plain .cmd shim passes the system prompt intact', { skip: !win }, async () => {
  const log = logFile();
  await createClaudeRunner({ command: fx('ok-plain.cmd') }).run({ prompt: 'a', sessionId: 's1' });
  const { argv } = readLog(log);
  assert.equal(argv[argv.indexOf('--system-prompt') + 1], SYSTEM_PROMPT);
});

test('--model is passed only when the setting is not "default"; resume, tools, MCP, prompt and cwd stay', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'polyprompt-model-'));
  const home = path.join(base, 'claude-home');
  try {
    const runner = createClaudeRunner({ command: fx('ok.mjs'), cwd: home });
    for (const model of [undefined, 'default', 'unknown']) {
      const log = logFile();
      await runner.run({ prompt: 'a', sessionId: 's1', model });
      const { argv } = readLog(log);
      assert.ok(!argv.includes('--model'), String(model));
    }
    for (const model of ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
      const log = logFile();
      await runner.run({ prompt: 'a', sessionId: 's1', model });
      const { argv, cwd } = readLog(log);
      assert.equal(argv[argv.indexOf('--model') + 1], model);
      assert.equal(argv.filter((a) => a === '--model').length, 1);
      assert.equal(argv[argv.indexOf('--resume') + 1], 's1');
      assert.equal(argv[argv.indexOf('--tools') + 1], 'WebSearch,WebFetch');
      assert.ok(argv.includes('--strict-mcp-config'));
      assert.equal(argv[argv.indexOf('--system-prompt') + 1], SYSTEM_PROMPT);
      assert.equal(path.resolve(cwd), path.resolve(home));
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('Windows: plain .cmd shim passes --model', { skip: !win }, async () => {
  const log = logFile();
  await createClaudeRunner({ command: fx('ok-plain.cmd') }).run({ prompt: 'a', sessionId: 's1', model: 'claude-haiku-5-5' });
  const { argv } = readLog(log);
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-haiku-5-5');
});

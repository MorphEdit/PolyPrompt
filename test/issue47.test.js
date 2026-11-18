// #47: real claude only routes can_use_tool to the host with
// --permission-prompt-tool stdio; without it edits and commands are denied
// silently. The fake claude behaves the same, so dropping the flag breaks the
// permission-card tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArgs } from '../src/claude.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude', 'script.mjs');

test('folder and plain chat args route permission prompts to the host over stdio', () => {
  for (const argv of [buildArgs('s1', 'default', path.resolve('/some/folder')), buildArgs('s1')]) {
    const i = argv.indexOf('--permission-prompt-tool');
    assert.ok(i !== -1, `missing --permission-prompt-tool in ${JSON.stringify(argv)}`);
    assert.equal(argv[i + 1], 'stdio');
    assert.ok(!argv.includes('--permission-prompts'), 'host is already the default');
  }
});

// Runs the fake claude with the given args; answers every control_request
// with allow and returns the parsed stdout lines.
function runFake(t, args) {
  const dir = mkdtempSync(path.join(tmpdir(), 'polyprompt-47-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'script.json');
  writeFileSync(script, JSON.stringify([
    { ask: { id: 'r1', tool: 'Edit', input: { file_path: 'a.txt' } } },
    { emit: { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's' } },
  ]));
  const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, FIXTURE_SCRIPT: script, FIXTURE_LOG: '' } });
  const lines = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      lines.push(msg);
      if (msg.type === 'control_request') {
        child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { behavior: 'allow', updatedInput: msg.request.input } } }) + '\n');
      }
      if (msg.type === 'result') child.stdin.end();
    }
  });
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }) + '\n');
  return new Promise((resolve) => child.on('close', () => resolve(lines)));
}

test('the fake claude asks the host only with --permission-prompt-tool stdio', async (t) => {
  const withFlag = await runFake(t, ['-p', '--permission-prompt-tool', 'stdio']);
  assert.deepEqual(withFlag.map((m) => m.type), ['control_request', 'result']);
  assert.equal(withFlag[0].request.tool_name, 'Edit');
  assert.equal(withFlag[1].permission_denials, undefined);

  const without = await runFake(t, ['-p', '--permission-prompts', 'host']);
  assert.deepEqual(without.map((m) => m.type), ['result']);
  assert.deepEqual(without[0].permission_denials.map((d) => d.tool_name), ['Edit']);
});

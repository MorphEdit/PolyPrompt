// #57: the additive runner changes the token benchmark relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeError, buildArgs, createClaudeRunner } from '../src/claude.js';
import { readEvent } from '../src/stream.js';
import { readLines } from '../src/bench/results.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude', 'bench.mjs');

async function setup(t, rules) {
  const dir = await mkdtemp(path.join(tmpdir(), 'polyprompt-57-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  process.env.BENCH_CALLS = path.join(dir, 'calls.jsonl');
  process.env.BENCH_RULES = path.join(dir, 'rules.json');
  await writeFile(process.env.BENCH_RULES, JSON.stringify(rules));
  return { home: path.join(dir, 'home'), calls: async () => (await readLines(process.env.BENCH_CALLS)).map((e) => e.value) };
}

test('#57 the parsed result event carries usage, total_cost_usd and duration_ms (null when missing)', () => {
  const usage = { input_tokens: 5, cache_creation_input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 };
  const e = readEvent({ type: 'result', is_error: false, result: 'ok', usage, total_cost_usd: 0.25, duration_ms: 1234 });
  assert.deepEqual([e.usage, e.total_cost_usd, e.duration_ms], [usage, 0.25, 1234]);
  const bare = readEvent({ type: 'result', is_error: false, result: 'ok' });
  assert.deepEqual([bare.usage, bare.total_cost_usd, bare.duration_ms], [null, null, null]);
});

test('#57 extraArgs are appended after the app args; without them the args are unchanged', async (t) => {
  const env = await setup(t, [{ includes: 'hi', text: 'hello' }]);
  const res = await createClaudeRunner({ command: FAKE, cwd: env.home, extraArgs: ['--no-session-persistence'] })
    .run({ prompt: 'hi', model: 'claude-opus-5-5' });
  await createClaudeRunner({ command: FAKE, cwd: env.home }).run({ prompt: 'hi', sessionId: 's1', model: 'claude-opus-5-5' });
  const [bench, app] = await env.calls();
  assert.deepEqual(bench.argv, [...buildArgs(null, 'claude-opus-5-5', null), '--no-session-persistence']);
  assert.deepEqual(app.argv, buildArgs('s1', 'claude-opus-5-5', null));

  assert.equal(res.text, 'hello');
  assert.equal(res.model, 'claude-opus-5-5');
  assert.deepEqual(res.usage, { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 });
  assert.deepEqual(res.modelUsage, { 'claude-opus-5-5': { inputTokens: 2, outputTokens: 5 } });
  assert.equal(res.totalCostUsd, 0.001);
  assert.equal(res.durationMs, 5);
});

test('#57 a failed run keeps the result text and stderr as err.output; kinds and messages stay the same', async (t) => {
  const env = await setup(t, [
    { includes: 'limit', text: 'Claude AI usage limit reached|1700000000', error: true },
    { includes: 'stderr', stderr: 'API Error: Rate limit exceeded', exit: 1 },
  ]);
  const runner = createClaudeRunner({ command: FAKE, cwd: env.home });
  await assert.rejects(runner.run({ prompt: 'limit' }), (err) => {
    assert.ok(err instanceof ClaudeError);
    assert.equal(err.kind, 'failed');
    assert.equal(err.message, new ClaudeError('failed', 'exit 1').message);
    assert.equal(err.output, 'Claude AI usage limit reached|1700000000');
    assert.equal(err.usage.cache_read_input_tokens, 1000);
    return true;
  });
  await assert.rejects(runner.run({ prompt: 'stderr' }), (err) => {
    assert.equal(err.kind, 'failed');
    assert.equal(err.output, 'API Error: Rate limit exceeded');
    assert.equal('usage' in err, false);
    return true;
  });
});

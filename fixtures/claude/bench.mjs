// Fake `claude` for the token benchmark tests (#57). Reads the stream-json
// user line, appends { argv, prompt } to $BENCH_CALLS (JSONL) and answers by
// the first rule in $BENCH_RULES (a JSON list) whose `includes` is in the
// prompt (default: "คำตอบ: 1"):
//   { "includes", "text" }                     a normal answer
//   { "includes", "text", "error": true }      is_error result, exit 1
//   { "includes", "stderr", "exit" }           no result, stderr, exit code
// Every result reports usage derived from the prompt and answer lengths.
import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = argv.indexOf('--model');
const model = flag === -1 ? 'claude-default' : argv[flag + 1];
let buffer = '';
process.stdin.setEncoding('utf8').on('data', (d) => {
  buffer += d;
  const i = buffer.indexOf('\n');
  if (i < 0) return;
  process.stdin.pause();
  const prompt = JSON.parse(buffer.slice(0, i)).message.content;
  if (process.env.BENCH_CALLS) appendFileSync(process.env.BENCH_CALLS, JSON.stringify({ argv, prompt }) + '\n');
  const rules = process.env.BENCH_RULES ? JSON.parse(readFileSync(process.env.BENCH_RULES, 'utf8')) : [];
  const rule = rules.find((r) => prompt.includes(r.includes)) ?? { text: 'คำตอบ: 1' };
  const out = (v) => process.stdout.write(JSON.stringify(v) + '\n');
  out({ type: 'system', subtype: 'init', session_id: 'fake-session' });
  if (rule.stderr !== undefined && rule.text === undefined) {
    // No result event, so the runner never closes stdin: exit by ourselves.
    process.stderr.write(rule.stderr, () => process.exit(rule.exit ?? 1));
    return;
  }
  const usage = { input_tokens: prompt.length, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: rule.text.length };
  if (!rule.error) out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: rule.text }] } });
  out({
    type: 'result', subtype: rule.error ? 'error' : 'success', is_error: !!rule.error, result: rule.text, session_id: 'fake-session',
    usage, modelUsage: { [model]: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } },
    total_cost_usd: 0.001, duration_ms: 5,
  });
  if (rule.error) process.exitCode = 1;
});

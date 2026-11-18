// Scripted fake `claude` speaking the stream-json and control_request /
// control_response protocol (src/stream.js). $FIXTURE_SCRIPT is a JSON file
// with a list of steps:
//   { "emit": {...} }                  print one stdout line
//   { "ask": { "id", "tool", "input" } } print a can_use_tool control_request
//                                      and wait for its control_response; like
//                                      the real CLI, only with
//                                      --permission-prompt-tool stdio, else the
//                                      tool lands in the result's
//                                      permission_denials
//   { "wait": ms }                     sleep
//   { "hang": true }                   never finish
// $FIXTURE_LOG gets { argv, cwd, pid, stdin: [lines], responses: [...] },
// rewritten after every change. The process exits once stdin closes after
// the steps are done.
import { readFileSync, writeFileSync } from 'node:fs';

const steps = JSON.parse(readFileSync(process.env.FIXTURE_SCRIPT, 'utf8'));
const log = { argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid, stdin: [], responses: [] };
const save = () => { if (process.env.FIXTURE_LOG) writeFileSync(process.env.FIXTURE_LOG, JSON.stringify(log)); };
save();

const waiters = new Map();
let gotPrompt;
const prompt = new Promise((r) => { gotPrompt = r; });
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buffer += d;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    log.stdin.push(line);
    const msg = JSON.parse(line);
    if (msg.type === 'user') gotPrompt(msg);
    if (msg.type === 'control_response') {
      log.responses.push(msg.response);
      waiters.get(msg.response.request_id)?.(msg.response);
    }
    save();
  }
});

const out = (v) => process.stdout.write(JSON.stringify(v) + '\n');

const flag = log.argv.indexOf('--permission-prompt-tool');
const promptsHost = flag !== -1 && log.argv[flag + 1] === 'stdio';
const denials = [];

await prompt;
for (const step of steps) {
  if (step.emit) {
    out(step.emit.type === 'result' && denials.length
      ? { ...step.emit, permission_denials: [...(step.emit.permission_denials ?? []), ...denials] }
      : step.emit);
  } else if (step.wait) await new Promise((r) => setTimeout(r, step.wait));
  else if (step.ask && !promptsHost) {
    denials.push({ tool_name: step.ask.tool, tool_use_id: step.ask.id, tool_input: step.ask.input ?? {} });
  } else if (step.ask) {
    const answered = new Promise((r) => waiters.set(step.ask.id, r));
    out({ type: 'control_request', request_id: step.ask.id,
      request: { subtype: 'can_use_tool', tool_name: step.ask.tool, input: step.ask.input ?? {} } });
    await answered;
  } else if (step.hang) {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
}

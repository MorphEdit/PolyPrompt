// Fake `claude --model <unknown>`: what Claude Code prints when the model
// does not exist or the account has no access to it (exit 1).
import { readFileSync } from 'node:fs';
readFileSync(0, 'utf8');
const model = process.argv[process.argv.indexOf('--model') + 1];
process.stderr.write(`[claude-code:unrecognized_model] {"model":"${model}","query_source":"sdk"}\n`);
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', is_error: true, api_error_status: 404, modelUsage: {}, session_id: 's9',
  result: `There's an issue with the selected model (${model}). It may not exist or you may not have access to it. Run --model to pick a different model.`,
}) + '\n');
process.exitCode = 1;

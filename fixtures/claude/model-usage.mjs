// Fake `claude`: answers with modelUsage listing a helper model and the model
// that actually wrote the answer.
import { readFileSync } from 'node:fs';
readFileSync(0, 'utf8');
process.stdout.write(JSON.stringify({
  type: 'result', is_error: false, result: 'hi', session_id: 's2',
  modelUsage: {
    'claude-haiku-5-5': { inputTokens: 300, outputTokens: 12 },
    'claude-opus-5-5': { inputTokens: 40, outputTokens: 250 },
  },
}) + '\n');

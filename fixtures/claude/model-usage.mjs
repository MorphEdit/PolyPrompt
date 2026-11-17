// Fake `claude`: answers with modelUsage listing a helper model and the model
// that actually wrote the answer.
// Answers once the stream-json user line has arrived on stdin.
process.stdin.setEncoding('utf8').once('data', () => {
  process.stdin.pause();
  process.stdout.write(JSON.stringify({
    type: 'result', is_error: false, result: 'hi', session_id: 's2',
    modelUsage: {
      'claude-haiku-5-5': { inputTokens: 300, outputTokens: 12 },
      'claude-opus-5-5': { inputTokens: 40, outputTokens: 250 },
    },
  }) + '\n');
});

// Fake newer `claude`: warns `unrecognized_model` on stderr for a model it
// does not list yet, then answers normally from that model.
// Answers once the stream-json user line has arrived on stdin.
process.stdin.setEncoding('utf8').once('data', () => {
  process.stdin.pause();
  const model = process.argv[process.argv.indexOf('--model') + 1];
  process.stderr.write(`[claude-code:unrecognized_model] {"model":"${model}","query_source":"sdk"}\n`);
  process.stdout.write(JSON.stringify({
    type: 'result', is_error: false, result: 'ok', session_id: 's53',
    modelUsage: { [model]: { inputTokens: 10, outputTokens: 2 } },
  }) + '\n');
});

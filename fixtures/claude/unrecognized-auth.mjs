// Fake `claude`: warns `unrecognized_model` on stderr, then fails because it
// is not logged in (exit 1). The failure is about login, not the model.
// Answers once the stream-json user line has arrived on stdin.
process.stdin.setEncoding('utf8').once('data', () => {
  process.stdin.pause();
  const model = process.argv[process.argv.indexOf('--model') + 1];
  process.stderr.write(`[claude-code:unrecognized_model] {"model":"${model}","query_source":"sdk"}\n`);
  process.stdout.write(JSON.stringify({
    type: 'result', is_error: true, result: 'Invalid API key · Please run /login', session_id: 's53',
  }) + '\n');
  process.exitCode = 1;
});

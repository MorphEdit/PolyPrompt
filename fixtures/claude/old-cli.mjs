// Fake old `claude` (2.1.150) given a model newer than it supports (exit 1).
// Answers once the stream-json user line has arrived on stdin.
process.stdin.setEncoding('utf8').once('data', () => {
  process.stdin.pause();
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'success', is_error: true, modelUsage: {}, session_id: 's53',
    result: "API Error: 400 Claude Code 2.1.150 does not support this model; version 2.1.290 or newer is required. Run 'claude update' to update.",
  }) + '\n');
  process.exitCode = 1;
});

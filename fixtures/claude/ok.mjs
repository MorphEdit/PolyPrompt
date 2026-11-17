// Fake `claude`: reads the stream-json user line from stdin, records argv,
// that line and cwd to $FIXTURE_LOG, and prints a success result.
import { writeFileSync } from 'node:fs';

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  stdin += d;
  if (!stdin.includes('\n')) return;
  const line = stdin.slice(0, stdin.indexOf('\n'));
  if (process.env.FIXTURE_LOG) {
    writeFileSync(process.env.FIXTURE_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin: line, cwd: process.cwd() }));
  }
  process.stdout.write('{"type":"result","is_error":false,"result":"hi","session_id":"s2"}\n');
  process.stdin.pause();
});

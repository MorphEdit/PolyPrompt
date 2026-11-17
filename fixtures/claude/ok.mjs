// Fake `claude`: records argv and stdin to $FIXTURE_LOG, prints a success result.
import { readFileSync, writeFileSync } from 'node:fs';
const stdin = readFileSync(0, 'utf8');
if (process.env.FIXTURE_LOG) {
  writeFileSync(process.env.FIXTURE_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd() }));
}
process.stdout.write('{"type":"result","is_error":false,"result":"hi","session_id":"s2"}\n');

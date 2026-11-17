// Fake `claude` that exits non-zero with a valid-looking result.
process.stderr.write('boom\n');
process.stdout.write('{"type":"result","is_error":false,"result":"hi","session_id":"s2"}');
process.exit(2);

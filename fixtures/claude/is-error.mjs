// Fake `claude` whose JSON says is_error but exits 0.
process.stdout.write('{"type":"result","is_error":true,"result":"Something broke","session_id":"s2"}');

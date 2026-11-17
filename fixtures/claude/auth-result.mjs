// Fake `claude` reporting an auth error in the JSON result.
process.stdout.write('{"type":"result","is_error":true,"result":"Invalid API key · auth","session_id":"s3"}');
process.exit(1);

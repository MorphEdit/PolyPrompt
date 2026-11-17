import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('entry point prints the 127.0.0.1 URL and serves before the model is ready', async (t) => {
  const child = spawn(process.execPath, [path.join(root, 'src', 'main.js')], {
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', (code) => reject(new Error('exited ' + code + ': ' + out)));
  });
  assert.ok(port > 0);
  assert.equal((await request(port, 'GET', '/')).status, 200);
  const { model } = (await request(port, 'GET', '/api/status')).json;
  assert.ok(['loading', 'error'].includes(model.state));
});

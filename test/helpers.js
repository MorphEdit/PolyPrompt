import http from 'node:http';

export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Fake loader: each call records its onProgress and a deferred to settle.
export function fakeLoader() {
  const calls = [];
  const load = (onProgress) => {
    const d = deferred();
    calls.push({ onProgress, ...d });
    return d.promise;
  };
  return { load, calls };
}

export const tick = () => new Promise((r) => setImmediate(r));

export function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address())));
}

// Raw request so the path is sent as-is (no client-side normalisation).
export function request(port, method, path, { headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

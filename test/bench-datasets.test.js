// #57: dataset files at pinned revisions, checked by SHA-256 (fake fetch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DATASETS, DatasetError, fetchFile, fileUrl, loadRows, readJsonl, sha256 } from '../src/bench/datasets.js';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'polyprompt-datasets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const fakeFetch = (bodies) => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const body = bodies[url];
    if (body === undefined) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  };
  return { fetch, calls };
};

const JSONL = '{"a":1}\r\n{"a":2}\n\n{"a":3}\n';
const dataset = (hash, files = [{ path: 'data/x.jsonl', sha256: hash }]) => ({ repo: 'org/set', rev: 'abc123', files });

test('#57 every dataset is pinned to a revision with a SHA-256 per file', () => {
  assert.equal(DATASETS.mgsm.rev, 'b2f13d426afe3be8d69a7e739b36724db8b66bbc');
  assert.equal(DATASETS.belebele.rev, '7899cdfa4e1e0d733fd77c848e2c273cb1d32be2');
  assert.equal(DATASETS.open.rev, '9099b833a1b6b9d471d7e6f4abb22bf88f318bd4');
  assert.deepEqual(DATASETS.belebele.files.map((f) => f.path), ['data/tha_Thai.jsonl']);
  for (const d of Object.values(DATASETS)) for (const f of d.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);
  assert.equal(fileUrl('facebook/belebele', 'r1', 'data/tha_Thai.jsonl'), 'https://huggingface.co/datasets/facebook/belebele/resolve/r1/data/tha_Thai.jsonl');
});

test('#57 a file is fetched at the pinned revision, checked and cached', async (t) => {
  const cacheDir = await tempDir(t);
  const url = 'https://huggingface.co/datasets/org/set/resolve/abc123/data/x.jsonl';
  const { fetch, calls } = fakeFetch({ [url]: JSONL });
  const d = dataset(sha256(Buffer.from(JSONL)));
  assert.deepEqual(await loadRows('belebele', { dataset: d, cacheDir, fetch }), [{ a: 1 }, { a: 2 }, { a: 3 }]);
  assert.deepEqual(calls, [url]);
  // Second time from the cache, no fetch.
  assert.deepEqual(await loadRows('belebele', { dataset: d, cacheDir, fetch }), [{ a: 1 }, { a: 2 }, { a: 3 }]);
  assert.equal(calls.length, 1);
});

test('#57 a SHA-256 mismatch stops the run with a clear error and caches nothing', async (t) => {
  const cacheDir = await tempDir(t);
  const url = 'https://huggingface.co/datasets/org/set/resolve/abc123/data/x.jsonl';
  const { fetch } = fakeFetch({ [url]: JSONL.replace('3', '4') });
  const d = dataset(sha256(Buffer.from(JSONL)));
  await assert.rejects(loadRows('belebele', { dataset: d, cacheDir, fetch }), (err) => {
    assert.ok(err instanceof DatasetError);
    assert.match(err.message, /SHA-256 mismatch for belebele data\/x\.jsonl at abc123/);
    assert.match(err.message, new RegExp(`expected ${d.files[0].sha256}`));
    return true;
  });
  // A tampered cached file is not trusted either: it is fetched again and checked.
  const local = path.join(cacheDir, 'belebele', 'abc123', 'data', 'x.jsonl');
  await assert.rejects(readFile(local), { code: 'ENOENT' });
  await mkdir(path.dirname(local), { recursive: true });
  await writeFile(local, 'tampered');
  await assert.rejects(fetchFile('belebele', d.files[0], { dataset: d, cacheDir, fetch }), DatasetError);
  await assert.rejects(loadRows('belebele', { dataset: d, cacheDir, fetch: fakeFetch({}).fetch }), /HTTP 404/);
});

test('#57 rows of a split in several files are read in ascending path order', async (t) => {
  const cacheDir = await tempDir(t);
  const base = 'https://huggingface.co/datasets/org/set/resolve/abc123/';
  const one = '{"r":"b0"}\n';
  const two = '{"r":"a0"}\n{"r":"a1"}\n';
  const { fetch } = fakeFetch({ [`${base}test-b.jsonl`]: one, [`${base}test-a.jsonl`]: two });
  const d = dataset(null, [
    { path: 'test-b.jsonl', sha256: sha256(Buffer.from(one)) },
    { path: 'test-a.jsonl', sha256: sha256(Buffer.from(two)) },
  ]);
  assert.deepEqual((await loadRows('open', { dataset: d, cacheDir, fetch })).map((r) => r.r), ['a0', 'a1', 'b0']);
  assert.deepEqual(readJsonl('{"x":1}\r\n\n'), [{ x: 1 }]);
});

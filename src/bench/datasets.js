// Dataset files of the token benchmark, at pinned revisions and checked by
// SHA-256 before use. Downloaded once into .cache/bench/.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parquetReadObjects } from 'hyparquet';
import { byCodePoint } from './rng.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CACHE_DIR = path.join(root, '.cache', 'bench');

// mgsm: the pinned revision has no mgsm_th.tsv; its card's `configs` lists
// th/test-* for config `th`, split `test`, which is this one parquet file.
export const DATASETS = {
  mgsm: {
    repo: 'juletxara/mgsm',
    rev: 'b2f13d426afe3be8d69a7e739b36724db8b66bbc',
    files: [{ path: 'th/test-00000-of-00001.parquet', sha256: '64dad497569988ac3ca88d7d805e078fe14cfa42dcc104357e1b6958321811cb' }],
  },
  belebele: {
    repo: 'facebook/belebele',
    rev: '7899cdfa4e1e0d733fd77c848e2c273cb1d32be2',
    files: [{ path: 'data/tha_Thai.jsonl', sha256: 'd668fa174428e09ed03b47028cb30f6fd0032017fc4b1b589c242f15bc8a73e3' }],
  },
  open: {
    repo: 'airesearch/WangchanThaiInstruct',
    rev: '9099b833a1b6b9d471d7e6f4abb22bf88f318bd4',
    files: [{ path: 'data/test-00000-of-00001.parquet', sha256: '07d71ae523e5de90c21e81b30d72d12ab55f6437efb0be51c36764056139763d' }],
  },
};

export const fileUrl = (repo, rev, file) => `https://huggingface.co/datasets/${repo}/resolve/${rev}/${file}`;
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export class DatasetError extends Error {}

// The file's bytes: from the cache when its hash matches, else downloaded and
// checked. A downloaded file with another hash stops the run (and is not cached).
export async function fetchFile(set, file, { dataset = DATASETS[set], cacheDir = CACHE_DIR, fetch = globalThis.fetch } = {}) {
  const local = path.join(cacheDir, set, dataset.rev, ...file.path.split('/'));
  try {
    const cached = await readFile(local);
    if (sha256(cached) === file.sha256) return cached;
  } catch {}
  const url = fileUrl(dataset.repo, dataset.rev, file.path);
  const res = await fetch(url);
  if (!res.ok) throw new DatasetError(`download failed: ${url} (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== file.sha256) {
    throw new DatasetError(`SHA-256 mismatch for ${set} ${file.path} at ${dataset.rev}: expected ${file.sha256}, got ${got}. The file at the pinned revision changed; the benchmark stops.`);
  }
  await mkdir(path.dirname(local), { recursive: true });
  await writeFile(`${local}.tmp`, buf);
  await rename(`${local}.tmp`, local);
  return buf;
}

export async function readParquet(buf) {
  const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return parquetReadObjects({ file });
}

export function readJsonl(text) {
  return text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// Rows of a set in file order; several files are read in ascending path order.
export async function loadRows(set, opts = {}) {
  const dataset = opts.dataset ?? DATASETS[set];
  const rows = [];
  for (const file of [...dataset.files].sort((a, b) => byCodePoint(a.path, b.path))) {
    const buf = await fetchFile(set, file, { ...opts, dataset });
    rows.push(...(file.path.endsWith('.parquet') ? await readParquet(buf) : readJsonl(buf.toString('utf8'))));
  }
  return rows;
}

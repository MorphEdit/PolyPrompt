// Result files of a benchmark run (bench/results/<run>/): append-only JSONL,
// where the last line of an item/condition pair (or judge id/order) wins.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// [{ value, line }] with 1-based line numbers; a malformed line (a write cut
// short by Ctrl+C) is ignored. A missing file has no lines.
export async function readLines(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  text.split('\n').forEach((raw, i) => {
    if (!raw.trim()) return;
    try {
      out.push({ value: JSON.parse(raw), line: i + 1 });
    } catch {}
  });
  return out;
}

// key -> the last entry with that key.
export function lastBy(entries, key) {
  const map = new Map();
  for (const e of entries) map.set(key(e.value), e);
  return map;
}

export const pairKey = (v) => `${v.id}\u0000${v.condition}`;
export const judgeKey = (v) => `${v.id}\u0000${v.order}`;
export const isErrorLine = (v) => v?.error != null;

// Appends are chained, so concurrent items never interleave their lines.
export function createAppender() {
  let chain = Promise.resolve();
  return (file, value) => {
    chain = chain.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, JSON.stringify(value) + '\n', 'utf8');
    });
    return chain;
  };
}

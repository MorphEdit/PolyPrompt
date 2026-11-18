// The frozen benchmark sample (bench/sample.json): which row IDs of each set
// take part. An item's ID is its 0-based row index as a decimal string.
import { MAX_CHARS } from '../pipeline.js';
import { promptFor } from './prompts.js';
import { SEED, byCodePoint, byNumericId, mulberry32, shuffle } from './rng.js';

export const BELEBELE_COUNT = 200;
export const OPEN_COUNT = 100;

const ids = (rows) => rows.map((_, i) => String(i));

// Why an `open` row is skipped before sampling, or null.
export function skipReason(row) {
  if (promptFor('open', row).length > MAX_CHARS) return 'too_long';
  if (typeof row.Output !== 'string' || row.Output.trim() === '') return 'empty_output';
  return null;
}

// Slots per group: count × total / sum, rounded by largest remainder (ties by
// key in code-point order), never more than the group's count. counts is
// { key: count }; returns { key: slots }.
export function allocate(counts, total) {
  const keys = Object.keys(counts).sort(byCodePoint);
  const sum = keys.reduce((s, k) => s + counts[k], 0);
  if (sum <= total) return Object.fromEntries(keys.map((k) => [k, counts[k]]));
  // Exact integer arithmetic: slots = floor(total × count / sum), remainder = (total × count) mod sum.
  const slots = {};
  const rest = [];
  for (const k of keys) {
    const p = total * counts[k];
    slots[k] = Math.floor(p / sum);
    rest.push({ k, r: p % sum });
  }
  let left = total - keys.reduce((s, k) => s + slots[k], 0);
  rest.sort((a, b) => b.r - a.r || byCodePoint(a.k, b.k));
  for (const { k } of rest) {
    if (left <= 0) break;
    if (slots[k] < counts[k]) {
      slots[k]++;
      left--;
    }
  }
  return slots;
}

// rows: { mgsm, belebele, open } arrays in file order. Each set gets its own
// fresh generator, so one set's sample never depends on another's.
export function buildSample(rows, { seed = SEED } = {}) {
  const mgsm = ids(rows.mgsm);
  const belebele = shuffle(ids(rows.belebele), mulberry32(seed)).slice(0, BELEBELE_COUNT);

  const skipped = [];
  const groups = new Map();
  rows.open.forEach((row, i) => {
    const id = String(i);
    const reason = skipReason(row);
    if (reason) return skipped.push({ id, reason });
    const type = String(row.Task_type ?? '');
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(id);
  });
  const slots = allocate(Object.fromEntries([...groups].map(([k, v]) => [k, v.length])), OPEN_COUNT);
  const rng = mulberry32(seed);
  const open = [];
  for (const type of [...groups.keys()].sort(byCodePoint)) {
    open.push(...shuffle(groups.get(type), rng).slice(0, slots[type]));
  }

  return {
    seed,
    sets: {
      mgsm: mgsm.sort(byNumericId),
      belebele: belebele.sort(byNumericId),
      open: open.sort(byNumericId),
    },
    skipped: { open: skipped },
  };
}

export const sampleJson = (sample) => JSON.stringify(sample, null, 2) + '\n';

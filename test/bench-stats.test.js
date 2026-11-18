// #57: report math on small fixtures, against the PRD's definitions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/bench/rng.js';
import { bootstrapCI, discordant, mcnemar, mean, median, pairedPct, wilson } from '../src/bench/stats.js';

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('#57 median and mean', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
  assert.equal(median([]), null);
  assert.equal(mean([1, 2, 6]), 3);
  assert.equal(mean([]), null);
});

test('#57 paired % difference is the % change of the summed totals', () => {
  // ΣA = 300, ΣB = 240 -> -20%.
  assert.equal(pairedPct([{ a: 100, b: 50 }, { a: 200, b: 190 }]), -20);
  assert.equal(pairedPct([{ a: 10, b: 15 }]), 50);
  assert.equal(pairedPct([]), null);
  assert.equal(pairedPct([{ a: 0, b: 5 }]), null, 'ΣA = 0 is n/a');
});

test('#57 bootstrap CI: 10,000 seeded resamples, percentile [s[250], s[9749]]', () => {
  const pairs = [{ a: 100, b: 50 }, { a: 200, b: 190 }, { a: 120, b: 100 }, { a: 80, b: 90 }, { a: 300, b: 210 }];
  const ci = bootstrapCI(pairs);
  assert.deepEqual(bootstrapCI(pairs), ci, 'seeded: same interval every time');

  // The definition, written out.
  const rng = mulberry32(20261118);
  const s = [];
  for (let r = 0; r < 10000; r++) {
    const pick = Array.from({ length: pairs.length }, () => pairs[Math.floor(rng() * pairs.length)]);
    s.push(pairedPct(pick));
  }
  s.sort((x, y) => x - y);
  assert.deepEqual(ci, [s[250], s[9749]]);
  assert.ok(ci[0] < pairedPct(pairs) && pairedPct(pairs) < ci[1]);
  assert.equal(pairedPct(pairs), -20);

  // Every pair halves: the interval collapses to -50%.
  assert.deepEqual(bootstrapCI([{ a: 10, b: 5 }, { a: 40, b: 20 }]), [-50, -50]);
  assert.equal(bootstrapCI([]), null);
});

test('#57 Wilson 95% interval with z = 1.959964', () => {
  const [lo, hi] = wilson(8, 10);
  close(lo, 0.490162);
  close(hi, 0.943318);
  const [lo0, hi0] = wilson(0, 20);
  close(lo0, 0);
  close(hi0, 0.161125);
  const [lo1, hi1] = wilson(5, 5);
  close(lo1, 0.565518);
  close(hi1, 1);
  assert.equal(wilson(0, 0), null);
});

test('#57 McNemar: exact two-sided binomial on the discordant pairs', () => {
  assert.deepEqual(mcnemar(0, 0), { b: 0, c: 0, p: 1 });
  assert.deepEqual(mcnemar(5, 0), { b: 5, c: 0, p: 0.0625 });
  // n = 4: 2 × (C(4,0) + C(4,1)) / 16 = 0.625.
  assert.deepEqual(mcnemar(3, 1), { b: 3, c: 1, p: 0.625 });
  assert.equal(mcnemar(10, 10).p, 1);
  // n = 12, min = 2: 2 × (1 + 12 + 66) / 4096.
  close(mcnemar(2, 10).p, (2 * 79) / 4096, 1e-12);
  assert.ok(mcnemar(0, 2000).p >= 0, 'no underflow to NaN');
  // b = A right / B wrong, c = A wrong / B right.
  assert.deepEqual(discordant([{ a: 1, b: 0 }, { a: 1, b: 1 }, { a: 0, b: 1 }, { a: 0, b: 1 }, { a: 0, b: 0 }]), { b: 1, c: 2 });
});

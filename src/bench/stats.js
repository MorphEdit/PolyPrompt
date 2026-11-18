// Report math for the token benchmark (definitions in PRD #56).
import { SEED, mulberry32 } from './rng.js';

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export const mean = (values) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : null);

// 100 × (ΣB − ΣA) / ΣA over pairs [{ a, b }]; null when there are no pairs or ΣA is 0.
export function pairedPct(pairs) {
  if (!pairs.length) return null;
  let a = 0;
  let b = 0;
  for (const p of pairs) {
    a += p.a;
    b += p.b;
  }
  return a === 0 ? null : (100 * (b - a)) / a;
}

// 95% percentile bootstrap of pairedPct: `resamples` resamples with
// replacement (pick = floor(rng() × n)) from a fresh mulberry32(seed);
// [s[250], s[9749]] for 10,000. Resamples with ΣA = 0 count as NaN and sort last.
export function bootstrapCI(pairs, { seed = SEED, resamples = 10000 } = {}) {
  const n = pairs.length;
  if (!n || pairedPct(pairs) === null) return null;
  const rng = mulberry32(seed);
  const values = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let a = 0;
    let b = 0;
    for (let i = 0; i < n; i++) {
      const p = pairs[Math.floor(rng() * n)];
      a += p.a;
      b += p.b;
    }
    values[r] = a === 0 ? NaN : (100 * (b - a)) / a;
  }
  values.sort((x, y) => (Number.isNaN(x) ? 1 : Number.isNaN(y) ? -1 : x - y));
  const lo = values[Math.round(resamples * 0.025)];
  const hi = values[Math.round(resamples * 0.975) - 1];
  return Number.isNaN(lo) || Number.isNaN(hi) ? null : [lo, hi];
}

export const Z95 = 1.959964;

// Wilson score interval for k successes out of n; null when n is 0.
export function wilson(k, n, z = Z95) {
  if (!n) return null;
  const p = k / n;
  const z2 = z * z;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [center - half, center + half];
}

// Exact two-sided McNemar: p = min(1, 2 × Σ_{i=0}^{min(b,c)} C(b+c, i) × 0.5^(b+c)).
// Terms are summed in log space so large n does not underflow.
export function mcnemar(b, c) {
  const n = b + c;
  if (n === 0) return { b, c, p: 1 };
  let logC = 0; // log C(n, 0)
  let sum = 0;
  const half = n * Math.log(0.5);
  for (let i = 0; i <= Math.min(b, c); i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    sum += Math.exp(logC + half);
  }
  return { b, c, p: Math.min(1, 2 * sum) };
}

// Discordant counts of paired 0/1 scores [{ a, b }]: b = A right / B wrong, c = A wrong / B right.
export function discordant(pairs) {
  let b = 0;
  let c = 0;
  for (const p of pairs) {
    if (p.a === 1 && p.b !== 1) b++;
    else if (p.a !== 1 && p.b === 1) c++;
  }
  return { b, c };
}

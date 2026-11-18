// Seeded randomness for the token benchmark: every draw comes from a fresh
// mulberry32 generator seeded with SEED, so samples and orders are the same
// on every machine.

export const SEED = 20261118;

// mulberry32: a small 32-bit PRNG; returns () => number in [0, 1).
export function mulberry32(seed = SEED) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher–Yates shuffle of a copy: i from the end down to 1, j = floor(rng() * (i + 1)).
export function shuffle(items, rng) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Ascending Unicode code-point order (not UTF-16 code units).
export function byCodePoint(a, b) {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}

export const byNumericId = (a, b) => Number(a) - Number(b);

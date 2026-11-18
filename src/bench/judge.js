// Blind pairwise judge for the `open` set: verdict parsing and the per-item
// outcome over both orders.

const WINNERS = [1, 2, 'tie'];

// The JSON object starting at text[start] ('{'), or null.
function objectAt(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// The first JSON object in the answer whose winner is 1, 2 or "tie", as
// { winner, reason }, or null (an unparseable judge answer).
export function parseVerdict(text) {
  if (typeof text !== 'string') return null;
  for (let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1)) {
    const value = objectAt(text, i);
    if (value && typeof value === 'object' && !Array.isArray(value) && WINNERS.includes(value.winner)) {
      return { winner: value.winner, reason: typeof value.reason === 'string' ? value.reason : null };
    }
  }
  return null;
}

// Order 1 shows A as "คำตอบ 1"; order 2 shows B as "คำตอบ 1".
function conditionOf(order, winner) {
  if (winner === 'tie') return 'tie';
  return (order === 1) === (winner === 1) ? 'A' : 'B';
}

// 'A' | 'B' when both orders name the same condition, else 'tie'.
export function judgeOutcome(winner1, winner2) {
  const a = conditionOf(1, winner1);
  const b = conditionOf(2, winner2);
  return a === b && a !== 'tie' ? a : 'tie';
}

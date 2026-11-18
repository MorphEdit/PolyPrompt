// Answer parsing and scoring for the scored sets (mgsm, belebele), plus the
// quota check that stops a run.

const MARKER = /(?:คำตอบ|answer)\s*[*_]*\s*[:：]/giu;
// Thai, Arabic-Indic and Extended Arabic-Indic digits -> ASCII.
const DIGIT_BLOCKS = [0x0e50, 0x0660, 0x06f0];
const NUMBER = /[-−]?\d[\d,]*(?:\.\d+)?/;

export function asciiDigits(text) {
  return String(text).replace(/[๐-๙٠-٩۰-۹]/g, (d) => {
    const c = d.codePointAt(0);
    const base = DIGIT_BLOCKS.find((b) => c >= b && c <= b + 9);
    return String(c - base);
  });
}

// The first number in `text` (commas between digits dropped, any unit after
// it ignored), as a canonical decimal string ("1,000.50 บาท" -> "1000.5"), or null.
function firstNumber(text) {
  const m = NUMBER.exec(asciiDigits(text));
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, '').replace('−', '-'));
  return Number.isFinite(n) ? String(n) : null;
}

// The answer on the last "คำตอบ:" / "Answer:" line (the text after its last
// marker, or the next non-empty line when the marker ends the line), or null.
export function parseAnswer(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const marks = [...lines[i].matchAll(MARKER)];
    if (!marks.length) continue;
    const last = marks[marks.length - 1];
    const found = firstNumber(lines[i].slice(last.index + last[0].length));
    if (found !== null) return found;
    const next = lines.slice(i + 1).find((l) => l.trim());
    return next === undefined ? null : firstNumber(next);
  }
  return null;
}

// 1 when the parsed answer equals the key, 0 otherwise (unparseable included).
export function score(parsed, expected) {
  if (parsed === null || parsed === undefined || expected === null || expected === undefined) return 0;
  return Number(parsed) === Number(expected) ? 1 : 0;
}

// A failed `claude` run whose output says the usage quota is used up.
export const QUOTA = /usage limit|rate limit|quota/i;
export const isQuotaError = (err) => err?.kind === 'failed' && QUOTA.test(String(err.output ?? ''));

// Pure text helpers for translating long text: splitting into pieces the
// translator accepts, protecting code/URLs/Markdown syntax from translation
// and rejecting degenerate translator output.

const PARAGRAPH_BREAK = /\s*\n[^\S\n]*\n\s*/g;
// After . ! ? 。 followed by whitespace, after 。 directly, or at a newline.
const SENTENCE_END = /(?<=[.!?。])\s+|(?<=。)(?=\S)|[^\S\n]*\n\s*/g;
const PROTECTED = /```[\s\S]*?(?:```|$)|``[^\n]*?``|`[^`\n]+`|https?:\/\/[^\s<>()`"']*[^\s<>()`"'.,!?;:]/g;
const PLACEHOLDER = /⟦(\d+)⟧/g;
const PLACEHOLDER_LOOSE = /⟦\s*(\d+)\s*⟧/g;

// Split `text` at every match of `re` into { piece, sep } (sep = the match).
function splitAt(text, re) {
  const parts = [];
  let start = 0;
  for (const m of text.matchAll(re)) {
    parts.push({ piece: text.slice(start, m.index), sep: m[0] });
    start = m.index + m[0].length;
  }
  parts.push({ piece: text.slice(start), sep: '' });
  return parts;
}

// Cut a sentence into pieces of at most maxChars: at the last whitespace within
// the limit, else hard-cut at maxChars without cutting through a `keep` match.
function cutLong(text, maxChars, keep) {
  const parts = [];
  let rest = text;
  while (rest.length > maxChars) {
    let i = maxChars;
    while (i > 0 && !/\s/.test(rest[i])) i--;
    if (i > 0) {
      const ws = /^\s+/.exec(rest.slice(i))[0];
      parts.push({ piece: rest.slice(0, i), sep: ws });
      rest = rest.slice(i + ws.length);
      continue;
    }
    let cut = maxChars;
    if (keep) {
      for (const m of rest.matchAll(new RegExp(keep.source, 'g'))) {
        if (m.index >= cut) break;
        const end = m.index + m[0].length;
        if (end > cut) cut = m.index > 0 ? m.index : end;
      }
    }
    parts.push({ piece: rest.slice(0, cut), sep: '' });
    rest = rest.slice(cut);
  }
  parts.push({ piece: rest, sep: '' });
  return parts;
}

// Split each part whose piece is longer than maxChars with `fn`, keeping the
// part's own separator after the last sub-piece.
function refine(parts, maxChars, fn) {
  return parts.flatMap((p) => {
    if (p.piece.length <= maxChars) return [p];
    const sub = fn(p.piece);
    sub[sub.length - 1].sep += p.sep;
    return sub;
  });
}

// Split text into [{ piece, sep }] with every piece.length <= maxChars, where
// pieces.map((p) => p.piece + p.sep).join('') === text. Matches of the
// optional `keep` regex are never cut (needed only for the hard cut).
export function splitText(text, maxChars, { keep } = {}) {
  if (text.length <= maxChars) return [{ piece: text, sep: '' }];
  let parts = splitAt(text, PARAGRAPH_BREAK);
  parts = refine(parts, maxChars, (t) => splitAt(t, SENTENCE_END));
  return refine(parts, maxChars, (t) => cutLong(t, maxChars, keep));
}

// Replace fenced code blocks, inline code and http(s) URLs with ⟦n⟧ tokens.
export function protect(text) {
  const originals = [];
  const replaced = text.replace(PROTECTED, (m) => `⟦${originals.push(m) - 1}⟧`);
  return {
    text: replaced,
    restore: (translated) =>
      translated.replace(PLACEHOLDER_LOOSE, (m, n) => (n < originals.length ? originals[n] : m)),
  };
}

// Markdown structure that never goes to the translator: the line prefix
// (indent, quote, heading, list marker, task box) and inline markers
// (emphasis, strike, table pipes, link brackets). Placeholders for protected
// spans are split out too: translators drop or mangle them (⟦0⟧ -> 0).
const LINE_BREAK = /(\r?\n)/;
const LINE_PREFIX = /^[^\S\n]*(?:>[^\S\n]?)*(?:#{1,6}(?=\s|$)|(?:[-*+]|\d+[.)])(?=\s)(?:\s+\[[ xX]\](?=\s))?)?[^\S\n]*/;
const INLINE_MARKER = /(⟦\d+⟧|\*+|~~|(?<![\p{L}\p{N}_])_+|_+(?![\p{L}\p{N}_])|\||!?\[|\]\([^)\s]*\))/u;
const EDGE_SPACE = /^(\s*)([\s\S]*?)(\s*)$/;
// One unit of up to 20 chars repeated 8+ times in a row.
const REPEAT = /(\S.{0,19}?)\1{7,}/su;

const hasLetters = (text) => /\p{L}/u.test(text.replace(PLACEHOLDER, ''));

function letterRatio(text) {
  const visible = text.replace(PLACEHOLDER_LOOSE, '').replace(/\s/g, '');
  if (!visible) return 0;
  return (visible.match(/[\p{L}\p{M}\p{N}]/gu)?.length ?? 0) / visible.length;
}

// True when `out` looks like a broken model output for the source `src`:
// empty, mostly symbols, one unit repeated, few tokens repeated, or far longer.
export function isDegenerate(src, out) {
  const text = String(out ?? '').replace(PLACEHOLDER_LOOSE, '').trim();
  if (!text) return true;
  if (out.length > 3 * src.length + 20) return true;
  if (letterRatio(out) < Math.min(0.5, letterRatio(src) * 0.75)) return true;
  if (REPEAT.test(text) && !REPEAT.test(src)) return true;
  const tokens = text.split(/\s+/);
  return tokens.length >= 12 && new Set(tokens).size * 4 <= tokens.length;
}

// Remove a line prefix (list marker, heading, quote) the translator added to a
// piece whose source has none, e.g. "สวัสดี" -> "- What's up?".
function dropAddedPrefix(src, out) {
  if (typeof out !== 'string' || LINE_PREFIX.exec(src)[0].trim()) return out;
  const prefix = LINE_PREFIX.exec(out)[0];
  return prefix.trim() ? out.slice(prefix.length) : out;
}

// Translate one piece; on degenerate output retry sentence by sentence, and
// fall back to the source piece rather than show garbage.
async function translatePiece(translator, piece, srcLang, tgtLang) {
  if (!hasLetters(piece)) return piece;
  const out = dropAddedPrefix(piece, await translator.translate(piece, srcLang, tgtLang));
  if (!isDegenerate(piece, out)) return out;
  const sentences = splitAt(piece, SENTENCE_END);
  if (sentences.length < 2) return piece;
  let joined = '';
  for (const { piece: s, sep } of sentences) joined += (await translatePiece(translator, s, srcLang, tgtLang)) + sep;
  return joined;
}

// Translate a run of plain text, keeping its surrounding whitespace.
async function translateRun(translator, run, srcLang, tgtLang, maxChars) {
  const [, lead, body, trail] = EDGE_SPACE.exec(run);
  if (!hasLetters(body)) return run;
  let out = '';
  for (const { piece, sep } of splitText(body, maxChars, { keep: PLACEHOLDER })) {
    out += (await translatePiece(translator, piece, srcLang, tgtLang)) + sep;
  }
  return lead + out + trail;
}

// Translate line by line: Markdown prefixes and inline markers are kept as-is
// and only the plain-text runs between them go to the translator.
export async function translateText(translator, text, srcLang, tgtLang, { maxChars = 2000 } = {}) {
  const { text: safe, restore } = protect(text);
  let out = '';
  for (const [i, line] of safe.split(LINE_BREAK).entries()) {
    if (i % 2) { out += line; continue; }
    const prefix = LINE_PREFIX.exec(line)[0];
    out += prefix;
    for (const [j, part] of line.slice(prefix.length).split(INLINE_MARKER).entries()) {
      out += j % 2 ? part : await translateRun(translator, part, srcLang, tgtLang, maxChars);
    }
  }
  return restore(out);
}

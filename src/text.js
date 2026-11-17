// Pure text helpers for translating long text: splitting into pieces the
// translator accepts and protecting code/URLs from translation.

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

export async function translateText(translator, text, srcLang, tgtLang, { maxChars = 500 } = {}) {
  const { text: safe, restore } = protect(text);
  let out = '';
  for (const { piece, sep } of splitText(safe, maxChars, { keep: PLACEHOLDER })) {
    const onlyPlaceholders = piece.replace(PLACEHOLDER, '').trim() === '';
    out += (onlyPlaceholders ? piece : await translator.translate(piece, srcLang, tgtLang)) + sep;
  }
  return restore(out);
}

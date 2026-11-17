import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitText, protect, translateText } from '../src/text.js';

const join = (parts) => parts.map((p) => p.piece + p.sep).join('');
const pieces = (parts) => parts.map((p) => p.piece);

function fakeTranslator(fn = (s) => s.toUpperCase()) {
  const calls = [];
  return {
    calls,
    async translate(text, src, tgt) {
      calls.push({ text, src, tgt });
      return fn(text);
    },
  };
}

test('short text is a single piece', () => {
  assert.deepEqual(splitText('Hello.\n\nWorld.', 20), [{ piece: 'Hello.\n\nWorld.', sep: '' }]);
  assert.deepEqual(splitText('', 20), [{ piece: '', sep: '' }]);
});

test('splits at paragraph breaks first', () => {
  const text = 'First para is here.\n\nSecond para here.\n  \nThird.';
  const parts = splitText(text, 20);
  assert.deepEqual(pieces(parts), ['First para is here.', 'Second para here.', 'Third.']);
  assert.deepEqual(parts.map((p) => p.sep), ['\n\n', '\n  \n', '']);
  assert.equal(join(parts), text);
});

test('splits a long paragraph at sentence ends', () => {
  const text = 'One two three. Four five six! Seven eight?\nNine ten。十一十二';
  const parts = splitText(text, 20);
  assert.deepEqual(pieces(parts), ['One two three.', 'Four five six!', 'Seven eight?', 'Nine ten。', '十一十二']);
  assert.equal(join(parts), text);
});

test('does not split at a period without following space', () => {
  const parts = splitText('Pi is 3.14 and e is 2.71 roughly', 20);
  assert.ok(!pieces(parts).some((p) => p.endsWith('3.') || p.endsWith('2.')));
});

test('cuts a long sentence at the last whitespace within the limit', () => {
  const text = 'aaaa bbbb cccc dddd eeee ffff';
  const parts = splitText(text, 20);
  assert.deepEqual(pieces(parts), ['aaaa bbbb cccc dddd', 'eeee ffff']);
  assert.equal(join(parts), text);
});

test('hard-cuts a long word with no whitespace', () => {
  const text = 'x'.repeat(45);
  const parts = splitText(text, 20);
  assert.deepEqual(pieces(parts), ['x'.repeat(20), 'x'.repeat(20), 'x'.repeat(5)]);
  assert.equal(join(parts), text);
});

test('every piece fits and rejoining reproduces the input exactly', () => {
  const text =
    '\n\nLead blank lines.  Then a sentence that is far too long to fit anywhere at all.\r\n\r\n' +
    'Supercalifragilisticexpialidocious-and-more! Short.\n' +
    'Line two。次の文です。\n\n\n   trailing   \n';
  for (const max of [1, 3, 7, 20, 50]) {
    const parts = splitText(text, max);
    for (const p of parts) assert.ok(p.piece.length <= max, `${JSON.stringify(p.piece)} > ${max}`);
    assert.equal(join(parts), text);
  }
});

test('protect replaces code and URLs and restore puts them back', () => {
  const text = 'Run `npm i` then see https://example.com/a?b=1.\n```js\nconst x = 1;\n```\nDone';
  const p = protect(text);
  assert.ok(!p.text.includes('npm i'));
  assert.ok(!p.text.includes('example.com'));
  assert.ok(!p.text.includes('const x'));
  assert.ok(p.text.includes('⟧.'), 'trailing period after a URL stays text');
  assert.equal(p.restore(p.text), text);
  assert.equal(p.restore('x ⟦ 0 ⟧ y⟦1 ⟧'), 'x `npm i` yhttps://example.com/a?b=1');
});

test('translateText calls the translator once per piece in order and keeps paragraphs', async () => {
  const t = fakeTranslator();
  const text = 'Hello there friend.\n\nSecond one. Third one here.\n\nEnd';
  const out = await translateText(t, text, 'th', 'en', { maxChars: 20 });
  assert.deepEqual(t.calls.map((c) => c.text), ['Hello there friend.', 'Second one.', 'Third one here.', 'End']);
  assert.ok(t.calls.every((c) => c.src === 'th' && c.tgt === 'en'));
  assert.equal(out, 'HELLO THERE FRIEND.\n\nSECOND ONE. THIRD ONE HERE.\n\nEND');
});

test('translateText keeps code and URLs byte-for-byte, even with spaces around placeholders', async () => {
  const code = '```py\nprint("hi")  # keep\n```';
  const inline = '`git status`';
  const url2 = 'http://foo.bar/Baz';
  const text = `Please run ${inline} first.\n\n${code}\n\nRead ${url2} and https://Example.com/Path?q=A now.`;
  const t = fakeTranslator((s) => s.toUpperCase().replace(/⟦\d+⟧/g, (m) => ` ${m.slice(0, 1)} ${m.slice(1, -1)} ${m.slice(-1)} `));
  const out = await translateText(t, text, 'en', 'th', { maxChars: 20 });
  assert.ok(out.includes(inline));
  assert.ok(out.includes(code));
  assert.ok(out.includes(url2));
  assert.ok(out.includes('https://Example.com/Path?q=A'));
  assert.ok(out.includes('PLEASE RUN'));
});

test('a placeholder on a maxChars boundary is never split', async () => {
  const p = protect('abcdefghi`code`xyz');
  assert.equal(p.text, 'abcdefghi⟦0⟧xyz');
  for (const max of [10, 11, 12]) {
    const parts = splitText(p.text, max, { keep: /⟦\d+⟧/ });
    assert.ok(parts.some((x) => x.piece.includes('⟦0⟧')), `max ${max}: ${JSON.stringify(parts)}`);
    for (const x of parts) assert.ok(x.piece.length <= max);
    assert.equal(join(parts), p.text);
  }
  const t = fakeTranslator();
  const out = await translateText(t, 'abcdefghi`code`xyz', 'a', 'b', { maxChars: 11 });
  assert.equal(out, 'ABCDEFGHI`code`XYZ');
});

test('pieces holding only placeholders are not sent to the translator', async () => {
  const t = fakeTranslator();
  const out = await translateText(t, 'Intro text.\n\n```\ncode\n```\n\nhttps://a.b', 'a', 'b', { maxChars: 12 });
  assert.deepEqual(t.calls.map((c) => c.text), ['Intro text.']);
  assert.equal(out, 'INTRO TEXT.\n\n```\ncode\n```\n\nhttps://a.b');
});

test('default maxChars is 2000', async () => {
  const t = fakeTranslator();
  const para = 'word '.repeat(399) + 'end.';
  assert.equal(para.length, 1999);
  await translateText(t, `${para}

${para}`, 'a', 'b');
  assert.equal(t.calls.length, 2);
  const t2 = fakeTranslator();
  await translateText(t2, 'x'.repeat(2000), 'a', 'b');
  assert.equal(t2.calls.length, 1);
  const t3 = fakeTranslator();
  await translateText(t3, 'x'.repeat(2001), 'a', 'b');
  assert.equal(t3.calls.length, 2);
});

test('a multi-sentence run of up to 2000 characters is one translator call; a longer one is split', async () => {
  const sentences = (n) => Array.from({ length: n }, (_, i) => `Sentence ${i} is about topic ${i * 7}.`).join(' ');
  const run = sentences(60);
  assert.ok(run.length <= 2000 && run.length > 1500, String(run.length));
  const t = fakeTranslator();
  const out = await translateText(t, run, 'en', 'th');
  assert.deepEqual(t.calls.map((c) => c.text), [run]);
  assert.equal(out, run.toUpperCase());
  const long = sentences(120);
  assert.ok(long.length > 2000);
  const t2 = fakeTranslator();
  const out2 = await translateText(t2, long, 'en', 'th');
  assert.ok(t2.calls.length > 1);
  assert.ok(t2.calls.every((c) => c.text.length <= 2000));
  assert.equal(out2, long.toUpperCase());
});

test('with the default maxChars a run over 2000 characters is split at paragraph breaks, in order', async () => {
  const para = (n) => Array.from({ length: 40 }, (_, i) => `Part ${n} sentence ${i} is about topic ${i * 7 + n}.`).join(' ');
  const paras = [para(1), para(2), para(3)];
  assert.ok(paras.every((p) => p.length > 1000 && p.length <= 2000), String(paras.map((p) => p.length)));
  const text = paras.join('\n\n');
  assert.ok(text.length > 2000);
  const t = fakeTranslator();
  const out = await translateText(t, text, 'en', 'th');
  assert.ok(t.calls.length > 1);
  assert.ok(t.calls.every((c) => c.text.length <= 2000));
  assert.deepEqual(t.calls.map((c) => c.text), paras, 'cut only at the paragraph breaks');
  assert.equal(out, text.toUpperCase());
});

test('with the default maxChars one paragraph over 2000 characters is split at sentence ends', async () => {
  const sentences = Array.from({ length: 100 }, (_, i) => `Sentence ${i} is about topic ${i * 7}.`);
  const text = sentences.join(' ');
  assert.ok(text.length > 2000 && !text.includes('\n'));
  const t = fakeTranslator();
  const out = await translateText(t, text, 'en', 'th');
  assert.ok(t.calls.length > 1);
  assert.ok(t.calls.every((c) => c.text.length <= 2000));
  assert.ok(t.calls.every((c) => /\.$/.test(c.text) && sentences.includes(c.text.split(/(?<=\.) /)[0])), 'cut at sentence ends');
  assert.equal(t.calls.map((c) => c.text).join(' '), text);
  assert.equal(out, text.toUpperCase());
});

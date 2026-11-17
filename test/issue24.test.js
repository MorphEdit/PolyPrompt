import test from 'node:test';
import assert from 'node:assert/strict';
import { translateText } from '../src/text.js';

// Fake NLLB: drops the ⟦ ⟧ brackets around placeholders, keeps the digits.
const dropBrackets = { async translate(t) { return t.replace(/⟦(\d+)⟧/g, '$1'); } };

test('#24: protected spans survive a translator that drops placeholder brackets', async () => {
  const src = "I'm in `polyprompt` on `main`, see ```\ncode\n``` and https://example.com/x now.";
  const out = await translateText(dropBrackets, src, 'en', 'th');
  for (const span of ['`polyprompt`', '`main`', '```\ncode\n```', 'https://example.com/x']) {
    assert.ok(out.includes(span), `missing ${JSON.stringify(span)} in ${JSON.stringify(out)}`);
  }
  assert.doesNotMatch(out, /\b[0-9]\b/, `bare placeholder digits in ${JSON.stringify(out)}`);
});

test('#24: protected spans stay in place and placeholders never reach the translator', async () => {
  const calls = [];
  const t = { async translate(s) { calls.push(s); return s.toUpperCase(); } };
  const src = "I'm in `polyprompt` on `main`, see https://example.com/x and\n```js\nlet a = 1;\n```\ndone.";
  const out = await translateText(t, src, 'en', 'th');
  assert.equal(out, "I'M IN `polyprompt` ON `main`, SEE https://example.com/x AND\n```js\nlet a = 1;\n```\nDONE.");
  assert.ok(calls.every((c) => !/[⟦⟧]/.test(c)), JSON.stringify(calls));
});

test('#24: a leading list marker added by the translator is stripped', async () => {
  const fake = { async translate() { return "- What's up?"; } };
  const out = await translateText(fake, 'สวัสดี', 'th', 'en');
  assert.equal(out, "What's up?");
});

test('#24: added "* ", "1. " and "# " are stripped; a source marker is kept', async () => {
  for (const added of ['* ', '1. ', '# ', '  - ']) {
    const fake = { async translate() { return `${added}Hello`; } };
    assert.equal(await translateText(fake, 'สวัสดี', 'th', 'en'), 'Hello');
  }
  const fake = { async translate(s) { return `- ${s.toUpperCase()}`; } };
  assert.equal(await translateText(fake, '- item `x` here', 'a', 'b'), '- ITEM `x` HERE');
});

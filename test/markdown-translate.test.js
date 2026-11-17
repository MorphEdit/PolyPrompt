import test from 'node:test';
import assert from 'node:assert/strict';
import { translateText, isDegenerate } from '../src/text.js';

const ANSWER = [
  '# Sleep tips',
  '',
  'Here are three simple ways to sleep better:',
  '',
  '1. **Keep a consistent schedule.** Go to bed at the same time every day.',
  '2. **Dim the screens before bed.** Put phones away 30–60 minutes before sleep.',
].join('\n');

const MARKDOWN_SYNTAX = /\*\*|^\s*#|^\s*\d+\.\s|^\s*-\s|\||~~|^\s*>/m;

test('#21: Markdown syntax is not sent to the translator and survives back-translation', async () => {
  const sent = [];
  const fake = { async translate(t) { sent.push(t); return `[${t}]`; } };
  const out = await translateText(fake, ANSWER, 'eng_Latn', 'tha_Thai');
  for (const s of sent) {
    assert.doesNotMatch(s, MARKDOWN_SYNTAX, `Markdown syntax sent to translator: ${JSON.stringify(s)}`);
  }
  assert.equal(out, [
    '# [Sleep tips]',
    '',
    '[Here are three simple ways to sleep better:]',
    '',
    '1. **[Keep a consistent schedule.]** [Go to bed at the same time every day.]',
    '2. **[Dim the screens before bed.]** [Put phones away 30–60 minutes before sleep.]',
  ].join('\n'));
});

test('#21: other Markdown (bullets, quotes, tasks, tables, italics, links, rules) is kept', async () => {
  const text = [
    '## Plan',
    '- *Rest* well',
    '  * nested _item_ here',
    '> quoted ~~old~~ text',
    '- [ ] open task',
    '| Name | Value |',
    '|------|-------|',
    '| Cool room | 18 °C |',
    'See [the guide](https://example.com/x) now.',
    '---',
    'snake_case stays one run',
  ].join('\r\n');
  const sent = [];
  const fake = { async translate(t) { sent.push(t); return t.toUpperCase(); } };
  const out = await translateText(fake, text, 'eng_Latn', 'tha_Thai');
  for (const s of sent) {
    assert.doesNotMatch(s, MARKDOWN_SYNTAX, `Markdown syntax sent to translator: ${JSON.stringify(s)}`);
    assert.doesNotMatch(s.replace('snake_case', ''), /[*_[\]]/, `Markdown syntax sent to translator: ${JSON.stringify(s)}`);
  }
  assert.ok(sent.includes('snake_case stays one run'));
  assert.equal(out, [
    '## PLAN',
    '- *REST* WELL',
    '  * NESTED _ITEM_ HERE',
    '> QUOTED ~~OLD~~ TEXT',
    '- [ ] OPEN TASK',
    '| NAME | VALUE |',
    '|------|-------|',
    '| COOL ROOM | 18 °C |',
    'SEE [THE GUIDE](https://example.com/x) NOW.',
    '---',
    'SNAKE_CASE STAYS ONE RUN',
  ].join('\r\n'));
});

test('#21: degenerate translator output falls back to the English piece', async () => {
  const fake = { async translate() { return Array(300).fill('*').join(' '); } };
  const out = await translateText(fake, ANSWER, 'eng_Latn', 'tha_Thai');
  assert.doesNotMatch(out, /(\* ){20}/, 'garbage "* * * ..." reached the user');
  assert.equal(out, ANSWER);
});

test('#21: a degenerate piece is retried sentence by sentence, only the bad sentence stays English', async () => {
  const fake = {
    async translate(t) {
      if (t.includes('Bad')) return 'ดี '.repeat(40);
      return `<${t}>`;
    },
  };
  const out = await translateText(fake, 'Good one. Bad one here. Fine again.', 'eng_Latn', 'tha_Thai');
  assert.equal(out, '<Good one.> Bad one here. <Fine again.>');
});

test('#21: isDegenerate flags garbage and accepts normal translations', () => {
  const src = 'Keep your bedroom cool, dark, and quiet.';
  assert.equal(isDegenerate(src, '* * * * * * * * * * * *'), true);
  assert.equal(isDegenerate(src, 'นอน '.repeat(30)), true);
  assert.equal(isDegenerate(src, 'นอนนอนนอนนอนนอนนอนนอนนอนนอน'), true);
  assert.equal(isDegenerate(src, 'a b c '.repeat(10)), true);
  assert.equal(isDegenerate(src, 'ห้องนอน'.repeat(30) + ' x'), true);
  assert.equal(isDegenerate(src, ''), true);
  assert.equal(isDegenerate(src, '   '), true);
  assert.equal(isDegenerate(src, 'ทำให้ห้องนอนเย็น มืด และเงียบ'), false);
  assert.equal(isDegenerate('Around 18–20 °C (65–68 °F).', 'ประมาณ 18–20 °C (65–68 °F)'), false);
  assert.equal(isDegenerate('x'.repeat(50), 'X'.repeat(50)), false);
  assert.equal(isDegenerate('Run ⟦0⟧ now.', 'รัน ⟦ 0 ⟧ ตอนนี้'), false);
});

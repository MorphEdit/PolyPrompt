import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NotTranslatedError, buildPrompt, createTranslator, looksLikeTranslation, maxTokensFor,
} from '../src/translator.js';

const SOURCE = 'ช่วยแนะนำวิธีนอนหลับให้ดีขึ้น 3 ข้อ แบบสั้นๆ';
const ANSWER = '1. Establish a regular sleep schedule.\n2. Create a relaxing bedtime routine.\n'
  + '3. Avoid screens and caffeine before bed.';

function fake(replies) {
  const calls = [];
  const complete = async (prompt, opts) => {
    calls.push({ prompt, opts });
    return typeof replies === 'function' ? replies(calls.length) : replies;
  };
  return { complete, calls };
}

test('an answer instead of a translation is retried once and then rejected (#36)', async () => {
  const { complete, calls } = fake(ANSWER);
  await assert.rejects(createTranslator(complete).translate(SOURCE, 'th', 'en'), NotTranslatedError);
  assert.equal(calls.length, 2, 'the translator retries once');
  assert.notEqual(calls[1].prompt, calls[0].prompt, 'the retry uses a sturdier prompt');
  assert.match(calls[1].prompt, /do not answer/i);
  assert.ok(calls[1].prompt.endsWith(`\n\n\n${SOURCE}`));
});

test('a retry that translates is returned (#36)', async () => {
  const { complete, calls } = fake((n) => (n === 1 ? ANSWER : 'Please suggest 3 short tips for better sleep.'));
  const out = await createTranslator(complete).translate(SOURCE, 'th', 'en');
  assert.equal(out, 'Please suggest 3 short tips for better sleep.');
  assert.equal(calls.length, 2);
});

test('output in the wrong language for the target is retried and rejected (#36)', async () => {
  const { complete, calls } = fake('ช่วยแนะนำวิธีนอนหลับ');
  await assert.rejects(
    createTranslator(complete).translate('Please suggest 3 short tips for better sleep.', 'en', 'de'),
    NotTranslatedError,
  );
  assert.equal(calls.length, 2);
});

test('English output for a German target is rejected once long enough to detect (#36)', () => {
  const src = 'Please suggest three short tips for better sleep tonight.';
  assert.equal(looksLikeTranslation(src, 'Here are three tips: keep a schedule and avoid caffeine late.', 'en', 'de'), false);
  assert.equal(looksLikeTranslation(src, 'Bitte schlage drei kurze Tipps für besseren Schlaf heute Nacht vor.', 'en', 'de'), true);
});

test('a good translation passes on the first call (#36)', async () => {
  const { complete, calls } = fake('Please suggest 3 short tips for better sleep.');
  assert.equal(await createTranslator(complete).translate(SOURCE, 'th', 'en'),
    'Please suggest 3 short tips for better sleep.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, buildPrompt(SOURCE, 'th', 'en'));
});

test('looksLikeTranslation rejects list lines, extra lines and runaway length (#36)', () => {
  assert.equal(looksLikeTranslation(SOURCE, ANSWER, 'th', 'en'), false);
  assert.equal(looksLikeTranslation(SOURCE, 'Sure, here you go.\nSleep more.', 'th', 'en'), false);
  assert.equal(looksLikeTranslation('สวัสดี', 'Hello! How can I help you today with anything at all?', 'th', 'en'), false);
  // Short and name-like output is not judged by language; CJK sources may grow a lot in English.
  assert.equal(looksLikeTranslation('React', 'React', 'en', 'th'), true);
  assert.equal(looksLikeTranslation('谢谢你的帮助', 'Thank you for your help', 'zh', 'en'), true);
  assert.equal(looksLikeTranslation('สวัสดี', 'Hello', 'th', 'en'), true);
  // A source with several lines may keep them.
  assert.equal(looksLikeTranslation('หนึ่ง\nสอง', 'One\nTwo', 'th', 'en'), true);
});

test('maxTokens is bounded by the input length (#36)', async () => {
  assert.ok(maxTokensFor(SOURCE) < 200);
  assert.ok(maxTokensFor('x'.repeat(10)) >= 64);
  assert.equal(maxTokensFor('x'.repeat(5000)), 2048);
  const { complete, calls } = fake('Please suggest 3 short tips for better sleep.');
  await createTranslator(complete).translate(SOURCE, 'th', 'en');
  assert.deepEqual(calls[0].opts, { maxTokens: maxTokensFor(SOURCE) });
});

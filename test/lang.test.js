import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, NLLB_CODES } from '../src/lang.js';

test('Thai sentence -> tha_Thai', () => {
  assert.deepEqual(detectLanguage('สวัสดีครับ วันนี้อากาศดีมาก'), { kind: 'ok', lang: 'tha_Thai' });
});

test('short Thai word -> tha_Thai', () => {
  assert.deepEqual(detectLanguage('สวัสดี'), { kind: 'ok', lang: 'tha_Thai' });
});

test('one-word Thai replies (vowel/tone marks are not letters) -> tha_Thai', () => {
  for (const s of ['ไม่', 'ใช่', 'ดี', 'ครับ']) {
    assert.deepEqual(detectLanguage(s), { kind: 'ok', lang: 'tha_Thai' }, s);
  }
});

test('short Chinese -> zho_Hans', () => {
  assert.deepEqual(detectLanguage('你好'), { kind: 'ok', lang: 'zho_Hans' });
});

test('English sentences -> eng_Latn', () => {
  for (const s of ['Hello, how are you today?', 'What is the weather like?', 'Can you help me write a function?']) {
    assert.deepEqual(detectLanguage(s), { kind: 'ok', lang: 'eng_Latn' }, s);
  }
});

test('other languages map to NLLB codes', () => {
  assert.equal(detectLanguage('今日はいい天気ですね').lang, 'jpn_Jpan');
  assert.equal(detectLanguage('今天天气很好').lang, 'zho_Hans');
  assert.equal(detectLanguage('Bonjour, comment allez-vous?').lang, 'fra_Latn');
});

test('tiny inputs are unsure', () => {
  for (const s of ['ok', '555', 'hi', '', '   ', '!!']) {
    assert.deepEqual(detectLanguage(s), { kind: 'unsure', lang: null }, JSON.stringify(s));
  }
});

test('mixed Thai/English where Thai dominates -> tha_Thai', () => {
  assert.deepEqual(detectLanguage('ช่วยเขียน function ภาษา JavaScript ให้หน่อยครับ'), { kind: 'ok', lang: 'tha_Thai' });
});

test('detected language missing from the mapping is unsupported with lang null', () => {
  const { th, ...rest } = NLLB_CODES;
  assert.deepEqual(detectLanguage('สวัสดีครับ วันนี้อากาศดีมาก', { mapping: rest }), { kind: 'unsupported', lang: null });
});

test('minLength option controls the unsure threshold', () => {
  assert.equal(detectLanguage('thanks', { minLength: 10 }).kind, 'unsure');
  assert.equal(detectLanguage('thanks').kind, 'ok');
});

test('every mapped value looks like an NLLB code', () => {
  for (const v of Object.values(NLLB_CODES)) assert.match(v, /^[a-z]{3}_[A-Z][a-z]{3}$/);
});

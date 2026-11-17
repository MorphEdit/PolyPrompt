import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, LANGUAGES, UNSUPPORTED, LEGACY_NLLB_CODES, fromLegacyCode, languageName } from '../src/lang.js';

test('Thai sentence -> th', () => {
  assert.deepEqual(detectLanguage('สวัสดีครับ วันนี้อากาศดีมาก'), { kind: 'ok', lang: 'th' });
});

test('short Thai word -> th', () => {
  assert.deepEqual(detectLanguage('สวัสดี'), { kind: 'ok', lang: 'th' });
});

test('one-word Thai replies (vowel/tone marks are not letters) -> th', () => {
  for (const s of ['ไม่', 'ใช่', 'ดี', 'ครับ']) {
    assert.deepEqual(detectLanguage(s), { kind: 'ok', lang: 'th' }, s);
  }
});

test('short Chinese -> zh', () => {
  assert.deepEqual(detectLanguage('你好'), { kind: 'ok', lang: 'zh' });
});

test('English sentences -> en', () => {
  for (const s of ['Hello, how are you today?', 'What is the weather like?', 'Can you help me write a function?']) {
    assert.deepEqual(detectLanguage(s), { kind: 'ok', lang: 'en' }, s);
  }
});

test('other languages map to ISO 639-1 codes', () => {
  assert.equal(detectLanguage('今日はいい天気ですね').lang, 'ja');
  assert.equal(detectLanguage('今天天气很好').lang, 'zh');
  assert.equal(detectLanguage('Bonjour, comment allez-vous?').lang, 'fr');
});

test('tiny inputs are unsure', () => {
  for (const s of ['ok', '555', 'hi', '', '   ', '!!']) {
    assert.deepEqual(detectLanguage(s), { kind: 'unsure', lang: null }, JSON.stringify(s));
  }
});

test('mixed Thai/English where Thai dominates -> th', () => {
  assert.deepEqual(detectLanguage('ช่วยเขียน function ภาษา JavaScript ให้หน่อยครับ'), { kind: 'ok', lang: 'th' });
});

test('detected language missing from the mapping is unsupported with lang null', () => {
  const { th, ...rest } = LANGUAGES;
  assert.deepEqual(detectLanguage('สวัสดีครับ วันนี้อากาศดีมาก', { languages: rest }), { kind: 'unsupported', lang: null });
});

test('minLength option controls the unsure threshold', () => {
  assert.equal(detectLanguage('thanks', { minLength: 10 }).kind, 'unsure');
  assert.equal(detectLanguage('thanks').kind, 'ok');
});

test('the supported table maps ISO 639-1 codes to English names', () => {
  for (const [code, name] of Object.entries(LANGUAGES)) {
    assert.match(code, /^[a-z]{2}$/);
    assert.match(name, /^[A-Z][a-z]+$/);
  }
  assert.equal(languageName('th'), 'Thai');
  assert.equal(languageName('en'), 'English');
});

const SUPPORTED = 'ar bg bn ca cs da de el en es et fa fi fr gu he hi hr hu is it ja kn ko lt lv ml mr nl no pa pl pt ro ru sk sl sr sv ta te th tr uk ur vi zh'.split(' ');
const NOT_SUPPORTED = 'am az be eu hy ka ku lo ms or sq tl yo'.split(' ');

test('every supported code gives ok with that code', () => {
  assert.deepEqual(Object.keys(LANGUAGES).sort(), [...SUPPORTED].sort());
  for (const code of SUPPORTED) {
    assert.deepEqual(detectLanguage('some longer text', { detect: () => code }), { kind: 'ok', lang: code }, code);
  }
});

test('every unsupported code gives unsupported', () => {
  assert.deepEqual([...UNSUPPORTED].sort(), [...NOT_SUPPORTED].sort());
  for (const code of NOT_SUPPORTED) {
    assert.deepEqual(detectLanguage('some longer text', { detect: () => code }), { kind: 'unsupported', lang: null }, code);
  }
});

test('the real detector returns ISO codes for sample languages', () => {
  assert.deepEqual(detectLanguage('Привет, как у тебя дела сегодня?'), { kind: 'ok', lang: 'ru' });
  assert.deepEqual(detectLanguage('Hallo, wie geht es dir heute?'), { kind: 'ok', lang: 'de' });
});

test('every eld/medium language is either supported or unsupported', () => {
  for (const code of Object.values(LEGACY_NLLB_CODES)) {
    assert.ok(Object.hasOwn(LANGUAGES, code) !== UNSUPPORTED.includes(code), code);
  }
});

test('old NLLB codes map to ISO 639-1; other values are kept', () => {
  assert.equal(fromLegacyCode('tha_Thai'), 'th');
  assert.equal(fromLegacyCode('eng_Latn'), 'en');
  assert.equal(fromLegacyCode('zho_Hans'), 'zh');
  assert.equal(fromLegacyCode('amh_Ethi'), 'am');
  assert.equal(fromLegacyCode('th'), 'th');
  assert.equal(fromLegacyCode(null), null);
});

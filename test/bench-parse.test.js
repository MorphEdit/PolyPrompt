// #57: answer parsing (Thai/Arabic digits, commas, units, "Answer:"/"คำตอบ:"),
// scoring, the judge verdict and the quota check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeError } from '../src/claude.js';
import { QUOTA, asciiDigits, isQuotaError, parseAnswer, score } from '../src/bench/parse.js';
import { judgeOutcome, parseVerdict } from '../src/bench/judge.js';

test('#57 parses the last คำตอบ:/Answer: line of real-looking outputs', () => {
  const cases = [
    ['เจเน็ตมีไข่ 16 ฟอง กินไป 3 ฟอง อบมัฟฟิน 4 ฟอง\nเหลือ 16 - 3 - 4 = 9 ฟอง ขายฟองละ 2 ดอลลาร์\n9 × 2 = 18\n\nคำตอบ: 18', '18'],
    ['16 − 3 − 4 = 9 eggs, 9 × $2 = $18.\n\nAnswer: $18', '18'],
    ['รวมทั้งหมด ๑,๒๕๐ บาท\nคำตอบ: ๑,๒๕๐ บาท', '1250'],
    ['المجموع\nAnswer: ١٢٣', '123'],
    ['**คำตอบ:** 1,000 คน', '1000'],
    ['**Answer:** 42 dollars', '42'],
    ['Answer: 3.50 ชั่วโมง', '3.5'],
    ['คำตอบ : -5 องศา', '-5'],
    ['answer: 7', '7'],
    ['Answer: 12\nแก้ใหม่\nคำตอบ: 15', '15'],
    ['คำตอบ: 2 (เจ้าพระยา)', '2'],
    ['คำตอบ: ข้อ 3', '3'],
    ['เลือกข้อ 2\nคำตอบ:\n2', '2'],
    ['คำตอบ：๔', '4'],
  ];
  for (const [text, want] of cases) assert.equal(parseAnswer(text), want, text);
});

test('#57 an unparseable answer is null and scores 0', () => {
  for (const text of ['ไม่ทราบคำตอบ', 'คำตอบ: ไม่แน่ใจ', '18', '', null, 'Answer:']) {
    assert.equal(parseAnswer(text), null, String(text));
  }
  assert.equal(score(null, '18'), 0);
  assert.equal(score('18', '18'), 1);
  assert.equal(score('18.0', 18), 1);
  assert.equal(score('17', '18'), 0);
  assert.equal(score('2', '2'), 1);
  assert.equal(asciiDigits('๐๑๒๓๔๕๖๗๘๙ ٠١٢٣٤٥٦٧٨٩ ۰۱۲'), '0123456789 0123456789 012');
});

test('#57 the quota check: a failed run whose output mentions a usage limit, rate limit or quota', () => {
  assert.equal(QUOTA.test('Claude AI usage limit reached|1700000000'), true);
  const err = (kind, output) => Object.assign(new ClaudeError(kind, 'exit 1'), output === undefined ? {} : { output });
  assert.equal(isQuotaError(err('failed', 'Claude AI usage limit reached')), true);
  assert.equal(isQuotaError(err('failed', 'API Error: Rate limit exceeded')), true);
  assert.equal(isQuotaError(err('failed', 'You have exceeded your quota')), true);
  assert.equal(isQuotaError(err('failed', 'something else broke')), false);
  assert.equal(isQuotaError(err('failed')), false);
  assert.equal(isQuotaError(err('timeout', 'usage limit')), false, 'only kind failed');
  assert.equal(isQuotaError(null), false);
});

test('#57 the judge verdict is the first JSON object with winner 1, 2 or "tie"', () => {
  assert.deepEqual(parseVerdict('{"winner": 1, "reason": "ดีกว่า"}'), { winner: 1, reason: 'ดีกว่า' });
  assert.deepEqual(parseVerdict('ผลคือ\n```json\n{"winner": "tie", "reason": "เท่ากัน {ไม่ต่าง}"}\n```'), { winner: 'tie', reason: 'เท่ากัน {ไม่ต่าง}' });
  assert.deepEqual(parseVerdict('{"note": 1} then {"winner": 2, "reason": "x"}'), { winner: 2, reason: 'x' });
  assert.deepEqual(parseVerdict('{"winner": 2}'), { winner: 2, reason: null });
  for (const bad of ['', 'คำตอบ 1 ดีกว่า', '{"winner": "1"}', '{"winner": 3}', '{"winner": 1', null]) {
    assert.equal(parseVerdict(bad), null, String(bad));
  }
});

test('#57 a win counts only when both orders agree', () => {
  // Order 1 shows A as "คำตอบ 1", order 2 shows B as "คำตอบ 1".
  assert.equal(judgeOutcome(1, 2), 'A');
  assert.equal(judgeOutcome(2, 1), 'B');
  assert.equal(judgeOutcome(1, 1), 'tie', 'position bias: each order picks the first answer');
  assert.equal(judgeOutcome(2, 2), 'tie');
  assert.equal(judgeOutcome('tie', 2), 'tie');
  assert.equal(judgeOutcome(1, 'tie'), 'tie');
  assert.equal(judgeOutcome('tie', 'tie'), 'tie');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityLine, bashPrefix, cardText, hasShellOperator, isAutoAllowed, ruleFor, truncateOutput } from '../src/activity.js';

test('Bash prefix is the first two words, or the only word', () => {
  assert.equal(bashPrefix('npm test -- --watch'), 'npm test');
  assert.equal(bashPrefix('  git   status  '), 'git status');
  assert.equal(bashPrefix('ls'), 'ls');
});

test('every shell operator is detected', () => {
  for (const c of ['a; b', 'a && b', 'a || b', 'a | b', 'a `b`', 'a $(b)', 'a > f', 'a < f', 'a\nb']) {
    assert.equal(hasShellOperator(c), true, c);
  }
  assert.equal(hasShellOperator('npm test -- --watch'), false);
});

test('a stored rule allows the same tool; for Bash only the same two-word prefix without operators', () => {
  const rules = [ruleFor('Edit', { file_path: 'a' }), ruleFor('Bash', { command: 'npm test -- --watch' })];
  assert.deepEqual(rules, [{ tool: 'Edit' }, { tool: 'Bash', prefix: 'npm test' }]);
  assert.equal(isAutoAllowed(rules, 'Edit', { file_path: 'other.js' }), true);
  assert.equal(isAutoAllowed(rules, 'Write', { file_path: 'a' }), false);
  assert.equal(isAutoAllowed(rules, 'Bash', { command: 'npm test' }), true);
  assert.equal(isAutoAllowed(rules, 'Bash', { command: 'npm test --coverage' }), true);
  assert.equal(isAutoAllowed(rules, 'Bash', { command: 'npm install' }), false);
  assert.equal(isAutoAllowed(rules, 'Bash', { command: 'npm' }), false);
  for (const c of ['npm test && rm -rf /', 'npm test; curl x', 'npm test | sh', 'npm test > out', 'npm test $(x)', 'npm test `x`', 'npm test\nrm x']) {
    assert.equal(isAutoAllowed(rules, 'Bash', { command: c }), false, c);
  }
  assert.equal(ruleFor('Bash', { command: 'npm test && rm x' }), null);
  assert.equal(isAutoAllowed([{ tool: 'Bash', prefix: 'ls' }], 'Bash', { command: 'ls' }), true);
  assert.equal(isAutoAllowed([{ tool: 'Bash', prefix: 'ls' }], 'Bash', { command: 'ls -la' }), false);
  assert.equal(isAutoAllowed(undefined, 'Edit', {}), false);
});

test('card and activity texts are fixed Thai templates with the English detail untouched', () => {
  assert.deepEqual(cardText('Bash', { command: 'npm test -- --watch' }), { text: 'Claude ขอรันคำสั่ง', detail: 'npm test -- --watch' });
  const edit = cardText('Edit', { file_path: 'src/app.js', old_string: 'a', new_string: 'b' });
  assert.equal(edit.text, 'Claude ขอแก้ไฟล์ `src/app.js`');
  assert.equal(edit.detail, 'src/app.js\n- a\n+ b');
  assert.equal(cardText('Write', { file_path: '/tmp/x', content: 'hello' }).detail, '/tmp/x\nhello');
  assert.match(cardText('mcp__github__create_issue', { title: 't' }).text, /MCP/);
  assert.equal(activityLine('Read', { file_path: 'src/app.js' }).text, '🔍 กำลังอ่าน `src/app.js`');
  assert.equal(activityLine('Bash', { command: 'npm test' }).text, '🔧 รัน `npm test`');
  assert.equal(activityLine('WebSearch', { query: 'q' }).text, '🌐 ค้นเว็บ: q');
  assert.deepEqual(truncateOutput('abc'), { output: 'abc' });
  assert.equal(truncateOutput('x'.repeat(20_001)).truncated, true);
});

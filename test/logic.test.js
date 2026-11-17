import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  keyAction, canSend, stepLabel, formatProgress, apiErrorMessage, canRetry,
  lastMessageHasError, escapeHtml, renderMarkdown,
} from '../public/logic.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

test('keyAction: Enter sends', () => {
  assert.equal(keyAction({ key: 'Enter', shiftKey: false, isComposing: false }), 'send');
});

test('keyAction: Shift+Enter inserts a newline', () => {
  assert.equal(keyAction({ key: 'Enter', shiftKey: true, isComposing: false }), 'newline');
});

test('keyAction: Enter during IME composition does not send', () => {
  assert.equal(keyAction({ key: 'Enter', shiftKey: false, isComposing: true }), 'none');
  assert.equal(keyAction({ key: 'Enter', shiftKey: true, isComposing: true }), 'none');
});

test('keyAction: other keys do nothing', () => {
  assert.equal(keyAction({ key: 'a', shiftKey: false, isComposing: false }), 'none');
});

const ok = { text: 'สวัสดี', pending: false, modelState: 'ready', lastMessageHasError: false };

test('canSend: true for text with the model ready and nothing pending', () => {
  assert.equal(canSend(ok), true);
  assert.equal(canSend({ ...ok, text: '  hi \n' }), true);
});

test('canSend: false for empty or whitespace-only text', () => {
  assert.equal(canSend({ ...ok, text: '' }), false);
  assert.equal(canSend({ ...ok, text: '   \n' }), false);
  assert.equal(canSend({ ...ok, text: '\t' }), false);
});

test('canSend: false while a reply is pending', () => {
  assert.equal(canSend({ ...ok, pending: true }), false);
});

test('canSend: false while the model is loading or failed', () => {
  assert.equal(canSend({ ...ok, modelState: 'loading' }), false);
  assert.equal(canSend({ ...ok, modelState: 'error' }), false);
  assert.equal(canSend({ ...ok, modelState: undefined }), false);
});

test('canSend: false when the last message has an error', () => {
  assert.equal(canSend({ ...ok, lastMessageHasError: true }), false);
});

test('stepLabel gives a Thai label per step', () => {
  assert.equal(stepLabel(null), '');
  assert.match(stepLabel('translating'), /แปล/);
  assert.match(stepLabel('thinking'), /Claude/);
  assert.match(stepLabel('translating_back'), /แปลคำตอบ/);
  const labels = ['translating', 'thinking', 'translating_back'].map(stepLabel);
  assert.equal(new Set(labels).size, 3);
});

test('formatProgress shows a clamped whole percentage', () => {
  assert.equal(formatProgress(0), '0%');
  assert.equal(formatProgress(0.425), '43%');
  assert.equal(formatProgress(1), '100%');
  assert.equal(formatProgress(1.5), '100%');
  assert.equal(formatProgress(-1), '0%');
  assert.equal(formatProgress(undefined), '0%');
});

test('apiErrorMessage gives short Thai text for API errors', () => {
  for (const s of [0, 400, 404, 409, 503, 500]) assert.match(apiErrorMessage(s), /[฀-๿]/);
  assert.notEqual(apiErrorMessage(409), apiErrorMessage(503));
  assert.match(apiErrorMessage(500), /500/);
});

test('canRetry: only the last message, a user message with an error', () => {
  const err = { kind: 'failed', message: 'x' };
  const msgs = [
    { role: 'user', error: err },
    { role: 'assistant' },
    { role: 'user', error: err },
  ];
  assert.equal(canRetry(msgs, 2), true);
  assert.equal(canRetry(msgs, 0), false);
  assert.equal(canRetry(msgs, 1), false);
  assert.equal(canRetry([{ role: 'user' }], 0), false);
});

test('lastMessageHasError', () => {
  assert.equal(lastMessageHasError(null), false);
  assert.equal(lastMessageHasError({ messages: [] }), false);
  assert.equal(lastMessageHasError({ messages: [{ role: 'user', error: { kind: 'failed' } }] }), true);
  assert.equal(lastMessageHasError({ messages: [{ role: 'user', error: { kind: 'failed' } }, { role: 'assistant' }] }), false);
});

test('escapeHtml escapes all HTML-special characters', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('renderMarkdown escapes <script> and <img onerror>', () => {
  const html = renderMarkdown('hi <script>alert(1)</script>\n\n<img src=x onerror="alert(1)">');
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test('renderMarkdown escapes HTML inside code and headings too', () => {
  const html = renderMarkdown('# <b>t</b>\n\n```\n<script>x</script>\n```\n\n`<img onerror=1>`');
  assert.doesNotMatch(html, /<script|<img|<b>/i);
  assert.match(html, /<pre><code>&lt;script&gt;x&lt;\/script&gt;<\/code><\/pre>/);
  assert.match(html, /<code>&lt;img onerror=1&gt;<\/code>/);
});

test('renderMarkdown makes no javascript:, data: or vbscript: links', () => {
  const inputs = [
    '[click](javascript:alert(1))',
    '[click](JavaScript:alert`1`)',
    '[click](  javascript:alert(1))',
    '[x](data:text/html;base64,PHNjcmlwdD4=)',
    '[x](vbscript:msgbox)',
    'javascript:alert(1)',
    '[x](java&#115;cript:alert(1))',
    '<a href="javascript:alert(1)">x</a>',
  ];
  for (const md of inputs) {
    const html = renderMarkdown(md);
    assert.doesNotMatch(html, /<a\s/i, md);
    assert.doesNotMatch(html, /href=["']?\s*(javascript|data|vbscript):/i, md);
  }
});

test('renderMarkdown keeps safe links with safe attributes', () => {
  const html = renderMarkdown('see [docs](https://example.com/a?b=1&c=2) or https://x.org/p.');
  assert.match(html, /<a href="https:\/\/example.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  assert.match(html, /<a href="https:\/\/x.org\/p" [^>]*>https:\/\/x.org\/p<\/a>\./);
});

test('renderMarkdown cannot break out of a link attribute', () => {
  const html = renderMarkdown('[x](https://a.com/"onmouseover="alert(1))  https://b.com/"onclick="1');
  assert.doesNotMatch(html, /"\s*on\w+=/i);
});

test('renderMarkdown renders basic Markdown', () => {
  const html = renderMarkdown('## Title\n\nSome **bold** and *it* and `code`.\nnext line\n\n- a\n- b\n\n1. one\n2. two\n\n> quote\n\n---');
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /<p>Some <strong>bold<\/strong> and <em>it<\/em> and <code>code<\/code>\.<br>next line<\/p>/);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>quote<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
});

test('renderMarkdown leaves Markdown inside code untouched', () => {
  const html = renderMarkdown('```js\nconst a = **b**; // https://x.com\n```');
  assert.equal(html, '<pre><code>const a = **b**; // https://x.com</code></pre>');
  assert.equal(renderMarkdown('`**x**`'), '<p><code>**x**</code></p>');
});

test('renderMarkdown handles empty input and stray placeholder characters', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
  assert.equal(renderMarkdown('a\u00000\u0000b'), '<p>a0b</p>');
});

test('the page loads no remote resources', async () => {
  const files = await readdir(publicDir);
  assert.ok(files.includes('index.html'));
  for (const f of files) {
    const text = await readFile(path.join(publicDir, f), 'utf8');
    assert.doesNotMatch(text, /(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i, f);
    assert.doesNotMatch(text, /url\(\s*["']?\s*(?:https?:)?\/\//i, f);
    assert.doesNotMatch(text, /@import\s+["']?(?:url\()?\s*["']?(?:https?:)?\/\//i, f);
    assert.doesNotMatch(text, /\bimport\b[^;\n]*from\s*["'](?:https?:)?\/\//i, f);
  }
  const index = await readFile(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(index, /<script type="module" src="\/app.js"><\/script>/);
});

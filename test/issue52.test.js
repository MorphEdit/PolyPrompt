// #52: polling a pending chat must not rebuild the chat DOM. Unchanged data
// keeps every element; new activity only adds or updates its own parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cardDecisions, DECISION_LABELS, ONCE_ONLY_HINT } from '../public/logic.js';

class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.style = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.clientHeight = 0;
    const cls = new Set();
    this.classList = { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), add: (c) => cls.add(c) };
  }
  append(...c) { this.children.push(...c); }
  replaceChildren(...c) { this.children = c; }
  addEventListener(e, f) { this.listeners[e] = f; }
  setAttribute() {}
  focus() {}
}

const byId = {};
const all = (el, pred, out = []) => {
  if (pred(el)) out.push(el);
  el.children?.forEach((c) => all(c, pred, out));
  return out;
};
const button = (root, text) => all(root, (e) => e.tagName === 'button' && e.textContent === text)[0];
const byClass = (root, cls) => all(root, (e) => e.className === cls);
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const nodes = (root) => all(root, () => true);

const chat = {
  id: 'c1', pendingStep: 'thinking', updatedAt: '2026-11-18T00:00:00.000Z',
  messages: [{ id: 'm1', role: 'user', original: 'รันเทสต์' }],
  live: {
    activity: [{ text: '🔧 รัน `npm test`', detail: 'npm test' }],
    card: { requestId: 'r1', token: 'tok-1', toolName: 'Bash', text: 'Claude ขอรันคำสั่ง', detail: 'npm test', onceOnly: false },
  },
};
const posts = [];
let chatGets = 0;

test('cardDecisions drops "อนุญาตตลอดในแชตนี้" only for allow-once cards', () => {
  assert.deepEqual(cardDecisions({ onceOnly: false }), DECISION_LABELS);
  assert.deepEqual(cardDecisions({}), DECISION_LABELS);
  assert.deepEqual(cardDecisions({ onceOnly: true }).map((d) => d.decision), ['allow', 'deny']);
});

test('polls keep unchanged chat elements; new activity and cards update only their parts', async () => {
  globalThis.document = { getElementById: (id) => (byId[id] ??= new El(id)), createElement: (t) => new El(t) };
  globalThis.confirm = () => true;
  globalThis.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') posts.push({ url, body: JSON.parse(opts.body ?? 'null') });
    if (url === '/api/status') return json({ model: { state: 'ready', progress: 1, error: null, size: '4b' }, switch: null });
    if (url === '/api/settings') return json({ translatorSize: '4b', claudeModel: 'default', downloadedSizes: ['4b'] });
    if (url === '/api/chats') return json([]);
    if (url === '/api/messages') return json({ chatId: 'c1', messageId: 'm1' }, 202);
    if (url === '/api/chats/c1') { chatGets++; return json(structuredClone(chat)); }
    if (url.startsWith('/api/chats/c1/permissions/')) {
      await tick(1500); // the answer is in flight across a poll
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  };

  await import('../public/app.js');
  await tick(30);
  byId.input.value = 'รันเทสต์';
  byId.input.listeners.input();
  byId.composer.listeners.submit({ preventDefault() {} });
  await tick(30);

  // 1. Unchanged data: every element in the chat is the same object after 3 polls.
  const allow = button(byId.messages, 'อนุญาต');
  assert.ok(allow, 'the permission card is shown');
  assert.ok(button(byId.messages, 'อนุญาตตลอดในแชตนี้'), 'a plain command offers allow for this chat');
  assert.equal(byClass(byId.messages, 'note permission-hint').length, 0);
  const before = nodes(byId.messages);
  const children = [...byId.messages.children];
  const gets = chatGets;
  // 3. The user opens a line's <details> and closes the activity box.
  const [line] = byClass(byId.messages, 'activity-line');
  line.open = true;
  byClass(byId.messages, 'activity')[0].open = false;
  await tick(3200);
  assert.ok(chatGets - gets >= 3, `polled ${chatGets - gets} times`);
  assert.equal(button(byId.messages, 'อนุญาต'), allow, 'the card button is the same DOM node after 3 polls');
  const after = nodes(byId.messages);
  assert.equal(after.length, before.length);
  assert.ok(after.every((n, i) => n === before[i]), 'no element was replaced');
  assert.ok(byId.messages.children.every((n, i) => n === children[i]));
  assert.equal(line.open, true, 'an opened <details> stays open');
  assert.equal(byClass(byId.messages, 'activity')[0].open, false, 'a closed activity box stays closed');

  // 2. New activity: the old line and the card stay; one line is added.
  chat.live.activity.push({ text: '🔧 อ่านไฟล์ `a.js`', detail: 'a.js' });
  chat.updatedAt = '2026-11-18T00:00:02.000Z';
  await tick(1100);
  const lines = byClass(byId.messages, 'activity-line');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], line, 'the existing activity line is kept');
  assert.equal(line.open, true);
  assert.equal(byClass(byId.messages, 'activity')[0].children[0].textContent, 'กิจกรรมของ Claude (2)');
  assert.equal(button(byId.messages, 'อนุญาต'), allow, 'the card is kept');
  assert.equal(all(byId.messages, (e) => e === before[0]).length, 1, 'the user message is kept');
  const userMsg = byId.messages.children[0];

  // A line that gets its output is updated alone and keeps its open state.
  chat.live.activity[0].output = 'ok';
  await tick(1100);
  const updated = byClass(byId.messages, 'activity-line');
  assert.notEqual(updated[0], line);
  assert.equal(updated[0].open, true, 'the updated line stays open');
  assert.equal(updated[1], lines[1]);
  assert.equal(byId.messages.children[0], userMsg);

  // 4. A click during a poll sends exactly one answer; the buttons are disabled meanwhile.
  allow.listeners.click();
  allow.listeners.click();
  assert.equal(allow.disabled, true);
  await tick(1100); // a poll lands while the answer is in flight
  assert.equal(button(byId.messages, 'อนุญาต'), allow);
  assert.equal(allow.disabled, true, 'still disabled during the poll');
  button(byId.messages, 'ไม่อนุญาต').listeners.click();
  const answers = () => posts.filter((p) => p.url.includes('/permissions/'));
  assert.equal(answers().length, 1);
  assert.deepEqual(answers()[0], { url: '/api/chats/c1/permissions/r1', body: { token: 'tok-1', decision: 'allow' } });

  // The next card is a Bash command with operators: allow once only, with the hint.
  chat.live.card = {
    requestId: 'r2', token: 'tok-2', toolName: 'Bash', text: 'Claude ขอรันคำสั่ง',
    detail: 'npm test && rm -rf dist', onceOnly: true,
  };
  await tick(1100);
  assert.equal(answers().length, 1);
  const allow2 = button(byId.messages, 'อนุญาต');
  assert.notEqual(allow2, allow, 'a new card gets new buttons');
  assert.equal(allow2.disabled, false);
  assert.equal(button(byId.messages, 'อนุญาตตลอดในแชตนี้'), undefined);
  assert.ok(button(byId.messages, 'ไม่อนุญาต'));
  assert.deepEqual(byClass(byId.messages, 'note permission-hint').map((e) => e.textContent), [ONCE_ONLY_HINT]);
  button(byId.messages, 'ไม่อนุญาต').listeners.click();
  await tick(10);
  assert.deepEqual(answers()[1].body, { token: 'tok-2', decision: 'deny' });

  // End the turn so polling stops and the test process exits.
  chat.pendingStep = null;
  chat.live = null;
  chat.messages.push({ id: 'm2', role: 'assistant', original: 'เสร็จแล้ว' });
  await tick(2700);
  assert.equal(byId.messages.children[0], userMsg, 'the user message survives the end of the turn');
  assert.equal(byId.messages.children.length, 2);
});

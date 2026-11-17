// Runs public/app.js against a tiny fake DOM and a fake fetch, to check
// behaviour that spans several UI updates.
import test from 'node:test';
import assert from 'node:assert/strict';

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
const find = (el, pred) => (pred(el) ? el : el.children?.map((c) => find(c, pred)).find(Boolean));
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('the "ส่งใหม่" button becomes enabled when the model turns ready', async () => {
  let model = { state: 'loading', progress: 0.5, error: null };
  const chat = {
    id: 'c1', title: 't', pendingStep: null,
    messages: [{ id: 'm1', role: 'user', original: 'สวัสดี', english: 'hi', error: { kind: 'failed', message: 'ถูกขัดจังหวะ' } }],
  };
  globalThis.document = { getElementById: (id) => (byId[id] ??= new El(id)), createElement: (t) => new El(t) };
  globalThis.confirm = () => true;
  globalThis.fetch = async (url) => {
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url === '/api/status') return json({ model });
    if (url === '/api/chats') return json([{ id: 'c1', title: 't', updatedAt: 'x' }]);
    if (url === '/api/chats/c1') return json(chat);
    return json({}, 404);
  };

  await import('../public/app.js');
  await tick(50);
  find(byId['chat-list'], (e) => e.className === 'chat-title').listeners.click();
  await tick(50);
  const retry = () => find(byId.messages, (e) => e.tagName === 'button' && e.textContent === 'ส่งใหม่');
  assert.equal(retry().disabled, true, 'disabled while the model is loading');

  model = { state: 'ready', progress: 1, error: null };
  await tick(1300); // one status poll
  assert.equal(byId['model-banner'].hidden, true);
  assert.equal(retry().disabled, false, 'enabled once the model is ready');
});

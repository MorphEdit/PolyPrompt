// #67: runs public/app.js against a tiny fake DOM (as app.test.js does) in
// direct mode with the translator never loaded.
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
const findAll = (el, pred, out = []) => {
  if (pred(el)) out.push(el);
  el.children?.forEach((c) => findAll(c, pred, out));
  return out;
};
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('direct mode: picker section, label, sizes off, no translator gate, no English original on direct replies', async () => {
  let model = { state: 'loading', progress: 0, error: null, size: '4b' };
  let settings = { translatorSize: '4b', claudeModel: 'default', sendMode: 'direct', downloadedSizes: ['4b'] };
  const puts = [];
  const chat = {
    id: 'c1', title: 't', pendingStep: null,
    messages: [
      { id: 'm1', role: 'user', original: 'สวัสดี', english: 'Hello', lang: 'th' },
      { id: 'm2', role: 'assistant', original: 'สวัสดีครับ', english: 'Hello there', lang: 'th' },
      { id: 'm3', role: 'user', original: 'เป็นไงบ้าง', english: null, lang: null, mode: 'direct' },
      { id: 'm4', role: 'assistant', original: 'สบายดีครับ', mode: 'direct', lang: null },
      { id: 'm5', role: 'user', original: 'อีกข้อ', english: null, lang: null, mode: 'direct', error: { kind: 'failed', message: 'ผิดพลาด' } },
    ],
  };
  globalThis.document = { getElementById: (id) => (byId[id] ??= new El(id)), createElement: (t) => new El(t) };
  globalThis.confirm = () => true;
  globalThis.fetch = async (url, opts = {}) => {
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url === '/api/status') return json({ model, switch: null });
    if (url === '/api/settings' && opts.method === 'PUT') {
      const patch = JSON.parse(opts.body);
      puts.push(patch);
      settings = { ...settings, ...patch };
      return json(settings);
    }
    if (url === '/api/settings') return json(settings);
    if (url === '/api/chats') return json([{ id: 'c1', title: 't', updatedAt: 'x' }]);
    if (url === '/api/chats/c1') return json(chat);
    return json({}, 404);
  };

  await import('../public/app.js');
  await tick(50);
  find(byId['chat-list'], (e) => e.className === 'chat-title').listeners.click();
  await tick(50);

  // The label and the banner follow the mode; retry works without the translator.
  assert.equal(byId.picker.textContent, 'ส่งตรง · Claude ค่าเริ่มต้น');
  assert.equal(byId['model-banner'].hidden, true, 'no translator banner in direct mode');
  const retry = find(byId.messages, (e) => e.tagName === 'button' && e.textContent === 'ส่งใหม่');
  assert.equal(retry.disabled, false);

  // Old translate-mode reply keeps its English original; the direct one has none.
  const summaries = findAll(byId.messages, (e) => e.tagName === 'summary').map((e) => e.textContent);
  assert.deepEqual(summaries, ['ดูคำแปลภาษาอังกฤษ', 'ดูต้นฉบับภาษาอังกฤษ']);

  // The "การส่ง" section comes first, direct selected; the sizes are disabled.
  byId.picker.listeners.click();
  const menu = byId['picker-menu'].children;
  assert.equal(menu[0].textContent, 'การส่ง');
  const modes = findAll(byId['picker-menu'], (e) => e.className === 'picker-option picker-mode');
  assert.deepEqual(modes.map((b) => b.children[0].textContent), ['ส่งตรง (แนะนำ)', 'แปลเป็นอังกฤษก่อน']);
  assert.equal(modes[1].children[1].textContent, 'ประหยัด token ราว 20–30% แต่คำตอบอาจผิดหรือภาษาแปลก');
  const sizes = findAll(byId['picker-menu'], (e) => e.className === 'picker-option').slice(0, 3);
  assert.equal(sizes.every((b) => b.disabled), true);
  assert.equal(sizes[0].children[1].textContent, 'ใช้เมื่อเลือกแปลเป็นอังกฤษก่อน');

  // Switching to translate saves it; the label, sizes and banner follow.
  modes[1].listeners.click();
  await tick(50);
  assert.deepEqual(puts.at(-1), { sendMode: 'translate' });
  assert.equal(byId.picker.textContent, 'แปล 4B · Claude ค่าเริ่มต้น');
  assert.equal(byId['model-banner'].hidden, false, 'translate mode shows the loading banner');
  const again = find(byId.messages, (e) => e.tagName === 'button' && e.textContent === 'ส่งใหม่');
  assert.equal(again.disabled, true, 'translate mode waits for the translator');

  // Ready: polling stops, so the test process can exit.
  model = { state: 'ready', progress: 1, error: null, size: '4b' };
  await tick(1300);
  assert.equal(byId['model-banner'].hidden, true);
});

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

let model;
let sw = null;
let settings = { translatorSize: '4b', claudeModel: 'default', downloadedSizes: ['4b'] };
const puts = [];

test('the "ส่งใหม่" button becomes enabled when the model turns ready', async () => {
  model = { state: 'loading', progress: 0.5, error: null, size: '4b' };
  const chat = {
    id: 'c1', title: 't', pendingStep: null,
    messages: [{ id: 'm1', role: 'user', original: 'สวัสดี', english: 'hi', error: { kind: 'failed', message: 'ถูกขัดจังหวะ' } }],
  };
  globalThis.document = { getElementById: (id) => (byId[id] ??= new El(id)), createElement: (t) => new El(t) };
  globalThis.confirm = () => true;
  globalThis.fetch = async (url, opts = {}) => {
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url === '/api/status') return json({ model, switch: sw });
    if (url === '/api/settings' && opts.method === 'PUT') {
      const patch = JSON.parse(opts.body);
      puts.push(patch);
      if (patch.claudeModel) settings = { ...settings, claudeModel: patch.claudeModel };
      if (patch.translatorSize) sw = { size: patch.translatorSize, state: 'downloading', progress: 0.2, error: null };
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
  const retry = () => find(byId.messages, (e) => e.tagName === 'button' && e.textContent === 'ส่งใหม่');
  assert.equal(retry().disabled, true, 'disabled while the model is loading');

  model = { state: 'ready', progress: 1, error: null, size: '4b' };
  await tick(1300); // one status poll
  assert.equal(byId['model-banner'].hidden, true);
  assert.equal(retry().disabled, false, 'enabled once the model is ready');
});

const pickerButtons = () => {
  const out = [];
  const walk = (el) => { if (el.className === 'picker-option') out.push(el); el.children?.forEach(walk); };
  walk(byId['picker-menu']);
  return out;
};

test('the model picker shows both choices, saves on change and follows the model state', async () => {
  // Continues from the app loaded above (model ready, chat c1 open, nothing pending).
  assert.equal(byId.picker.textContent, 'แปล 4B · Claude ค่าเริ่มต้น');
  assert.equal(byId.picker.disabled, false);
  byId.picker.listeners.click();
  assert.equal(byId['picker-menu'].hidden, false);
  const [b4, b12, b27, cDefault, cFable, cOpus] = pickerButtons();
  assert.equal(pickerButtons().length, 8);
  assert.equal(cDefault.children[0].textContent, 'ค่าเริ่มต้น');
  assert.equal(cFable.children[0].textContent, 'Fable 5.2');
  assert.equal(b4.children[0].textContent, '4B · ดาวน์โหลดแล้ว');
  assert.equal(b12.children[0].textContent, '12B · 7.3 GB');
  assert.equal([b4, b12, b27].some((b) => b.disabled), false);

  cOpus.listeners.click();
  await tick(20);
  assert.deepEqual(puts.at(-1), { claudeModel: 'claude-opus-5-5' });
  assert.equal(byId.picker.textContent, 'แปล 4B · Claude Opus 5.5');

  // A missing size asks first; cancelling sends nothing.
  let asked = null;
  globalThis.confirm = (text) => { asked = text; return false; };
  pickerButtons()[1].listeners.click();
  assert.equal(asked, 'ดาวน์โหลด 7.3 GB?');
  assert.equal(puts.length, 1);
  globalThis.confirm = () => true;
  pickerButtons()[1].listeners.click();
  await tick(20);
  assert.deepEqual(puts.at(-1), { translatorSize: '12b' });

  // A background download disables the size options; the Claude section stays.
  await tick(50);
  assert.equal(byId['switch-banner'].hidden, false);
  assert.equal(pickerButtons().slice(0, 3).every((b) => b.disabled), true);
  assert.equal(pickerButtons()[3].disabled, false);
  assert.equal(byId.send.disabled, true, 'empty input');

  // A load disables them too; the error state enables them again.
  sw = null;
  model = { state: 'loading', progress: 0, error: null, size: '12b' };
  await tick(1300);
  assert.equal(pickerButtons().slice(0, 3).every((b) => b.disabled), true);
  model = { state: 'error', progress: 0, error: 'หน่วยความจำไม่พอ', size: '12b' };
  await tick(1300);
  assert.equal(pickerButtons().slice(0, 3).some((b) => b.disabled), false);
  assert.equal(byId['model-banner'].children[0].textContent, 'หน่วยความจำไม่พอ');

  // Ready again: polling stops, so the test process can exit.
  model = { state: 'ready', progress: 1, error: null, size: '4b' };
  await tick(1300);
});

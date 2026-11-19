// #69: the send-mode option in the picker must carry `selected` (the ✓).
// Fake DOM whose className and classList share one class set, like a browser.
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
    const cls = (this._cls = new Set());
    this.classList = {
      toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)),
      add: (...c) => c.forEach((x) => cls.add(x)),
      remove: (...c) => c.forEach((x) => cls.delete(x)),
      contains: (c) => cls.has(c),
    };
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this._cls.add(c)); }
  append(...c) { this.children.push(...c); }
  replaceChildren(...c) { this.children = c; }
  addEventListener(e, f) { this.listeners[e] = f; }
  setAttribute() {}
  focus() {}
}

const byId = {};
const findAll = (el, pred, out = []) => {
  if (pred(el)) out.push(el);
  el.children?.forEach((c) => findAll(c, pred, out));
  return out;
};
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('picker marks the current send mode as selected, in both modes', async () => {
  const model = { state: 'ready', progress: 1, error: null, size: '4b' };
  let settings = { translatorSize: '4b', claudeModel: 'default', sendMode: 'direct', downloadedSizes: ['4b'] };
  globalThis.document = { getElementById: (id) => (byId[id] ??= new El(id)), createElement: (t) => new El(t) };
  globalThis.confirm = () => true;
  globalThis.fetch = async (url, opts = {}) => {
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url === '/api/status') return json({ model, switch: null });
    if (url === '/api/settings' && opts.method === 'PUT') {
      settings = { ...settings, ...JSON.parse(opts.body) };
      return json(settings);
    }
    if (url === '/api/settings') return json(settings);
    if (url === '/api/chats') return json([]);
    return json({}, 404);
  };

  await import('../public/app.js');
  await tick(50);

  const modes = () => findAll(byId['picker-menu'], (e) => e.classList?.contains('picker-mode'));
  const selected = () => modes().map((b) => b.classList.contains('selected'));
  const names = () => modes().map((b) => b.children[0].textContent);

  byId.picker.listeners.click();
  assert.deepEqual(names(), ['ส่งตรง (แนะนำ)', 'แปลเป็นอังกฤษก่อน']);
  assert.deepEqual(selected(), [true, false], 'direct: "ส่งตรง (แนะนำ)" has the ✓');

  modes()[1].listeners.click();
  await tick(50);
  byId.picker.listeners.click();
  assert.deepEqual(selected(), [false, true], 'translate: "แปลเป็นอังกฤษก่อน" has the ✓');
});

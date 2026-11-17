// #35: public/app.js with a fake DOM and fetch: folder picker, old sessions,
// live activity, permission cards and stop.
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
const all = (el, pred, out = []) => {
  if (pred(el)) out.push(el);
  el.children?.forEach((c) => all(c, pred, out));
  return out;
};
const find = (el, pred) => all(el, pred)[0];
const button = (root, text) => find(root, (e) => e.tagName === 'button' && e.textContent === text);
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

const FOLDER = 'C:\\work\\app';
const posts = [];
let chat;
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('folder picker, old sessions, live card answers with its token, and stop', async () => {
  globalThis.document = { getElementById: (id) => (byId[id] ??= new El(id)), createElement: (t) => new El(t) };
  globalThis.confirm = () => true;
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    if (opts.method === 'POST') posts.push({ url, body });
    if (url === '/api/status') return json({ model: { state: 'ready', progress: 1, error: null, size: '4b' }, switch: null });
    if (url === '/api/settings') return json({ translatorSize: '4b', claudeModel: 'default', downloadedSizes: ['4b'] });
    if (url === '/api/chats') return json([]);
    if (url === '/api/folders') return json({ path: null, parent: null, home: 'C:\\work', folders: [{ name: 'C:\\', path: 'C:\\' }] });
    if (url === `/api/folders?path=${encodeURIComponent('C:\\work')}`) {
      return json({ path: 'C:\\work', parent: 'C:\\', home: 'C:\\work', folders: [{ name: 'app', path: FOLDER }] });
    }
    if (url === `/api/folders?path=${encodeURIComponent(FOLDER)}`) return json({ path: FOLDER, parent: 'C:\\work', folders: [] });
    if (url === `/api/claude-sessions?folder=${encodeURIComponent(FOLDER)}`) {
      return json([{ id: 'old-1', title: 'Fix the login bug', updatedAt: '2026-03-01T09:00:00.000Z' }]);
    }
    if (url.startsWith('/api/claude-sessions/old-1?')) {
      return json({ id: 'old-1', folder: FOLDER, done: 1, total: 1,
        messages: [{ role: 'user', english: 'Fix the login bug', original: 'แก้บั๊กล็อกอิน', activity: [] }] });
    }
    if (url === '/api/messages') return json({ chatId: 'c1', messageId: 'm1' }, 202);
    if (url === '/api/chats/c1') return json(chat);
    if (url === '/api/chats/c1/permissions/r1') return json({});
    if (url === '/api/chats/c1/stop') return json({}, 202);
    return json({ error: 'not found' }, 404);
  };

  await import('../public/app.js');
  await tick(30);
  // A new chat: the folder button shows, no old-sessions section yet.
  assert.equal(byId['folder-button'].hidden, false);
  assert.equal(byId['folder-button'].textContent, '📁 เลือกโฟลเดอร์');
  assert.equal(byId['old-sessions-label'].hidden, true);

  // The picker opens at the home folder; pick "app".
  byId['folder-button'].listeners.click();
  await tick(30);
  assert.equal(byId['folder-dialog'].hidden, false);
  assert.equal(byId['folder-path'].textContent, 'C:\\work');
  find(byId['folder-list'], (e) => e.textContent === '📁 app').listeners.click();
  await tick(30);
  assert.equal(byId['folder-path'].textContent, FOLDER);
  byId['folder-choose'].listeners.click();
  await tick(30);
  assert.equal(byId['folder-dialog'].hidden, true);
  assert.equal(byId['folder-label'].textContent, `📁 ${FOLDER}`);
  assert.equal(byId['old-sessions-label'].hidden, false);
  const entry = find(byId['old-sessions'], (e) => e.className === 'chat-title');
  assert.equal(entry.textContent, 'Fix the login bug · 1/3/2026');

  // Opening an old session shows its Thai text; typing continues it.
  entry.listeners.click();
  await tick(30);
  assert.ok(all(byId.messages, (e) => e.textContent === 'แก้บั๊กล็อกอิน').length);
  chat = {
    id: 'c1', folder: FOLDER, pendingStep: 'thinking', messages: [{ id: 'm1', role: 'user', original: 'ต่อเลย' }],
    live: {
      activity: [{ text: '🔍 กำลังอ่าน `src/app.js`', detail: 'src/app.js', output: 'code' }],
      card: { requestId: 'r1', token: 'tok-1', toolName: 'Bash', text: 'Claude ขอรันคำสั่ง', detail: 'npm test' },
    },
  };
  byId.input.value = 'ต่อเลย';
  byId.input.listeners.input();
  byId.composer.listeners.submit({ preventDefault() {} });
  await tick(30);
  assert.deepEqual(posts.find((p) => p.url === '/api/messages').body, { text: 'ต่อเลย', folder: FOLDER, resumeSessionId: 'old-1' });

  // Live activity and the card, with the untranslated detail.
  assert.ok(all(byId.messages, (e) => e.textContent === '🔍 กำลังอ่าน `src/app.js`').length);
  assert.ok(all(byId.messages, (e) => e.textContent === 'Claude ขอรันคำสั่ง').length);
  assert.ok(all(byId.messages, (e) => e.tagName === 'pre' && e.textContent === 'npm test').length);
  assert.equal(byId['folder-button'].hidden, true, 'the folder is fixed once the chat exists');
  assert.equal(byId.stop.hidden, false);
  assert.equal(byId.send.disabled, true);

  button(byId.messages, 'อนุญาตตลอดในแชตนี้').listeners.click();
  await tick(30);
  assert.deepEqual(posts.find((p) => p.url.endsWith('/permissions/r1')).body, { token: 'tok-1', decision: 'allow_chat' });

  byId.stop.listeners.click();
  await tick(30);
  assert.ok(posts.some((p) => p.url === '/api/chats/c1/stop'));

  // The turn ends stopped: the note shows, the stop button goes.
  chat = { ...chat, pendingStep: null, live: null, messages: [...chat.messages,
    { id: 'm2', role: 'assistant', original: 'ทำไปบางส่วน', english: 'Partly done', stopped: true,
      activity: [{ text: '🔧 รัน `npm test`', detail: 'npm test', output: 'x', truncated: true }] }] };
  await tick(1100);
  assert.equal(byId.stop.hidden, true);
  assert.ok(all(byId.messages, (e) => e.textContent === 'หยุดแล้ว').length);
  assert.ok(all(byId.messages, (e) => e.textContent === 'ผลลัพธ์ยาวเกินไป จึงเก็บไว้เฉพาะส่วนต้น').length);
});

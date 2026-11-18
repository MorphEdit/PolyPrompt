// #35: folder chats, permission cards, live activity and stop, end to end
// through the HTTP API, the real runner and a fake `claude` (fixtures/claude/
// script.mjs) speaking stream-json and control_request/control_response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOLDER_ALLOWED_TOOLS, SYSTEM_PROMPT, createClaudeRunner } from '../src/claude.js';
import { createModelManager } from '../src/model.js';
import { createPending } from '../src/pipeline.js';
import { createApp } from '../src/server.js';
import { createChatStore } from '../src/store.js';
import { DENY_MESSAGE } from '../src/stream.js';
import { deferred, fakeLoader, listen, request, tick } from './helpers.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude', 'script.mjs');
const THAI = /[\u0E00-\u0E7F]/;

const init = (sid) => ({ emit: { type: 'system', subtype: 'init', session_id: sid } });
const say = (text) => ({ emit: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } } });
const use = (id, name, input) => ({ emit: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } } });
const toolResult = (id, content) => ({ emit: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } } });
const result = (text, sid) => ({ emit: { type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid } });
const ask = (id, tool, input) => ({ ask: { id, tool, input } });

async function setup(t, { timeoutMs = 300000 } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'polyprompt-tools-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const folder = path.join(base, 'work folder');
  await mkdir(folder);
  const chatStore = createChatStore({ dir: path.join(base, 'chats') });
  const translator = {
    calls: [],
    gate: null,
    async translate(text, src, tgt) {
      translator.calls.push(text);
      if (translator.gate) await translator.gate();
      return `<${tgt}>${text}`;
    },
  };
  const loader = fakeLoader();
  const modelManager = createModelManager({ load: loader.load });
  modelManager.start();
  loader.calls[0].resolve(translator);
  await tick();
  const home = path.join(base, 'claude-home');
  const runner = createClaudeRunner({ command: SCRIPT, cwd: home, timeoutMs });
  const pending = createPending();
  const detect = (text) => (THAI.test(text) ? { kind: 'ok', lang: 'th' } : { kind: 'ok', lang: 'en' });
  const server = createApp({ modelManager, chatStore, publicDir: base, runner, pending, detect, projectsDir: path.join(base, 'projects') });
  const { port } = await listen(server);
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));

  const logFile = path.join(base, 'log.json');
  const scriptFile = path.join(base, 'script.json');
  process.env.FIXTURE_LOG = logFile;
  process.env.FIXTURE_SCRIPT = scriptFile;
  const json = { 'content-type': 'application/json' };
  const api = {
    script: (steps) => writeFile(scriptFile, JSON.stringify(steps)),
    log: async () => JSON.parse(await readFile(logFile, 'utf8')),
    send: (body) => request(port, 'POST', '/api/messages', { headers: json, body: JSON.stringify(body) }),
    get: async (id) => (await request(port, 'GET', `/api/chats/${id}`)).json,
    answer: (id, requestId, body) => request(port, 'POST', `/api/chats/${id}/permissions/${requestId}`, { headers: json, body: JSON.stringify(body) }),
    retry: (id, messageId) => request(port, 'POST', `/api/chats/${id}/messages/${messageId}/retry`),
    stop: (id) => request(port, 'POST', `/api/chats/${id}/stop`),
    async until(id, pred, what = 'condition') {
      for (let i = 0; i < 500; i++) {
        const chat = await api.get(id);
        if (pred(chat)) return chat;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for ${what}`);
    },
    card: (id) => api.until(id, (c) => c.live?.card, 'a card'),
    idle: (id) => api.until(id, (c) => c.pendingStep === null, 'the turn to end'),
    async start(body) {
      const r = await api.send(body);
      assert.equal(r.status, 202, JSON.stringify(r.json));
      return r.json.chatId;
    },
  };
  return { api, base, folder, home, chatStore, translator, pending };
}

test('a folder sent with the first message is stored on the chat and used as the claude cwd, with Claude Code defaults', async (t) => {
  const { api, folder } = await setup(t);
  await api.script([init('s-folder'), result('Hi from the folder', 's-folder')]);
  const id = await api.start({ text: 'hello', folder: folder + path.sep });
  const chat = await api.idle(id);
  assert.equal(chat.folder, path.resolve(folder));
  assert.equal(chat.sessionId, 's-folder');
  assert.equal(chat.messages[1].original, 'Hi from the folder');
  const log = await api.log();
  assert.equal(path.resolve(log.cwd), path.resolve(folder));
  assert.equal(log.argv[log.argv.indexOf('--allowedTools') + 1], FOLDER_ALLOWED_TOOLS);
  for (const flag of ['--tools', '--strict-mcp-config', '--setting-sources', '--system-prompt']) assert.ok(!log.argv.includes(flag), flag);
  assert.equal(log.argv[log.argv.indexOf('--permission-prompt-tool') + 1], 'stdio');

  // The follow-up resumes in the same folder; folder with chatId is refused.
  await api.script([result('again', 's-folder')]);
  const bad = await api.send({ text: 'x', chatId: id, folder });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, THAI);
  assert.equal((await api.send({ text: 'next', chatId: id })).status, 202);
  await api.idle(id);
  const again = await api.log();
  assert.equal(path.resolve(again.cwd), path.resolve(folder));
  assert.equal(again.argv[again.argv.indexOf('--resume') + 1], 's-folder');
});

test('a chat without a folder keeps the general assistant with web tools only, in the app folder', async (t) => {
  const { api, home } = await setup(t);
  await api.script([result('plain', 's-plain')]);
  const id = await api.start({ text: 'hello' });
  const chat = await api.idle(id);
  assert.equal(chat.folder, undefined);
  const log = await api.log();
  assert.equal(path.resolve(log.cwd), path.resolve(home));
  assert.equal(log.argv[log.argv.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  assert.equal(log.argv[log.argv.indexOf('--system-prompt') + 1], SYSTEM_PROMPT);
});

test('a bad folder on the first message: 400 relative, 404 missing or a file; no chat is made', async (t) => {
  const { api, base, chatStore } = await setup(t);
  await writeFile(path.join(base, 'f.txt'), 'x');
  assert.equal((await api.send({ text: 'x', folder: 'relative/dir' })).status, 400);
  assert.equal((await api.send({ text: 'x', folder: 42 })).status, 400);
  assert.equal((await api.send({ text: 'x', folder: path.join(base, 'missing') })).status, 404);
  assert.equal((await api.send({ text: 'x', folder: path.join(base, 'f.txt') })).status, 404);
  assert.deepEqual(await chatStore.list(), []);
});

test('a deleted folder: the chat can be read but not continued (Thai error)', async (t) => {
  const { api, base } = await setup(t);
  const folder = path.join(base, 'temp-work');
  await mkdir(folder);
  await api.script([result('ok', 's1')]);
  const id = await api.start({ text: 'hello', folder });
  await api.idle(id);
  await rm(folder, { recursive: true });
  assert.equal((await api.get(id)).messages.length, 2);
  const r = await api.send({ text: 'more', chatId: id });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /โฟลเดอร์/);
});

test('read-only tools show live activity without a card; Bash opens a card and the turn waits; allow is sent back', async (t) => {
  const { api, folder } = await setup(t);
  await api.script([
    init('s-card'),
    say('Let me check.'),
    use('t1', 'Read', { file_path: 'src/app.js' }),
    toolResult('t1', 'console.log(1)'),
    use('t2', 'Bash', { command: 'npm test -- --watch' }),
    ask('r1', 'Bash', { command: 'npm test -- --watch' }),
    toolResult('t2', 'tests ok'),
    result('Tests pass.', 's-card'),
  ]);
  const id = await api.start({ text: 'run the tests', folder });
  const chat = await api.card(id);
  assert.equal(chat.pendingStep, 'thinking');
  // Activity is visible while the turn runs, before it ends.
  assert.deepEqual(chat.live.activity[0], { text: '🔍 กำลังอ่าน `src/app.js`', detail: 'src/app.js', output: 'console.log(1)' });
  assert.equal(chat.live.activity[1].text, '🔧 รัน `npm test -- --watch`');
  const { card } = chat.live;
  assert.equal(card.requestId, 'r1');
  assert.equal(card.toolName, 'Bash');
  assert.equal(card.text, 'Claude ขอรันคำสั่ง');
  assert.equal(card.detail, 'npm test -- --watch');
  assert.match(card.token, /^[0-9a-f]{32}$/);
  // Session id stored right away, before the turn ends.
  assert.equal((await api.until(id, (c) => c.sessionId === 's-card', 'the session id')).pendingStep, 'thinking');

  // The turn waits for the answer.
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await api.get(id)).live.card.requestId, 'r1');

  assert.equal((await api.answer(id, 'r1', { token: card.token })).status, 400);
  assert.equal((await api.answer(id, 'r1', { token: card.token, decision: 'maybe' })).status, 400);
  assert.equal((await api.answer(id, 'r1', { token: 'wrong', decision: 'allow' })).status, 403);
  assert.equal((await api.answer(id, 'r1', { decision: 'allow' })).status, 403);
  assert.equal((await api.answer(id, 'nope', { token: card.token, decision: 'allow' })).status, 404);
  assert.equal((await api.answer('44444444-4444-4444-8444-444444444444', 'r1', { token: card.token, decision: 'allow' })).status, 404);
  const ok = await api.answer(id, 'r1', { token: card.token, decision: 'allow' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, {});
  // A reused token is refused.
  assert.equal((await api.answer(id, 'r1', { token: card.token, decision: 'allow' })).status, 403);

  const done = await api.idle(id);
  assert.equal(done.live, null);
  const reply = done.messages[1];
  assert.equal(reply.original, 'Let me check.');
  assert.deepEqual(reply.activity.map((a) => a.text), ['🔍 กำลังอ่าน `src/app.js`', '🔧 รัน `npm test -- --watch`']);
  assert.equal(reply.activity[1].output, 'tests ok');
  const { responses } = await api.log();
  assert.deepEqual(responses, [{ subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { command: 'npm test -- --watch' } } }]);
});

test('deny sends a deny response; Edit and Write produce cards one at a time, in order', async (t) => {
  const { api, folder } = await setup(t);
  await api.script([
    init('s-deny'),
    ask('e1', 'Edit', { file_path: path.join(folder, 'a.js'), old_string: 'old', new_string: 'new' }),
    ask('w1', 'Write', { file_path: 'C:/outside/b.txt', content: 'hello' }),
    result('ok', 's-deny'),
  ]);
  const id = await api.start({ text: 'edit', folder });
  let chat = await api.card(id);
  assert.equal(chat.live.card.requestId, 'e1');
  assert.equal(chat.live.card.text, `Claude ขอแก้ไฟล์ \`${path.join(folder, 'a.js')}\``);
  assert.equal(chat.live.card.detail, `${path.join(folder, 'a.js')}\n- old\n+ new`);
  assert.equal((await api.answer(id, 'e1', { token: chat.live.card.token, decision: 'deny' })).status, 200);
  chat = await api.until(id, (c) => c.live?.card?.requestId === 'w1', 'the second card');
  assert.equal(chat.live.card.text, 'Claude ขอเขียนไฟล์ `C:/outside/b.txt`');
  assert.equal(chat.live.card.detail, 'C:/outside/b.txt\nhello');
  await api.answer(id, 'w1', { token: chat.live.card.token, decision: 'allow' });
  await api.idle(id);
  const { responses } = await api.log();
  assert.deepEqual(responses.map((r) => [r.request_id, r.response.behavior, r.response.message]), [
    ['e1', 'deny', DENY_MESSAGE], ['w1', 'allow', undefined],
  ]);
});

test('allow_chat is stored on the chat; it auto-allows the same tool or Bash prefix in that chat only; operators always ask', async (t) => {
  const { api, folder, chatStore } = await setup(t);
  await api.script([
    init('s-rules'),
    ask('b1', 'Bash', { command: 'npm test -- --watch' }),
    ask('b2', 'Bash', { command: 'npm test --coverage' }), // auto-allowed
    ask('b3', 'Bash', { command: 'npm test && rm -rf dist' }), // operator: card
    ask('e1', 'Edit', { file_path: 'a.js', old_string: 'a', new_string: 'b' }),
    ask('e2', 'Edit', { file_path: 'b.js', old_string: 'a', new_string: 'b' }), // auto-allowed
    ask('b4', 'Bash', { command: 'npm install' }), // other prefix: card
    result('ok', 's-rules'),
  ]);
  const id = await api.start({ text: 'go', folder });
  const answerNext = async (requestId, decision) => {
    const chat = await api.until(id, (c) => c.live?.card?.requestId === requestId, requestId);
    assert.equal((await api.answer(id, requestId, { token: chat.live.card.token, decision })).status, 200);
  };
  await answerNext('b1', 'allow_chat');
  assert.deepEqual((await chatStore.get(id)).permissions, [{ tool: 'Bash', prefix: 'npm test' }]);
  await answerNext('b3', 'allow');
  await answerNext('e1', 'allow_chat');
  await answerNext('b4', 'deny');
  const chat = await api.idle(id);
  assert.deepEqual(chat.permissions, [{ tool: 'Bash', prefix: 'npm test' }, { tool: 'Edit' }]);
  const { responses } = await api.log();
  assert.deepEqual(responses.map((r) => [r.request_id, r.response.behavior]), [
    ['b1', 'allow'], ['b2', 'allow'], ['b3', 'allow'], ['e1', 'allow'], ['e2', 'allow'], ['b4', 'deny'],
  ]);

  // Later in the same chat: no card for the stored rules.
  await api.script([ask('b5', 'Bash', { command: 'npm test' }), ask('e3', 'Edit', { file_path: 'c.js' }), result('ok', 's-rules')]);
  assert.equal((await api.send({ text: 'again', chatId: id })).status, 202);
  await api.idle(id);
  assert.deepEqual((await api.log()).responses.map((r) => [r.request_id, r.response.behavior]), [['b5', 'allow'], ['e3', 'allow']]);

  // Another chat does not use them.
  await api.script([ask('x1', 'Bash', { command: 'npm test' }), result('ok', 's-other')]);
  const other = await api.start({ text: 'other', folder });
  const card = await api.card(other);
  assert.equal(card.live.card.requestId, 'x1');
  await api.answer(other, 'x1', { token: card.live.card.token, decision: 'deny' });
  await api.idle(other);
});

test('a stored git status rule does not auto-allow a command chained with a single &', async (t) => {
  const { api, folder } = await setup(t);
  await api.script([
    init('s-amp'),
    ask('g1', 'Bash', { command: 'git status' }),
    ask('g2', 'Bash', { command: 'git status & echo pwned' }), // single &: card
    result('ok', 's-amp'),
  ]);
  const id = await api.start({ text: 'go', folder });
  let chat = await api.until(id, (c) => c.live?.card?.requestId === 'g1', 'g1');
  await api.answer(id, 'g1', { token: chat.live.card.token, decision: 'allow_chat' });
  chat = await api.until(id, (c) => c.live?.card?.requestId === 'g2', 'the card for the chained command');
  assert.equal(chat.live.card.detail, 'git status & echo pwned');
  assert.equal((await api.answer(id, 'g2', { token: chat.live.card.token, decision: 'deny' })).status, 200);
  const done = await api.idle(id);
  assert.deepEqual(done.permissions, [{ tool: 'Bash', prefix: 'git status' }]);
  assert.deepEqual((await api.log()).responses.map((r) => [r.request_id, r.response.behavior]), [['g1', 'allow'], ['g2', 'deny']]);
});

test('cards, activity and commands are never passed through the translator', async (t) => {
  const { api, folder, translator } = await setup(t);
  const command = 'git commit -m "secret command text"';
  await api.script([
    init('s-tr'),
    say('Committing now.'),
    use('t1', 'Bash', { command }),
    ask('r1', 'Bash', { command }),
    toolResult('t1', 'command output text'),
    result('Committed.', 's-tr'),
  ]);
  const id = await api.start({ text: 'ช่วย commit ให้หน่อย', folder });
  const chat = await api.card(id);
  await api.answer(id, 'r1', { token: chat.live.card.token, decision: 'allow' });
  const done = await api.idle(id);
  assert.equal(done.messages[1].original, '<th>Committing now.');
  assert.deepEqual(translator.calls, ['ช่วย commit ให้หน่อย', 'Committing now.']);
  const forbidden = [command, 'secret command text', 'command output text', chat.live.card.text, ...chat.live.activity.map((a) => a.text)];
  for (const call of translator.calls) for (const text of forbidden) assert.ok(!call.includes(text), `${text} was translated`);
});

test('stop denies the open card, kills claude and saves the text so far with stopped: true; the next message resumes', async (t) => {
  const { api, folder } = await setup(t);
  await api.script([
    init('s-stop'),
    say('I started the work.'),
    use('t1', 'Read', { file_path: 'x.js' }),
    ask('r1', 'Write', { file_path: 'x.js', content: 'y' }),
    { hang: true },
  ]);
  const id = await api.start({ text: 'สวัสดี', folder });
  await api.card(id);
  const r = await api.stop(id);
  assert.equal(r.status, 202);
  assert.deepEqual(r.json, {});
  const chat = await api.idle(id);
  const [user, reply] = chat.messages;
  assert.equal(user.error, undefined);
  assert.equal(reply.stopped, true);
  assert.equal(reply.english, 'I started the work.');
  assert.equal(reply.original, '<th>I started the work.');
  assert.deepEqual(reply.activity.map((a) => a.text), ['🔍 กำลังอ่าน `x.js`']);
  assert.equal(chat.sessionId, 's-stop');
  const log = await api.log();
  assert.deepEqual(log.responses, [{ subtype: 'success', request_id: 'r1', response: { behavior: 'deny', message: DENY_MESSAGE } }]);

  // No claude running now: 409; unknown chat: 404.
  assert.equal((await api.stop(id)).status, 409);
  assert.equal((await api.stop('44444444-4444-4444-8444-444444444444')).status, 404);

  await api.script([result('continued', 's-stop')]);
  assert.equal((await api.send({ text: 'go on', chatId: id })).status, 202);
  await api.idle(id);
  const next = await api.log();
  assert.equal(next.argv[next.argv.indexOf('--resume') + 1], 's-stop');
});

test('stop before any session id keeps the previous one; stop is 409 while translating', async (t) => {
  const { api, translator } = await setup(t);
  await api.script([init('s-first'), result('first', 's-first')]);
  const id = await api.start({ text: 'hello' });
  await api.idle(id);
  await api.script([{ hang: true }]);
  assert.equal((await api.send({ text: 'second', chatId: id })).status, 202);
  await api.until(id, (c) => c.pendingStep === 'thinking', 'thinking');
  // Wait until claude is up so the stop really kills it.
  for (let i = 0; i < 300; i++) {
    try {
      if ((await api.log()).stdin.length) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal((await api.stop(id)).status, 202);
  const chat = await api.idle(id);
  assert.equal(chat.sessionId, 's-first');
  assert.equal(chat.messages.at(-1).stopped, true);
  assert.equal(chat.messages.at(-1).original, '');

  const gate = deferred();
  translator.gate = () => gate.promise;
  await api.script([result('x', 's-first')]);
  assert.equal((await api.send({ text: 'สวัสดี', chatId: id })).status, 202);
  await api.until(id, (c) => c.pendingStep === 'translating', 'translating');
  assert.equal((await api.stop(id)).status, 409);
  translator.gate = null;
  gate.resolve();
  await api.idle(id);
});

test('a failed turn keeps the streamed session id and drops its partial text and activity; retry resumes it', async (t) => {
  const { api, folder } = await setup(t, { timeoutMs: 300 });
  await api.script([init('s-fail'), say('partial'), use('t1', 'Read', { file_path: 'a' }), { hang: true }]);
  const id = await api.start({ text: 'hello', folder });
  const chat = await api.idle(id);
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.messages[0].error.kind, 'timeout');
  assert.equal(chat.sessionId, 's-fail');

  await api.script([result('ok', 's-fail')]);
  assert.equal((await api.retry(id, chat.messages[0].id)).status, 202);
  await api.idle(id);
  const log = await api.log();
  assert.equal(log.argv[log.argv.indexOf('--resume') + 1], 's-fail');
});

test('the idle timeout is paused while a card is open', async (t) => {
  const { api, folder } = await setup(t, { timeoutMs: 250 });
  await api.script([init('s-wait'), ask('r1', 'Bash', { command: 'npm test' }), result('fine', 's-wait')]);
  const id = await api.start({ text: 'go', folder });
  const chat = await api.card(id);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal((await api.answer(id, 'r1', { token: chat.live.card.token, decision: 'allow' })).status, 200);
  const done = await api.idle(id);
  assert.equal(done.messages[0].error, undefined);
  assert.equal(done.messages[1].original, 'fine');
});

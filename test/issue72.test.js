// #72 (PRD #71): translate mode sends the message as typed, asks Claude for
// an English reply and has Claude Haiku translate the reply back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClaudeError, ENGLISH_SYSTEM_PROMPT, REPLY_IN_ENGLISH, SYSTEM_PROMPT, TRANSLATOR_MODEL,
  buildArgs, createClaudeRunner, resolveCommand, translatorArgs, translatorPrompt,
} from '../src/claude.js';
import { LANGUAGES, REPLY_LANGUAGES, UNSUPPORTED, detectLanguage } from '../src/lang.js';
import { ANSWER_NOT_TRANSLATED_NOTE, UNSUPPORTED_NOTE, createPending, runTurn } from '../src/pipeline.js';
import { createChatStore } from '../src/store.js';
import { deferred, tick } from './helpers.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude');
const SCRIPT = path.join(fixtures, 'script.mjs');
const win = process.platform === 'win32';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'polyprompt-72-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

// A local translator that must never be used in translate mode.
function localTranslator() {
  const calls = [];
  return { calls, translate: async (...args) => { calls.push(args); return 'LOCAL'; } };
}

// Fake runner (Claude) and fake back-translator (Haiku).
async function setup(t, { reply = 'The answer is 4.', back } = {}) {
  const dir = await tempDir(t);
  const chatStore = createChatStore({ dir });
  const modelManager = localTranslator();
  const runs = [];
  const runner = {
    reply,
    gate: null,
    async run(opts) {
      runs.push(opts);
      if (runner.gate) return runner.gate(opts);
      return { text: runner.reply, sessionId: 's1', model: 'claude-opus-5-5' };
    },
  };
  const backs = [];
  const backTranslate = async (opts) => {
    backs.push(opts);
    return back ? back(opts) : `[${opts.targetLang}] ${opts.text}`;
  };
  const pending = createPending();
  const deps = { chatStore, modelManager, detect: detectLanguage, runner, pending, backTranslate };
  async function turn(text, { chat, mode = 'translate', folder = null } = {}) {
    chat ??= await chatStore.create(text, { folder });
    const message = { id: `m${chat.messages.length}`, role: 'user', original: text, english: null, lang: null, createdAt: 'x' };
    chat.messages.push(message);
    pending.set(chat.id, 'thinking');
    await runTurn(deps, chat, message, mode);
    return chatStore.get(chat.id);
  }
  return { dir, chatStore, modelManager, runner, runs, backs, pending, deps, turn };
}

// ---- AC1 ----

test('AC1: a Thai message is sent as typed with the English-reply flag; Haiku translates the reply to Thai', async (t) => {
  const s = await setup(t);
  const chat = await s.turn('สองบวกสองเท่ากับเท่าไร');
  assert.equal(s.runs.length, 1);
  assert.equal(s.runs[0].prompt, 'สองบวกสองเท่ากับเท่าไร');
  assert.equal(s.runs[0].replyInEnglish, true);
  assert.equal(s.modelManager.calls.length, 0, 'zero local translator calls');
  assert.equal(s.backs.length, 1);
  assert.equal(s.backs[0].text, 'The answer is 4.');
  assert.equal(s.backs[0].targetLang, 'th');
  const [u, a] = chat.messages;
  assert.equal(u.english, null);
  assert.equal(u.lang, 'th');
  assert.equal(a.original, '[th] The answer is 4.');
  assert.equal(a.english, 'The answer is 4.');
  assert.equal(a.lang, 'th');
  assert.equal(a.note, undefined);
  assert.equal(a.stopped, undefined);
  // The answering model, not Haiku.
  assert.equal(a.model, 'claude-opus-5-5');
  assert.equal(chat.lang, 'th');
  assert.equal(chat.sessionId, 's1');
});

// ---- AC2 ----

test('AC2: an English message makes no back-translation and gets no note', async (t) => {
  const s = await setup(t);
  const chat = await s.turn('What is two plus two?');
  assert.equal(s.backs.length, 0);
  const a = chat.messages[1];
  assert.equal(a.original, 'The answer is 4.');
  assert.equal(a.note, undefined);
});

test('AC2: a reply already in Thai, also with English code and terms, is shown as is', async (t) => {
  for (const reply of [
    'สองบวกสองเท่ากับสี่ครับ',
    'ใช้คำสั่ง `npm install express` เพื่อติดตั้งแพ็กเกจ แล้วเรียก `app.listen(3000)` เพื่อเปิดเซิร์ฟเวอร์ ถ้าใช้ TypeScript ให้ติดตั้ง @types/express ด้วย',
  ]) {
    const s = await setup(t, { reply });
    const chat = await s.turn('ช่วยอธิบายหน่อย');
    assert.equal(s.backs.length, 0, reply);
    const a = chat.messages[1];
    assert.equal(a.original, reply);
    assert.equal(a.english, reply);
    assert.equal(a.note, undefined);
  }
});

test('AC2: an empty reply is shown as is, with no call and no note', async (t) => {
  const s = await setup(t, { reply: '' });
  const chat = await s.turn('สวัสดีครับ');
  assert.equal(s.backs.length, 0);
  assert.equal(chat.messages[1].original, '');
  assert.equal(chat.messages[1].note, undefined);
});

// ---- AC3 ----

for (const [name, back] of [
  ['an error', () => { throw new ClaudeError('not_logged_in'); }],
  ['empty output', () => '   '],
  ['a timeout', () => Promise.reject(new ClaudeError('timeout'))],
]) {
  test(`AC3: a back-translation with ${name} keeps the English answer with the note; the turn succeeds`, async (t) => {
    const s = await setup(t, { back });
    const chat = await s.turn('สวัสดีครับ');
    const [u, a] = chat.messages;
    assert.equal(u.error, undefined);
    assert.equal(a.original, 'The answer is 4.');
    assert.equal(a.english, 'The answer is 4.');
    assert.equal(a.note, ANSWER_NOT_TRANSLATED_NOTE);
    assert.equal(chat.sessionId, 's1');
  });
}

// ---- AC4 ----

test('AC4: stop during translating_back aborts the Haiku call and keeps the English answer, not marked stopped', async (t) => {
  const s = await setup(t, {
    back: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new ClaudeError('failed', 'stopped')), { once: true });
    }),
  });
  const done = s.turn('สวัสดีครับ');
  while (s.backs.length === 0) await tick();
  const [id] = [...(await s.chatStore.list())].map((c) => c.id);
  assert.equal(s.pending.get(id), 'translating_back');
  s.pending.turn(id).stop();
  const chat = await done;
  assert.equal(s.backs[0].signal.aborted, true);
  const a = chat.messages[1];
  assert.equal(a.original, 'The answer is 4.');
  assert.equal(a.note, ANSWER_NOT_TRANSLATED_NOTE);
  assert.equal(a.stopped, undefined);
  assert.equal(chat.sessionId, 's1');
});

test('AC4: stop during thinking shows the partial English answer with the note, stopped, no Haiku call', async (t) => {
  const s = await setup(t);
  const started = deferred();
  s.runner.gate = ({ signal }) => new Promise((resolve) => {
    started.resolve();
    signal.addEventListener('abort', () => resolve({ text: 'The answer', sessionId: 's1', stopped: true }), { once: true });
  });
  const done = s.turn('สวัสดีครับ');
  await started.promise;
  const [id] = (await s.chatStore.list()).map((c) => c.id);
  assert.equal(s.pending.get(id), 'thinking');
  s.pending.turn(id).stop();
  const chat = await done;
  assert.equal(s.backs.length, 0);
  const a = chat.messages[1];
  assert.equal(a.original, 'The answer');
  assert.equal(a.english, 'The answer');
  assert.equal(a.note, ANSWER_NOT_TRANSLATED_NOTE);
  assert.equal(a.stopped, true);
});

// ---- AC11 ----

test('AC11: a Lao message (not supported by TranslateGemma) is translated back to Lao, with no unsupported note', async (t) => {
  assert.ok(UNSUPPORTED.includes('lo'));
  const s = await setup(t);
  const chat = await s.turn('ສະບາຍດີ ເຈົ້າເປັນແນວໃດ ມື້ນີ້ອາກາດດີຫຼາຍ');
  assert.deepEqual(s.backs.map((b) => b.targetLang), ['lo']);
  const [u, a] = chat.messages;
  assert.equal(u.lang, 'lo');
  assert.equal(a.lang, 'lo');
  assert.equal(chat.lang, 'lo');
  assert.equal(a.original, '[lo] The answer is 4.');
  assert.equal(a.note, undefined);
  assert.ok(!JSON.stringify(chat).includes(UNSUPPORTED_NOTE));
});

test('translate-mode detection covers all 60 eld languages; LANGUAGES itself is unchanged', () => {
  assert.equal(Object.keys(REPLY_LANGUAGES).length, 60);
  for (const code of UNSUPPORTED) assert.ok(!Object.hasOwn(LANGUAGES, code), code);
  assert.deepEqual(detectLanguage('ສະບາຍດີ ເຈົ້າເປັນແນວໃດ ມື້ນີ້ອາກາດດີຫຼາຍ'), { kind: 'unsupported', lang: null });
});

// ---- AC5 ----

test('AC5: the Haiku call: fixed model, no tools, no session, a prompt naming the language, in the Claude home', async (t) => {
  const dir = await tempDir(t);
  const home = path.join(dir, 'claude-home');
  const log = path.join(dir, 'log.json');
  const script = path.join(dir, 'script.json');
  process.env.FIXTURE_LOG = log;
  process.env.FIXTURE_SCRIPT = script;
  await writeFile(script, JSON.stringify([
    { emit: { type: 'assistant', message: { role: 'assistant', model: TRANSLATOR_MODEL, content: [{ type: 'text', text: 'คำตอบคือ 4' }] } } },
    { emit: { type: 'result', subtype: 'success', is_error: false, result: 'คำตอบคือ 4', session_id: 'haiku' } },
  ]));
  const runner = createClaudeRunner({ command: SCRIPT, cwd: home });
  const out = await runner.translate({ text: 'The answer is 4.', targetLang: 'th' });
  assert.equal(out, 'คำตอบคือ 4');
  const { argv, cwd, stdin } = JSON.parse(await readFile(log, 'utf8'));
  assert.equal(path.resolve(cwd), path.resolve(home));
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-haiku-5-5');
  assert.equal(argv[argv.indexOf('--tools') + 1], '');
  assert.ok(argv.includes('--no-session-persistence'));
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.equal(argv[argv.indexOf('--setting-sources') + 1], 'user');
  assert.ok(!argv.includes('--resume'));
  assert.ok(!argv.includes('--allowedTools'));
  const prompt = argv[argv.indexOf('--system-prompt') + 1];
  assert.equal(prompt, translatorPrompt('th'));
  assert.match(prompt, /English-to-Thai translator/);
  assert.match(prompt, /Output only the Thai translation/);
  assert.equal(JSON.parse(stdin[0]).message.content, 'The answer is 4.');
});

test('AC5: in a folder chat the Haiku call still runs in the Claude home, after Claude ran in the folder', async (t) => {
  const dir = await tempDir(t);
  const home = path.join(dir, 'claude-home');
  const folder = path.join(dir, 'work');
  await mkdir(folder);
  const log = path.join(dir, 'log.json');
  const script = path.join(dir, 'script.json');
  process.env.FIXTURE_LOG = log;
  process.env.FIXTURE_SCRIPT = script;
  const emit = (text, sid) => [
    { emit: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } } },
    { emit: { type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid } },
  ];
  await writeFile(script, JSON.stringify(emit('The file has 3 lines.', 's-folder')));
  const runner = createClaudeRunner({ command: SCRIPT, cwd: home });
  const chatStore = createChatStore({ dir: path.join(dir, 'chats') });
  let first;
  const backTranslate = async (opts) => {
    first = JSON.parse(await readFile(log, 'utf8'));
    await writeFile(script, JSON.stringify(emit('ไฟล์มี 3 บรรทัด', 'haiku')));
    return runner.translate(opts);
  };
  const pending = createPending();
  const chat = await chatStore.create('x', { folder });
  const message = { id: 'm1', role: 'user', original: 'ไฟล์นี้มีกี่บรรทัด', english: null, lang: null, createdAt: 'x' };
  chat.messages.push(message);
  await runTurn({ chatStore, detect: detectLanguage, runner, pending, backTranslate }, chat, message, 'translate');

  assert.equal(path.resolve(first.cwd), path.resolve(folder));
  assert.equal(first.argv[first.argv.indexOf('--append-system-prompt') + 1], REPLY_IN_ENGLISH);
  const haiku = JSON.parse(await readFile(log, 'utf8'));
  assert.equal(path.resolve(haiku.cwd), path.resolve(home));
  assert.equal(haiku.argv[haiku.argv.indexOf('--model') + 1], TRANSLATOR_MODEL);
  assert.ok(!haiku.argv.includes('--resume'));
  const saved = await chatStore.get(chat.id);
  assert.equal(saved.messages[1].original, 'ไฟล์มี 3 บรรทัด');
  assert.equal(saved.messages[1].english, 'The file has 3 lines.');
  assert.equal(saved.sessionId, 's-folder', 'the Haiku call never touches the chat session');
});

test('AC5: the Haiku call rejects on empty output, an error result and a stop', async (t) => {
  const dir = await tempDir(t);
  const script = path.join(dir, 'script.json');
  process.env.FIXTURE_LOG = path.join(dir, 'log.json');
  process.env.FIXTURE_SCRIPT = script;
  const runner = createClaudeRunner({ command: SCRIPT, cwd: path.join(dir, 'home'), graceMs: 50 });
  await writeFile(script, JSON.stringify([{ emit: { type: 'result', subtype: 'success', is_error: false, result: '', session_id: 'h' } }]));
  await assert.rejects(runner.translate({ text: 'Hi.', targetLang: 'th' }), (err) => err.kind === 'failed');
  await writeFile(script, JSON.stringify([{ emit: { type: 'result', subtype: 'error', is_error: true, result: 'quota', session_id: 'h' } }]));
  await assert.rejects(runner.translate({ text: 'Hi.', targetLang: 'th' }), (err) => !!err.kind);
  await writeFile(script, JSON.stringify([{ hang: true }]));
  const controller = new AbortController();
  const p = runner.translate({ text: 'Hi.', targetLang: 'th', signal: controller.signal });
  await new Promise((r) => setTimeout(r, 300));
  controller.abort();
  await assert.rejects(p, (err) => err.kind === 'failed');
});

// ---- AC6 ----

test('AC6: buildArgs adds the English-reply sentence only in translate mode', () => {
  const general = buildArgs(null, 'default', null, { replyInEnglish: true });
  assert.equal(general[general.indexOf('--system-prompt') + 1], ENGLISH_SYSTEM_PROMPT);
  assert.ok(ENGLISH_SYSTEM_PROMPT.includes(REPLY_IN_ENGLISH));
  assert.equal(REPLY_IN_ENGLISH, 'Always write your reply in English, whatever language the user writes in.');
  assert.ok(!general.includes('--append-system-prompt'));

  const folder = buildArgs('s1', 'default', 'C:\\work', { replyInEnglish: true });
  assert.equal(folder[folder.indexOf('--append-system-prompt') + 1], REPLY_IN_ENGLISH);
  assert.ok(!folder.includes('--system-prompt'));

  // Direct mode: neither.
  const direct = buildArgs(null, 'default', null);
  assert.equal(direct[direct.indexOf('--system-prompt') + 1], SYSTEM_PROMPT);
  assert.ok(!direct.join(' ').includes(REPLY_IN_ENGLISH));
  const directFolder = buildArgs('s1', 'default', 'C:\\work');
  assert.ok(!directFolder.includes('--append-system-prompt'));
  assert.ok(!directFolder.join(' ').includes(REPLY_IN_ENGLISH));
});

test('AC6: a direct turn asks for no English reply and makes no back-translation', async (t) => {
  const s = await setup(t);
  const chat = await s.turn('สวัสดีครับ', { mode: 'direct' });
  assert.equal(s.runs[0].replyInEnglish, false);
  assert.equal(s.backs.length, 0);
  assert.equal(chat.messages[1].original, 'The answer is 4.');
  assert.equal(chat.messages[1].mode, 'direct');
});

test('AC6: the real runner passes the flag through to the claude args', async (t) => {
  const dir = await tempDir(t);
  const folder = path.join(dir, 'work');
  await mkdir(folder);
  const log = path.join(dir, 'log.json');
  process.env.FIXTURE_LOG = log;
  process.env.FIXTURE_SCRIPT = path.join(dir, 'script.json');
  await writeFile(process.env.FIXTURE_SCRIPT, JSON.stringify([{ emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's' } }]));
  const runner = createClaudeRunner({ command: SCRIPT, cwd: path.join(dir, 'home') });
  const argvOf = async (opts) => { await runner.run({ prompt: 'x', ...opts }); return JSON.parse(await readFile(log, 'utf8')).argv; };
  let argv = await argvOf({ replyInEnglish: true });
  assert.equal(argv[argv.indexOf('--system-prompt') + 1], ENGLISH_SYSTEM_PROMPT);
  argv = await argvOf({ replyInEnglish: true, folder });
  assert.equal(argv[argv.indexOf('--append-system-prompt') + 1], REPLY_IN_ENGLISH);
  argv = await argvOf({});
  assert.equal(argv[argv.indexOf('--system-prompt') + 1], SYSTEM_PROMPT);
  argv = await argvOf({ folder });
  assert.ok(!argv.includes('--append-system-prompt'));
});

// ---- AC12 ----

test('AC12: the .cmd fallback accepts the translate-mode and Haiku args, and still refuses anything else', { skip: !win }, () => {
  const shim = path.join(fixtures, 'ok-plain.cmd');
  const lists = [
    buildArgs(null, 'claude-opus-5-5', null, { replyInEnglish: true }),
    buildArgs('s1', 'claude-opus-5-5', 'C:\\work\\my-app', { replyInEnglish: true }),
    translatorArgs('th'),
    translatorArgs('lo'),
    ...[...Object.keys(LANGUAGES), ...UNSUPPORTED].map(translatorArgs),
  ];
  for (const args of lists) {
    const r = resolveCommand(shim, args);
    assert.match(r.file, /cmd(\.exe)?$/i);
    assert.ok(r.args.at(-1).includes(args.at(-1)));
  }
  for (const bad of ['hello world', `${REPLY_IN_ENGLISH} `, translatorPrompt('xx'), `${SYSTEM_PROMPT} & calc`, 'a"b']) {
    assert.throws(() => resolveCommand(shim, ['-p', '--system-prompt', bad]), (err) => err instanceof ClaudeError && err.kind === 'failed' && /unsafe argument/.test(err.message));
  }
});

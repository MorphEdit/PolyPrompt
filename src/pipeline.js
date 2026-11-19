// Send/retry pipeline: detect -> translate -> Claude -> translate back -> save.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { cardText, isAutoAllowed, ruleFor, sameRule } from './activity.js';
import { newId } from './store.js';
import { translateText } from './text.js';
import { NotTranslatedError } from './translator.js';

export const ENGLISH = 'en';
export const MAX_CHARS = 2000;
export const UNSUPPORTED_NOTE = 'ภาษานี้ยังไม่รองรับการแปล จึงแสดงคำตอบเป็นภาษาอังกฤษ';
export const TRANSLATE_FAILED = 'แปลข้อความไม่สำเร็จ กรุณาลองส่งใหม่';
export const TURN_FAILED = 'เกิดข้อผิดพลาด กรุณาลองส่งใหม่';
export const NOT_TRANSLATED_NOTE = 'แปลข้อความไม่สำเร็จ จึงส่งข้อความตามที่พิมพ์ให้ Claude';
export const ANSWER_NOT_TRANSLATED_NOTE = 'แปลคำตอบไม่สำเร็จ จึงแสดงคำตอบเป็นภาษาอังกฤษ';
export const DECISIONS = ['allow', 'allow_chat', 'deny'];

// In-memory registry chatId -> 'translating' | 'thinking' | 'translating_back',
// plus the running turn (live activity, permission cards, stop) of each chat.
// Nothing here survives a restart: markInterrupted covers that.
export function createPending() {
  const steps = new Map();
  const turns = new Map();
  const answered = new Map(); // chatId -> request ids already answered (tokens used)
  return {
    get: (chatId) => steps.get(chatId) ?? null,
    set: (chatId, step) => { steps.set(chatId, step); },
    clear: (chatId) => { steps.delete(chatId); turns.delete(chatId); },
    begin: (chatId, turn) => { turns.set(chatId, turn); },
    turn: (chatId) => turns.get(chatId) ?? null,
    answered(chatId) {
      if (!answered.has(chatId)) answered.set(chatId, new Set());
      return answered.get(chatId);
    },
    // What GET /api/chats/:id shows as `live`: null when no turn runs.
    live(chatId) {
      if (!steps.has(chatId)) return null;
      const turn = turns.get(chatId);
      return {
        activity: (turn?.activity ?? []).map((line) => ({ ...line })),
        card: turn?.card ? { ...turn.card } : null,
      };
    },
  };
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// One running turn: its activity lines, the queue of permission requests
// (shown one card at a time, in order) and its stop switch.
// autoAllowed(request) tells whether a stored chat rule now covers a request;
// allowChat(request) stores the rule for one.
export function createTurn({ autoAllowed = () => false, allowChat = async () => {}, answered = new Set() } = {}) {
  const queue = []; // { request, card, resolve }
  const controller = new AbortController();

  function next() {
    while (queue.length && !turn.card) {
      const item = queue[0];
      if (autoAllowed(item.request)) {
        queue.shift();
        item.resolve('allow');
        continue;
      }
      // The token is made when the card opens: valid for this request only, once.
      turn.card = { ...item.card, token: randomBytes(16).toString('hex') };
    }
  }

  const turn = {
    activity: [],
    card: null,
    signal: controller.signal,
    running: false, // true while `claude` runs (the thinking step)
    ask(request, card) {
      return new Promise((resolve) => {
        queue.push({ request, card: { requestId: request.requestId, toolName: request.toolName, ...card }, resolve });
        next();
      });
    },
    // -> 'ok' | 'not_found' | 'forbidden'
    async answer(requestId, token, decision) {
      if (answered.has(requestId)) return 'forbidden';
      if (!turn.card || turn.card.requestId !== requestId) return 'not_found';
      if (!sameToken(token, turn.card.token)) return 'forbidden';
      answered.add(requestId);
      const item = queue.shift();
      turn.card = null;
      const saved = decision === 'allow_chat' ? allowChat(item.request) : null;
      item.resolve(decision === 'deny' ? 'deny' : 'allow');
      next();
      await saved;
      return 'ok';
    },
    // Denies every open or queued request, then stops `claude`.
    stop() {
      for (const item of queue.splice(0)) {
        answered.add(item.request.requestId);
        item.resolve('deny');
      }
      turn.card = null;
      controller.abort();
    },
  };
  return turn;
}

class TranslateError extends Error {}

// Resolves to the translation, or to null when the model kept returning
// something other than a translation (the caller then falls back).
async function translate(translator, text, src, tgt, maxChars) {
  try {
    return await translateText(translator, text, src, tgt, { maxChars });
  } catch (err) {
    if (err instanceof NotTranslatedError) return null;
    throw new TranslateError(err?.message ?? String(err));
  }
}

function errorOf(err) {
  if (err instanceof TranslateError) return { kind: 'failed', message: TRANSLATE_FAILED };
  if (['cli_missing', 'not_logged_in', 'timeout', 'failed', 'model_rejected', 'folder_missing'].includes(err?.kind)) {
    return { kind: err.kind, message: err.message || TURN_FAILED };
  }
  return { kind: 'failed', message: TURN_FAILED };
}

// The send mode of a turn when the caller passes none: the setting, or
// 'translate' when no settings store is injected (tests, older callers).
export function sendModeOf(deps) {
  return deps.settings ? deps.settings.get().sendMode ?? 'direct' : 'translate';
}

// Runs steps 3-7 for the chat's last (user) message. The caller has already
// set the chat's pending entry; it is always cleared here. Never rejects.
// mode: 'direct' (sent as typed, nothing translated) or 'translate'; the
// routes pass the mode they read, so a later switch never changes this turn.
// deps: { chatStore, modelManager, detect, runner, pending, settings?, maxChars? }
export async function runTurn(deps, chat, message, mode = sendModeOf(deps)) {
  const { chatStore, modelManager, detect, runner, pending, settings, maxChars = MAX_CHARS } = deps;
  const id = chat.id;
  const direct = mode === 'direct';
  // Restored on failure so a failed final save leaves no answer and the old
  // session, unless the stream already gave a new one: that session holds
  // what Claude did, so a retry resumes it.
  const before = { count: chat.messages.length, sessionId: chat.sessionId, lang: chat.lang };
  let model = 'default';
  let streamedSession = null;
  // Saves made while the turn runs (session id, chat rules) go one at a time.
  let saving = Promise.resolve();
  const persist = () => {
    saving = saving.then(() => chatStore.save(chat)).catch((err) => console.error(`could not save chat ${id}:`, err));
    return saving;
  };
  const turn = createTurn({
    answered: pending.answered(id),
    autoAllowed: (req) => isAutoAllowed(chat.permissions, req.toolName, req.input),
    allowChat: (req) => {
      const rule = ruleFor(req.toolName, req.input);
      if (!rule) return Promise.resolve();
      if (!Array.isArray(chat.permissions)) chat.permissions = [];
      if (!chat.permissions.some((r) => sameRule(r, rule))) chat.permissions.push(rule);
      return persist();
    },
  });
  pending.begin(id, turn);
  try {
    pending.set(id, direct ? 'thinking' : 'translating');
    // Every call goes through the manager's queue, so a size switch during
    // this turn is picked up by the calls that run after it.
    const translator = { translate: (text, src, tgt) => modelManager.translate(text, src, tgt) };
    // Direct: no detection, Claude reads and answers the text as typed.
    const detected = direct ? { kind: 'direct' } : detect(message.original);
    const supported = detected.kind !== 'unsupported';
    let lang = null;
    if (detected.kind === 'ok') lang = detected.lang;
    else if (!direct && detected.kind !== 'unsupported') lang = chat.lang ?? ENGLISH;
    const foreign = !direct && supported && lang !== ENGLISH;

    const notes = [];
    let english = message.original;
    if (foreign) {
      // Not translatable: Claude gets the text as typed (it reads every language).
      english = await translate(translator, message.original, lang, ENGLISH, maxChars);
      if (english === null) {
        english = message.original;
        notes.push(NOT_TRANSLATED_NOTE);
      }
    }

    message.lang = lang;
    message.english = direct ? null : english;
    if (direct) message.mode = 'direct';

    pending.set(id, 'thinking');
    turn.running = true;
    model = settings?.get().claudeModel ?? 'default';
    let answer;
    try {
      answer = await runner.run({
        prompt: english,
        sessionId: chat.sessionId ?? null,
        model,
        folder: chat.folder ?? null,
        signal: turn.signal,
        onSession: (sessionId) => {
          streamedSession = sessionId;
          chat.sessionId = sessionId;
          persist();
        },
        onActivity: (line) => { turn.activity.push(line); },
        // Activity lines and cards are fixed Thai templates with the English
        // detail: never translated, so they never wait on the translator.
        onPermission: (req) => {
          if (isAutoAllowed(chat.permissions, req.toolName, req.input)) return 'allow';
          // onceOnly: "อนุญาตตลอดในแชตนี้" would store no rule (a Bash command with shell operators).
          return turn.ask(req, { ...cardText(req.toolName, req.input), onceOnly: ruleFor(req.toolName, req.input) === null });
        },
      });
    } finally {
      turn.running = false;
    }

    // Back to this message's language; English and unsupported are shown as is.
    let shown = answer.text;
    if (foreign && answer.text) {
      pending.set(id, 'translating_back');
      shown = await translate(translator, answer.text, ENGLISH, lang, maxChars);
      if (shown === null) {
        shown = answer.text;
        notes.push(ANSWER_NOT_TRANSLATED_NOTE);
      }
    }

    delete message.error;
    if (detected.kind === 'ok') chat.lang = lang;
    // A direct reply keeps no English text: the UI shows no original for it.
    const reply = direct
      ? { id: newId(), role: 'assistant', original: shown, mode: 'direct', lang: null, createdAt: new Date().toISOString() }
      : {
        id: newId(),
        role: 'assistant',
        original: shown,
        english: answer.text,
        lang: supported ? lang : ENGLISH,
        createdAt: new Date().toISOString(),
      };
    // Which model answered, and which one was asked for (see answeredByLabel).
    if (answer.model) {
      reply.model = answer.model;
      reply.requestedModel = model;
    }
    if (!supported) notes.push(UNSUPPORTED_NOTE);
    if (notes.length) reply.note = notes.join(' ');
    if (turn.activity.length) reply.activity = turn.activity.map((line) => ({ ...line }));
    if (answer.stopped) reply.stopped = true;
    chat.messages.push(reply);
    chat.sessionId = answer.sessionId ?? streamedSession ?? chat.sessionId ?? null;
    await saving;
    await chatStore.save(chat);
  } catch (err) {
    if (!(err?.kind)) console.error(`turn failed in chat ${id}:`, err);
    chat.messages.length = before.count;
    chat.sessionId = streamedSession ?? before.sessionId;
    chat.lang = before.lang;
    message.error = errorOf(err);
    // Keep the previous selection when Claude refuses the picked model.
    if (err?.kind === 'model_rejected') {
      try {
        await settings?.revertClaudeModel?.(model);
      } catch (revertErr) {
        console.error('could not restore the previous Claude model:', revertErr);
      }
    }
    try {
      await saving;
      await chatStore.save(chat);
    } catch (saveErr) {
      console.error(`could not save error for chat ${id}:`, saveErr);
    }
  } finally {
    pending.clear(id);
  }
}

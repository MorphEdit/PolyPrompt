// Send/retry pipeline: detect -> translate -> Claude -> translate back -> save.
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

// In-memory registry chatId -> 'translating' | 'thinking' | 'translating_back'.
export function createPending() {
  const steps = new Map();
  return {
    get: (chatId) => steps.get(chatId) ?? null,
    set: (chatId, step) => { steps.set(chatId, step); },
    clear: (chatId) => { steps.delete(chatId); },
  };
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
  if (['cli_missing', 'not_logged_in', 'timeout', 'failed'].includes(err?.kind)) {
    return { kind: err.kind, message: err.message || TURN_FAILED };
  }
  return { kind: 'failed', message: TURN_FAILED };
}

// Runs steps 3-7 for the chat's last (user) message. The caller has already
// set the chat's pending entry; it is always cleared here. Never rejects.
// deps: { chatStore, modelManager, detect, runner, pending, settings?, maxChars? }
export async function runTurn(deps, chat, message) {
  const { chatStore, modelManager, detect, runner, pending, settings, maxChars = MAX_CHARS } = deps;
  const id = chat.id;
  // Restored on failure so a failed final save leaves no answer and the old session.
  const before = { count: chat.messages.length, sessionId: chat.sessionId, lang: chat.lang };
  try {
    pending.set(id, 'translating');
    // Every call goes through the manager's queue, so a size switch during
    // this turn is picked up by the calls that run after it.
    const translator = { translate: (text, src, tgt) => modelManager.translate(text, src, tgt) };
    const detected = detect(message.original);
    const supported = detected.kind !== 'unsupported';
    let lang = null;
    if (detected.kind === 'ok') lang = detected.lang;
    else if (detected.kind !== 'unsupported') lang = chat.lang ?? ENGLISH;
    const foreign = supported && lang !== ENGLISH;

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
    message.english = english;

    pending.set(id, 'thinking');
    const model = settings?.get().claudeModel ?? 'default';
    const answer = await runner.run({ prompt: english, sessionId: chat.sessionId ?? null, model });

    // Back to this message's language; English and unsupported are shown as is.
    let shown = answer.text;
    if (foreign) {
      pending.set(id, 'translating_back');
      shown = await translate(translator, answer.text, ENGLISH, lang, maxChars);
      if (shown === null) {
        shown = answer.text;
        notes.push(ANSWER_NOT_TRANSLATED_NOTE);
      }
    }

    delete message.error;
    if (detected.kind === 'ok') chat.lang = lang;
    const reply = {
      id: newId(),
      role: 'assistant',
      original: shown,
      english: answer.text,
      lang: supported ? lang : ENGLISH,
      createdAt: new Date().toISOString(),
    };
    if (!supported) notes.push(UNSUPPORTED_NOTE);
    if (notes.length) reply.note = notes.join(' ');
    chat.messages.push(reply);
    chat.sessionId = answer.sessionId ?? chat.sessionId ?? null;
    await chatStore.save(chat);
  } catch (err) {
    if (!(err?.kind)) console.error(`turn failed in chat ${id}:`, err);
    chat.messages.length = before.count;
    chat.sessionId = before.sessionId;
    chat.lang = before.lang;
    message.error = errorOf(err);
    try {
      await chatStore.save(chat);
    } catch (saveErr) {
      console.error(`could not save error for chat ${id}:`, saveErr);
    }
  } finally {
    pending.clear(id);
  }
}

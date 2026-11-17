// Send/retry pipeline: detect -> translate -> Claude -> translate back -> save.
import { newId } from './store.js';
import { translateText } from './text.js';

export const ENGLISH = 'eng_Latn';
export const UNSUPPORTED_NOTE = 'ภาษานี้ยังไม่รองรับการแปล จึงแสดงคำตอบเป็นภาษาอังกฤษ';
export const TRANSLATE_FAILED = 'แปลข้อความไม่สำเร็จ กรุณาลองส่งใหม่';
export const TURN_FAILED = 'เกิดข้อผิดพลาด กรุณาลองส่งใหม่';

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

async function translate(translator, text, src, tgt, maxChars) {
  try {
    return await translateText(translator, text, src, tgt, { maxChars });
  } catch (err) {
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
// deps: { chatStore, modelManager, detect, runner, pending, maxChars? }
export async function runTurn(deps, chat, message) {
  const { chatStore, modelManager, detect, runner, pending, maxChars = 500 } = deps;
  const id = chat.id;
  try {
    pending.set(id, 'translating');
    const translator = modelManager.translator();
    const detected = detect(message.original);
    const supported = detected.kind !== 'unsupported';
    let lang = null;
    if (detected.kind === 'ok') lang = detected.lang;
    else if (detected.kind !== 'unsupported') lang = chat.lang ?? ENGLISH;
    const foreign = supported && lang !== ENGLISH;

    const english = foreign
      ? await translate(translator, message.original, lang, ENGLISH, maxChars)
      : message.original;

    message.lang = lang;
    message.english = english;

    pending.set(id, 'thinking');
    const answer = await runner.run({ prompt: english, sessionId: chat.sessionId ?? null });

    // Back to this message's language; English and unsupported are shown as is.
    let shown = answer.text;
    if (foreign) {
      pending.set(id, 'translating_back');
      shown = await translate(translator, answer.text, ENGLISH, lang, maxChars);
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
    if (!supported) reply.note = UNSUPPORTED_NOTE;
    chat.messages.push(reply);
    chat.sessionId = answer.sessionId ?? chat.sessionId ?? null;
    await chatStore.save(chat);
  } catch (err) {
    if (!(err?.kind)) console.error(`turn failed in chat ${id}:`, err);
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

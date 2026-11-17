import {
  keyAction, canSend, stepLabel, formatProgress, apiErrorMessage, canRetry,
  lastMessageHasError, renderMarkdown,
} from './logic.js';

const POLL_MS = 1000;

const $ = (id) => document.getElementById(id);
const els = {
  newChat: $('new-chat'),
  chatList: $('chat-list'),
  modelBanner: $('model-banner'),
  errorBanner: $('error-banner'),
  messages: $('messages'),
  statusLine: $('status-line'),
  composer: $('composer'),
  input: $('input'),
  send: $('send'),
};

const state = {
  model: { state: 'loading', progress: 0, error: null },
  chats: [],
  chat: null, // the open chat (with pendingStep), or null for a new chat
  busy: false, // a send/retry request is in flight
};

let chatPollTimer = null;
let statusPollTimer = null;

class ApiError extends Error {
  constructor(status) {
    super(apiErrorMessage(status));
    this.status = status;
  }
}

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0);
  }
  if (!res.ok) throw new ApiError(res.status);
  return res.status === 204 ? null : res.json();
}

function showError(err) {
  els.errorBanner.textContent = err ? (err instanceof ApiError ? err.message : apiErrorMessage(0)) : '';
  els.errorBanner.hidden = !err;
}

const isPending = () => state.busy || state.chat?.pendingStep != null;

function updateComposer() {
  els.send.disabled = !canSend({
    text: els.input.value,
    pending: isPending(),
    modelState: state.model.state,
    lastMessageHasError: lastMessageHasError(state.chat),
  });
  const step = state.chat?.pendingStep;
  const label = step != null ? stepLabel(step) : state.busy ? 'กำลังส่ง…' : '';
  els.statusLine.textContent = label;
  els.statusLine.hidden = !label;
}

// ---- model status ----

function renderModel() {
  const { state: s, progress, error } = state.model;
  const b = els.modelBanner;
  b.replaceChildren();
  b.hidden = s === 'ready';
  b.classList.toggle('banner-error', s === 'error');
  if (s === 'loading') {
    const text = document.createElement('span');
    text.textContent = `กำลังโหลดโมเดลแปลภาษา… ${formatProgress(progress)} (ครั้งแรกจะดาวน์โหลดประมาณ 1 GB)`;
    const bar = document.createElement('div');
    bar.className = 'progress';
    const fill = document.createElement('div');
    fill.style.width = formatProgress(progress);
    bar.append(fill);
    b.append(text, bar);
  } else if (s === 'error') {
    const text = document.createElement('span');
    text.textContent = `โหลดโมเดลแปลภาษาไม่สำเร็จ: ${error ?? ''}`;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'ลองใหม่';
    retry.addEventListener('click', retryModel);
    b.append(text, retry);
  }
  updateComposer();
}

async function loadStatus() {
  clearTimeout(statusPollTimer);
  try {
    const { model } = await api('GET', '/api/status');
    state.model = model;
    renderModel();
  } catch (err) {
    showError(err);
  }
  if (state.model.state !== 'ready') statusPollTimer = setTimeout(loadStatus, POLL_MS);
}

async function retryModel() {
  try {
    await api('POST', '/api/model/retry');
    showError(null);
  } catch (err) {
    showError(err);
  }
  loadStatus();
}

// ---- sidebar ----

function renderChatList() {
  els.chatList.replaceChildren(...state.chats.map((c) => {
    const li = document.createElement('li');
    li.className = 'chat-item';
    li.classList.toggle('active', c.id === state.chat?.id);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'chat-title';
    open.textContent = c.title || 'แชทไม่มีชื่อ';
    open.title = c.title;
    open.addEventListener('click', () => openChat(c.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'chat-delete';
    del.textContent = '✕';
    del.title = 'ลบแชท';
    del.setAttribute('aria-label', 'ลบแชท');
    del.addEventListener('click', () => deleteChat(c));
    li.append(open, del);
    return li;
  }));
}

async function loadChats() {
  try {
    const chats = await api('GET', '/api/chats');
    state.chats = [...chats].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    renderChatList();
  } catch (err) {
    showError(err);
  }
}

async function deleteChat(c) {
  if (!confirm(`ลบแชท "${c.title}" หรือไม่?`)) return;
  try {
    await api('DELETE', `/api/chats/${encodeURIComponent(c.id)}`);
    showError(null);
    if (state.chat?.id === c.id) newChat();
  } catch (err) {
    showError(err);
  }
  loadChats();
}

// ---- conversation ----

function translationBlock(summaryText, body) {
  const details = document.createElement('details');
  details.className = 'translation';
  const summary = document.createElement('summary');
  summary.textContent = summaryText;
  details.append(summary, body);
  body.classList.add('translation-body');
  return details;
}

function renderMessage(m, index, messages) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${m.role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  wrap.append(bubble);
  if (m.role === 'user') {
    bubble.textContent = m.original;
    if (m.english && m.english !== m.original) {
      const body = document.createElement('div');
      body.textContent = m.english;
      wrap.append(translationBlock('ดูคำแปลภาษาอังกฤษ', body));
    }
    if (m.error) {
      const err = document.createElement('div');
      err.className = 'msg-error';
      const text = document.createElement('span');
      text.textContent = m.error.message;
      err.append(text);
      if (canRetry(messages, index)) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = 'ส่งใหม่';
        retry.disabled = isPending() || state.model.state !== 'ready';
        retry.addEventListener('click', () => retryMessage(m.id));
        err.append(retry);
      }
      wrap.append(err);
    }
  } else {
    // renderMarkdown escapes all HTML in Claude's (untrusted) text.
    bubble.innerHTML = renderMarkdown(m.original);
    if (m.english && m.english !== m.original) {
      const body = document.createElement('div');
      body.innerHTML = renderMarkdown(m.english);
      wrap.append(translationBlock('ดูต้นฉบับภาษาอังกฤษ', body));
    }
    if (m.note) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = m.note;
      wrap.append(note);
    }
  }
  return wrap;
}

function renderChat() {
  const atBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 40;
  const messages = state.chat?.messages ?? [];
  if (messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'วันนี้ให้ช่วยอะไรดี?';
    els.messages.replaceChildren(empty);
  } else {
    els.messages.replaceChildren(...messages.map(renderMessage));
  }
  if (atBottom) els.messages.scrollTop = els.messages.scrollHeight;
  renderChatList();
  updateComposer();
}

function schedulePoll() {
  clearTimeout(chatPollTimer);
  if (state.chat?.pendingStep == null) return;
  const id = state.chat.id;
  chatPollTimer = setTimeout(() => refreshChat(id), POLL_MS);
}

async function refreshChat(id) {
  try {
    const chat = await api('GET', `/api/chats/${encodeURIComponent(id)}`);
    if (state.chat?.id !== id) return; // the user opened another chat meanwhile
    const wasPending = state.chat?.pendingStep != null;
    state.chat = chat;
    renderChat();
    if (wasPending && chat.pendingStep == null) loadChats();
  } catch (err) {
    if (state.chat?.id === id) showError(err);
  }
  if (state.chat?.id === id) schedulePoll();
}

async function openChat(id) {
  clearTimeout(chatPollTimer);
  showError(null);
  try {
    state.chat = await api('GET', `/api/chats/${encodeURIComponent(id)}`);
    els.messages.scrollTop = 0;
    renderChat();
    els.messages.scrollTop = els.messages.scrollHeight;
    schedulePoll();
  } catch (err) {
    showError(err);
    if (err.status === 404) loadChats();
  }
}

function newChat() {
  clearTimeout(chatPollTimer);
  state.chat = null;
  showError(null);
  renderChat();
  els.input.focus();
}

async function send() {
  updateComposer();
  if (els.send.disabled) return;
  const text = els.input.value;
  const chatId = state.chat?.id;
  state.busy = true;
  updateComposer();
  try {
    const res = await api('POST', '/api/messages', chatId ? { chatId, text } : { text });
    els.input.value = '';
    showError(null);
    state.chat = state.chat ?? { id: res.chatId, messages: [], pendingStep: null };
    await refreshChat(res.chatId);
    loadChats();
  } catch (err) {
    showError(err);
    if (err.status === 503) loadStatus();
  } finally {
    state.busy = false;
    updateComposer();
    autoGrow();
  }
}

async function retryMessage(messageId) {
  const id = state.chat?.id;
  if (!id || isPending()) return;
  state.busy = true;
  renderChat();
  try {
    await api('POST', `/api/chats/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/retry`);
    showError(null);
    await refreshChat(id);
  } catch (err) {
    showError(err);
    if (err.status === 503) loadStatus();
  } finally {
    state.busy = false;
    if (state.chat?.id === id) renderChat();
  }
}

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = `${els.input.scrollHeight}px`;
}

els.newChat.addEventListener('click', newChat);
els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});
els.input.addEventListener('keydown', (e) => {
  const action = keyAction({ key: e.key, shiftKey: e.shiftKey, isComposing: e.isComposing || e.keyCode === 229 });
  if (action === 'send') {
    e.preventDefault();
    send();
  }
});
els.input.addEventListener('input', () => {
  autoGrow();
  updateComposer();
});

renderChat();
renderModel();
loadStatus();
loadChats();

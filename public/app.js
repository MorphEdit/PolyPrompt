import {
  keyAction, canSend, stepLabel, formatProgress, apiErrorMessage, canRetry,
  retryEnabled, lastMessageHasError, renderMarkdown, SIZE_OPTIONS, CLAUDE_OPTIONS, formatGB,
  pickerLabel, pickerDisabled, answeredByLabel, sizeOptionsDisabled, sizePickAction, confirmDownloadText, sizeOptionNote,
  STOPPED_NOTE, TRUNCATED_NOTE, ONCE_ONLY_HINT, cardDecisions, canStop, currentFolder, canPickFolder, sendBody,
  sessionProgress, shortDate, nextTheme, themeToggleLabel, themeToggleIcon, loadTheme, saveTheme,
  modelBannerShown, SEND_MODE_OPTIONS, SIZES_DIRECT_HINT, showsEnglish,
} from './logic.js';

const POLL_MS = 1000;

const $ = (id) => document.getElementById(id);
const els = {
  newChat: $('new-chat'),
  chatList: $('chat-list'),
  modelBanner: $('model-banner'),
  switchBanner: $('switch-banner'),
  picker: $('picker'),
  pickerMenu: $('picker-menu'),
  errorBanner: $('error-banner'),
  messages: $('messages'),
  statusLine: $('status-line'),
  composer: $('composer'),
  input: $('input'),
  send: $('send'),
  stop: $('stop'),
  folderLabel: $('folder-label'),
  folderButton: $('folder-button'),
  oldSessionsLabel: $('old-sessions-label'),
  oldSessions: $('old-sessions'),
  folderDialog: $('folder-dialog'),
  folderPath: $('folder-path'),
  folderError: $('folder-error'),
  folderList: $('folder-list'),
  folderCancel: $('folder-cancel'),
  folderChoose: $('folder-choose'),
  themeToggle: $('theme-toggle'),
};

const state = {
  model: { state: 'loading', progress: 0, error: null, size: '4b' },
  switch: null, // background download of another translator size, or a failed one
  settings: null, // { translatorSize, claudeModel, downloadedSizes }
  pickerError: null,
  chats: [],
  chat: null, // the open chat (with pendingStep), or null for a new chat
  busy: false, // a send/retry request is in flight
  pendingFolder: null, // folder picked for the new chat; sent with its first message
  session: null, // an opened old Claude Code session { id, folder, messages, done, total, note? }
  oldSessions: [], // old Claude Code sessions of the current folder
  oldSessionsFolder: null, // the folder oldSessions belong to
  folderView: null, // what the folder picker shows: { path, parent, home, folders }
  answering: false, // a permission answer or stop is in flight
};

let chatPollTimer = null;
let sessionPollTimer = null;
let retryButton = null; // the "ส่งใหม่" button of the open chat, if any
// Keyed rendering (#52): a poll touches only what changed, so a waiting card's
// buttons, open <details> and text selections stay in place.
const messageViews = new Map(); // key -> { sig, el, retry }
let liveView = null; // { chatId, wrap, activity: { box, summary, lines }, card: { key, el, buttons } }
let emptyEl = null;
let sessionNoteEl = null;
let statusPollTimer = null;

class ApiError extends Error {
  constructor(status, serverMessage) {
    super(apiErrorMessage(status, serverMessage));
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
  if (!res.ok) {
    let message;
    try {
      message = (await res.json())?.error;
    } catch {}
    throw new ApiError(res.status, message);
  }
  return res.status === 204 ? null : res.json();
}

function showError(err) {
  els.errorBanner.textContent = err ? (err instanceof ApiError ? err.message : apiErrorMessage(0)) : '';
  els.errorBanner.hidden = !err;
}

const isPending = () => state.busy || state.chat?.pendingStep != null;

function updateComposer() {
  const sendMode = state.settings?.sendMode;
  els.send.disabled = !canSend({
    text: els.input.value,
    pending: isPending(),
    modelState: state.model.state,
    lastMessageHasError: lastMessageHasError(state.chat),
    sendMode,
  });
  // The model state can change without a re-render of the chat (status poll),
  // so the retry button's state is kept in sync here too.
  if (retryButton) retryButton.disabled = !retryEnabled({ pending: isPending(), modelState: state.model.state, sendMode });
  // Direct mode needs no translator: its banner shows only for an old
  // session still waiting for its translation.
  const sessionWaiting = !!state.session && state.session.done < state.session.total;
  els.modelBanner.hidden = state.model.state === 'ready' || !modelBannerShown({ sendMode, sessionWaiting });
  renderPicker();
  els.stop.hidden = !canStop(state.chat);
  els.stop.disabled = state.answering;
  const step = state.chat?.pendingStep;
  const label = step != null ? stepLabel(step) : state.busy ? 'กำลังส่ง…' : sessionProgress(state.session ?? {});
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
    const size = SIZE_OPTIONS.find((o) => o.value === state.model.size) ?? SIZE_OPTIONS[0];
    text.textContent = `กำลังโหลดโมเดลแปลภาษา ${size.label}… ${formatProgress(progress)} (ครั้งแรกจะดาวน์โหลดประมาณ ${formatGB(size.bytes)})`;
    const bar = document.createElement('div');
    bar.className = 'progress';
    const fill = document.createElement('div');
    fill.style.width = formatProgress(progress);
    bar.append(fill);
    b.append(text, bar);
  } else if (s === 'error') {
    const text = document.createElement('span');
    text.textContent = error || 'โหลดโมเดลแปลภาษาไม่สำเร็จ';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'ลองใหม่';
    retry.addEventListener('click', retryModel);
    b.append(text, retry);
  }
  renderSwitch();
  updateComposer();
}

// Progress of a background download of another translator size.
function renderSwitch() {
  const sw = state.switch;
  const b = els.switchBanner;
  b.replaceChildren();
  b.hidden = sw?.state !== 'downloading';
  if (b.hidden) return;
  const size = SIZE_OPTIONS.find((o) => o.value === sw.size);
  const text = document.createElement('span');
  text.textContent = `กำลังดาวน์โหลดโมเดลแปลภาษา ${size?.label ?? sw.size}… ${formatProgress(sw.progress)} (ใช้ตัวแปลเดิมไปก่อนได้)`;
  const bar = document.createElement('div');
  bar.className = 'progress';
  const fill = document.createElement('div');
  fill.style.width = formatProgress(sw.progress);
  bar.append(fill);
  b.append(text, bar);
}

async function loadStatus() {
  clearTimeout(statusPollTimer);
  const before = `${state.model.state}/${state.model.size}/${state.switch?.state}`;
  try {
    const status = await api('GET', '/api/status');
    state.model = status.model;
    state.switch = status.switch ?? null;
    renderModel();
  } catch (err) {
    showError(err);
  }
  // A finished load or download changes the saved size and downloaded sizes.
  if (before !== `${state.model.state}/${state.model.size}/${state.switch?.state}`) loadSettings();
  if (state.model.state !== 'ready' || state.switch?.state === 'downloading') {
    statusPollTimer = setTimeout(loadStatus, POLL_MS);
  }
}

// ---- model picker ----

async function loadSettings() {
  try {
    state.settings = await api('GET', '/api/settings');
    updateComposer();
  } catch (err) {
    showError(err);
  }
}

function pickerOption({ name, hint, note, selected, disabled, onPick }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'picker-option';
  b.classList.toggle('selected', selected);
  b.disabled = disabled;
  const n = document.createElement('span');
  n.className = 'picker-name';
  n.textContent = note ? `${name} · ${note}` : name;
  const h = document.createElement('span');
  h.className = 'picker-hint';
  h.textContent = hint;
  b.append(n, h);
  b.addEventListener('click', onPick);
  return b;
}

function sectionTitle(text) {
  const t = document.createElement('div');
  t.className = 'picker-section';
  t.textContent = text;
  return t;
}

function renderPicker() {
  const settings = state.settings;
  const disabled = !settings || pickerDisabled({ pending: isPending() });
  els.picker.disabled = disabled;
  els.picker.textContent = settings ? pickerLabel(settings) : 'โมเดล';
  if (disabled) closePicker();
  if (!settings) return;
  const direct = settings.sendMode === 'direct';
  const sizesOff = sizeOptionsDisabled({
    pending: isPending(), modelState: state.model.state, switchState: state.switch?.state, sendMode: settings.sendMode,
  });
  const loaded = state.model.state === 'ready' ? state.model.size : settings.translatorSize;
  const items = [];
  // An older server sends no sendMode: no send-mode section then.
  if (settings.sendMode) {
    items.push(sectionTitle('การส่ง'));
    for (const o of SEND_MODE_OPTIONS) {
      const option = pickerOption({
        name: o.label,
        hint: o.hint,
        selected: o.value === settings.sendMode,
        disabled: false,
        onPick: () => (o.value === settings.sendMode ? closePicker() : saveSettings({ sendMode: o.value })),
      });
      option.className = 'picker-option picker-mode';
      items.push(option);
    }
  }
  items.push(sectionTitle('ตัวแปลภาษา'));
  for (const o of SIZE_OPTIONS) {
    items.push(pickerOption({
      name: o.label,
      hint: direct ? SIZES_DIRECT_HINT : o.hint,
      note: sizeOptionNote(o.value, settings.downloadedSizes),
      selected: o.value === loaded,
      disabled: sizesOff,
      onPick: () => pickSize(o.value),
    }));
  }
  const error = state.pickerError ?? (state.switch?.state === 'failed' ? state.switch.error : null);
  if (error) {
    const e = document.createElement('div');
    e.className = 'picker-error';
    e.textContent = error;
    items.push(e);
  }
  items.push(sectionTitle('Claude'));
  for (const o of CLAUDE_OPTIONS) {
    items.push(pickerOption({
      name: o.label,
      hint: o.hint,
      selected: o.value === settings.claudeModel,
      disabled: false,
      onPick: () => saveSettings({ claudeModel: o.value }),
    }));
  }
  els.pickerMenu.replaceChildren(...items);
}

function closePicker() {
  els.pickerMenu.hidden = true;
  els.picker.setAttribute('aria-expanded', 'false');
}

function togglePicker() {
  if (els.picker.disabled) return;
  const open = els.pickerMenu.hidden;
  els.pickerMenu.hidden = !open;
  els.picker.setAttribute('aria-expanded', String(open));
}

async function saveSettings(patch) {
  closePicker();
  state.pickerError = null;
  try {
    state.settings = await api('PUT', '/api/settings', patch);
  } catch (err) {
    state.pickerError = err.status === 409
      ? 'กำลังเปลี่ยนโมเดลแปลภาษาอยู่ กรุณารอสักครู่'
      : err.message;
  }
  updateComposer();
  // Translate mode starts the translator load: show its progress.
  if (patch.translatorSize || patch.sendMode) loadStatus();
}

function pickSize(size) {
  const action = sizePickAction({ size, model: state.model, downloadedSizes: state.settings?.downloadedSizes });
  if (action === 'none') return closePicker();
  if (action === 'confirm' && !confirm(confirmDownloadText(size))) return closePicker();
  saveSettings({ translatorSize: size });
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

// ---- theme ----

const storage = () => localStorage;
let theme = loadTheme(storage);

function applyTheme() {
  document.documentElement?.setAttribute('data-theme', theme);
  els.themeToggle.textContent = themeToggleIcon(theme);
  els.themeToggle.title = themeToggleLabel(theme);
  els.themeToggle.setAttribute('aria-label', themeToggleLabel(theme));
}

function toggleTheme() {
  theme = nextTheme(theme);
  saveTheme(storage, theme);
  applyTheme();
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
    if (showsEnglish(m)) {
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
        retryButton = retry;
        retry.addEventListener('click', () => retryMessage(m.id));
        err.append(retry);
      }
      wrap.append(err);
    }
  } else {
    // renderMarkdown escapes all HTML in Claude's (untrusted) text.
    bubble.innerHTML = renderMarkdown(m.original);
    bubble.hidden = !m.original;
    if (showsEnglish(m)) {
      const body = document.createElement('div');
      body.innerHTML = renderMarkdown(m.english);
      wrap.append(translationBlock('ดูต้นฉบับภาษาอังกฤษ', body));
    }
    if (m.activity?.length) wrap.append(activityBlock(m.activity, false));
    for (const text of [m.note, m.stopped ? STOPPED_NOTE : null]) {
      if (!text) continue;
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = text;
      wrap.append(note);
    }
    const by = answeredByLabel(m);
    if (by) {
      const meta = document.createElement('div');
      meta.className = 'answered-by';
      meta.textContent = by;
      wrap.append(meta);
    }
  }
  return wrap;
}

// Sets parent's children to items, touching the DOM only where they differ.
function syncChildren(parent, items) {
  const current = Array.from(parent.children);
  if (current.length <= items.length && current.every((c, i) => c === items[i])) {
    if (items.length > current.length) parent.append(...items.slice(current.length));
    return;
  }
  parent.replaceChildren(...items);
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

const isDetails = (el) => el.tagName?.toLowerCase() === 'details';

function detailsIn(el, out = []) {
  if (isDetails(el)) out.push(el);
  for (const c of Array.from(el.children ?? [])) detailsIn(c, out);
  return out;
}

// A re-rendered element keeps the open/closed state the user gave its <details>.
function keepOpen(from, to) {
  const before = detailsIn(from);
  detailsIn(to).forEach((d, i) => {
    if (before[i]?.className === d.className) d.open = before[i].open;
  });
}

const activitySummary = (count) => `กิจกรรมของ Claude (${count})`;

// Activity lines: fixed Thai text, with the raw English detail and the tool
// output (collapsed) inside. Nothing here is translated.
function activityBlock(lines, open) {
  const box = document.createElement('details');
  box.className = 'activity';
  box.open = open;
  const summary = document.createElement('summary');
  summary.textContent = activitySummary(lines.length);
  box.append(summary, ...lines.map(activityLine));
  return box;
}

function activityLine(line) {
  const item = document.createElement('details');
  item.className = 'activity-line';
  const head = document.createElement('summary');
  head.textContent = line.text;
  const detail = document.createElement('pre');
  detail.textContent = line.detail ?? '';
  item.append(head, detail);
  if (line.output) {
    const output = document.createElement('details');
    output.className = 'activity-output';
    const label = document.createElement('summary');
    label.textContent = 'ผลลัพธ์';
    const body = document.createElement('pre');
    body.textContent = line.output;
    output.append(label, body);
    if (line.truncated) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = TRUNCATED_NOTE;
      output.append(note);
    }
    item.append(output);
  }
  return item;
}

// The open permission card: Thai text, the exact English action, three buttons.
function cardBlock(card) {
  const box = document.createElement('div');
  box.className = 'permission-card';
  const text = document.createElement('div');
  text.className = 'permission-text';
  text.textContent = card.text;
  const detail = document.createElement('pre');
  detail.className = 'permission-detail';
  detail.textContent = card.detail;
  const actions = document.createElement('div');
  actions.className = 'permission-actions';
  const buttons = [];
  for (const { decision, label } of cardDecisions(card)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `permission-${decision}`;
    b.textContent = label;
    b.disabled = state.answering;
    b.addEventListener('click', () => answerCard(card, decision));
    actions.append(b);
    buttons.push(b);
  }
  box.append(text, detail);
  if (card.onceOnly) {
    const hint = document.createElement('div');
    hint.className = 'note permission-hint';
    hint.textContent = ONCE_ONLY_HINT;
    box.append(hint);
  }
  box.append(actions);
  return { el: box, buttons };
}

// A message's element, reused while its data is unchanged.
function messageEl(m, index, messages, key) {
  const sig = JSON.stringify([m, Boolean(m.error) && canRetry(messages, index)]);
  const old = messageViews.get(key);
  if (old?.sig === sig) {
    retryButton = old.retry ?? retryButton;
    return old.el;
  }
  const before = retryButton;
  retryButton = null;
  const view = { sig, el: renderMessage(m, index, messages), retry: retryButton };
  retryButton = retryButton ?? before;
  if (old) keepOpen(old.el, view.el);
  messageViews.set(key, view);
  return view.el;
}

// The turn in progress: one element per chat, updated in place. New activity
// lines are appended and the card is rebuilt only when another one opens.
function liveBlock(live, chatId) {
  if (liveView?.chatId !== chatId) {
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant live';
    liveView = { chatId, wrap, activity: null, card: null };
  }
  const items = [];
  if (live.activity.length) {
    if (!liveView.activity) {
      const box = activityBlock([], true);
      liveView.activity = { box, summary: box.children[0], lines: [] };
    }
    const view = liveView.activity;
    setText(view.summary, activitySummary(live.activity.length));
    view.lines = live.activity.map((line, i) => {
      const sig = JSON.stringify(line);
      const old = view.lines[i];
      if (old?.sig === sig) return old;
      const el = activityLine(line);
      if (old) keepOpen(old.el, el);
      return { sig, el };
    });
    syncChildren(view.box, [view.summary, ...view.lines.map((l) => l.el)]);
    items.push(view.box);
  } else {
    liveView.activity = null;
  }
  if (live.card) {
    const key = `${live.card.requestId}\n${live.card.token}`;
    if (liveView.card?.key !== key) liveView.card = { key, ...cardBlock(live.card) };
    for (const b of liveView.card.buttons) if (b.disabled !== state.answering) b.disabled = state.answering;
    items.push(liveView.card.el);
  } else {
    liveView.card = null;
  }
  syncChildren(liveView.wrap, items);
  return liveView.wrap;
}

function renderHeader() {
  const folder = currentFolder(state);
  els.folderLabel.textContent = folder ? `📁 ${folder}` : '';
  els.folderLabel.title = folder ?? '';
  els.folderButton.hidden = !canPickFolder(state);
  els.folderButton.textContent = folder ? '📁 เปลี่ยนโฟลเดอร์' : '📁 เลือกโฟลเดอร์';
}

function renderChat() {
  const atBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 40;
  // An old session shows its English text until its translation arrives.
  const messages = state.session
    ? state.session.messages.map((m) => ({ ...m, original: m.original ?? m.english }))
    : state.chat?.messages ?? [];
  retryButton = null;
  const scope = state.session ? `s:${state.session.id}` : `c:${state.chat?.id}`;
  const keys = new Set();
  const items = messages.map((m, i, all) => {
    const key = `${scope}:${m.id ?? i}`;
    keys.add(key);
    return messageEl(m, i, all, key);
  });
  for (const key of messageViews.keys()) if (!keys.has(key)) messageViews.delete(key);
  if (state.session?.note) {
    if (!sessionNoteEl) {
      sessionNoteEl = document.createElement('div');
      sessionNoteEl.className = 'note';
    }
    setText(sessionNoteEl, state.session.note);
    items.unshift(sessionNoteEl);
  }
  if (state.chat?.live) items.push(liveBlock(state.chat.live, state.chat.id));
  else liveView = null;
  if (items.length === 0) {
    if (!emptyEl) {
      emptyEl = document.createElement('div');
      emptyEl.className = 'empty';
      emptyEl.textContent = 'วันนี้ให้ช่วยอะไรดี?';
    }
    items.push(emptyEl);
  }
  syncChildren(els.messages, items);
  if (atBottom) els.messages.scrollTop = els.messages.scrollHeight;
  renderHeader();
  renderChatList();
  loadOldSessions();
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
    if (wasPending && chat.pendingStep == null) {
      loadChats();
      loadSettings(); // a refused Claude model was put back on the server
    }
  } catch (err) {
    if (state.chat?.id === id) showError(err);
  }
  if (state.chat?.id === id) schedulePoll();
}

function closeSession() {
  clearTimeout(sessionPollTimer);
  state.session = null;
}

async function openChat(id) {
  clearTimeout(chatPollTimer);
  closeSession();
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
  closeSession();
  state.chat = null;
  state.pendingFolder = null;
  showError(null);
  renderChat();
  els.input.focus();
}

async function send() {
  updateComposer();
  if (els.send.disabled) return;
  const text = els.input.value;
  const body = sendBody({ text, chat: state.chat, session: state.session, pendingFolder: state.pendingFolder });
  state.busy = true;
  updateComposer();
  try {
    const res = await api('POST', '/api/messages', body);
    els.input.value = '';
    showError(null);
    if (!state.chat) {
      closeSession();
      state.pendingFolder = null;
      state.chat = { id: res.chatId, messages: [], pendingStep: null };
    }
    await refreshChat(res.chatId);
    loadChats();
    // A continued old session leaves the list.
    if (body.resumeSessionId) loadOldSessions(true);
  } catch (err) {
    showError(err);
    if (err.status === 503) loadStatus();
  } finally {
    state.busy = false;
    updateComposer();
    autoGrow();
  }
}

// ---- permission cards and stop ----

async function answerCard(card, decision) {
  const id = state.chat?.id;
  if (!id || state.answering) return;
  state.answering = true;
  renderChat();
  try {
    await api('POST', `/api/chats/${encodeURIComponent(id)}/permissions/${encodeURIComponent(card.requestId)}`,
      { token: card.token, decision });
    showError(null);
  } catch (err) {
    showError(err);
  } finally {
    state.answering = false;
  }
  if (state.chat?.id === id) await refreshChat(id);
}

async function stopTurn() {
  const id = state.chat?.id;
  if (!id || !canStop(state.chat) || state.answering) return;
  state.answering = true;
  updateComposer();
  try {
    await api('POST', `/api/chats/${encodeURIComponent(id)}/stop`);
    showError(null);
  } catch (err) {
    showError(err);
  } finally {
    state.answering = false;
  }
  if (state.chat?.id === id) await refreshChat(id);
}

// ---- work folder picker ----

function renderFolderPicker() {
  const view = state.folderView;
  els.folderDialog.hidden = !view;
  if (!view) return;
  els.folderPath.textContent = view.path ?? 'เลือกไดรฟ์';
  els.folderChoose.disabled = !view.path;
  const items = [];
  if (view.path) {
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'folder-item folder-up';
    up.textContent = '⬆ ขึ้นไปหนึ่งระดับ';
    up.addEventListener('click', () => browseFolder(view.parent));
    const li = document.createElement('li');
    li.append(up);
    items.push(li);
  }
  for (const f of view.folders) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'folder-item';
    b.textContent = `📁 ${f.name}`;
    b.title = f.path;
    b.addEventListener('click', () => browseFolder(f.path));
    const li = document.createElement('li');
    li.append(b);
    items.push(li);
  }
  els.folderList.replaceChildren(...items);
}

function showFolderError(message) {
  els.folderError.textContent = message ?? '';
  els.folderError.hidden = !message;
}

// path null shows the roots (drives on Windows).
async function browseFolder(path) {
  try {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    state.folderView = await api('GET', `/api/folders${query}`);
    showFolderError(null);
  } catch (err) {
    showFolderError(err.message);
  }
  renderFolderPicker();
}

async function openFolderPicker() {
  if (!canPickFolder(state)) return;
  state.folderView = { path: null, parent: null, folders: [] };
  renderFolderPicker();
  // Start at the chosen folder, or the home folder (from the roots answer).
  let start = state.pendingFolder;
  if (!start) {
    try {
      start = (await api('GET', '/api/folders')).home;
    } catch {}
  }
  await browseFolder(start ?? null);
}

function closeFolderPicker() {
  state.folderView = null;
  showFolderError(null);
  renderFolderPicker();
}

function chooseFolder() {
  const path = state.folderView?.path;
  if (!path) return;
  state.pendingFolder = path;
  closeFolderPicker();
  renderChat();
}

// ---- old Claude Code sessions of the current folder ----

function renderOldSessions() {
  const folder = currentFolder(state);
  els.oldSessionsLabel.hidden = !folder;
  els.oldSessions.hidden = !folder;
  els.oldSessions.replaceChildren(...(folder ? state.oldSessions : []).map((s) => {
    const li = document.createElement('li');
    li.className = 'chat-item';
    li.classList.toggle('active', s.id === state.session?.id);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'chat-title';
    open.textContent = `${s.title} · ${shortDate(s.updatedAt)}`;
    open.title = s.title;
    open.addEventListener('click', () => openSession(folder, s.id));
    li.append(open);
    return li;
  }));
}

async function loadOldSessions(force = false) {
  const folder = currentFolder(state);
  if (!force && folder === state.oldSessionsFolder) return renderOldSessions();
  state.oldSessionsFolder = folder;
  state.oldSessions = [];
  renderOldSessions();
  if (!folder) return;
  try {
    const list = await api('GET', `/api/claude-sessions?folder=${encodeURIComponent(folder)}`);
    if (state.oldSessionsFolder === folder) state.oldSessions = list;
  } catch (err) {
    showError(err);
  }
  renderOldSessions();
}

async function openSession(folder, id) {
  clearTimeout(chatPollTimer);
  clearTimeout(sessionPollTimer);
  showError(null);
  try {
    const session = await api('GET', `/api/claude-sessions/${encodeURIComponent(id)}?folder=${encodeURIComponent(folder)}`);
    const first = state.session?.id !== id;
    state.chat = null;
    state.pendingFolder = folder;
    state.session = session;
    if (first) els.messages.scrollTop = 0;
    renderChat();
    if (first) els.messages.scrollTop = els.messages.scrollHeight;
    // Poll until every message is translated.
    if (session.done < session.total) sessionPollTimer = setTimeout(() => openSession(folder, id), POLL_MS);
  } catch (err) {
    showError(err);
    if (err.status === 404) loadOldSessions(true);
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
els.themeToggle.addEventListener('click', toggleTheme);
els.picker.addEventListener('click', togglePicker);
els.stop.addEventListener('click', stopTurn);
els.folderButton.addEventListener('click', openFolderPicker);
els.folderCancel.addEventListener('click', closeFolderPicker);
els.folderChoose.addEventListener('click', chooseFolder);
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

applyTheme();
renderChat();
renderModel();
loadStatus();
loadSettings();
loadChats();

// Pure front-end logic: no DOM, so `node --test` can import it directly.
import { CLAUDE_OPTIONS } from './models.js';

export { CLAUDE_OPTIONS };

// What a keydown in the message box should do: "send", "newline" or "none".
// Enter during an IME composition (Thai, Japanese, ...) only confirms the
// composition, so it never sends.
export function keyAction({ key, shiftKey = false, isComposing = false } = {}) {
  if (key !== 'Enter' || isComposing) return 'none';
  return shiftKey ? 'newline' : 'send';
}

// No send mode needs the local translator any more: translate mode has
// Claude Haiku translate the answer back. Only the old-session viewer uses it.
// modelState and sendMode are still accepted, and ignored.
export function canSend({ text, pending, lastMessageHasError }) {
  if (typeof text !== 'string' || text.trim() === '') return false;
  if (pending) return false;
  if (lastMessageHasError) return false;
  return true;
}

// 'translating' is only shown by an older server.
const STEP_LABELS = {
  translating: 'กำลังแปลข้อความเป็นภาษาอังกฤษ…',
  thinking: 'Claude กำลังคิด…',
  translating_back: 'กำลังแปลคำตอบกลับ…',
};

export function stepLabel(pendingStep) {
  if (pendingStep == null) return '';
  return STEP_LABELS[pendingStep] ?? 'กำลังดำเนินการ…';
}

export function formatProgress(progress) {
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return `${Math.round(p * 100)}%`;
}

const THAI = /[฀-๿]/;

// Short Thai message for a failed API call; status 0 means the request never
// reached the server. A Thai message from the server (folder, permission,
// stop and old-session routes) is shown as is.
export function apiErrorMessage(status, serverMessage) {
  if (typeof serverMessage === 'string' && THAI.test(serverMessage)) return serverMessage;
  switch (status) {
    case 0: return 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้';
    case 400: return 'ไม่สามารถส่งข้อความว่างได้';
    case 404: return 'ไม่พบแชทนี้';
    case 409: return 'ทำรายการนี้ไม่ได้ในตอนนี้ เพราะกำลังรอคำตอบ หรือข้อความล่าสุดยังมีข้อผิดพลาด';
    case 503: return 'โมเดลแปลภาษายังไม่พร้อม กรุณารอสักครู่';
    default: return `เกิดข้อผิดพลาด (${status})`;
  }
}

// Only the last message can be retried, and only a user message with an error.
export function canRetry(messages, index) {
  const m = messages?.[index];
  return index === messages.length - 1 && m?.role === 'user' && !!m.error;
}

// Whether the "ส่งใหม่" button of a retryable message can be clicked now.
export function retryEnabled({ pending }) {
  return !pending;
}

// Whether the translator's loading/error banners show: only while an open
// old Claude Code session waits for its translation (in either send mode).
export function modelBannerShown({ sessionWaiting = false } = {}) {
  return !!sessionWaiting;
}

export function lastMessageHasError(chat) {
  const last = chat?.messages?.at(-1);
  return !!last?.error;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Links are only kept for these schemes; anything else (javascript:, data:,
// vbscript:, ...) is shown as plain text.
const SAFE_URL = /^(?:https?:|mailto:)/i;
const SLOT = /\u0000(\d+)\u0000/g;

// Inline Markdown on one block of text. Everything is HTML-escaped before any
// tag is added, so the only tags in the output are the ones made here.
function renderInline(text) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = text.replace(/\u0000/g, '');
  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${escapeHtml(code)}</code>`));
  s = escapeHtml(s);
  const link = (url, label) =>
    keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  s = s.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (m, label, url) =>
    SAFE_URL.test(url) ? link(url, emphasis(label)) : m);
  s = s.replace(/https?:\/\/(?:(?!&lt;|&gt;|&quot;|&#39;)[^\s\u0000])+/g, (url) => {
    const trail = /[.,;:!?)]+$/.exec(url)?.[0] ?? '';
    const bare = url.slice(0, url.length - trail.length);
    return link(bare, bare) + trail;
  });
  s = emphasis(s);
  while (s.includes('\u0000')) s = s.replace(SLOT, (_, i) => slots[i]);
  return s;
}

function emphasis(s) {
  return s
    .replace(/\*\*(?=\S)([^*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([^_]+?)__/g, '<strong>$1</strong>')
    .replace(/\*(?=\S)([^*\n]+?)\*/g, '<em>$1</em>');
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const BULLET = /^\s{0,3}[-*+]\s+/;
const NUMBERED = /^\s{0,3}\d+[.)]\s+/;

const startsBlock = (line) =>
  FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) ||
  BULLET.test(line) || NUMBERED.test(line);

// Small, safe Markdown renderer for untrusted Claude output: fenced code,
// headings, rules, quotes, lists, paragraphs, inline code, bold/italic and
// http(s)/mailto links. Raw HTML in the input is always shown as text.
export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    const heading = HEADING.exec(line);
    if (heading) {
      const n = heading[1].length;
      out.push(`<h${n}>${renderInline(heading[2])}</h${n}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) { out.push('<hr>'); i++; continue; }
    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(lines[i++].replace(QUOTE, ''));
      out.push(`<blockquote>${renderMarkdown(inner.join('\n'))}</blockquote>`);
      continue;
    }
    const marker = BULLET.test(line) ? BULLET : NUMBERED.test(line) ? NUMBERED : null;
    if (marker) {
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        if (marker.test(l)) items.push([l.replace(marker, '')]);
        else if (l.trim() !== '' && /^\s/.test(l) && !FENCE.test(l)) items.at(-1).push(l.trim());
        else break;
        i++;
      }
      const tag = marker === BULLET ? 'ul' : 'ol';
      const lis = items.map((it) => `<li>${it.map(renderInline).join('<br>')}</li>`).join('');
      out.push(`<${tag}>${lis}</${tag}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && (para.length === 0 || !startsBlock(lines[i]))) {
      para.push(lines[i++]);
    }
    out.push(`<p>${para.map(renderInline).join('<br>')}</p>`);
  }
  return out.join('\n');
}

// ---- model picker ----

export const SIZE_OPTIONS = [
  { value: '4b', label: '4B', bytes: 2_489_909_760, hint: 'เร็ว เหมาะกับเครื่องส่วนใหญ่' },
  { value: '12b', label: '12B', bytes: 7_300_794_112, hint: 'แปลดีขึ้น ช้าลง ต้องใช้ RAM/การ์ดจอมากขึ้น' },
  { value: '27b', label: '27B', bytes: 16_546_704_480, hint: 'แปลดีที่สุด ช้ามาก ต้องใช้ RAM มาก' },
];

export const SEND_MODE_OPTIONS = [
  { value: 'direct', label: 'ส่งตรง (แนะนำ)', hint: 'ส่งข้อความตามที่พิมพ์ Claude ตอบเป็นภาษาเดียวกัน แม่นที่สุด' },
  { value: 'translate', label: 'ตอบเป็นอังกฤษแล้วแปลกลับ', hint: 'ประหยัดราว 20% ช้าลงราว 10 วินาที ภาษาอาจดูเป็นงานแปล' },
];

// Hint of the size section: the local translator only translates old sessions.
export const SIZES_HINT = 'ใช้แปลแชตเก่าจาก Claude Code';
// Kept for older imports; the same hint.
export const SIZES_DIRECT_HINT = SIZES_HINT;

const optionOf = (options, value) => options.find((o) => o.value === value) ?? options[0];

// Small text under an answer naming the model that wrote it, when that is
// not the one picked (always for "ค่าเริ่มต้น"); '' otherwise.
export function answeredByLabel(message) {
  if (!message?.model || message.model === message.requestedModel) return '';
  return `ตอบโดย ${message.model}`;
}

// "7.3 GB" (one decimal, decimal gigabytes).
export function formatGB(bytes) {
  return `${(Math.round(bytes / 1e8) / 10).toFixed(1)} GB`;
}

// Text of the picker button, e.g. "ส่งตรง · Claude ค่าเริ่มต้น" or "แปลกลับ · Claude ค่าเริ่มต้น".
// A missing sendMode (an older server) means translate mode.
export function pickerLabel({ claudeModel, sendMode } = {}) {
  const send = sendMode === 'direct' ? 'ส่งตรง' : 'แปลกลับ';
  return `${send} · Claude ${optionOf(CLAUDE_OPTIONS, claudeModel).label}`;
}

// The whole picker waits while the open chat's reply is pending.
export function pickerDisabled({ pending }) {
  return !!pending;
}

// Size picks are refused while a size download or any model load runs; they
// stay available in the error state.
// They work in both send modes (the old-session viewer uses them).
export function sizeOptionsDisabled({ pending, modelState, switchState }) {
  return !!pending || modelState === 'loading' || switchState === 'downloading';
}

// Whether a message shows its English text ("ดูต้นฉบับภาษาอังกฤษ" /
// "ดูคำแปลภาษาอังกฤษ"): never for a direct-mode message. Messages from before
// direct mode have no `mode` and are translate-mode messages.
export function showsEnglish(m) {
  return m?.mode !== 'direct' && !!m?.english && m.english !== m.original;
}

// What picking `size` should do: 'none' (already loaded), 'confirm' (needs a
// download: ask first with confirmDownloadText) or 'switch'.
export function sizePickAction({ size, model, downloadedSizes = [] }) {
  if (model?.state === 'ready' && model.size === size) return 'none';
  return downloadedSizes.includes(size) ? 'switch' : 'confirm';
}

export function confirmDownloadText(size) {
  return `ดาวน์โหลด ${formatGB(optionOf(SIZE_OPTIONS, size).bytes)}?`;
}

// "ดาวน์โหลดแล้ว" or the download size.
export function sizeOptionNote(size, downloadedSizes = []) {
  return downloadedSizes.includes(size) ? 'ดาวน์โหลดแล้ว' : formatGB(optionOf(SIZE_OPTIONS, size).bytes);
}

// ---- work folder, live turn and old Claude Code sessions ----

export const STOPPED_NOTE = 'หยุดแล้ว';
export const TRUNCATED_NOTE = 'ผลลัพธ์ยาวเกินไป จึงเก็บไว้เฉพาะส่วนต้น';
export const DECISION_LABELS = [
  { decision: 'allow', label: 'อนุญาต' },
  { decision: 'allow_chat', label: 'อนุญาตตลอดในแชตนี้' },
  { decision: 'deny', label: 'ไม่อนุญาต' },
];

export const ONCE_ONLY_HINT = 'คำสั่งนี้มีหลายคำสั่งต่อกัน อนุญาตได้ทีละครั้ง';

// The buttons of a permission card: no "อนุญาตตลอดในแชตนี้" when the server
// flags the request as allow-once (a Bash command with shell operators).
export function cardDecisions(card) {
  return card?.onceOnly ? DECISION_LABELS.filter((d) => d.decision !== 'allow_chat') : DECISION_LABELS;
}

// "หยุด" only while `claude` runs (the thinking step).
export function canStop(chat) {
  return chat?.pendingStep === 'thinking' || chat?.pendingStep === 'translating_back';
}

// The work folder of what is open: an old session's, the chat's, or the one
// picked for a new chat (before its first message).
export function currentFolder({ chat, session, pendingFolder }) {
  if (session) return session.folder;
  if (chat) return chat.folder ?? null;
  return pendingFolder ?? null;
}

// The folder can be picked only for a new chat.
export function canPickFolder({ chat, session }) {
  return !chat && !session;
}

// Body of POST /api/messages for what is open.
export function sendBody({ text, chat, session, pendingFolder }) {
  if (chat) return { chatId: chat.id, text };
  if (session) return { text, folder: session.folder, resumeSessionId: session.id };
  return pendingFolder ? { text, folder: pendingFolder } : { text };
}

// Progress note of an old session's translation, or '' when done.
export function sessionProgress({ done, total } = {}) {
  if (!Number.isFinite(done) || !Number.isFinite(total) || done >= total) return '';
  return `กำลังแปลแชตเก่า… ${done}/${total}`;
}

// Date of an old session for the sidebar, e.g. "1/3/2026".
export function shortDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

// ---- theme (#50): dark by default, "light" only when saved as such ----
export const THEME_KEY = 'polyprompt.theme';

export function normalizeTheme(value) {
  return value === 'light' ? 'light' : 'dark';
}

export function nextTheme(theme) {
  return normalizeTheme(theme) === 'dark' ? 'light' : 'dark';
}

// The toggle names the theme it switches to.
export function themeToggleLabel(theme) {
  return normalizeTheme(theme) === 'dark' ? 'โหมดสว่าง' : 'โหมดมืด';
}

export function themeToggleIcon(theme) {
  return normalizeTheme(theme) === 'dark' ? '☀' : '☾';
}

// getStorage returns localStorage; reading it may throw (private mode, blocked storage).
export function loadTheme(getStorage) {
  try {
    return normalizeTheme(getStorage().getItem(THEME_KEY));
  } catch {
    return 'dark';
  }
}

export function saveTheme(getStorage, theme) {
  try {
    getStorage().setItem(THEME_KEY, normalizeTheme(theme));
  } catch {
    // Storage unavailable: the theme still applies for this session.
  }
}

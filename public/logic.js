// Pure front-end logic: no DOM, so `node --test` can import it directly.

// What a keydown in the message box should do: "send", "newline" or "none".
// Enter during an IME composition (Thai, Japanese, ...) only confirms the
// composition, so it never sends.
export function keyAction({ key, shiftKey = false, isComposing = false } = {}) {
  if (key !== 'Enter' || isComposing) return 'none';
  return shiftKey ? 'newline' : 'send';
}

export function canSend({ text, pending, modelState, lastMessageHasError }) {
  if (typeof text !== 'string' || text.trim() === '') return false;
  if (pending) return false;
  if (modelState !== 'ready') return false;
  if (lastMessageHasError) return false;
  return true;
}

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

// Short Thai message for a failed API call; status 0 means the request never
// reached the server.
export function apiErrorMessage(status) {
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

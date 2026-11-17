// Fixed Thai templates for activity lines and permission cards, and the
// per-chat "allow for this chat" rules. Nothing here is ever translated: the
// Thai text is fixed and the details stay in Claude's own (English) words.

export const OUTPUT_MAX = 20_000;
const SHORT_MAX = 80;
const PREVIEW_MAX = 2_000;

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

// First line of `text`, cut to `max` characters.
function short(text, max = SHORT_MAX) {
  const first = str(text).split('\n')[0];
  const chars = Array.from(first);
  return chars.length > max || str(text).includes('\n') ? chars.slice(0, max).join('') + '…' : first;
}

function preview(text) {
  const s = str(text);
  return s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX) + '\n…' : s;
}

const json = (input) => {
  try {
    return JSON.stringify(input ?? {}, null, 2);
  } catch {
    return '';
  }
};

const filePath = (input) => str(input?.file_path ?? input?.notebook_path ?? input?.path);

// One activity line for a tool call: { text, detail }.
export function activityLine(name, input = {}) {
  const file = filePath(input);
  switch (name) {
    case 'Read':
    case 'NotebookRead':
      return { text: `🔍 กำลังอ่าน \`${short(file)}\``, detail: file };
    case 'Glob':
      return { text: `🔍 ค้นหาไฟล์ \`${short(input.pattern)}\``, detail: json(input) };
    case 'Grep':
      return { text: `🔍 ค้นหาข้อความ \`${short(input.pattern)}\``, detail: json(input) };
    case 'LS':
      return { text: `📂 ดูโฟลเดอร์ \`${short(file)}\``, detail: file };
    case 'Bash':
      return { text: `🔧 รัน \`${short(input.command)}\``, detail: str(input.command) };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { text: `✏️ แก้ไฟล์ \`${short(file)}\``, detail: file };
    case 'Write':
      return { text: `📝 เขียนไฟล์ \`${short(file)}\``, detail: file };
    case 'WebSearch':
      return { text: `🌐 ค้นเว็บ: ${short(input.query)}`, detail: str(input.query) };
    case 'WebFetch':
      return { text: `🌐 เปิดเว็บ ${short(input.url)}`, detail: str(input.url) };
    case 'TodoWrite':
      return { text: '📋 อัปเดตรายการงาน', detail: json(input) };
    case 'Task':
    case 'Agent':
      return { text: `🤖 ให้ผู้ช่วยย่อยทำงาน: ${short(input.description)}`, detail: json(input) };
    default:
      return { text: `🛠️ ใช้เครื่องมือ \`${short(name)}\``, detail: json(input) };
  }
}

function editPreview(input) {
  if (Array.isArray(input.edits)) return input.edits.map(editPreview).join('\n');
  const minus = str(input.old_string).split('\n').map((l) => `- ${l}`);
  const plus = str(input.new_string).split('\n').map((l) => `+ ${l}`);
  return [...minus, ...plus].join('\n');
}

// The permission card text for a tool request: { text, detail }, where text
// is the fixed Thai description and detail the exact English action.
export function cardText(name, input = {}) {
  const file = filePath(input);
  switch (name) {
    case 'Bash':
      return { text: 'Claude ขอรันคำสั่ง', detail: str(input.command) };
    case 'Edit':
    case 'MultiEdit':
      return { text: `Claude ขอแก้ไฟล์ \`${short(file)}\``, detail: `${file}\n${preview(editPreview(input))}` };
    case 'Write':
      return { text: `Claude ขอเขียนไฟล์ \`${short(file)}\``, detail: `${file}\n${preview(input.content)}` };
    case 'NotebookEdit':
      return { text: `Claude ขอแก้โน้ตบุ๊ก \`${short(file)}\``, detail: `${file}\n${preview(input.new_source)}` };
    case 'WebFetch':
      return { text: 'Claude ขอเปิดเว็บ', detail: str(input.url) };
    case 'WebSearch':
      return { text: 'Claude ขอค้นเว็บ', detail: str(input.query) };
    default:
      if (name.startsWith('mcp__')) return { text: `Claude ขอใช้เครื่องมือ MCP \`${short(name)}\``, detail: json(input) };
      return { text: `Claude ขอใช้เครื่องมือ \`${short(name)}\``, detail: json(input) };
  }
}

// Tool output as stored in an activity line: about the first 20 KB.
export function truncateOutput(text) {
  const s = str(text);
  return s.length > OUTPUT_MAX ? { output: s.slice(0, OUTPUT_MAX), truncated: true } : { output: s };
}

// A single & also covers &&: bash and cmd.exe run the next command after it.
const SHELL_OPERATOR = /;|&|\|\||\||`|\$\(|>|<|\n|\r/;

export const hasShellOperator = (command) => SHELL_OPERATOR.test(str(command));

// First two whitespace-separated words of a command, or its only word.
export function bashPrefix(command) {
  return str(command).trim().split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
}

// The rule "อนุญาตตลอดในแชตนี้" stores for a request, or null when none can
// be stored (a Bash command with shell operators is never auto-allowed).
export function ruleFor(toolName, input = {}) {
  if (toolName !== 'Bash') return { tool: toolName };
  if (hasShellOperator(input.command) || !bashPrefix(input.command)) return null;
  return { tool: 'Bash', prefix: bashPrefix(input.command) };
}

export const sameRule = (a, b) => a.tool === b.tool && (a.prefix ?? null) === (b.prefix ?? null);

// Whether the chat's stored rules allow this request without a card.
export function isAutoAllowed(rules, toolName, input = {}) {
  if (!Array.isArray(rules)) return false;
  const rule = ruleFor(toolName, input);
  return rule !== null && rules.some((r) => r && typeof r === 'object' && sameRule(r, rule));
}

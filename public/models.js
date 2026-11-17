// Claude models the picker offers, shared by the server and the browser.
// A new model is one line here. 'default' passes no --model flag.
export const CLAUDE_OPTIONS = [
  { value: 'default', label: 'ค่าเริ่มต้น', hint: 'ใช้โมเดลที่ Claude Code ตั้งไว้' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1', hint: 'รุ่นใหม่ล่าสุด เก่งงานเขียนและงานยาก' },
  { value: 'claude-opus-5-5', label: 'Opus 5.5', hint: 'ฉลาดที่สุด ใช้โควตามากที่สุด' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'สมดุลระหว่างความฉลาดและความเร็ว' },
  { value: 'claude-haiku-5-5', label: 'Haiku 5.5', hint: 'เร็วที่สุด ประหยัดโควตา' },
];

// Values saved by older versions, mapped to full model IDs on read.
// claude-fable-5-2 was a wrong ID an earlier version offered.
export const LEGACY_CLAUDE_MODELS = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  'claude-fable-5-2': 'claude-fable-5-1',
};

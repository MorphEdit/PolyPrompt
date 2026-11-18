// The benchmark's fixed Thai prompt templates and the judge prompt. Printed
// as is in meta.json and the report.

export const MGSM_SUFFIX = 'ตอบโดยแสดงวิธีคิดสั้น ๆ แล้วจบด้วยบรรทัด "คำตอบ: <ตัวเลข>"';
export const BELEBELE_SUFFIX = 'ตอบด้วยบรรทัด "คำตอบ: <หมายเลข 1-4>"';

export const PROMPTS = {
  mgsm: `{question}\n\n${MGSM_SUFFIX}`,
  belebele: `{flores_passage}\n\n{question}\n\n1. {mc_answer1}\n2. {mc_answer2}\n3. {mc_answer3}\n4. {mc_answer4}\n\n${BELEBELE_SUFFIX}`,
  open: '{Instruction}  (+ "\\n\\n" + {Input} when Input is a non-empty string after .trim())',
};

const hasInput = (input) => typeof input === 'string' && input.trim() !== '';

// The text Claude gets for one dataset row (condition A sends it as is).
export function promptFor(set, row) {
  if (set === 'mgsm') return `${row.question}\n\n${MGSM_SUFFIX}`;
  if (set === 'belebele') {
    const options = [1, 2, 3, 4].map((n) => `${n}. ${row[`mc_answer${n}`]}`).join('\n');
    return `${row.flores_passage}\n\n${row.question}\n\n${options}\n\n${BELEBELE_SUFFIX}`;
  }
  if (set === 'open') return hasInput(row.Input) ? `${row.Instruction}\n\n${row.Input}` : String(row.Instruction ?? '');
  throw new Error(`unknown set: ${set}`);
}

// The key a scored set's answer is checked against, as a string.
export function expectedFor(set, row) {
  if (set === 'mgsm') return String(row.answer_number);
  if (set === 'belebele') return String(row.correct_answer_num);
  return null;
}

export const JUDGE_PROMPT = `คุณเป็นผู้ตัดสินที่เป็นกลาง ให้เปรียบเทียบคำตอบสองคำตอบต่อคำสั่งด้านล่าง โดยใช้คำตอบอ้างอิงที่มนุษย์เขียนเป็นแนวทาง
พิจารณาความถูกต้อง ความครบถ้วน การทำตามคำสั่ง และความเป็นธรรมชาติของภาษาไทย ไม่ต้องสนใจความยาวหรือลำดับของคำตอบ

### คำสั่ง
{instruction}

### คำตอบอ้างอิง
{reference}

### คำตอบ 1
{answer1}

### คำตอบ 2
{answer2}

ตอบเป็น JSON บรรทัดเดียวเท่านั้น: {"winner": 1 | 2 | "tie", "reason": "<เหตุผลสั้น ๆ>"}`;

// Placeholders are replaced in one pass, so an answer containing "{answer2}" stays as typed.
export function judgePrompt({ instruction, reference, answer1, answer2 }) {
  const values = { instruction, reference, answer1, answer2 };
  return JUDGE_PROMPT.replace(/\{(instruction|reference|answer1|answer2)\}/g, (_, k) => String(values[k] ?? ''));
}

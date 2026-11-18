// #57: a small dataset fixture for the sampling tests.
const TYPES = ['Open QA', 'Closed QA', 'Brainstorming'];

// open: 150 eligible rows (50 per type, interleaved) with skipped rows at
// fixed places: ids 3 and 40 too long, 7 and 41 with an empty Output; ids 5
// and 6 are exactly 2000 characters (kept).
export function openRows() {
  const rows = [];
  let n = 0;
  const push = (row) => rows.push({ Instruction: 'อธิบาย', Input: '', Output: 'คำตอบอ้างอิง', ...row });
  for (let i = 0; rows.length < 154; i++) {
    const id = rows.length;
    if (id === 3) push({ Instruction: 'ก'.repeat(2001), Task_type: 'Open QA' });
    else if (id === 40) push({ Instruction: 'ก'.repeat(1000), Input: 'ข'.repeat(999), Task_type: 'Closed QA' });
    else if (id === 7) push({ Output: '', Task_type: 'Brainstorming' });
    else if (id === 41) push({ Output: '  \n', Task_type: 'Open QA' });
    else if (id === 5) push({ Instruction: 'ก'.repeat(2000), Task_type: TYPES[n++ % 3] });
    else if (id === 6) push({ Instruction: 'ก'.repeat(1000), Input: 'ข'.repeat(998), Task_type: TYPES[n++ % 3] });
    else push({ Instruction: `คำสั่ง ${id}`, Input: id % 5 === 0 ? `ข้อมูล ${id}` : '   ', Task_type: TYPES[n++ % 3] });
  }
  return rows;
}

export const fixtureRows = () => ({
  mgsm: Array.from({ length: 12 }, (_, i) => ({ question: `โจทย์ ${i}`, answer_number: i })),
  belebele: Array.from({ length: 210 }, (_, i) => ({ flores_passage: `บทความ ${i}`, correct_answer_num: '1' })),
  open: openRows(),
});

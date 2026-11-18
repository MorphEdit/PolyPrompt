# Token benchmark: full-2026-11-18

A = Thai sent to Claude as typed. B = PolyPrompt (Thai → English → Claude → Thai). Only items whose last A line and last B line are both non-error count as pairs. "B vs A (Σ)" is 100 × (ΣB − ΣA) / ΣA over the pairs (negative = B uses fewer tokens); CIs are 95% seeded bootstrap (10,000 resamples).

## Tokens

### mgsm (250 pairs)

| tokens per item | A median | A mean | B median | B mean | B vs A (Σ) | 95% CI |
|---|---:|---:|---:|---:|---:|---|
| input: uncached | 2.0 | 2.0 | 2.0 | 2.0 | 0.0% | [0.0%, 0.0%] |
| input: cache write | 1097.5 | 1112.0 | 969.5 | 973.0 | -12.5% | [-13.0%, -12.0%] |
| input: cache read | 1399.0 | 1402.8 | 1399.0 | 1401.8 | -0.1% | [-0.2%, 0.0%] |
| output | 217.5 | 232.8 | 140.0 | 206.7 | -11.2% | [-18.5%, -3.2%] |
| message tokens only (uncached input + output) | 219.5 | 234.8 | 142.0 | 208.7 | -11.1% | [-18.4%, -3.2%] |
| full total (incl. cached system prompt) | 2730.0 | 2749.6 | 2523.5 | 2583.5 | -6.0% | [-6.7%, -5.3%] |

### belebele (200 pairs)

| tokens per item | A median | A mean | B median | B mean | B vs A (Σ) | 95% CI |
|---|---:|---:|---:|---:|---:|---|
| input: uncached | 2.0 | 2.0 | 2.0 | 2.0 | 0.0% | [0.0%, 0.0%] |
| input: cache write | 1428.0 | 1442.7 | 1099.5 | 1105.7 | -23.4% | [-24.4%, -22.2%] |
| input: cache read | 1399.0 | 1403.7 | 1399.0 | 1404.2 | +0.0% | [-1.0%, +1.1%] |
| output | 269.0 | 311.6 | 229.0 | 274.6 | -11.9% | [-19.2%, -4.1%] |
| message tokens only (uncached input + output) | 271.0 | 313.6 | 231.0 | 276.6 | -11.8% | [-19.1%, -4.1%] |
| full total (incl. cached system prompt) | 3142.5 | 3160.1 | 2743.0 | 2786.5 | -11.8% | [-12.7%, -11.0%] |

### open (100 pairs)

| tokens per item | A median | A mean | B median | B mean | B vs A (Σ) | 95% CI |
|---|---:|---:|---:|---:|---:|---|
| input: uncached | 2.0 | 3.2 | 2.0 | 3.3 | +2.5% | [-8.2%, +13.0%] |
| input: cache write | 1057.0 | 2436.7 | 965.5 | 2253.8 | -7.5% | [-19.8%, +7.2%] |
| input: cache read | 1399.0 | 4076.1 | 1399.0 | 3966.7 | -2.7% | [-24.1%, +19.7%] |
| output | 2774.0 | 3013.3 | 1574.0 | 1799.7 | -40.3% | [-44.7%, -35.4%] |
| message tokens only (uncached input + output) | 2776.0 | 3016.5 | 1577.0 | 1803.0 | -40.2% | [-44.7%, -35.4%] |
| full total (incl. cached system prompt) | 5785.0 | 9529.2 | 4242.5 | 8023.5 | -15.8% | [-28.1%, -3.5%] |

### all sets (550 pairs)

| tokens per item | A median | A mean | B median | B mean | B vs A (Σ) | 95% CI |
|---|---:|---:|---:|---:|---:|---|
| input: uncached | 2.0 | 2.2 | 2.0 | 2.2 | +0.7% | [-2.3%, +3.3%] |
| input: cache write | 1198.0 | 1473.1 | 1009.0 | 1254.1 | -14.9% | [-18.7%, -11.0%] |
| input: cache read | 1399.0 | 1889.2 | 1399.0 | 1869.0 | -1.1% | [-10.3%, +7.0%] |
| output | 267.0 | 767.0 | 228.5 | 521.0 | -32.1% | [-36.0%, -27.6%] |
| message tokens only (uncached input + output) | 269.0 | 769.2 | 230.5 | 523.2 | -32.0% | [-35.9%, -27.6%] |
| full total (incl. cached system prompt) | 2957.0 | 4131.5 | 2690.5 | 3646.4 | -11.7% | [-17.3%, -6.7%] |

## Quality

| set | pairs | A | 95% CI | B-Thai | 95% CI | B-English | 95% CI |
|---|---:|---:|---|---:|---|---:|---|
| mgsm | 250 | 97.2% (243/250) | [94.3%, 98.6%] | 79.6% (199/250) | [74.2%, 84.1%] | 79.6% (199/250) | [74.2%, 84.1%] |
| belebele | 200 | 93.5% (187/200) | [89.2%, 96.2%] | 84.0% (168/200) | [78.3%, 88.4%] | 84.0% (168/200) | [78.3%, 88.4%] |

McNemar (exact, two-sided): b = A right / B wrong, c = A wrong / B right.

| set | comparison | b | c | p |
|---|---|---:|---:|---:|
| mgsm | A vs B-Thai | 47 | 3 | 3.71e-11 |
| mgsm | A vs B-English | 47 | 3 | 3.71e-11 |
| belebele | A vs B-Thai | 20 | 1 | 2.10e-5 |
| belebele | A vs B-English | 20 | 1 | 2.10e-5 |

Judge on `open` (100 pairs, both orders must agree for a win): A wins 99, B wins 0, ties 1, judge failures 0, not judged yet 0.

## Time

| set | A median (s) | B median (s) | B translation share |
|---|---:|---:|---:|
| mgsm | 6.46 | 10.45 | 105.2% |
| belebele | 7.71 | 14.07 | 122.3% |
| open | 32.59 | 51.68 | 187.4% |
| all sets | 7.24 | 13.28 | 149.7% |

## Failures

- errors (not counted as pairs): 0
- translation fallbacks (kept): 22
  - mgsm 90 B: แปลคำตอบไม่สำเร็จ จึงแสดงคำตอบเป็นภาษาอังกฤษ — [mgsm.jsonl:182](mgsm.jsonl#L182)
  - mgsm 157 B: แปลคำตอบไม่สำเร็จ จึงแสดงคำตอบเป็นภาษาอังกฤษ — [mgsm.jsonl:315](mgsm.jsonl#L315)
  - mgsm 185 B: แปลคำตอบไม่สำเร็จ จึงแสดงคำตอบเป็นภาษาอังกฤษ — [mgsm.jsonl:372](mgsm.jsonl#L372)
  - belebele 57 B: แปลคำตอบไม่สำเร็จ จึงแสดงคำตอบเป็นภาษาอังกฤษ — [belebele.jsonl:22](belebele.jsonl#L22)
  - belebele 265 B: แปลข้อความไม่สำเร็จ จึงส่งข้อความตามที่พิมพ์ให้ Claude — [belebele.jsonl:118](belebele.jsonl#L118)
  - belebele 277 B: แปลคำตอบไม่สำเร็จ จึงแสดงคำตอบเป็นภาษาอังกฤษ — [belebele.jsonl:122](belebele.jsonl#L122)
  - belebele 324 B: แปลคำตอบไม่สำเร็จ จึงแสดงคำตอบเป็นภาษาอังกฤษ — [belebele.jsonl:156](belebele.jsonl#L156)
  - belebele 644 B: แปลข้อความไม่สำเร็จ จึงส่งข้อความตามที่พิมพ์ให้ Claude — [belebele.jsonl:291](belebele.jsonl#L291)
  - belebele 842 B: แปลคำตอบไม่สำเร็จ จึงแสดงคำตอบเป็นภาษาอังกฤษ — [belebele.jsonl:381](belebele.jsonl#L381)
  - open 218 B: แปลคำตอบไม่สำเร็จ จึงแสดงคำตอบเป็นภาษาอังกฤษ — [open.jsonl:10](open.jsonl#L10)
  - open 278 B: แปลข้อความไม่สำเร็จ จึงส่งข้อความตามที่พิมพ์ให้ Claude — [open.jsonl:11](open.jsonl#L11)
  - open 489 B: แปลคำตอบไม่สำเร็จ จึงแสดงคำตอบเป็นภาษาอังกฤษ — [open.jsonl:18](open.jsonl#L18)
  - open 605 B: แปลคำตอบไม่สำเร็จ จึงแสดงคำตอบเป็นภาษาอังกฤษ — [open.jsonl:22](open.jsonl#L22)
  - open 1029 B: แปลคำตอบไม่สำเร็จ จึงแสดงคำตอบเป็นภาษาอังกฤษ — [open.jsonl:38](open.jsonl#L38)
  - open 1627 B: แปลคำตอบไม่สำเร็จ จึงแสดงคำตอบเป็นภาษาอังกฤษ — [open.jsonl:46](open.jsonl#L46)
  - open 1649 B: แปลคำตอบไม่สำเร็จ จึงแสดงคำตอบเป็นภาษาอังกฤษ — [open.jsonl:47](open.jsonl#L47)
  - open 3737 B: แปลข้อความไม่สำเร็จ จึงส่งข้อความตามที่พิมพ์ให้ Claude — [open.jsonl:106](open.jsonl#L106)
  - open 4837 B: แปลข้อความไม่สำเร็จ จึงส่งข้อความตามที่พิมพ์ให้ Claude — [open.jsonl:126](open.jsonl#L126)
  - open 5607 B: แปลคำตอบไม่สำเร็จ จึงแสดงคำตอบเป็นภาษาอังกฤษ — [open.jsonl:142](open.jsonl#L142)
  - open 6069 B: แปลคำตอบไม่สำเร็จ จึงแสดงคำตอบเป็นภาษาอังกฤษ — [open.jsonl:149](open.jsonl#L149)
  - open 6663 B: แปลคำตอบไม่สำเร็จ จึงแสดงคำตอบเป็นภาษาอังกฤษ — [open.jsonl:173](open.jsonl#L173)
  - open 7781 B: แปลคำตอบไม่สำเร็จ จึงแสดงคำตอบเป็นภาษาอังกฤษ — [open.jsonl:200](open.jsonl#L200)
- unparseable answers (scored 0): 2
  - belebele 805 B-Thai — [belebele.jsonl:364](belebele.jsonl#L364)
  - belebele 805 B-English — [belebele.jsonl:364](belebele.jsonl#L364)
- judge failures: 0
- skipped `open` items (before sampling): 2322
  - too_long: 2322

## Setup

- date: 2026-11-18T15:19:50.523Z
- seed: 20261118
- Claude model: claude-opus-5-5 (judge: claude-opus-5-5)
- Claude Code: 2.1.314 (Claude Code)
- claude args: `-p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --tools WebSearch,WebFetch --allowedTools WebSearch,WebFetch --strict-mcp-config --setting-sources user --system-prompt You are Claude, a helpful general assistant in a chat. You can search the web and fetch web pages. You have no access to files, folders, commands or the computer you run on. Answer from your own knowledge, the web and what the user writes in the chat. --model claude-opus-5-5 --no-session-persistence`
- translator: TranslateGemma 4b
- machine: CPU AMD Ryzen 5 5600X 6-Core Processor             , GPU NVIDIA GeForce RTX 4060, VRAM 8188 MiB
- mgsm: `juletxara/mgsm` rev `b2f13d426afe3be8d69a7e739b36724db8b66bbc` (th/test-00000-of-00001.parquet)
- belebele: `facebook/belebele` rev `7899cdfa4e1e0d733fd77c848e2c273cb1d32be2` (data/tha_Thai.jsonl)
- open: `airesearch/WangchanThaiInstruct` rev `9099b833a1b6b9d471d7e6f4abb22bf88f318bd4` (data/test-00000-of-00001.parquet)

### Prompts

mgsm:

```text
{question}

ตอบโดยแสดงวิธีคิดสั้น ๆ แล้วจบด้วยบรรทัด "คำตอบ: <ตัวเลข>"
```

belebele:

```text
{flores_passage}

{question}

1. {mc_answer1}
2. {mc_answer2}
3. {mc_answer3}
4. {mc_answer4}

ตอบด้วยบรรทัด "คำตอบ: <หมายเลข 1-4>"
```

open:

```text
{Instruction}  (+ "\n\n" + {Input} when Input is a non-empty string after .trim())
```

judge:

```text
คุณเป็นผู้ตัดสินที่เป็นกลาง ให้เปรียบเทียบคำตอบสองคำตอบต่อคำสั่งด้านล่าง โดยใช้คำตอบอ้างอิงที่มนุษย์เขียนเป็นแนวทาง
พิจารณาความถูกต้อง ความครบถ้วน การทำตามคำสั่ง และความเป็นธรรมชาติของภาษาไทย ไม่ต้องสนใจความยาวหรือลำดับของคำตอบ

### คำสั่ง
{instruction}

### คำตอบอ้างอิง
{reference}

### คำตอบ 1
{answer1}

### คำตอบ 2
{answer2}

ตอบเป็น JSON บรรทัดเดียวเท่านั้น: {"winner": 1 | 2 | "tie", "reason": "<เหตุผลสั้น ๆ>"}
```

## Limitations

- The judge for the `open` set is Claude itself, so it may prefer answers written the way Claude writes.
- Token counts depend on the Claude Code version and its system prompt; the cached system prompt dominates the full total.
- Only Thai is tested. Other languages may translate better or worse.
- All results are for one Claude model (see Setup); other models may differ.
- The `open` sample is n=100 (fewer if items failed), so its judge counts have wide uncertainty.

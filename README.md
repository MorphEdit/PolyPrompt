# PolyPrompt

Type a prompt in any language and chat with Claude through your own Claude Code.

By default (**ส่งตรง**, direct mode) the message goes to Claude exactly as typed and Claude
answers in the same language: in our [token benchmark](#token-benchmark) this gave clearly
better answers than translating first. The optional **ตอบเป็นอังกฤษแล้วแปลกลับ** (translate mode)
also sends the message as typed, but asks Claude to reply in English; Claude Haiku
(`claude-haiku-5-5`) then translates the reply into your language. This costs about 20% less
and takes about 10 seconds longer per answer, and the answer can read like a translation.
It needs no download: the local translator is not used for new messages.

## Getting started

Requires Node.js 23.6 or newer.

```sh
npm install
npm start
```

Open the URL it prints (default `http://127.0.0.1:3210`; set `PORT` to change it).
A chat without a work folder runs Claude in its own folder, `~/.polyprompt/claude-home` (set `CLAUDE_HOME_DIR` to change it), so it never sees this repo or your files.
The server only listens on `127.0.0.1`.

Run the tests with `npm test`. Install the dependencies first (`npm ci`): the tests
import them, so a fresh checkout without `node_modules` fails.

## Translation model

PolyPrompt translates locally with Google's [TranslateGemma](https://huggingface.co/google/translategemma-4b-it),
run inside the app by [`node-llama-cpp`](https://node-llama-cpp.withcat.ai/) from a GGUF file.
Nothing else needs to be installed.

This local translator is only used to translate old Claude Code sessions ("แชตเก่าจาก Claude Code")
and by the [token benchmark](#token-benchmark). New messages never use it, in either mode:
translate mode translates the reply back with Claude Haiku instead (see [Claude Code](#claude-code)).
Nothing is downloaded or loaded at startup or when you switch to translate mode; the download/load
starts the first time you open an old Claude Code session that is not translated yet.

The first time, the app downloads the default 4B model
(`translategemma-4b-it.Q4_K_M.gguf` from `mradermacher/translategemma-4b-it-GGUF`, about 2.5 GB)
and caches it in `.cache/models/` (git-ignored). The page shows the download progress while an
old session waits for the model. An interrupted download resumes on the next try, and a partial
file is never loaded. Later runs load it from the cache, and translation then works offline.
The GPU is used automatically when there is one (CUDA, Vulkan or Metal); otherwise the model runs
on the CPU, which is slower but works. Set `POLYPROMPT_OFFLINE=1` to forbid any download
(cache only), or `POLYPROMPT_CACHE_DIR` to use another cache folder.

Language detection uses the offline [`eld`](https://github.com/nitotm/efficient-language-detector-js)
library. In translate mode every one of its 60 languages gets the reply translated back by Haiku.
For old sessions, the 47 languages TranslateGemma supports are listed in `src/lang.js`; the others
(for example Amharic or Lao) are shown in English with a note.
Texts with fewer than 3 letters (e.g. "ok", "555") count as "unsure".
If the translation model answers a text instead of translating it (seen on the CPU), the
translation is retried once; if it fails again, the text is shown in English with a note.

## Choosing the models

The model button next to Send (for example "ส่งตรง · Claude ค่าเริ่มต้น", or "แปลกลับ · Claude ค่าเริ่มต้น"
in translate mode) opens a menu with three parts. All choices are saved in `data/settings.json` (next to the chats folder) and kept after a restart.

- **การส่ง (send mode):** ส่งตรง (direct, the default and recommended: the message is sent as
  typed and Claude answers in your language) or ตอบเป็นอังกฤษแล้วแปลกลับ (also sent as typed;
  Claude answers in English and Haiku translates the answer back: about 20% cheaper, about
  10 seconds slower, and the language can read like a translation). The choice
  applies from the next message and the chat keeps its Claude session, so one chat can mix both.
- **ตัวแปลภาษา (size of the local translator, "ใช้แปลแชตเก่าจาก Claude Code"):** shown and
  usable in both modes, but only used for old Claude Code sessions, never for new messages. 4B (default, about 2.5 GB, fast), 12B (about 7.3 GB, better,
  needs more RAM/VRAM) or 27B (about 16.5 GB, best, slow, needs a lot of RAM). The larger sizes are
  optional downloads: picking one that is not downloaded asks first, then downloads it in the
  background while the current model keeps translating, and switches when it is done. If the new
  size cannot be loaded (for example not enough memory), the app goes back to the previous size.
- **Claude:** the model that answers (in translate mode Haiku always translates the answer back;
  that model is fixed). "ค่าเริ่มต้น" (Claude Code's own default), Fable 5.2, Opus 5.5,
  Sonnet 5.5 or Haiku 5.5 (passed as full model IDs; the list is in `public/models.js`). The choice
  applies from the next message; the chat keeps its Claude session. Each answer shows which model
  wrote it when that is not the picked one. If Claude refuses the picked model, the chat shows the
  error and the picker goes back to the previous model; when the installed Claude Code is too old
  for the model, the message says to run `claude update`.

## Claude Code

PolyPrompt sends the prompt as typed to Claude through your own
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI, so Claude Code
must be installed and logged in: run `claude` once in a terminal and type `/login`.
No API key is used. Each chat continues its own Claude Code session. If `claude`
is missing, not logged in, fails or sends nothing for 5 minutes (time spent on a
permission card doesn't count), the message stays in the chat with an error and a
"ส่งใหม่" (retry) button.

- **Without a work folder** (the default) Claude is a general assistant that can
  only search and fetch the web.
- **With a work folder** ("📁 เลือกโฟลเดอร์" in a new chat, before the first
  message) Claude runs in that folder as normal Claude Code: its system prompt,
  settings, CLAUDE.md, your MCP servers and all tools. Reading files and the web
  is free. Every file change, command or other tool asks first with a card in the
  chat ("อนุญาต", "อนุญาตตลอดในแชตนี้", "ไม่อนุญาต") showing the exact English
  action. "อนุญาตตลอดในแชตนี้" is stored on that chat only; for commands it covers
  the same first two words, and a command with `;`, `&&`, `|`, `>` and the like
  always asks. Claude runs with your own permissions: there is no extra sandbox.
- **Translate mode** asks Claude to reply in English: a chat without a work folder adds
  "Always write your reply in English, whatever language the user writes in." to its system
  prompt, and a folder chat passes that sentence with `--append-system-prompt` (keeping Claude
  Code's own system prompt). When your language is not English and the reply is not already in
  it, one more `claude` call with `--model claude-haiku-5-5` translates the reply back. It runs
  with no tools, `--no-session-persistence` and no `--resume`, always in the Claude home folder
  (never the chat's work folder), so it never touches the chat's session. It uses a little
  extra quota. "ดูต้นฉบับภาษาอังกฤษ" shows Claude's English. If the translation back fails
  (error, timeout, empty output, quota or login) or you stop it with "หยุด", the English reply
  is shown with a note that it was not translated; the message itself never fails because of it.
- While Claude works the chat shows each step (never translated). "หยุด" stops
  it; what it wrote so far is kept and the next message continues the session.
- The sidebar section "แชตเก่าจาก Claude Code" lists the folder's older Claude Code
  sessions (from `~/.claude/projects`, or `CLAUDE_PROJECTS_DIR`). Opening one
  shows it translated to Thai (cached in `data/claude-sessions/`); typing in it
  continues that session in PolyPrompt.

## Token benchmark

Does PolyPrompt save tokens, and what does it cost in quality? `npm run bench:tokens`
sends the same Thai items to Claude directly (A) and through PolyPrompt (B), with the
same model and the same `claude` args, and writes every raw result to
`bench/results/<run>/`. `npm run bench:report -- --run <id>` then writes `REPORT.md`
there: tokens, accuracy, a blind judge for open questions, time and failures.
Condition B is the local-translate pipeline (the prompt translated to English and the
answer back with TranslateGemma); `bench:tokens` does not test the current translate mode.

The current translate mode (prompt as typed, reply in English, Haiku translates it back) comes
from a one-off follow-up experiment, not a `bench:tokens` run, on the same 30 open items: the
blind judge preferred direct in 23 pairs, the Haiku pipeline in 1, with 6 ties (the
local-translate pipeline lost all 30). Total cost, Haiku included, was 22% lower than direct
(−22%), and each answer took about 9 s longer. Its scripts and data are not in the repo, and
`bench:tokens` is unchanged.

```
npm run bench:tokens -- [--sets mgsm,belebele,open] [--model claude-opus-5-5]
  [--judge-model claude-opus-5-5] [--translator 4b] [--limit N] [--concurrency 1]
  [--run <id>] [--retry-failed]
npm run bench:report -- --run <id>
```

- The items come from three public datasets at pinned revisions (MGSM, Belebele,
  WangchanThaiInstruct), checked by SHA-256 and cached in `.cache/bench/`. The
  frozen, seeded sample is `bench/sample.json`.
- Rerunning with the same `--run` resumes; `--retry-failed` reruns only the
  failed items, and judges any `open` item whose answers it just repaired. A resume may add other `--sets` to the run, but must keep its
  `--model`, `--judge-model` and `--translator` (use a new `--run` to change them). When Claude's usage quota runs out the run stops (exit code 2)
  and can be resumed later with the same `--run`.
- It uses real Claude calls and your quota; it is not part of `npm test`.

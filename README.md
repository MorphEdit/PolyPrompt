# PolyPrompt

Type a prompt in any language; PolyPrompt translates it to English and sends it to an AI.

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

On the first `npm start` the app downloads the default 4B model
(`translategemma-4b-it.Q4_K_M.gguf` from `mradermacher/translategemma-4b-it-GGUF`, about 2.5 GB)
and caches it in `.cache/models/` (git-ignored). The page shows the download progress; sending is
blocked until the model is ready. An interrupted download resumes on the next try, and a partial
file is never loaded. Later runs load it from the cache, and translation then works offline.
The GPU is used automatically when there is one (CUDA, Vulkan or Metal); otherwise the model runs
on the CPU, which is slower but works. Set `POLYPROMPT_OFFLINE=1` to forbid any download
(cache only), or `POLYPROMPT_CACHE_DIR` to use another cache folder.

Language detection uses the offline [`eld`](https://github.com/nitotm/efficient-language-detector-js)
library. The 47 detected languages TranslateGemma supports are listed in `src/lang.js`; the others
(for example Amharic or Lao) get Claude's answer in English with a note.
Texts with fewer than 3 letters (e.g. "ok", "555") count as "unsure".
If the translation model answers a message instead of translating it (seen on the CPU), the
translation is retried once; if it fails again, Claude gets the message as typed, or the answer
is shown in English, each with a note.

## Choosing the models

The model button next to Send (for example "แปล 4B · Claude ค่าเริ่มต้น") opens a menu with two parts.
Both choices are saved in `data/settings.json` (next to the chats folder) and kept after a restart.

- **ตัวแปลภาษา (translator size):** 4B (default, about 2.5 GB, fast), 12B (about 7.3 GB, better,
  needs more RAM/VRAM) or 27B (about 16.5 GB, best, slow, needs a lot of RAM). The larger sizes are
  optional downloads: picking one that is not downloaded asks first, then downloads it in the
  background while the current model keeps translating, and switches when it is done. If the new
  size cannot be loaded (for example not enough memory), the app goes back to the previous size.
- **Claude:** "ค่าเริ่มต้น" (Claude Code's own default), Fable 5.2, Opus 5.5,
  Sonnet 5.5 or Haiku 5.5 (passed as full model IDs; the list is in `public/models.js`). The choice
  applies from the next message; the chat keeps its Claude session. Each answer shows which model
  wrote it when that is not the picked one. If Claude refuses the picked model, the chat shows the
  error and the picker goes back to the previous model.

## Claude Code

PolyPrompt sends the English prompt to Claude through your own
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
- While Claude works the chat shows each step (never translated). "หยุด" stops
  it; what it wrote so far is kept and the next message continues the session.
- The sidebar section "แชตเก่าจาก Claude Code" lists the folder's older Claude Code
  sessions (from `~/.claude/projects`, or `CLAUDE_PROJECTS_DIR`). Opening one
  shows it translated to Thai (cached in `data/claude-sessions/`); typing in it
  continues that session in PolyPrompt.

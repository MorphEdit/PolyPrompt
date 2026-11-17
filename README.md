# PolyPrompt

Type a prompt in any language; PolyPrompt translates it to English and sends it to an AI.

## Getting started

Requires Node.js 23.6 or newer.

```sh
npm install
npm start
```

Open the URL it prints (default `http://127.0.0.1:3210`; set `PORT` to change it).
The server only listens on `127.0.0.1`.

Run the tests with `npm test`.

## Translation model

On the first `npm start` the app downloads the local translation model
(`Xenova/nllb-200-distilled-600M`, 8-bit quantized, about 1 GB) and caches it in
`.cache/models/` (git-ignored). The page shows the download progress; sending is
blocked until the model is ready. Later runs load it from the cache, and
translation then works offline. Set `POLYPROMPT_OFFLINE=1` to forbid any download
(cache only), or `POLYPROMPT_CACHE_DIR` to use another cache folder.

Language detection uses the offline [`eld`](https://github.com/nitotm/efficient-language-detector-js)
library (60 languages, all mapped to NLLB codes in `src/lang.js`).
Texts with fewer than 3 letters (e.g. "ok", "555") count as "unsure".

// Back-translation benchmark (npm run bench:translate; not part of the tests).
// Loads the cached TranslateGemma size, prints prompt-processing and generation
// tok/s, then the time for N EN->TH paragraphs one by one vs in parallel.
// Usage: npm run bench:translate -- [size=4b] [paragraphs=4]
import { performance } from 'node:perf_hooks';
import { getLlama, LlamaChat, GemmaChatWrapper } from 'node-llama-cpp';
import { buildPrompt, downloadModel, isSize, loadTranslateGemma, maxTokensFor } from '../src/translator.js';

const size = isSize(process.argv[2]) ? process.argv[2] : '4b';
const count = Number(process.argv[3]) || 4;

const PARAGRAPHS = [
  'Keep a consistent sleep schedule: go to bed and wake up at the same time every day, even on weekends. '
    + 'This helps your body clock and makes it easier to fall asleep at night.',
  'Before you deploy, run the full test suite locally and check that the build passes. '
    + 'If a test fails, read the error message carefully and fix the cause instead of skipping the test.',
  'Drink enough water during the day, especially when it is hot or when you exercise. '
    + 'A simple rule is to drink a glass of water with every meal and one between meals.',
  'When you write a function, give it one clear job and a name that says what it does. '
    + 'Small functions are easier to test, easier to read and easier to change later.',
];
const paragraphs = Array.from({ length: count }, (_, i) => PARAGRAPHS[i % PARAGRAPHS.length]);

const seconds = (ms) => `${(ms / 1000).toFixed(2)} s`;

// One generation on a fresh single-sequence context: prompt tokens over time to
// the first token, then generated tokens over the rest.
async function measureSpeed(file) {
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath: file });
  const context = await model.createContext({ contextSize: { max: 8192 }, flashAttention: true });
  const chat = new LlamaChat({ contextSequence: context.getSequence(), chatWrapper: new GemmaChatWrapper() });
  const run = async (text) => {
    const prompt = buildPrompt(text, 'en', 'th');
    const promptTokens = model.tokenize(prompt).length;
    let first = 0;
    let generated = 0;
    const start = performance.now();
    await chat.generateResponse([{ type: 'user', text: prompt }, { type: 'model', response: [] }], {
      temperature: 0,
      maxTokens: maxTokensFor(text),
      onToken(tokens) {
        if (!first) first = performance.now();
        generated += tokens.length;
      },
    });
    const end = performance.now();
    return { promptTokens, generated, prompt: first - start, generation: end - first };
  };
  await run('Hi');
  const r = await run(paragraphs[0]);
  console.log(`prompt processing: ${r.promptTokens} tok in ${seconds(r.prompt)} = ${(r.promptTokens / (r.prompt / 1000)).toFixed(0)} tok/s`);
  console.log(`generation: ${r.generated} tok in ${seconds(r.generation)} = ${((r.generated - 1) / (r.generation / 1000)).toFixed(1)} tok/s`);
  chat.dispose();
  await context.dispose();
  await model.dispose();
}

const file = await downloadModel(size, () => {}, { offline: true });
console.log(`TranslateGemma ${size}: ${file}`);
await measureSpeed(file);

let start = performance.now();
const translator = await loadTranslateGemma(() => {}, { size, offline: true });
console.log(`load + warm-up: ${seconds(performance.now() - start)} (${translator.concurrency} sequences)`);

start = performance.now();
const sequential = [];
for (const p of paragraphs) sequential.push(await translator.translate(p, 'en', 'th'));
console.log(`${count} paragraphs one by one: ${seconds(performance.now() - start)}`);

start = performance.now();
const parallel = await Promise.all(paragraphs.map((p) => translator.translate(p, 'en', 'th')));
console.log(`${count} paragraphs in parallel: ${seconds(performance.now() - start)}`);
console.log(`outputs identical: ${parallel.every((out, i) => out === sequential[i])}`);

await translator.dispose();

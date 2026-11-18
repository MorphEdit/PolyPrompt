// Writes bench/results/<run>/REPORT.md from a token benchmark run.
// Usage: npm run bench:report -- --run <id>
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { writeReport } from '../src/bench/report.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { run: { type: 'string' } } });
if (!values.run || !/^[\w.-]+$/.test(values.run)) {
  console.error('usage: npm run bench:report -- --run <id>');
  process.exit(1);
}
const dir = path.join(root, 'bench', 'results', values.run);
const sample = JSON.parse(await readFile(path.join(root, 'bench', 'sample.json'), 'utf8'));
const file = await writeReport(dir, sample);
console.log(file);

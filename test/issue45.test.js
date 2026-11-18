// #45, revised by #53: the Fable picker option sends claude-fable-5-2; the
// claude-fable-5-1 that #45 offered instead is read back as Fable 5.2.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildArgs } from '../src/claude.js';
import { createSettingsStore, isClaudeModel } from '../src/settings.js';
import { CLAUDE_OPTIONS } from '../public/models.js';

test('#45 Fable option uses the model ID claude-fable-5-2', () => {
  const fable = CLAUDE_OPTIONS.find((o) => o.label.startsWith('Fable'));
  assert.deepEqual({ value: fable.value, label: fable.label }, { value: 'claude-fable-5-2', label: 'Fable 5.2' });
  assert.equal(isClaudeModel('claude-fable-5-2'), true);
  assert.equal(isClaudeModel('claude-fable-5-1'), false);
  const args = buildArgs(null, fable.value);
  assert.equal(args[args.indexOf('--model') + 1], 'claude-fable-5-2');
});

test('#45 settings saved with claude-fable-5-1 read back as Fable 5.2', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pp45-'));
  try {
    const file = path.join(dir, 'settings.json');
    await writeFile(file, JSON.stringify({ translatorSize: '4b', claudeModel: 'claude-fable-5-1' }));
    const settings = await createSettingsStore({ file });
    assert.equal(settings.get().claudeModel, 'claude-fable-5-2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

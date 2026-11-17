import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The gate and fresh worktrees run the tests in a new checkout: without `npm ci` every
// test that imports a dependency fails with a bare "Cannot find package" (#15).
test('every package.json dependency is installed', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const missing = [];
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    try {
      import.meta.resolve(name);
    } catch {
      missing.push(name);
    }
  }
  assert.deepEqual(missing, [], `dependencies not installed (${missing.join(', ')}): run npm ci`);
});

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chronicleInternals } from './chronicle.mjs';

test('Chronicle memory keeps authorized work context and hides credentials', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chronicle-context-'));
  try {
    await writeFile(
      path.join(directory, 'work.md'),
      '周宁在 Aurora 群跟进 /Users/demo/Projects/voice-quality/评测方案.md，来源 https://example.com/spec。access_token=top-secret',
    );
    const result = await chronicleInternals.readRecentMemorySignals(directory, Date.now());
    const serialized = JSON.stringify(result);
    assert.equal(result.count, 1);
    assert.match(serialized, /周宁/u);
    assert.match(serialized, /\/Users\/demo\/Projects\/voice-quality\/评测方案\.md/u);
    assert.match(serialized, /https:\/\/example\.com\/spec/u);
    assert.equal(serialized.includes('top-secret'), false);
    assert.match(serialized, /凭证已隐藏/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

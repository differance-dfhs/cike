import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FiveLayerMemoryStore, fiveLayerMemoryInternals } from './five-layer-memory.mjs';

test('imports generic profile and playbook sections into the five layers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-memory-'));
  const profile = path.join(root, 'profile.md');
  const playbook = path.join(root, 'playbook.md');
  await writeFile(profile, '# Their Laws\n\n- Verify current sources before conclusions.\n\n## Current Work System\n\nProject Aurora is in review.\n');
  await writeFile(playbook, '# 执行经验总结\n\n- 先核验再交付。\n\n# 自动化偏好\n\n- 低噪、可回退。\n');
  const store = new FiveLayerMemoryStore(path.join(root, 'data'), {
    homeDir: root,
    sources: [
      { kind: 'profile', path: profile, label: 'Synthetic profile' },
      { kind: 'playbook', path: playbook, label: 'Synthetic playbook' },
    ],
    now: () => new Date('2026-07-22T10:00:00.000Z'),
  });
  await store.init();
  const result = await store.syncPrivateSources();
  assert.equal(result.changed, true);
  assert.equal(result.summary.sourceCount, 2);
  assert.ok(result.summary.layers.find((layer) => layer.id === 'preference').count > 0);
  assert.ok(result.summary.layers.find((layer) => layer.id === 'expertise').count > 0);
  assert.ok(result.summary.layers.find((layer) => layer.id === 'project').count > 0);
  const mode = (await stat(store.filePath)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('sync is idempotent and source content is replaced after a digest change', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-memory-'));
  const sourcePath = path.join(root, 'memory.md');
  await writeFile(sourcePath, '# Project Aurora\n\nFirst phase.\n');
  const store = new FiveLayerMemoryStore(path.join(root, 'data'), {
    sources: [{ kind: 'summary', path: sourcePath, label: 'Synthetic memory' }],
  });
  await store.init();
  const first = await store.syncPrivateSources();
  const second = await store.syncPrivateSources();
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  await writeFile(sourcePath, '# Project Aurora\n\nSecond phase.\n');
  const third = await store.syncPrivateSources();
  assert.equal(third.changed, true);
  assert.equal(store.retrieve({ query: 'Second phase' })[0].content, 'Second phase.');
  assert.equal(store.retrieve({ query: 'First phase' }).some((entry) => entry.content === 'First phase.'), false);
});

test('retrieval prioritizes current and project-matched memory within a bounded prompt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-memory-'));
  const store = new FiveLayerMemoryStore(path.join(root, 'data'), {
    sources: [],
    now: () => new Date('2026-07-22T10:00:00.000Z'),
  });
  await store.init();
  await store.replaceLiveEntries('test', [
    { layer: 'working', title: 'Review release', content: 'Aurora release needs a final review.', projectKey: 'Aurora' },
    { layer: 'project', title: 'Other project', content: 'Unrelated backlog.', projectKey: 'Borealis' },
    { layer: 'preference', title: 'Delivery style', content: 'Lead with the verified result.' },
  ]);
  const selected = store.retrieve({ query: 'Aurora release', projectKey: 'Aurora', maxItems: 2 });
  assert.equal(selected[0].title, 'Review release');
  assert.equal(selected.length, 2);
  const prompt = store.promptContext({ query: 'Aurora release', projectKey: 'Aurora', maxChars: 900 });
  assert.match(prompt, /CIKE_PRIVATE_MEMORY/u);
  assert.ok(prompt.length <= 1_300);
});

test('expired working memory is removed and raw content is never part of public summary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-memory-'));
  let now = new Date('2026-07-22T10:00:00.000Z');
  const store = new FiveLayerMemoryStore(path.join(root, 'data'), { sources: [], now: () => now });
  await store.init();
  await store.replaceLiveEntries('test', [{
    layer: 'working', title: 'Temporary task', content: 'Private task detail', expiresAt: '2026-07-22T11:00:00.000Z',
  }]);
  now = new Date('2026-07-22T12:00:00.000Z');
  await store.prune();
  assert.equal(store.retrieve({ query: 'Temporary' }).length, 0);
  assert.doesNotMatch(JSON.stringify(store.publicSummary()), /Private task detail/u);
  assert.doesNotMatch(await readFile(store.filePath, 'utf8'), /Temporary task/u);
});

test('section classifier keeps durable rules out of current task memory', () => {
  assert.equal(fiveLayerMemoryInternals.layerForChunk('playbook', {
    path: '可复用规则 / UI demo', content: 'Build and verify the real preview.',
  }), 'expertise');
});

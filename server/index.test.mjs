import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startService } from './index.mjs';

test('listener cold start defers the profile baseline until the first engine scan', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-service-lazy-'));
  const dataDir = path.join(root, 'data');
  const profilePath = path.join(root, 'profile', 'ditto_you.md');
  await mkdir(path.dirname(profilePath), { recursive: true });
  await writeFile(profilePath, '- Lazy profile baseline.');
  const service = await startService({
    dataDir,
    profilePath,
    projectRoots: [],
    contextSourcesEnabled: false,
    autoExecute: false,
    port: 0,
    initialScan: false,
  });
  try {
    assert.ok(service.port > 0);
    assert.equal(service.learning.getContext().publicSummary.baselineLoaded, false);
    assert.equal(await service.startupRefresh, null);

    const snapshot = await service.engine.getSnapshot({ force: true, reason: 'manual' });
    assert.equal(snapshot.learning.baselineLoaded, true);
    assert.match(service.learning.getContext().baselineExcerpt, /Lazy profile baseline/u);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('startService preserves the dynamic port getter used by packaged Electron', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cike-service-'));
  const service = await startService({
    dataDir,
    projectRoots: [],
    contextSourcesEnabled: false,
    autoExecute: false,
    port: 0,
    initialScan: false,
  });
  try {
    assert.ok(Number.isInteger(service.port));
    assert.ok(service.port > 0);
    assert.ok(service.deliveryRegistry);
    assert.deepEqual(service.deliveryRegistry.listReferences(), []);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('startService performs one awaitable read-only startup refresh', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cike-service-'));
  const profilePath = path.join(dataDir, 'startup-profile.md');
  await writeFile(profilePath, '- Startup refresh profile baseline.');
  const service = await startService({
    dataDir,
    profilePath,
    projectRoots: [],
    contextSourcesEnabled: false,
    autoExecute: false,
    port: 0,
  });
  try {
    const snapshot = await service.startupRefresh;
    assert.ok(snapshot);
    assert.equal(snapshot.startupSync?.state, 'partial');
    assert.match(snapshot.startupSync?.detail || '', /启动同步已完成/u);
    assert.equal(snapshot.learning.baselineLoaded, true);
    assert.match(service.learning.getContext().baselineExcerpt, /Startup refresh profile baseline/u);
    assert.equal(service.engine.lastSnapshot?.generatedAt, snapshot.generatedAt);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

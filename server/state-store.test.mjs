import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStateStore } from './state-store.mjs';

test('legacy snoozed decisions migrate on disk to terminal saved-for-later records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-state-migration-'));
  const dataDir = path.join(root, 'data');
  const statePath = path.join(dataDir, 'state.json');
  await mkdir(dataDir, { recursive: true });
  await writeFile(statePath, `${JSON.stringify({
    version: 1,
    decisions: {
      'opp-legacy-snoozed': {
        status: 'snoozed',
        snoozedUntil: new Date('2026-07-15T09:00:00.000Z').getTime(),
        updatedAt: '2026-07-15T08:30:00.000Z',
        pendingSpec: {
          schemaVersion: 1,
          recipeId: 'meeting-prep',
          anchor: '旧会议',
          title: '老大，建议会前确认目标。',
          reason: '会议即将开始。',
          priority: 'medium',
          confidence: 0.9,
          due: '会前',
          origin: '飞书日程',
          kind: 'brief',
          autoTrigger: 'proactive-context',
          autoAllowed: false,
          prompt: '',
        },
      },
      'opp-untouched': {
        status: 'archived',
        archiveReason: 'artifact_viewed',
        updatedAt: '2026-07-15T08:00:00.000Z',
      },
    },
    activities: [],
    lastArtifact: null,
  }, null, 2)}\n`, 'utf8');

  try {
    const first = await new JsonStateStore(dataDir).init();
    assert.deepEqual(
      {
        version: first.get().version,
        status: first.get().decisions['opp-legacy-snoozed'].status,
        archiveReason: first.get().decisions['opp-legacy-snoozed'].archiveReason,
        archivedAt: first.get().decisions['opp-legacy-snoozed'].archivedAt,
        snoozedUntil: first.get().decisions['opp-legacy-snoozed'].snoozedUntil,
      },
      {
        version: 2,
        status: 'archived',
        archiveReason: 'saved_for_later',
        archivedAt: '2026-07-15T08:30:00.000Z',
        snoozedUntil: null,
      },
    );
    assert.equal(first.get().decisions['opp-untouched'].archiveReason, 'artifact_viewed');

    const persisted = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(persisted.version, 2);
    assert.equal(persisted.decisions['opp-legacy-snoozed'].status, 'archived');
    assert.equal(persisted.decisions['opp-legacy-snoozed'].archiveReason, 'saved_for_later');
    assert.equal(persisted.decisions['opp-legacy-snoozed'].snoozedUntil, null);

    const restarted = await new JsonStateStore(dataDir).init();
    assert.equal(restarted.get().decisions['opp-legacy-snoozed'].status, 'archived');
    assert.equal(restarted.get().decisions['opp-legacy-snoozed'].archiveReason, 'saved_for_later');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed state write leaves the last persisted in-memory snapshot untouched', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-state-atomic-'));
  try {
    const store = await new JsonStateStore(root).init();
    await store.update((state) => {
      state.decisions.stable = { status: 'active', updatedAt: '2026-07-15T08:00:00.000Z' };
    });
    const persistedPath = store.filePath;
    store.filePath = root;
    await assert.rejects(store.update((state) => {
      state.decisions.stable = { status: 'archived', archiveReason: 'artifact_viewed' };
    }));
    store.filePath = persistedPath;

    assert.equal(store.get().decisions.stable.status, 'active');
    const restarted = await new JsonStateStore(root).init();
    assert.equal(restarted.get().decisions.stable.status, 'active');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

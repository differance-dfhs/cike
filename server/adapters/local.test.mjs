import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalAdapter, localInternals } from './local.mjs';

test('local scan attaches a redacted project label and canonical first-level workspace path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-local-'));
  try {
    const project = path.join(root, '主动 agent');
    const nested = path.join(project, 'notes');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, '主动评测方案.md'), '# test\n');

    const adapter = new LocalAdapter({ roots: [root], now: () => new Date('2026-07-15T08:30:00.000Z') });
    const result = await adapter.collect();
    const file = result.files.find((item) => item.title === '主动评测方案');
    assert.ok(file);
    assert.equal(file.projectLabel, '主动 agent');
    assert.equal(file.workspacePath, await realpath(project));
    assert.equal(path.isAbsolute(file.workspacePath), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local scan does not traverse a symlinked project directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-local-root-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'cike-local-outside-'));
  try {
    await writeFile(path.join(outside, 'secret.md'), 'secret\n');
    await symlink(outside, path.join(root, 'linked-project'));
    const files = await localInternals.scanRoot(root, { maxDepth: 2, maxDirectories: 20, maxFiles: 20 });
    assert.deepEqual(files, []);
    const projects = await localInternals.inventoryProjects(root);
    assert.equal(projects.some((project) => project.projectLabel === 'linked-project'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('project inventory remains complete when a project falls outside the recent-file slice', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-local-inventory-'));
  try {
    const aiTakeover = path.join(root, '客户支持');
    const busyProject = path.join(root, '录音');
    await Promise.all([mkdir(aiTakeover), mkdir(busyProject)]);
    const staleFile = path.join(aiTakeover, '题库与评测标准.md');
    await writeFile(staleFile, '# stale but routable\n');
    await utimes(staleFile, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));
    await Promise.all(Array.from({ length: 125 }, async (_, index) => {
      const file = path.join(busyProject, `语音质量评估-${index}.md`);
      await writeFile(file, `# ${index}\n`);
      await utimes(file, new Date('2026-07-15T10:00:00.000Z'), new Date('2026-07-15T10:00:00.000Z'));
    }));

    const result = await new LocalAdapter({ roots: [root] }).collect();
    assert.equal(result.files.length, 120);
    assert.equal(result.files.some((file) => file.projectLabel === '客户支持'), false);
    const inventoryEntry = result.projects.find((project) => project.projectLabel === '客户支持');
    assert.ok(inventoryEntry);
    assert.equal(inventoryEntry.workspacePath, await realpath(aiTakeover));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local adapter keeps more than twelve internal candidates for project matching', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-local-many-'));
  try {
    const project = path.join(root, '反馈平台');
    await mkdir(project);
    await Promise.all(
      Array.from({ length: 25 }, (_, index) => writeFile(path.join(project, `需求文档-${index}.md`), `# ${index}\n`)),
    );
    const result = await new LocalAdapter({ roots: [root] }).collect();
    assert.equal(result.files.length, 25);
    assert.ok(result.files.every((file) => file.projectLabel === '反馈平台'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

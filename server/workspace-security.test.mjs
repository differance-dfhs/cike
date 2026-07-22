import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateWorkspacePath } from './workspace-security.mjs';

test('workspace validation accepts only a real directory below a configured root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-workspace-root-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'cike-workspace-outside-'));
  try {
    const project = path.join(root, 'project');
    await mkdir(project);
    assert.equal(await validateWorkspacePath(project, [root]), await realpath(project));
    await assert.rejects(validateWorkspacePath(outside, [root]), { code: 'WORKSPACE_OUTSIDE_ALLOWED_ROOTS' });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('workspace validation rejects a symlink even when it is located below an allowed root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-workspace-root-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'cike-workspace-outside-'));
  try {
    const link = path.join(root, 'linked-project');
    await symlink(outside, link);
    await assert.rejects(validateWorkspacePath(link, [root]), { code: 'INVALID_WORKSPACE_PATH' });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

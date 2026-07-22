import { lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function configuredProjectRoots(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const configured = String(env.PROACTIVE_AGENT_PROJECT_ROOTS || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  return configured.length ? configured : [path.join(homeDir, 'Documents')];
}

export function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function resolveConfiguredRoot(rootPath) {
  try {
    const directInfo = await lstat(rootPath);
    if (!directInfo.isDirectory() || directInfo.isSymbolicLink()) return null;
    const canonical = await realpath(rootPath);
    const canonicalInfo = await lstat(canonical);
    if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink()) return null;
    return canonical;
  } catch {
    return null;
  }
}

export async function validateWorkspacePath(workspacePath, configuredRoots) {
  if (!workspacePath || !path.isAbsolute(workspacePath)) {
    const error = new Error('工作区路径无效。');
    error.code = 'INVALID_WORKSPACE_PATH';
    throw error;
  }

  let directInfo;
  let canonical;
  try {
    directInfo = await lstat(workspacePath);
    if (!directInfo.isDirectory() || directInfo.isSymbolicLink()) throw new Error('invalid directory');
    canonical = await realpath(workspacePath);
    const canonicalInfo = await lstat(canonical);
    if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink()) throw new Error('invalid canonical directory');
  } catch {
    const error = new Error('工作区路径不可用。');
    error.code = 'INVALID_WORKSPACE_PATH';
    throw error;
  }

  const roots = await Promise.all((configuredRoots || []).map((root) => resolveConfiguredRoot(root)));
  if (!roots.filter(Boolean).some((root) => isPathInside(canonical, root))) {
    const error = new Error('工作区不在允许的项目根目录内。');
    error.code = 'WORKSPACE_OUTSIDE_ALLOWED_ROOTS';
    throw error;
  }
  return canonical;
}

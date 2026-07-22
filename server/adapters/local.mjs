import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { safeLabel } from '../security.mjs';
import { configuredProjectRoots, isPathInside, resolveConfiguredRoot } from '../workspace-security.mjs';

const ALLOWED_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.html',
  '.csv',
  '.json',
  '.jsonl',
  '.js',
  '.mjs',
  '.ts',
  '.tsx',
  '.py',
  '.docx',
  '.pdf',
]);
const SKIP_NAMES = new Set(['.git', '.data', 'node_modules', 'dist', 'Library', '.Trash', '.cache']);

function classifyFileTopic(fileName) {
  const normalized = fileName.toLocaleLowerCase('zh-CN');
  if (/(?:论文|research|paper|前沿)/iu.test(normalized)) return '业界前沿研究';
  if (/(?:主动|proactive|agent)/iu.test(normalized)) return '主动 Agent';
  if (/(?:录音|recording|speaker|asr)/iu.test(normalized)) return '语音质量评估';
  if (/(?:评测|eval|judge|rubric|benchmark)/iu.test(normalized)) return '评测工作';
  return '本地项目';
}

async function scanRoot(rootPath, limits) {
  const canonicalRoot = await resolveConfiguredRoot(rootPath);
  if (!canonicalRoot) return [];
  const files = [];
  const queue = [
    {
      dir: canonicalRoot,
      depth: 0,
      workspacePath: canonicalRoot,
      projectLabel: safeLabel(path.basename(canonicalRoot), '本地项目', 64),
    },
  ];
  let visitedDirectories = 0;

  while (queue.length && visitedDirectories < limits.maxDirectories && files.length < limits.maxFiles) {
    const current = queue.shift();
    visitedDirectories += 1;
    let entries;
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
      const filePath = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < limits.maxDepth) {
          try {
            const directInfo = await lstat(filePath);
            if (!directInfo.isDirectory() || directInfo.isSymbolicLink()) continue;
            const canonicalDirectory = await realpath(filePath);
            if (!isPathInside(canonicalDirectory, canonicalRoot)) continue;
            queue.push({
              dir: canonicalDirectory,
              depth: current.depth + 1,
              workspacePath: current.depth === 0 ? canonicalDirectory : current.workspacePath,
              projectLabel:
                current.depth === 0
                  ? safeLabel(path.basename(canonicalDirectory), '本地项目', 64)
                  : current.projectLabel,
            });
          } catch {
            // Ignore directories that move or change type during the scan.
          }
        }
        continue;
      }
      if (!entry.isFile() || !ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLocaleLowerCase())) continue;
      try {
        const info = await lstat(filePath);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        files.push({
          title: safeLabel(path.basename(entry.name, path.extname(entry.name)), '未命名文件', 72),
          fileName: entry.name,
          path: filePath,
          topic: classifyFileTopic(entry.name),
          projectLabel: current.projectLabel,
          workspacePath: current.workspacePath,
          modifiedAt: info.mtime.toISOString(),
        });
      } catch {
        // Ignore files that changed while scanning.
      }
      if (files.length >= limits.maxFiles) break;
    }
  }
  return files;
}

async function inventoryProjects(rootPath, maxProjects = 512) {
  const canonicalRoot = await resolveConfiguredRoot(rootPath);
  if (!canonicalRoot) return [];

  const projects = [{
    projectLabel: safeLabel(path.basename(canonicalRoot), '本地项目', 64),
    workspacePath: canonicalRoot,
  }];
  let entries;
  try {
    entries = await readdir(canonicalRoot, { withFileTypes: true });
  } catch {
    return projects;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))) {
    if (projects.length >= maxProjects) break;
    if (SKIP_NAMES.has(entry.name) || entry.name.startsWith('.') || !entry.isDirectory()) continue;
    const directPath = path.join(canonicalRoot, entry.name);
    try {
      // Dirent data can race with filesystem changes. Re-check the direct entry,
      // reject symlinks, and require the canonical path to remain below the root.
      const directInfo = await lstat(directPath);
      if (!directInfo.isDirectory() || directInfo.isSymbolicLink()) continue;
      const workspacePath = await realpath(directPath);
      const canonicalInfo = await lstat(workspacePath);
      if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink()) continue;
      if (!isPathInside(workspacePath, canonicalRoot)) continue;
      projects.push({
        projectLabel: safeLabel(path.basename(workspacePath), '本地项目', 64),
        workspacePath,
      });
    } catch {
      // Ignore entries that disappear or change type while inventorying.
    }
  }
  return projects;
}

export class LocalAdapter {
  constructor(options = {}) {
    this.roots = options.roots ?? configuredProjectRoots();
    this.now = options.now || (() => new Date());
  }

  async collect() {
    const roots = this.roots.slice(0, 4);
    if (!roots.length) {
      return {
        state: 'unavailable',
        files: [],
        projects: [],
        lastSeen: null,
        source: {
          id: 'local',
          name: '项目目录',
          state: 'unavailable',
          detail: '尚未选择允许此刻读取和工作的项目目录。',
        },
        issue: {
          source: '项目目录',
          message: '尚未选择项目目录。',
          recovery: '选择一个项目根目录后重新启动。',
        },
      };
    }
    const [batches, projectBatches] = await Promise.all([
      Promise.all(
        roots.map((rootPath) =>
          scanRoot(rootPath, { maxDepth: 2, maxDirectories: 80, maxFiles: 500 }),
        ),
      ),
      Promise.all(roots.map((rootPath) => inventoryProjects(rootPath))),
    ]);
    const files = batches
      .flat()
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
      .slice(0, 120);
    const projects = [...new Map(
      projectBatches.flat().map((project) => [project.workspacePath, project]),
    ).values()];
    const lastSeen = files[0]?.modifiedAt || this.now().toISOString();
    return {
      state: 'available',
      files,
      // Internal-only workspace inventory. The engine consumes it for safe
      // routing but never serializes paths into the renderer snapshot.
      projects,
      lastSeen,
      source: {
        id: 'local',
        name: '本地资料',
        state: 'available',
        detail: `已只读检查最近的 ${files.length} 个项目文件，保留完整文件名与路径用于任务关联。`,
        lastSeen,
      },
    };
  }
}

export const localInternals = { classifyFileTopic, inventoryProjects, scanRoot };

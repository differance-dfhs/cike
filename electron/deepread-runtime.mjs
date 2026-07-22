import { spawn } from 'node:child_process';
import { access, lstat, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEEPREAD_ORIGIN = 'http://127.0.0.1:4173';
const HEALTH_TIMEOUT_MS = 1_500;
const START_TIMEOUT_MS = 12_000;
const HEALTH_RETRY_DELAY_MS = 120;

function boundedTimeout(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function health(fetchImpl = fetch, requestedTimeoutMs = HEALTH_TIMEOUT_MS) {
  const timeoutMs = boundedTimeout(requestedTimeoutMs, HEALTH_TIMEOUT_MS);
  const controller = new AbortController();
  let timeoutId;
  const timedOut = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, occupied: false });
    }, timeoutMs);
  });
  const probed = (async () => {
    try {
      const response = await fetchImpl(`${DEEPREAD_ORIGIN}/api/health`, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      const payload = await response.json();
      return response.ok
        && payload?.ok === true
        && payload?.service === 'deepread-paper-reader'
        && payload?.apiVersion === 1
        ? { ok: true, payload }
        : { ok: false, occupied: true };
    } catch {
      return { ok: false, occupied: false };
    }
  })();

  try {
    return await Promise.race([probed, timedOut]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function firstExecutable(candidates) {
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate)) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next portable Codex installation candidate.
    }
  }
  return null;
}

function codexCandidates(env = process.env, homeDir = os.homedir()) {
  return [
    String(env.PROACTIVE_AGENT_CODEX_BIN || '').trim(),
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    path.join(homeDir, '.local', 'bin', 'codex'),
    path.join(homeDir, '.codex', 'bin', 'codex'),
  ];
}

function runtimeRoot({ isPackaged, resourcesPath, projectRoot, env = process.env }) {
  const configured = String(env.DEEPREAD_RUNTIME_ROOT || '').trim();
  if (configured && path.isAbsolute(configured)) return path.normalize(configured);
  return isPackaged
    ? path.join(resourcesPath, 'deepread-runtime')
    : path.join(projectRoot, 'vendor', 'deepread-runtime');
}

async function waitUntilHealthy(child, fetchImpl, options = {}) {
  const startTimeoutMs = boundedTimeout(options.startTimeoutMs, START_TIMEOUT_MS);
  const healthTimeoutMs = boundedTimeout(options.healthTimeoutMs, HEALTH_TIMEOUT_MS);
  const retryDelayMs = boundedTimeout(options.retryDelayMs, HEALTH_RETRY_DELAY_MS);
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    const result = await health(fetchImpl, Math.min(healthTimeoutMs, remainingMs));
    if (result.ok) return true;
    if (result.occupied) return false;
    const retryInMs = Math.min(retryDelayMs, Math.max(0, deadline - Date.now()));
    if (retryInMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryInMs));
    }
  }
  return false;
}

export async function ensureDeepReadRuntime(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const existing = await health(fetchImpl, options.healthTimeoutMs);
  if (existing.ok) {
    return {
      state: 'connected',
      owned: false,
      source: {
        id: 'deepread', name: '论文阅读器', state: 'connected',
        detail: 'DeepRead 已连接，论文原文和中文版可预载后直接打开。',
      },
      async close() {},
    };
  }
  if (existing.occupied) throw new Error('DeepRead 端口被其他服务占用。');

  const root = runtimeRoot(options);
  const serverPath = path.join(root, 'server.mjs');
  const info = await lstat(serverPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('DeepRead 运行时不可用。');
  const codexBinary = await firstExecutable(codexCandidates(options.env, options.homeDir));
  if (!codexBinary) throw new Error('DeepRead 找不到 Codex 执行引擎。');

  const bundleRoot = path.join(options.dataDir, 'papers');
  await mkdir(bundleRoot, { recursive: true, mode: 0o700 });
  const importRoots = [...new Set((options.projectRoots || [])
    .filter((root) => typeof root === 'string' && path.isAbsolute(root))
    .map((root) => path.normalize(root)))]
    .slice(0, 4);
  const child = (options.spawnProcess || spawn)(process.execPath, [
    serverPath,
    '--production',
    '--host', '127.0.0.1',
    '--port', '4173',
  ], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DEEPREAD_BUNDLE_ROOT: bundleRoot,
      DEEPREAD_CODEX_BIN: codexBinary,
      ...(importRoots.length ? { DEEPREAD_IMPORT_ROOTS: importRoots.join(path.delimiter) } : {}),
    },
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });

  if (!(await waitUntilHealthy(child, fetchImpl, options))) {
    child.kill('SIGTERM');
    throw new Error('DeepRead 启动后未通过健康检查。');
  }

  let closed = false;
  return {
    state: 'connected',
    owned: true,
    source: {
      id: 'deepread', name: '论文阅读器', state: 'connected',
      detail: '内置 DeepRead 已启动，论文原文和中文版可预载后直接打开。',
    },
    async close() {
      if (closed || child.exitCode !== null) return;
      closed = true;
      child.kill('SIGTERM');
    },
  };
}

export const deepReadRuntimeInternals = {
  DEEPREAD_ORIGIN,
  HEALTH_TIMEOUT_MS,
  START_TIMEOUT_MS,
  codexCandidates,
  health,
  runtimeRoot,
  waitUntilHealthy,
};

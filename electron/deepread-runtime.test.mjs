import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deepReadRuntimeInternals, ensureDeepReadRuntime } from './deepread-runtime.mjs';

function response(payload, ok = true) {
  return { ok, json: async () => structuredClone(payload) };
}

test('an already healthy loopback DeepRead is reused without spawning', async () => {
  let spawned = false;
  const runtime = await ensureDeepReadRuntime({
    fetchImpl: async () => response({ ok: true, service: 'deepread-paper-reader', apiVersion: 1 }),
    spawnProcess: () => { spawned = true; },
  });
  assert.equal(runtime.state, 'connected');
  assert.equal(runtime.owned, false);
  assert.equal(spawned, false);
});

test('a health probe has a hard timeout when fetch never settles', { timeout: 500 }, async () => {
  let signal;
  const startedAt = Date.now();
  const result = await deepReadRuntimeInternals.health((_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  }, 20);

  assert.deepEqual(result, { ok: false, occupied: false });
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - startedAt < 400);
});

test('a bundled DeepRead helper starts with isolated user data and the resolved Codex binary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-deepread-runtime-'));
  const runtimeRoot = path.join(root, 'runtime');
  const dataDir = path.join(root, 'data');
  const codexBinary = path.join(root, 'codex');
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(path.join(runtimeRoot, 'server.mjs'), 'export {};\n');
  await writeFile(codexBinary, 'binary');
  const calls = [];
  let healthChecks = 0;
  const child = { exitCode: null, killed: false, kill() { this.killed = true; } };
  try {
    const runtime = await ensureDeepReadRuntime({
      isPackaged: true,
      resourcesPath: root,
      projectRoot: root,
      dataDir,
      projectRoots: [path.join(root, 'Documents')],
      env: {
        DEEPREAD_RUNTIME_ROOT: runtimeRoot,
        PROACTIVE_AGENT_CODEX_BIN: codexBinary,
      },
      fetchImpl: async () => {
        healthChecks += 1;
        if (healthChecks === 1) throw new Error('not running');
        return response({ ok: true, service: 'deepread-paper-reader', apiVersion: 1 });
      },
      spawnProcess: (command, args, options) => {
        calls.push({ command, args, options });
        return child;
      },
    });
    assert.equal(runtime.owned, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.includes('--production'), true);
    assert.equal(calls[0].options.env.DEEPREAD_CODEX_BIN, codexBinary);
    assert.equal(calls[0].options.env.DEEPREAD_BUNDLE_ROOT, path.join(dataDir, 'papers'));
    assert.equal(calls[0].options.env.DEEPREAD_IMPORT_ROOTS, path.join(root, 'Documents'));
    await runtime.close();
    assert.equal(child.killed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packaged runtime resolves only below Electron resources unless explicitly overridden', () => {
  assert.equal(
    deepReadRuntimeInternals.runtimeRoot({
      isPackaged: true,
      resourcesPath: '/Applications/此刻.app/Contents/Resources',
      projectRoot: '/tmp/project',
      env: {},
    }),
    '/Applications/此刻.app/Contents/Resources/deepread-runtime',
  );
});

test('startup waiting stays within its deadline when health fetch never settles', { timeout: 500 }, async () => {
  const child = { exitCode: null };
  const startedAt = Date.now();
  const healthy = await deepReadRuntimeInternals.waitUntilHealthy(
    child,
    () => new Promise(() => {}),
    { healthTimeoutMs: 20, startTimeoutMs: 45, retryDelayMs: 5 },
  );

  assert.equal(healthy, false);
  assert.ok(Date.now() - startedAt < 400);
});

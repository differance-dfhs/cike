import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHttpService } from './http-service.mjs';

async function withArtifactService(run, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-artifact-http-'));
  const artifactsDir = path.join(root, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const service = createHttpService({
    host: '127.0.0.1',
    port: 0,
    engine: options.engine || { getSnapshot: async () => ({ ok: true }) },
    runner: {
      artifactsDir,
      listJobs: () => [],
      getJob: () => null,
    },
    accessToken: options.accessToken,
  });
  try {
    await service.listen();
    const address = service.server.address();
    await run({ artifactsDir, baseUrl: `http://127.0.0.1:${address.port}` });
  } finally {
    service.server.closeAllConnections?.();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('session token protects the loopback API and dynamic port is reported after listen', async () => {
  await withArtifactService(async ({ baseUrl }) => {
    const missing = await fetch(`${baseUrl}/api/snapshot`);
    assert.equal(missing.status, 401);
    const wrong = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { 'X-Cike-Session-Token': 'wrong-token' },
    });
    assert.equal(wrong.status, 401);
    const allowed = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { 'X-Cike-Session-Token': 'session-secret' },
    });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { ok: true });
  }, { accessToken: 'session-secret' });
});

test('feedback and semantic interaction endpoints stay inside the local engine contract', async () => {
  const calls = [];
  const snapshot = { generatedAt: '2026-07-16T09:00:00.000Z', opportunities: [] };
  const engine = {
    getSnapshot: async () => snapshot,
    rateOpportunity: async (id, rating, note) => {
      calls.push({ kind: 'feedback', id, rating, note });
      return { snapshot };
    },
    recordInteraction: async (input) => {
      calls.push(input);
      return { ok: true };
    },
  };
  await withArtifactService(async ({ baseUrl }) => {
    const feedback = await fetch(`${baseUrl}/api/opportunities/opp-feedback/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: 'bad', note: '项目判断不准' }),
    });
    assert.equal(feedback.status, 200);
    assert.deepEqual(await feedback.json(), snapshot);

    const interaction = await fetch(`${baseUrl}/api/interactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'project_opened', projectId: 'project-1' }),
    });
    assert.equal(interaction.status, 200);
    assert.deepEqual(await interaction.json(), { ok: true });
  }, { engine });
  assert.deepEqual(calls, [
    { kind: 'feedback', id: 'opp-feedback', rating: 'bad', note: '项目判断不准' },
    { kind: 'project_opened', projectId: 'project-1' },
  ]);
});

test('artifact GET preserves its body but makes active and external content inert', async () => {
  await withArtifactService(async ({ artifactsDir, baseUrl }) => {
    const html = '<!doctype html><style>body{color:#123}</style><script src="https://evil.test/a.js"></script><img src="https://evil.test/pixel">\n结果';
    await writeFile(path.join(artifactsDir, 'result.html'), html, 'utf8');

    const response = await fetch(`${baseUrl}/api/artifacts/result.html`, {
      headers: { Origin: 'http://127.0.0.1:5189' },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), html);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('content-disposition'), 'inline; filename="result.html"');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5189');
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /script-src 'none'/u);
    assert.match(csp, /img-src data:/u);
    assert.match(csp, /frame-ancestors 'none'/u);
    assert.match(csp, /sandbox/u);
    assert.equal(csp.includes('https:'), false);
    assert.match(response.headers.get('permissions-policy'), /camera=\(\)/u);
  });
});

test('query parameters cannot opt an artifact into framing', async () => {
  await withArtifactService(async ({ artifactsDir, baseUrl }) => {
    await writeFile(path.join(artifactsDir, 'result.html'), '<h1>本地结果</h1>', 'utf8');
    const response = await fetch(`${baseUrl}/api/artifacts/result.html?view=embed`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/u);
  });
});

test('artifact serving rejects traversal and symbolic links', async () => {
  await withArtifactService(async ({ artifactsDir, baseUrl }) => {
    const target = path.join(path.dirname(artifactsDir), 'private.html');
    await writeFile(target, '<h1>private</h1>', 'utf8');
    await symlink(target, path.join(artifactsDir, 'linked.html'));

    const traversal = await fetch(`${baseUrl}/api/artifacts/%2e%2e%2fprivate.html`);
    assert.equal(traversal.status, 400);
    const linked = await fetch(`${baseUrl}/api/artifacts/linked.html`);
    assert.equal(linked.status, 400);
  });
});

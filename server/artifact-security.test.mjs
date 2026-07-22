import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARTIFACT_PREVIEW_LIMIT_BYTES,
  artifactNameFromPathname,
  artifactResponseHeaders,
  DIRECT_ARTIFACT_CSP,
  isSafeAppNavigation,
  isSafeEmbeddedFrameNavigation,
  normalizeLocalArtifactUrl,
  readArtifactResponse,
} from './artifact-security.mjs';

test('artifact path parser accepts only a single bounded safe file name', () => {
  assert.equal(artifactNameFromPathname('/api/artifacts/result-1.html'), 'result-1.html');
  assert.equal(artifactNameFromPathname('/api/artifacts/note.md'), 'note.md');
  assert.equal(artifactNameFromPathname('/api/artifacts/%2e%2e%2fsecret.html'), null);
  assert.equal(artifactNameFromPathname('/api/artifacts/result.svg'), null);
  assert.equal(artifactNameFromPathname('/api/artifacts/result.html/extra'), null);
});

test('local artifact URL normalizer rejects other ports, hosts, schemes, and non-HTML previews', () => {
  assert.equal(
    normalizeLocalArtifactUrl('/api/artifacts/result.html?token=discarded', { htmlOnly: true }),
    'http://127.0.0.1:4318/api/artifacts/result.html',
  );
  assert.equal(
    normalizeLocalArtifactUrl('http://localhost:4318/api/artifacts/result.html', { htmlOnly: true }),
    'http://127.0.0.1:4318/api/artifacts/result.html',
  );
  assert.equal(normalizeLocalArtifactUrl('http://127.0.0.1:9999/api/artifacts/result.html'), null);
  assert.equal(normalizeLocalArtifactUrl('https://127.0.0.1:4318/api/artifacts/result.html'), null);
  assert.equal(normalizeLocalArtifactUrl('http://example.com/api/artifacts/result.html'), null);
  assert.equal(normalizeLocalArtifactUrl('javascript:alert(1)'), null);
  assert.equal(normalizeLocalArtifactUrl('/api/artifacts/result.md', { htmlOnly: true }), null);
  assert.equal(
    normalizeLocalArtifactUrl('http://127.0.0.1:58421/api/artifacts/result.html', {
      origin: 'http://127.0.0.1:58421',
      htmlOnly: true,
    }),
    'http://127.0.0.1:58421/api/artifacts/result.html',
  );
});

test('preview reader supports the four artifact extensions through safe content types', async () => {
  const html = await readArtifactResponse(new Response('<h1>结果</h1>', {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  }));
  assert.deepEqual(html, { content: '<h1>结果</h1>', contentType: 'text/html' });

  const text = await readArtifactResponse(new Response('# 摘要', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  }));
  assert.deepEqual(text, { content: '# 摘要', contentType: 'text/plain' });

  const json = await readArtifactResponse(new Response('{"ok":true}', {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  }));
  assert.deepEqual(json, { content: '{"ok":true}', contentType: 'application/json' });
});

test('preview reader enforces a 2 MiB cap and returns no source path in failures', async () => {
  assert.equal(ARTIFACT_PREVIEW_LIMIT_BYTES, 2 * 1024 * 1024);
  const declaredOversize = new Response('small', {
    headers: {
      'Content-Type': 'text/html',
      'Content-Length': String(ARTIFACT_PREVIEW_LIMIT_BYTES + 1),
      'X-Private-Path': '/Users/example/private/result.html',
    },
  });
  await assert.rejects(
    readArtifactResponse(declaredOversize),
    (error) => error.message === 'artifact too large' && !error.message.includes('/Users/'),
  );

  const undeclaredOversize = new Response('123456789', { headers: { 'Content-Type': 'text/plain' } });
  await assert.rejects(readArtifactResponse(undeclaredOversize, { limit: 8 }), /artifact too large/u);
  await assert.rejects(
    readArtifactResponse(new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } })),
    /artifact unavailable/u,
  );
});

test('artifact policy blocks scripts, network resources, framing, forms, and privileged APIs', () => {
  const headers = artifactResponseHeaders();
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.match(headers['Content-Security-Policy'], /script-src 'none'/u);
  assert.match(headers['Content-Security-Policy'], /img-src data:/u);
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/u);
  assert.match(headers['Content-Security-Policy'], /form-action 'none'/u);
  assert.match(headers['Content-Security-Policy'], /sandbox/u);
  assert.equal(DIRECT_ARTIFACT_CSP.includes('https:'), false);
  assert.equal(DIRECT_ARTIFACT_CSP.includes("script-src 'unsafe-inline'"), false);
  assert.match(headers['Permissions-Policy'], /camera=\(\)/u);
  assert.match(headers['Permissions-Policy'], /microphone=\(\)/u);
});

test('Electron navigation policy allows only the app surface and inert srcDoc frames', () => {
  const productionUrl = 'file:///Users/example/app/dist/index.html';
  assert.equal(isSafeAppNavigation(productionUrl, { primaryUrl: productionUrl }), true);
  assert.equal(isSafeAppNavigation(`${productionUrl}#result`, { primaryUrl: productionUrl }), true);
  assert.equal(isSafeAppNavigation(`${productionUrl}.evil`, { primaryUrl: productionUrl }), false);
  assert.equal(isSafeAppNavigation('https://example.com', { primaryUrl: productionUrl }), false);

  const devOptions = { primaryUrl: productionUrl, devServerUrl: 'http://127.0.0.1:5189' };
  assert.equal(isSafeAppNavigation('http://127.0.0.1:5189/', devOptions), true);
  assert.equal(isSafeAppNavigation('http://127.0.0.1:5189/result', devOptions), true);
  assert.equal(isSafeAppNavigation('http://127.0.0.1:5189.evil.test/', devOptions), false);

  assert.equal(isSafeEmbeddedFrameNavigation('about:srcdoc'), true);
  assert.equal(isSafeEmbeddedFrameNavigation('about:blank'), true);
  assert.equal(isSafeEmbeddedFrameNavigation('https://example.com'), false);
  assert.equal(isSafeEmbeddedFrameNavigation('javascript:alert(1)'), false);
  assert.equal(isSafeEmbeddedFrameNavigation('file:///tmp/private'), false);
});

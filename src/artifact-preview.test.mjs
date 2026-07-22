import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactPreviewLimits, parseNativeArtifactText, trustedArtifactUrl } from './artifact-preview.ts';

test('accepts only bounded artifact names on the pinned local service', () => {
  assert.equal(
    trustedArtifactUrl(
      'http://127.0.0.1:4318/api/artifacts/range-36.html',
      'file:///Applications/Cike/index.html',
      'http://127.0.0.1:4318',
    ),
    'http://127.0.0.1:4318/api/artifacts/range-36.html',
  );
  assert.equal(trustedArtifactUrl('https://example.com/result.html', 'file:///app.html'), null);
  assert.equal(trustedArtifactUrl('http://127.0.0.1:4319/api/artifacts/result.html', 'file:///app.html'), null);
  assert.equal(trustedArtifactUrl('http://127.0.0.1:4318/api/artifacts/../state.json', 'file:///app.html'), null);
  assert.equal(trustedArtifactUrl('http://127.0.0.1:4318/api/artifacts/result.html?next=https://example.com', 'file:///app.html'), null);
});

test('canonicalizes the Vite proxy shape to the pinned artifact service', () => {
  assert.equal(
    trustedArtifactUrl(
      'http://127.0.0.1:5189/api/artifacts/result.html',
      'http://127.0.0.1:5189/',
    ),
    'http://127.0.0.1:4318/api/artifacts/result.html',
  );
});

test('accepts only the dynamic loopback origin supplied by the trusted desktop bridge', () => {
  assert.equal(
    trustedArtifactUrl(
      'http://127.0.0.1:58421/api/artifacts/result.html',
      'file:///Applications/Cike/index.html',
      'http://127.0.0.1:58421',
    ),
    'http://127.0.0.1:58421/api/artifacts/result.html',
  );
  assert.equal(
    trustedArtifactUrl(
      'http://127.0.0.1:58422/api/artifacts/result.html',
      'file:///Applications/Cike/index.html',
      'http://127.0.0.1:58421',
    ),
    null,
  );
});

test('keeps the renderer artifact body cap at two MiB', () => {
  assert.equal(artifactPreviewLimits.maxBytes, 2 * 1024 * 1024);
});

test('turns a legacy markdown result into bounded native result sections', () => {
  const sections = parseNativeArtifactText(`
# 老大，我正在梳理你现在最该推进的事
**当前局势判断**
这是本周最需要定住的一件事。

已核验事实：评测范围已经变化。原方案仍按旧范围统计。
合理推断：应先只读核对，不要直接覆盖现有方案。
建议下一步：让 Codex 建立副本并产出差异清单。
  `);

  assert.deepEqual(sections.map((section) => section.kind), ['conclusion', 'evidence', 'next']);
  assert.equal(sections[0].items[0], '这是本周最需要定住的一件事。');
  assert.equal(sections[1].items.length, 2);
  assert.equal(sections[2].items[0], '让 Codex 建立副本并产出差异清单。');
  assert.equal(JSON.stringify(sections).includes('**'), false);
});

test('native result keeps authorized paths and URLs while hiding credentials', () => {
  const sections = parseNativeArtifactText(`
**判断依据**
文件位于 /Users/demo/Projects/voice-quality/方案.md，来源 https://example.com/spec。
access_token=top-secret
  `);
  const serialized = JSON.stringify(sections);
  assert.match(serialized, /\/Users\/demo\/Projects\/voice-quality\/方案\.md/u);
  assert.match(serialized, /https:\/\/example\.com\/spec/u);
  assert.equal(serialized.includes('top-secret'), false);
  assert.match(serialized, /凭证已隐藏/u);
});

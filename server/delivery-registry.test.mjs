import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DeliveryRegistry,
  normalizeLarkDocumentUrl,
  normalizePaperReaderUrl,
} from './delivery-registry.mjs';

function readyPaper(paperId) {
  return {
    paperId,
    status: 'ready',
    ready: true,
    paper: { title: 'A paper', sourcePdfUrl: `/api/papers/${paperId}/source.pdf` },
    assets: { sourcePdf: `/api/papers/${paperId}/source.pdf`, chinesePdf: `/api/papers/${paperId}/chinese.pdf` },
    validation: { integrity: 'verified' },
    passages: [{ translationState: 'done', english: 'Evidence', chinese: '证据' }],
  };
}

test('paper delivery exposes only an opaque reference and revalidates DeepRead before every open', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-delivery-paper-'));
  try {
    const dataDir = path.join(root, 'data');
    const paperId = 'Abcdefghijklmnopqrstuvwx';
    let status = readyPaper(paperId);
    const registry = await new DeliveryRegistry({ dataDir, paperStatusChecker: async () => status }).init();
    const reference = await registry.registerPaperBundle({
      paperId,
      label: '主动 Agent 论文双语版',
      actionLabel: '阅读双语版',
      role: 'primary',
    });

    assert.equal(reference.kind, 'PAPER_BUNDLE');
    assert.equal(reference.state, 'ready');
    assert.equal(reference.actionLabel, '阅读双语版');
    assert.match(reference.id, /^delivery-[a-f0-9]{20}$/u);
    assert.equal(JSON.stringify(reference).includes(paperId), false);

    const resolved = await registry.resolve(reference.id);
    assert.equal(resolved.ok, true);
    assert.equal(resolved.loadedTarget, 'PAPER_READER');
    assert.deepEqual(
      { type: resolved.launch.type, policy: resolved.launch.policy },
      { type: 'external_url', policy: 'local_paper_reader' },
    );
    assert.equal(resolved.launch.url, `http://127.0.0.1:4173/?paper=${paperId}`);

    status = { ...status, passages: [{ translationState: 'done', english: 'Evidence', chinese: '' }] };
    const tampered = await registry.resolve(reference.id);
    assert.equal(tampered.ok, false);
    assert.equal(tampered.error, 'DELIVERY_UNAVAILABLE');
    assert.equal(tampered.reference.state, 'error');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('paper delivery rejects preparing or unverified reader state and remains closed after restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-delivery-unready-'));
  try {
    const dataDir = path.join(root, 'data');
    const paperId = 'Abcdefghijklmnopqrstuvwx';
    const paperStatusChecker = async () => ({ paperId, status: 'preparing', ready: false });
    const registry = await new DeliveryRegistry({ dataDir, paperStatusChecker }).init();
    const reference = await registry.registerPaperBundle({ paperId });
    assert.equal(reference.state, 'error');
    const restored = await new DeliveryRegistry({ dataDir, paperStatusChecker }).init();
    assert.equal((await restored.resolve(reference.id)).ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trusted Feishu doc delivery survives restart while hostile and non-doc URLs never resolve', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-delivery-lark-'));
  try {
    const dataDir = path.join(root, 'data');
    const registry = await new DeliveryRegistry({ dataDir }).init();
    const reference = await registry.registerLarkDocument({
      label: '评测方案',
      url: 'https://example.larksuite.com/docx/A1b2C3d4E5f6?from=agent#block',
    });
    assert.equal(reference.state, 'ready');

    const restored = await new DeliveryRegistry({ dataDir }).init();
    const resolved = await restored.resolve(reference.id);
    assert.deepEqual(
      { ok: resolved.ok, launch: resolved.launch, loadedTarget: resolved.loadedTarget },
      {
        ok: true,
        launch: {
          type: 'external_url',
          policy: 'trusted_lark_document',
          url: 'https://example.larksuite.com/docx/A1b2C3d4E5f6',
        },
        loadedTarget: 'LARK_DOC',
      },
    );

    for (const url of [
      'https://larkoffice.com.evil.example/docx/A1b2C3d4E5f6',
      'https://example.larksuite.com/wiki/A1b2C3d4E5f6',
      'http://example.larksuite.com/docx/A1b2C3d4E5f6',
      'https://user:secret@example.larksuite.com/docx/A1b2C3d4E5f6',
    ]) {
      assert.equal(normalizeLarkDocumentUrl(url), null);
    }

    assert.equal(normalizePaperReaderUrl('http://127.0.0.1:4173/?paper=Abcdefghijklmnopqrstuvwx') !== null, true);
    assert.equal(normalizePaperReaderUrl('http://127.0.0.1:4173/?paper=Abcdefghijklmnopqrstuvwx&url=file:///tmp/a.pdf'), null);
    assert.equal(normalizePaperReaderUrl('http://localhost:4173/?paper=Abcdefghijklmnopqrstuvwx'), null);

    const stored = await readFile(path.join(dataDir, 'delivery-registry.json'), 'utf8');
    assert.equal(stored.includes('A1b2C3d4E5f6'), true);
    assert.equal(stored.includes('user:secret'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generic and local file adapters keep paths private and expose a controlled launch target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-delivery-generic-'));
  try {
    const filePath = path.join(root, 'result.html');
    await writeFile(filePath, '<h1>result</h1>');
    const registry = await new DeliveryRegistry({ dataDir: path.join(root, 'data') }).init();
    const reference = await registry.registerGenericResult({
      filePath,
      label: '用户研究结果',
      actionLabel: '查看研究面板',
    });

    assert.deepEqual(
      {
        kind: reference.kind,
        actionLabel: reference.actionLabel,
        leakedPath: JSON.stringify(reference).includes(filePath),
      },
      { kind: 'GENERIC_RESULT', actionLabel: '查看研究面板', leakedPath: false },
    );
    const resolved = await registry.resolve(reference.id);
    assert.deepEqual(resolved.launch, { type: 'in_app_result', policy: 'registered_local_result' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

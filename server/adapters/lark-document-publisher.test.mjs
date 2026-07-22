import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  LarkDocumentPublisher,
  LarkDocumentPublisherError,
  larkDocumentPublisherInternals,
} from './lark-document-publisher.mjs';

const TITLE = '主动 Agent 评测方案';
const CONTENT = [
  '# 目标与范围',
  '',
  '建立可复核的主动 Agent 评测口径，并明确本轮交付边界。',
  '',
  '## 核心方案',
  '',
  '- 分开评估任务识别准确性与最终执行效果。',
  '- 对高风险副作用设置独立的安全拦截项。',
].join('\n');

const TOKEN = 'docxAbCdEf123456';
const URL = `https://example.larksuite.com/docx/${TOKEN}`;

function authEnvelope() {
  return {
    verified: true,
    identities: {
      user: { status: 'ready', tokenStatus: 'valid' },
    },
  };
}

function publisherStub(options = {}) {
  const calls = [];
  let stagedXml = '';
  let title = '';
  let createCount = 0;
  const execJson = async (file, args, commandOptions) => {
    calls.push({ file, args: [...args], options: commandOptions });
    if (args[0] === 'auth') return authEnvelope();
    if (args[0] === 'docs' && args[1] === '+create') {
      createCount += 1;
      if (options.createDelay) await new Promise((resolve) => setTimeout(resolve, options.createDelay));
      if (options.createError) throw options.createError;
      const contentArg = args[args.indexOf('--content') + 1];
      assert.match(contentArg, /^@lark-publications\/draft-[a-f0-9]{24}\.xml$/u);
      stagedXml = await readFile(path.join(commandOptions.cwd, contentArg.slice(1)), 'utf8');
      title = args[args.indexOf('--title') + 1];
      return options.createEnvelope ?? {
        ok: true,
        identity: 'user',
        data: {
          document: {
            document_id: TOKEN,
            revision_id: 1,
            url: URL,
          },
        },
      };
    }
    if (args[0] === 'docs' && args[1] === '+fetch') {
      if (options.fetchError) throw options.fetchError;
      return options.fetchEnvelope ?? {
        ok: true,
        identity: 'user',
        data: {
          document: {
            title,
            content: `<title>${title}</title>\n${stagedXml}`,
          },
        },
      };
    }
    throw new Error(`unexpected command: ${args.join(' ')}`);
  };
  return {
    calls,
    execJson,
    get createCount() { return createCount; },
    get stagedXml() { return stagedXml; },
  };
}

async function withTempDir(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-lark-publisher-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertPublisherError(error, code) {
  assert.equal(error instanceof LarkDocumentPublisherError, true);
  assert.equal(error.code, code);
  return true;
}

test('publishes through fixed user argv, relative 0600 XML, and verified opaque record', async () => {
  await withTempDir(async (dataDir) => {
    const stub = publisherStub();
    const publisher = new LarkDocumentPublisher({
      dataDir,
      binary: '/fake/lark-cli',
      execJson: stub.execJson,
      now: () => new Date('2026-07-21T10:00:00.000Z'),
    });

    const delivery = await publisher.publish({ jobId: 'job-plan-1', title: TITLE, content: CONTENT });
    assert.deepEqual(delivery, {
      id: delivery.id,
      label: TITLE,
      kind: 'LARK_DOC',
      state: 'verified',
    });
    assert.match(delivery.id, /^lark-doc-[a-f0-9]{24}$/u);
    assert.equal(JSON.stringify(delivery).includes(TOKEN), false);
    assert.equal(JSON.stringify(delivery).includes('larkoffice.com'), false);
    assert.equal(JSON.stringify(delivery).includes('job-plan-1'), false);

    assert.deepEqual(stub.calls.map((call) => call.args.slice(0, 2)), [
      ['auth', 'status'],
      ['docs', '+create'],
      ['docs', '+fetch'],
    ]);
    assert.deepEqual(stub.calls[0].args, ['auth', 'status', '--json', '--verify']);
    assert.deepEqual(stub.calls[1].args, [
      'docs', '+create',
      '--as', 'user',
      '--parent-position', 'my_library',
      '--doc-format', 'xml',
      '--title', TITLE,
      '--content', stub.calls[1].args[stub.calls[1].args.indexOf('--content') + 1],
      '--format', 'json',
    ]);
    assert.equal(path.isAbsolute(stub.calls[1].args[stub.calls[1].args.indexOf('--content') + 1].slice(1)), false);
    assert.deepEqual(stub.calls[2].args, [
      'docs', '+fetch',
      '--doc', TOKEN,
      '--doc-format', 'xml',
      '--detail', 'simple',
      '--as', 'user',
      '--format', 'json',
    ]);
    for (const call of stub.calls) {
      assert.equal(call.file, '/fake/lark-cli');
      assert.equal(call.options.cwd, dataDir);
    }

    assert.match(stub.stagedXml, /<h1>目标与范围<\/h1>/u);
    assert.match(stub.stagedXml, /<h2>核心方案<\/h2>/u);
    assert.match(stub.stagedXml, /<ul><li>分开评估任务识别准确性与最终执行效果。<\/li>/u);
    assert.match(stub.stagedXml, /cike_delivery_[a-f0-9]{24}/u);
    assert.equal(stub.stagedXml.includes('<script>'), false);

    const stagingArg = stub.calls[1].args[stub.calls[1].args.indexOf('--content') + 1].slice(1);
    assert.equal((await stat(path.join(dataDir, stagingArg))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(dataDir, 'lark-document-deliveries.json'))).mode & 0o777, 0o600);

    const privateDelivery = publisher.resolvePrivateDelivery(delivery.id);
    assert.equal(privateDelivery.token, TOKEN);
    assert.equal(privateDelivery.url, URL);
    assert.equal(privateDelivery.title, TITLE);
    assert.equal(publisher.resolvePrivateDelivery('../unsafe'), null);
  });
});

test('deduplicates concurrent publishes and restores verified idempotency from disk', async () => {
  await withTempDir(async (dataDir) => {
    const stub = publisherStub({ createDelay: 15 });
    const publisher = new LarkDocumentPublisher({ dataDir, binary: 'lark-cli', execJson: stub.execJson });
    const input = { jobId: 'job-idempotent', title: TITLE, content: CONTENT };

    const [first, second] = await Promise.all([publisher.publish(input), publisher.publish(input)]);
    assert.deepEqual(first, second);
    assert.equal(stub.createCount, 1);

    const restored = new LarkDocumentPublisher({
      dataDir,
      binary: 'lark-cli',
      execJson: async () => {
        throw new Error('persisted delivery must not execute lark-cli again');
      },
    });
    const third = await restored.publish(input);
    assert.deepEqual(third, first);
    assert.equal(restored.resolvePrivateDelivery(third.id).url, URL);
  });
});

test('readback mismatch retains the local draft and never returns a ready record', async () => {
  await withTempDir(async (dataDir) => {
    const stub = publisherStub({
      fetchEnvelope: {
        ok: true,
        data: {
          document: {
            title: TITLE,
            content: '<title>主动 Agent 评测方案</title><p>只回来了一个不完整段落。</p>',
          },
        },
      },
    });
    const publisher = new LarkDocumentPublisher({ dataDir, binary: 'lark-cli', execJson: stub.execJson });

    await assert.rejects(
      publisher.publish({ jobId: 'job-readback-fail', title: TITLE, content: CONTENT }),
      (error) => assertPublisherError(error, 'READBACK_MARKER_MISMATCH'),
    );
    const staged = await readdir(path.join(dataDir, 'lark-publications'));
    assert.equal(staged.length, 1);
    assert.equal(staged[0].endsWith('.xml'), true);
    assert.equal(publisher.resolvePrivateDelivery(`lark-doc-${staged[0].match(/[a-f0-9]{24}/u)[0]}`), null);

    await assert.rejects(
      publisher.publish({ jobId: 'job-readback-fail', title: TITLE, content: CONTENT }),
      (error) => assertPublisherError(error, 'DELIVERY_RECONCILIATION_REQUIRED'),
    );
    assert.equal(stub.createCount, 1);
  });
});

test('rejects untrusted or mismatched docx URLs even when create returns a token', async () => {
  await withTempDir(async (dataDir) => {
    const stub = publisherStub({
      createEnvelope: {
        ok: true,
        data: {
          document: {
            document_id: TOKEN,
            url: `https://evil.example/docx/${TOKEN}`,
          },
        },
      },
    });
    const publisher = new LarkDocumentPublisher({ dataDir, binary: 'lark-cli', execJson: stub.execJson });
    await assert.rejects(
      publisher.publish({ jobId: 'job-url-block', title: TITLE, content: CONTENT }),
      (error) => assertPublisherError(error, 'UNTRUSTED_DOCUMENT_REFERENCE'),
    );
    assert.equal(stub.calls.some((call) => call.args[1] === '+fetch'), false);
  });

  assert.deepEqual(
    larkDocumentPublisherInternals.normalizeTrustedDocxUrl(`${URL}?from=copy#fragment`),
    { url: URL, token: TOKEN },
  );
  assert.equal(larkDocumentPublisherInternals.normalizeTrustedDocxUrl(`http://example.larksuite.com/docx/${TOKEN}`), null);
  assert.equal(larkDocumentPublisherInternals.normalizeTrustedDocxUrl(`https://larkoffice.com.evil.test/docx/${TOKEN}`), null);
  assert.equal(larkDocumentPublisherInternals.normalizeTrustedDocxUrl(`https://user:secret@feishu.cn/docx/${TOKEN}`), null);
  assert.equal(larkDocumentPublisherInternals.normalizeTrustedDocxUrl('https://feishu.cn/wiki/unsafeToken123'), null);
});

test('blocks credential-like content before staging or executing lark-cli', async () => {
  await withTempDir(async (dataDir) => {
    let executions = 0;
    const publisher = new LarkDocumentPublisher({
      dataDir,
      binary: 'lark-cli',
      execJson: async () => {
        executions += 1;
        return authEnvelope();
      },
    });
    const secretCases = [
      `${CONTENT}\n\naccess_token=top-secret-value`,
      `${CONTENT}\n\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz`,
      `${CONTENT}\n\nhttps://user:password@example.com/private`,
      `${CONTENT}\n\n${'sk'}-${'proj'}-${'abcdefghijklmnopqrstuvwxyz'}`,
    ];
    for (const [index, content] of secretCases.entries()) {
      await assert.rejects(
        publisher.publish({ jobId: `job-secret-${index}`, title: TITLE, content }),
        (error) => assertPublisherError(error, 'SENSITIVE_CONTENT'),
      );
    }
    assert.equal(executions, 0);
    assert.deepEqual(await readdir(path.join(dataDir, 'lark-publications')), []);
  });
});

test('light Markdown is escaped into restrained XML instead of executing raw markup', () => {
  const blocks = larkDocumentPublisherInternals.sourceBlocks([
    '# 标题',
    '',
    '第一段包含 **重点**、`代码` 与 <script>alert(1)</script>。',
    '',
    '- 第二个可以核验的内容片段。',
  ].join('\n'));
  const xml = larkDocumentPublisherInternals.renderLarkXml(blocks, 'cike_delivery_1234567890abcdef12345678');
  assert.match(xml, /<p>第一段包含 重点、代码 与 &lt;script&gt;alert\(1\)&lt;\/script&gt;。<\/p>/u);
  assert.equal(xml.includes('<script>'), false);
  assert.equal(xml.includes('<strong>'), false);
});

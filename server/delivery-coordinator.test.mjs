import assert from 'node:assert/strict';
import test from 'node:test';
import { DeliveryCoordinator } from './delivery-coordinator.mjs';

function readyReference(kind, input, id = 'delivery-0123456789abcdefabcd') {
  return {
    id,
    label: input.label,
    actionLabel: input.actionLabel,
    kind,
    role: input.role,
    state: 'ready',
  };
}

function fakeRegistry(calls) {
  const references = new Map();
  let sequence = 0;
  const store = (reference) => {
    references.set(reference.id, reference);
    return reference;
  };
  return {
    getReference(id) {
      return references.get(id) || null;
    },
    async registerGenericResult(input) {
      calls.push(['generic', input]);
      sequence += 1;
      return store(readyReference('GENERIC_RESULT', input, `delivery-${sequence.toString(16).padStart(20, '0')}`));
    },
    async registerLocalFile(input) {
      calls.push(['file', input]);
      sequence += 1;
      return store(readyReference('LOCAL_FILE', input, `delivery-${sequence.toString(16).padStart(20, '0')}`));
    },
    async registerLarkDocument(input) {
      calls.push(['lark', input]);
      sequence += 1;
      return store(readyReference('LARK_DOC', input, `delivery-${sequence.toString(16).padStart(20, '0')}`));
    },
    async registerPaperBundle(input) {
      calls.push(['paper', input]);
      sequence += 1;
      return store(readyReference('PAPER_BUNDLE', input, `delivery-${sequence.toString(16).padStart(20, '0')}`));
    },
  };
}

function response(status, body) {
  return { status, json: async () => structuredClone(body) };
}

test('every ordinary task receives a verified task-agnostic in-app result', async () => {
  const calls = [];
  const coordinator = new DeliveryCoordinator({ registry: fakeRegistry(calls) });
  const result = await coordinator.prepare({
    job: {
      id: 'job-1',
      title: '核对评测范围',
      deliveryTarget: 'generic_result',
      deliveryActionLabel: '看范围差异',
    },
    artifactPath: '/private/result.html',
  });
  assert.equal(result.deliveries[0].kind, 'GENERIC_RESULT');
  assert.deepEqual(calls, [[
    'generic',
    {
      filePath: '/private/result.html',
      label: '核对评测范围',
      actionLabel: '看范围差异',
      role: 'primary',
    },
  ]]);
});

test('verified Lark publication is bridged without exposing its URL in the public reference', async () => {
  const calls = [];
  const publisher = {
    async publish(input) {
      calls.push(['publish', input]);
      return { id: 'lark-doc-0123456789abcdef01234567', state: 'verified' };
    },
    resolvePrivateDelivery() {
      return { title: '完整评测方案', url: 'https://example.feishu.cn/docx/Abcdefgh1234' };
    },
  };
  const coordinator = new DeliveryCoordinator({ registry: fakeRegistry(calls), larkPublisher: publisher });
  const result = await coordinator.prepare({
    job: { id: 'job-2', title: '评测方案', deliveryTitle: '完整评测方案', deliveryTarget: 'lark_doc' },
    finalText: '# 完整评测方案\n\n这是经过核对的正文。',
  });
  assert.deepEqual(result.deliveries.map((delivery) => delivery.kind), ['LARK_DOC', 'GENERIC_RESULT']);
  assert.equal(result.enhancement.state, 'ready');
  assert.equal(calls[0][0], 'generic');
  assert.equal(JSON.stringify(result).includes('https://'), false);
  assert.equal(calls.at(-1)[0], 'lark');
});

test('Lark publication failure keeps the completed generic result available', async () => {
  const calls = [];
  const coordinator = new DeliveryCoordinator({
    registry: fakeRegistry(calls),
    larkPublisher: {
      async publish() {
        throw new Error('Lark unavailable');
      },
      resolvePrivateDelivery() {
        return null;
      },
    },
  });
  const result = await coordinator.prepare({
    job: {
      id: 'job-lark-fallback',
      title: '完整评测方案',
      deliveryTarget: 'lark_doc',
      deliveryActionLabel: '看完整方案',
    },
    finalText: '# 完整评测方案\n\n本地正文已完成。',
    artifactPath: '/private/evaluation-plan.html',
  });
  assert.deepEqual(result.deliveries.map((delivery) => delivery.kind), ['GENERIC_RESULT']);
  assert.equal(result.deliveries[0].actionLabel, '看完整方案');
  assert.equal(result.enhancement.state, 'error');
  assert.equal(calls[0][0], 'generic');
});

test('paper delivery waits for DeepRead integrity and translated passages before registering', async () => {
  const calls = [];
  const paperId = 'Abcdefghijklmnopqrstuvwx';
  const responses = [
    response(202, { paperId, status: 'preparing' }),
    response(202, { paperId, status: 'preparing', ready: false }),
    response(200, {
      paperId,
      status: 'ready',
      ready: true,
      paper: { title: 'A useful paper' },
      assets: { sourcePdf: `/api/papers/${paperId}/source.pdf` },
      validation: { integrity: 'verified' },
      passages: [{ translationState: 'done', english: 'Evidence', chinese: '证据' }],
    }),
  ];
  const fetchCalls = [];
  const coordinator = new DeliveryCoordinator({
    registry: fakeRegistry(calls),
    fetchImpl: async (url, init) => {
      fetchCalls.push([url, init.method]);
      return responses.shift();
    },
    sleep: async () => {},
    pollIntervalMs: 50,
    paperTimeoutMs: 2_000,
  });
  const result = await coordinator.prepare({
    job: { deliveryTarget: 'paper_bundle' },
    deliveryPayload: {
      paper: {
        title: 'A useful paper',
        pdfUrl: 'https://arxiv.org/pdf/2607.17701',
        authors: ['A. Researcher'],
      },
    },
  });
  assert.deepEqual(result.deliveries.map((delivery) => delivery.kind), ['PAPER_BUNDLE', 'GENERIC_RESULT']);
  assert.equal(result.enhancement.state, 'ready');
  assert.equal(calls[0][0], 'generic');
  assert.equal(calls.at(-1)[1].paperId, paperId);
  assert.deepEqual(fetchCalls.map((item) => item[1]), ['POST', 'GET', 'GET']);
});

test('paper delivery failure keeps the completed generic result available', async () => {
  const paperId = 'Abcdefghijklmnopqrstuvwx';
  const responses = [
    response(202, { paperId, status: 'preparing' }),
    response(200, {
      paperId,
      status: 'ready',
      ready: true,
      validation: { integrity: 'verified' },
      passages: [{ translationState: 'done', english: 'Evidence', chinese: '' }],
    }),
  ];
  const calls = [];
  const coordinator = new DeliveryCoordinator({
    registry: fakeRegistry(calls),
    fetchImpl: async () => responses.shift(),
    sleep: async () => {},
    paperTimeoutMs: 1_000,
  });
  const result = await coordinator.prepare({
    job: { title: '研究结论', deliveryTarget: 'paper_bundle' },
    artifactPath: '/private/research-result.html',
    deliveryPayload: { paper: { title: 'A paper', pdfUrl: 'https://arxiv.org/pdf/2607.17701' } },
  });
  assert.deepEqual(result.deliveries.map((delivery) => delivery.kind), ['GENERIC_RESULT']);
  assert.equal(result.enhancement.state, 'error');
  assert.equal(calls[0][0], 'generic');
});

test('custom target adapters keep the coordinator extensible beyond papers and plans', async () => {
  const calls = [];
  const registry = fakeRegistry(calls);
  const coordinator = new DeliveryCoordinator({
    registry,
    handlers: {
      design_preview: async () => ({
        deliveries: [await registry.registerGenericResult({
          filePath: '/private/design-preview.html',
          label: '交互预览',
          actionLabel: '打开预览',
          role: 'primary',
        })],
      }),
    },
  });
  const result = await coordinator.prepare({ job: { deliveryTarget: 'design_preview' } });
  assert.deepEqual(result.deliveries.map((delivery) => delivery.kind), ['GENERIC_RESULT', 'GENERIC_RESULT']);
  assert.equal(result.deliveries[0].actionLabel, '打开预览');
  assert.equal(result.enhancement.state, 'ready');
  assert.equal(calls[0][0], 'generic');
});

test('custom target failure or forged reference falls back to the registered generic result', async () => {
  const calls = [];
  const coordinator = new DeliveryCoordinator({
    registry: fakeRegistry(calls),
    handlers: {
      forged_preview: async () => ({ deliveries: [readyReference('GENERIC_RESULT', {
        label: '伪造结果', actionLabel: '打开', role: 'primary',
      })] }),
    },
  });
  const result = await coordinator.prepare({
    job: { title: '交互预览', deliveryTarget: 'forged_preview' },
    artifactPath: '/private/fallback.html',
  });
  assert.deepEqual(result.deliveries.map((delivery) => delivery.kind), ['GENERIC_RESULT']);
  assert.equal(result.enhancement.state, 'error');
  assert.equal(result.deliveries[0].label, '交互预览');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addressHeadline,
  resolveOpportunityPresentation,
  resolveOpportunityReceipt,
} from './opportunity-presentation.ts';

function opportunity(overrides = {}) {
  return {
    id: 'task-one',
    title: '核对评测范围',
    reason: 'Codex 已匹配本地评测项目。',
    priority: 'high',
    confidence: 96,
    due: '现在',
    status: 'active',
    steps: [],
    origin: '飞书',
    signalType: 'task_change',
    ...overrides,
  };
}

test('keeps every useful model action while removing unsupported or duplicate intents', () => {
  const item = opportunity({
    presentation: {
      headline: '老大，周宁在群里@你，需要你核对新范围。',
      summary: 'Codex 已定位对应评测方案。',
      actions: [
        { intent: 'open_delivery', label: '伪造交付', targetId: 'delivery-aaaaaaaaaaaaaaaaaaaa' },
        { intent: 'continue_codex', label: '更新评测方案' },
        { intent: 'launch_missiles', label: '不安全操作' },
        { intent: 'continue_codex', label: '更新评测方案' },
        { intent: 'ask', label: '追问变更原因' },
        { intent: 'ask', label: '追问影响范围' },
        { intent: 'snooze', label: '明天再看' },
        { intent: 'dismiss', label: '无需调整' },
        { intent: 'complete', label: '不会显示' },
      ],
    },
  });

  const resolved = resolveOpportunityPresentation(item);

  assert.deepEqual(resolved.actions.map((action) => action.intent), [
    'continue_codex',
    'ask',
    'ask',
    'snooze',
    'dismiss',
    'complete',
  ]);
  assert.deepEqual(resolved.actions.map((action) => action.tone), ['codex', 'codex', 'codex', 'quiet', 'danger', 'positive']);
});

test('only a host delivery reference can mint the first open_delivery action', () => {
  const targetId = 'delivery-aaaaaaaaaaaaaaaaaaaa';
  const resolved = resolveOpportunityPresentation(opportunity({
    status: 'ready',
    receipt: {
      timeline: [{ label: '已准备论文', state: 'done' }],
      result: {
        title: '论文阅读包已就绪',
        deliveries: [{
          id: targetId,
          label: '主动 Agent 论文双语版',
          actionLabel: '阅读双语版',
          kind: 'PAPER_BUNDLE',
          role: 'primary',
          state: 'ready',
        }],
      },
    },
    presentation: {
      headline: '老大，论文已筛好',
      summary: '原文和中文版已加载。',
      actions: [
        { intent: 'open_delivery', label: '模型伪造', targetId: 'delivery-bbbbbbbbbbbbbbbbbbbb' },
        { intent: 'complete', label: '已读' },
        { intent: 'continue_codex', label: '继续研究' },
        { intent: 'ask', label: '追问适用边界' },
        { intent: 'ask', label: '追问反例' },
        { intent: 'snooze', label: '稍后阅读' },
        { intent: 'dismiss', label: '不再关注' },
      ],
    },
  }));

  assert.equal(resolved.actions.length, 7);
  assert.deepEqual(resolved.actions[0], {
    intent: 'open_delivery',
    targetId,
    label: '阅读双语版',
    tone: 'primary',
  });
  assert.equal(resolved.actions[1].intent, 'complete');
  assert.equal(resolved.actions[2].intent, 'continue_codex');
  assert.deepEqual(resolved.actions.slice(3).map((action) => action.intent), ['ask', 'ask', 'snooze', 'dismiss']);
});

test('uses an exact 老大 salutation without duplicating it', () => {
  assert.equal(addressHeadline('老大：新的范围已经确认', 'fallback'), '老大，新的范围已经确认');
  assert.equal(addressHeadline('新的范围已经确认', 'fallback'), '老大，新的范围已经确认');
});

test('never exposes legacy raw-message prefixes as the fallback headline', () => {
  const resolved = resolveOpportunityPresentation(opportunity({
    title: '处理：@林晓 请看看这批题',
    signalType: 'direct_request',
    presentation: undefined,
  }));

  assert.equal(resolved.headline, '老大，这里识别到一项明确任务');
  assert.equal(resolved.headline.includes('@林晓'), false);
});

test('keeps the backend task heading when a model headline drops actor or chat context', () => {
  const taskTitle = '老大，周宁在「Aurora 评测小群」@你，需要你核对新范围。';
  const resolved = resolveOpportunityPresentation(opportunity({
    title: taskTitle,
    presentation: {
      headline: '老大，新范围已经整理好了',
      summary: 'Codex 已完成影响分析。',
      actions: [{ intent: 'view_artifact', label: '查看影响' }],
    },
  }));

  assert.equal(resolved.headline, taskTitle);
});

test('uses three contextual fallback actions instead of a fixed generic row', () => {
  const preparing = resolveOpportunityPresentation(opportunity({ status: 'preparing', presentation: undefined }));
  const ready = resolveOpportunityPresentation(opportunity({
    status: 'ready',
    artifactUrl: '/result.html',
    presentation: undefined,
  }));

  assert.deepEqual(preparing.actions.map((action) => action.label), ['去 Codex 看进度', '稍后再看', '不再跟进']);
  assert.deepEqual(ready.actions.map((action) => action.label), ['查看变更分析', '继续核对', '采用新方案']);
});

test('caps receipt data and selects the running step for the compact execution row', () => {
  const resolved = resolveOpportunityReceipt(opportunity({
    receipt: {
      timeline: [
        { label: '定位项目', state: 'done', time: '18:49' },
        { label: '建立副本', state: 'done', time: '18:50' },
        { label: '筛查重复题', state: 'running', time: '2m 18s' },
        { label: '补齐标签', state: 'pending' },
        { label: '生成报告', state: 'pending' },
        { label: '核验结果', state: 'pending' },
        { label: '超出上限', state: 'pending' },
      ],
      result: {
        title: '已定位 12 个重复簇',
        summary: '原表未修改，所有标记保存在副本中。',
        deliverableLabel: '题库清洗报告',
        metrics: [
          { label: '已检查', value: '184 题' },
          { label: '重复簇', value: '12 组' },
          { label: '低价值', value: '17 题' },
          { label: '待核验', value: '6 题' },
          { label: '超出上限', value: '1 项' },
        ],
        sections: [
          { kind: 'conclusion', title: '核心判断', items: ['先在副本中完成清洗。'] },
          { kind: 'evidence', title: '判断依据', items: ['已定位 12 个重复簇。'] },
          { kind: 'next', title: '下一步', items: ['核验 6 个边界题。'] },
          { kind: 'unknown', title: '不会展示', items: ['不支持的类型。'] },
        ],
        documents: [
          { id: 'doc-1234567890abcdef1234', label: '题库清洗方案.md', kind: 'MD' },
          { id: 'file:///Users/example/private', label: '不安全文件', kind: 'MD' },
          { id: 'doc-abcdef1234567890abcd', label: '脚本', kind: 'SH' },
        ],
        deliveries: [
          { id: 'delivery-aaaaaaaaaaaaaaaaaaaa', label: '飞书方案', actionLabel: '打开可编辑方案', kind: 'LARK_DOC', role: 'primary', state: 'ready' },
          { id: 'delivery-too-short', label: '伪造交付', kind: 'LARK_DOC', role: 'primary', state: 'ready' },
        ],
      },
    },
  }));

  assert.equal(resolved.timeline.length, 6);
  assert.equal(resolved.current.label, '筛查重复题');
  assert.equal(resolved.result?.metrics.length, 4);
  assert.deepEqual(resolved.result?.sections.map((section) => section.kind), ['conclusion', 'evidence', 'next']);
  assert.deepEqual(resolved.result?.documents, [
    { id: 'doc-1234567890abcdef1234', label: '题库清洗方案.md', kind: 'MD' },
  ]);
  assert.deepEqual(resolved.result?.deliveries, [
    { id: 'delivery-aaaaaaaaaaaaaaaaaaaa', label: '飞书方案', actionLabel: '打开可编辑方案', kind: 'LARK_DOC', role: 'primary', state: 'ready' },
  ]);
});

test('falls back to existing opportunity steps when no receipt is available', () => {
  const resolved = resolveOpportunityReceipt(opportunity({
    steps: [
      { label: '读取上下文', state: 'done', time: '已完成' },
      { label: 'Codex 分析', state: 'running' },
    ],
  }));

  assert.deepEqual(resolved.timeline.map((step) => step.label), ['读取上下文', 'Codex 分析']);
  assert.equal(resolved.current.label, 'Codex 分析');
});

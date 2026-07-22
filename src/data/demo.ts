import type { AgentSnapshot, Intervention } from '../types';

const now = '2026-06-18T08:42:00.000Z';

const common = {
  generatedAt: now,
  now: {
    state: 'available' as const,
    title: '专注时间',
    detail: '未来 45 分钟没有会议。',
  },
  policy: {
    label: '只展示有新价值的判断',
    detail: '已读、已完成和低相关内容会自动离开主面板。',
  },
  sources: [
    { id: 'codex', name: 'Codex', state: 'connected' as const, detail: '已连接' },
    { id: 'calendar', name: '日历', state: 'connected' as const, detail: '已同步' },
    { id: 'local', name: '本地项目', state: 'available' as const, detail: '2 个项目有更新' },
  ],
  setup: {
    state: 'ready' as const,
    readyCount: 3,
    totalCount: 3,
    autoExecute: true,
    contextSourcesEnabled: true,
    checks: [],
  },
  plan: { generatedAt: now, items: [] },
  projects: [],
  history: [],
  background: { state: 'idle' as const, current: null, recent: [] },
  learning: {
    baselineLoaded: true,
    totalActions: 24,
    explicitFeedback: 7,
    ratings: { good: 6, bad: 1 },
    correctionCandidates: [],
    updatedAt: now,
  },
  prepared: {
    title: '演示数据',
    subtitle: '所有人物、项目和内容均为虚构。',
    status: 'empty' as const,
    items: [],
    deliverables: [],
  },
  evidence: [],
  activity: [],
};

const resultIntervention: Intervention = {
  id: 'demo-result',
  opportunityId: 'demo-result',
  kind: 'work_result',
  state: 'ready',
  title: '发布准备清单已经整理好',
  summary: 'Codex 对照产品说明、测试结果和发布时间，整理出 3 个可直接处理的发布风险。',
  statusLabel: '刚完成',
  projectLabel: '产品发布',
  whyNow: '明天进入候选版本冻结期，现在处理可以避免打断发布节奏。',
  completedAt: now,
  actions: [
    { intent: 'view_artifact', label: '查看完整清单' },
    { intent: 'continue_codex', label: '补充验证' },
    { intent: 'ask', label: '解释最高风险' },
    { intent: 'complete', label: '采用并收起' },
    { intent: 'snooze', label: '下午再看' },
  ],
  receipt: {
    timeline: [
      { label: '读取发布说明', state: 'done', time: '16:38' },
      { label: '核对测试结果', state: 'done', time: '16:40' },
      { label: '生成发布清单', state: 'done', time: '16:42' },
    ],
    result: {
      title: '发布准备结论',
      summary: '已有明确的优先级和负责人建议。',
      sections: [{
        kind: 'conclusion',
        title: '可直接采用的结论',
        items: [
          '先修复首次启动的权限说明，再进入候选版本冻结。',
          '保留回滚包，并在发布后 30 分钟检查关键指标。',
          '其余两项不阻塞本次发布，可排入下一迭代。',
        ],
      }],
      documents: [
        { id: 'demo-release-checklist', label: 'release-readiness-checklist.md', kind: 'MD' },
        { id: 'demo-test-summary', label: 'test-summary.pdf', kind: 'PDF' },
      ],
    },
  },
};

const decisionIntervention: Intervention = {
  id: 'demo-decision',
  opportunityId: 'demo-decision',
  kind: 'decision',
  state: 'active',
  title: '下午的评审可能需要换一种节奏',
  summary: '当前材料还有两处关键假设未验证；建议先用 20 分钟补齐证据，再决定是否按原计划开会。',
  statusLabel: '等你决定',
  projectLabel: '下午评审',
  whyNow: '你刚结束上一场会议，距离评审还有 55 分钟，仍有低成本调整空间。',
  updatedAt: now,
  actions: [
    { intent: 'complete', label: '先补齐证据' },
    { intent: 'continue_codex', label: '让 Codex 准备' },
    { intent: 'ask', label: '列出缺口' },
    { intent: 'ask', label: '生成延期消息' },
    { intent: 'snooze', label: '10 分钟后提醒' },
    { intent: 'dismiss', label: '维持原计划' },
  ],
};

const progressIntervention: Intervention = {
  id: 'demo-progress',
  opportunityId: 'demo-progress',
  kind: 'work_progress',
  state: 'running',
  title: '正在整理竞品体验差异',
  summary: 'Codex 正在把 6 份公开资料整理成一页可评审的对照表。',
  statusLabel: '进行中',
  projectLabel: '竞品研究',
  updatedAt: now,
  progress: {
    value: 0.68,
    label: '整理差异证据',
    currentStep: '合并重复观点并标注来源',
    completedSteps: 4,
    totalSteps: 6,
  },
  actions: [
    { intent: 'continue_codex', label: '查看执行进度' },
    { intent: 'ask', label: '调整研究范围' },
    { intent: 'snooze', label: '完成后再提醒' },
  ],
};

function withIntervention(intervention: Intervention): AgentSnapshot {
  return {
    ...common,
    opportunities: [],
    interventions: [intervention],
    codexRuntime: {
      state: intervention.kind === 'work_progress' ? 'running' : 'complete',
      current: {
        id: 'demo-codex-session',
        title: intervention.title,
        project: intervention.projectLabel ?? '演示项目',
        state: intervention.kind === 'work_progress' ? 'running' : 'complete',
        updatedAt: now,
        startedAt: '2026-06-18T08:36:00.000Z',
        ...(intervention.kind === 'work_progress' ? {} : { completedAt: now }),
        usage: {
          turnTokens: 18420,
          inputTokens: 12400,
          cachedInputTokens: 5200,
          outputTokens: 820,
          reasoningTokens: 3100,
          sessionTokens: 18420,
          contextWindow: 200000,
          contextPercent: 9.2,
        },
        quota: {
          available: true,
          usedPercent: 31,
          remainingPercent: 69,
          windowMinutes: 300,
          resetsAt: '2026-06-18T12:00:00.000Z',
          planType: 'demo',
          credits: { hasCredits: false, unlimited: false, balance: '—' },
        },
      },
      sessions: [],
      resources: { available: true, cpuPercent: 18.4, memoryBytes: 684000000, processCount: 2 },
      lastSeen: now,
    },
  };
}

export function demoSnapshot(scenario: string): AgentSnapshot {
  if (scenario === 'decision') return withIntervention(decisionIntervention);
  if (scenario === 'progress') return withIntervention(progressIntervention);
  return withIntervention(resultIntervention);
}

import type { AgentSnapshot } from '../types';

export const fallbackSnapshot: AgentSnapshot = {
  generatedAt: new Date().toISOString(),
  now: {
    state: 'stale',
    title: '本地服务尚未连接',
    detail: '当前不会读取任何来源，也不会生成建议。',
  },
  policy: {
    label: '先创造价值，再选择介入',
    detail: '服务恢复后会先静默过滤无价值线索；明确的低风险任务可交给 Codex 在本地完成。',
  },
  sources: [],
  setup: {
    state: 'needs_setup',
    readyCount: 0,
    totalCount: 4,
    autoExecute: false,
    contextSourcesEnabled: false,
    checks: [
      { id: 'codex', label: 'Codex 活动', required: false, state: 'missing', detail: '可选，用于理解最近任务周期。' },
      { id: 'local', label: '项目目录', required: false, state: 'missing', detail: '可选，用于理解项目进度。' },
      { id: 'chronicle', label: 'Chronicle', required: false, state: 'missing', detail: '等待本地服务检测。' },
      { id: 'lark', label: '飞书', required: false, state: 'missing', detail: '等待本地服务检测。' },
    ],
  },
  plan: {
    generatedAt: new Date().toISOString(),
    items: [],
  },
  projects: [],
  opportunities: [],
  codexRuntime: {
    state: 'unavailable',
    current: null,
    sessions: [],
    resources: { available: false, cpuPercent: 0, memoryBytes: 0, processCount: 0 },
    lastSeen: null,
  },
  prepared: {
    title: '暂无需要介入的事',
    subtitle: '服务连接并获得足够证据后，只会展示有新价值的建议或结果。',
    status: 'empty',
    items: [],
    deliverables: [],
  },
  evidence: [],
  activity: [],
  connectorIssue: {
    source: '本地服务',
    message: '此刻的本地服务没有响应。',
    recovery: '点击重新连接；如果仍失败，请退出后重新打开此刻。',
  },
};

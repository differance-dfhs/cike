import type {
  DeliveryReference,
  Opportunity,
  OpportunityActionIntent,
  OpportunityPresentationAction,
  OpportunityResultSection,
  OpportunityResultSectionKind,
  OpportunityStep,
  OutputDocument,
} from './types';

export type ActionTone = 'primary' | 'codex' | 'positive' | 'quiet' | 'danger';

export type ResolvedOpportunityAction = OpportunityPresentationAction & { tone: ActionTone };

export interface ResolvedOpportunityPresentation {
  headline: string;
  summary: string;
  actions: ResolvedOpportunityAction[];
}

export interface ResolvedOpportunityReceipt {
  timeline: OpportunityStep[];
  current: OpportunityStep;
  result?: {
    title: string;
    summary?: string;
    deliverableLabel?: string;
    metrics: Array<{ label: string; value: string }>;
    sections: OpportunityResultSection[];
    documents: OutputDocument[];
    deliveries: DeliveryReference[];
  };
}

const MAX_TIMELINE_ITEMS = 6;
const MAX_RESULT_METRICS = 4;
const MAX_RESULT_DOCUMENTS = 4;
const MAX_RESULT_DELIVERIES = 4;
const MAX_RESULT_SECTIONS = 3;
const MAX_SECTION_ITEMS = 4;
const DOCUMENT_REF_PATTERN = /^doc-[a-f0-9]{20}$/u;
const DELIVERY_REF_PATTERN = /^delivery-[a-f0-9]{20}$/u;
const DELIVERY_KIND_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/u;
const DELIVERY_ROLE_PATTERN = /^[a-z][a-z0-9_]{1,31}$/u;
const DOCUMENT_KINDS = new Set<OutputDocument['kind']>([
  'MD', 'TXT', 'JSON', 'PDF', 'DOCX', 'XLSX', 'CSV', 'RTF', 'PPTX',
]);
const RESULT_SECTION_KINDS = new Set<OpportunityResultSectionKind>(['conclusion', 'evidence', 'next']);
const ALLOWED_ACTIONS = new Set<OpportunityActionIntent>([
  'view_artifact',
  'continue_codex',
  'ask',
  'complete',
  'snooze',
  'dismiss',
]);

const ACTION_TONES: Record<OpportunityActionIntent, ActionTone> = {
  view_artifact: 'primary',
  open_delivery: 'primary',
  continue_codex: 'codex',
  ask: 'codex',
  complete: 'positive',
  snooze: 'quiet',
  dismiss: 'danger',
};

function validDeliveryReferences(value: unknown): DeliveryReference[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .map((candidate) => {
      if (!candidate || typeof candidate !== 'object') return null;
      const id = visibleText((candidate as { id?: unknown }).id, 64);
      const label = visibleText((candidate as { label?: unknown }).label, 96);
      const actionLabel = visibleText((candidate as { actionLabel?: unknown }).actionLabel, 24) || '打开结果';
      const kind = visibleText((candidate as { kind?: unknown }).kind, 24) as DeliveryReference['kind'];
      const role = visibleText((candidate as { role?: unknown }).role, 24) as DeliveryReference['role'];
      const state = visibleText((candidate as { state?: unknown }).state, 16) as DeliveryReference['state'];
      const error = visibleText((candidate as { error?: unknown }).error, 120);
      if (
        !DELIVERY_REF_PATTERN.test(id)
        || !label
        || !DELIVERY_KIND_PATTERN.test(kind)
        || !DELIVERY_ROLE_PATTERN.test(role)
        || !['ready', 'error'].includes(state)
        || seen.has(id)
      ) return null;
      seen.add(id);
      return { id, label, actionLabel, kind, role, state, ...(state === 'error' && error ? { error } : {}) };
    })
    .filter((candidate): candidate is DeliveryReference => Boolean(candidate))
    .slice(0, MAX_RESULT_DELIVERIES);
}

function deliveryAction(deliveries: DeliveryReference[]): OpportunityPresentationAction | null {
  const target = deliveries.find((delivery) => delivery.state === 'ready' && delivery.role === 'primary')
    ?? deliveries.find((delivery) => delivery.state === 'ready');
  if (!target) return null;
  return {
    intent: 'open_delivery',
    targetId: target.id,
    label: visibleText(target.actionLabel, 24) || '打开结果',
  };
}

function visibleText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/[—–]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

function safeFallbackHeadline(item: Opportunity): string {
  const candidate = visibleText(item.title, 96);
  if (candidate && !/^(?:处理|原话|消息|范围变化|兑现承诺)[：:]/u.test(candidate)) return candidate;
  if (item.signalType === 'task_change') return '这项任务的范围有变化，需要核对影响';
  if (item.signalType === 'direct_request') return '这里识别到一项明确任务';
  if (item.status === 'ready') return 'Codex 已完成这项任务';
  if (item.status === 'preparing') return 'Codex 正在处理这项任务';
  return '这里有一项值得处理的建议';
}

export function addressHeadline(value: unknown, fallback: string): string {
  const candidate = visibleText(value, 108) || visibleText(fallback, 108);
  const withoutAddress = candidate.replace(/^老大[，,:：\s]*/u, '').trim();
  return `老大，${withoutAddress || '这里有一项值得处理的建议'}`;
}

function preservesTaskContext(candidate: string, taskTitle: string): boolean {
  const chat = taskTitle.match(/「([^」]+)」/u)?.[1];
  const actor = taskTitle.match(/^老大，([^，。]{1,24})在「/u)?.[1];
  if (chat && !candidate.includes(`「${chat}」`)) return false;
  if (actor && !candidate.includes(actor)) return false;
  if (taskTitle.includes('@你') && !candidate.includes('@你')) return false;
  return true;
}

function fallbackActions(item: Opportunity): OpportunityPresentationAction[] {
  if (item.status === 'ready' && item.artifactUrl) {
    if (item.signalType === 'task_change') {
      return [
        { intent: 'view_artifact', label: '查看变更分析' },
        { intent: 'continue_codex', label: '继续核对' },
        { intent: 'complete', label: '采用新方案' },
      ];
    }
    return [
      { intent: 'view_artifact', label: '查看结果' },
      { intent: 'continue_codex', label: '继续完善' },
      { intent: 'complete', label: '确认完成' },
    ];
  }

  if (item.status === 'preparing') {
    return [
      { intent: 'continue_codex', label: '去 Codex 看进度' },
      { intent: 'snooze', label: '稍后再看' },
      { intent: 'dismiss', label: '不再跟进' },
    ];
  }

  if (item.signalType === 'task_change') {
    return [
      { intent: 'continue_codex', label: '分析变更影响' },
      { intent: 'snooze', label: '稍后决定' },
      { intent: 'dismiss', label: '无需调整' },
    ];
  }

  if (item.signalType === 'research') {
    return [
      { intent: 'continue_codex', label: '开始检索' },
      { intent: 'snooze', label: '稍后研究' },
      { intent: 'dismiss', label: '不再关注' },
    ];
  }

  return [
    { intent: 'continue_codex', label: item.signalType === 'direct_request' ? '开始处理' : '交给 Codex' },
    { intent: 'snooze', label: '稍后再看' },
    { intent: 'dismiss', label: '不用处理' },
  ];
}

function validManifestActions(value: unknown): OpportunityPresentationAction[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const actions: OpportunityPresentationAction[] = [];

  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const intent = (candidate as { intent?: unknown }).intent;
    const label = visibleText((candidate as { label?: unknown }).label, 16);
    if (typeof intent !== 'string' || !ALLOWED_ACTIONS.has(intent as OpportunityActionIntent) || !label) continue;
    // open_delivery is deliberately absent from ALLOWED_ACTIONS. Only the host
    // can mint an opaque targetId through a verified DeliveryReference.
    const allowedIntent = intent as Exclude<OpportunityActionIntent, 'open_delivery'>;
    const identity = `${allowedIntent}:${label}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    actions.push({ intent: allowedIntent, label });
  }
  return actions;
}

export function resolveOpportunityPresentation(item: Opportunity): ResolvedOpportunityPresentation {
  const manifest = item.presentation;
  const taskHeadline = addressHeadline(safeFallbackHeadline(item), '这里有一项值得处理的建议');
  const modelHeadline = addressHeadline(manifest?.headline, taskHeadline);
  // The task heading is an answer to "who, where, and what". A model result
  // headline may replace it only when it keeps that routing context intact.
  const headline = preservesTaskContext(modelHeadline, taskHeadline) ? modelHeadline : taskHeadline;
  const summary = visibleText(manifest?.summary, 180) || visibleText(item.reason, 180);
  const actions = validManifestActions(manifest?.actions);
  const deliveries = validDeliveryReferences(item.deliveries ?? item.receipt?.result?.deliveries);
  const hostAction = deliveryAction(deliveries);
  const contextualActions = actions.length ? actions : fallbackActions(item);
  const orderedActions = [
    ...(hostAction ? [hostAction] : []),
    ...contextualActions.filter((action) => !hostAction || action.intent !== 'view_artifact'),
  ].filter((action, index, all) => all.findIndex((candidate) => (
    candidate.intent === action.intent && candidate.label === action.label
  )) === index);
  const resolvedActions = orderedActions.map((action) => ({
    ...action,
    tone: ACTION_TONES[action.intent],
  }));

  return {
    headline,
    summary: summary || 'Codex 会在本地完成处理，并保留可核验的结果。',
    actions: resolvedActions,
  };
}

function validStep(value: unknown): OpportunityStep | null {
  if (!value || typeof value !== 'object') return null;
  const label = visibleText((value as { label?: unknown }).label, 80);
  const state = (value as { state?: unknown }).state;
  if (!label || !['done', 'running', 'pending', 'error'].includes(String(state))) return null;
  const time = visibleText((value as { time?: unknown }).time, 32);
  return {
    label,
    state: state as OpportunityStep['state'],
    ...(time ? { time } : {}),
  };
}

function selectCurrentStep(timeline: OpportunityStep[]): OpportunityStep {
  return timeline.find((step) => step.state === 'running')
    ?? timeline.find((step) => step.state === 'error')
    ?? [...timeline].reverse().find((step) => step.state === 'done')
    ?? timeline.find((step) => step.state === 'pending')
    ?? { label: '等待 Codex 接手', state: 'pending' };
}

export function resolveOpportunityReceipt(item: Opportunity): ResolvedOpportunityReceipt {
  const receiptTimeline = Array.isArray(item.receipt?.timeline) ? item.receipt.timeline : [];
  const timeline = (receiptTimeline.length ? receiptTimeline : item.steps)
    .map(validStep)
    .filter((step): step is OpportunityStep => Boolean(step))
    .slice(0, MAX_TIMELINE_ITEMS);
  const safeTimeline = timeline.length ? timeline : [{ label: '等待 Codex 接手', state: 'pending' as const }];
  const result = item.receipt?.result;
  const resultTitle = visibleText(result?.title, 80);
  const metrics = Array.isArray(result?.metrics)
    ? result.metrics
      .map((metric) => ({
        label: visibleText(metric?.label, 28),
        value: visibleText(metric?.value, 36),
      }))
      .filter((metric) => metric.label && metric.value)
      .slice(0, MAX_RESULT_METRICS)
    : [];
  const documents = Array.isArray(result?.documents)
    ? result.documents
      .map((document) => ({
        id: visibleText(document?.id, 32),
        label: visibleText(document?.label, 96),
        kind: visibleText(document?.kind, 8).toUpperCase() as OutputDocument['kind'],
      }))
      .filter((document) => (
        DOCUMENT_REF_PATTERN.test(document.id)
        && Boolean(document.label)
        && DOCUMENT_KINDS.has(document.kind)
      ))
      .slice(0, MAX_RESULT_DOCUMENTS)
    : [];
  const deliveries = validDeliveryReferences(item.deliveries ?? result?.deliveries);
  const sections = Array.isArray(result?.sections)
    ? result.sections
      .map((section) => {
        const kind = visibleText(section?.kind, 16) as OpportunityResultSectionKind;
        const title = visibleText(section?.title, 28);
        const items = Array.isArray(section?.items)
          ? section.items.map((item) => visibleText(item, 140)).filter(Boolean).slice(0, MAX_SECTION_ITEMS)
          : [];
        return { kind, title, items };
      })
      .filter((section) => RESULT_SECTION_KINDS.has(section.kind) && section.title && section.items.length)
      .slice(0, MAX_RESULT_SECTIONS)
    : [];

  const fallbackReadyResult = item.status === 'ready'
    ? {
        title: '执行结果已就绪',
        summary: visibleText(item.reason, 200) || 'Codex 已完成只读核验。',
        ...(item.artifactUrl ? { deliverableLabel: '本地产物' } : {}),
        metrics: [],
        sections: [],
        documents: [],
        deliveries,
      }
    : undefined;

  return {
    timeline: safeTimeline,
    current: selectCurrentStep(safeTimeline),
    ...(resultTitle ? {
      result: {
        title: resultTitle,
        ...(visibleText(result?.summary, 200) ? { summary: visibleText(result?.summary, 200) } : {}),
        ...(visibleText(result?.deliverableLabel, 40)
          ? { deliverableLabel: visibleText(result?.deliverableLabel, 40) }
          : {}),
        metrics,
        sections,
        documents,
        deliveries,
      },
    } : fallbackReadyResult ? { result: fallbackReadyResult } : {}),
  };
}

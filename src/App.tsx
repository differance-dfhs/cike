import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CalendarX,
  CaretDown,
  Check,
  Clock,
  ClockCounterClockwise,
  DotsThree,
  Eye,
  FileText,
  Info,
  Robot,
  Sparkle,
  SpinnerGap,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  actOnOpportunity,
  getCodexRuntime,
  getSnapshot,
  recordInteraction,
  type CodexRuntimeState,
} from './api';
import duduAtlas from './assets/dudu-atlas.webp';
import { ArtifactViewer } from './components/ArtifactViewer';
import { DocumentLinks } from './components/DocumentLinks';
import type {
  AgentSnapshot,
  BackgroundWorkItem,
  DeliveryReference,
  Intervention,
  InterventionKind,
  InterventionState,
  Opportunity,
  OpportunityAction,
  OpportunityActionIntent,
  OpportunityPresentationAction,
  OpportunityReceipt,
  OutputDocument,
  SuggestionHistoryItem,
} from './types';

const SNAPSHOT_POLL_MS = 30_000;
const CODEX_POLL_MS = 4_000;
const GLANCE_DURATION_MS = 7_000;
const LEAVE_COLLAPSE_MS = 800;
const COLLAPSE_ANIMATION_MS = 180;
const VIEWED_DWELL_MS = 4_000;
const EXPANDED_BASE_HEIGHT = Object.freeze({ empty: 120, suggestion: 356, codex: 380 });
const ACTION_ROW_HEIGHT = 48;
const HIDDEN_OPPORTUNITY_STATUSES = new Set(['snoozed', 'completed', 'viewed']);
const HIDDEN_INTERVENTION_STATES = new Set(['snoozed', 'dismissed', 'completed']);

type IslandMode = 'dormant' | 'glance' | 'empty' | 'suggestion' | 'codex';
type DuduMode = 'idle' | 'working' | 'notice';
type IslandNotice = { title: string; detail: string; kind?: InterventionKind } | null;

function actionRows(count: number): number {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  return 1 + Math.ceil((count - 1) / 2);
}

function expandedHeightForActions(mode: Extract<IslandMode, 'empty' | 'suggestion' | 'codex'>, count: number): number {
  const baselineRows = mode === 'empty' ? 0 : 2;
  return EXPANDED_BASE_HEIGHT[mode] + Math.max(0, actionRows(count) - baselineRows) * ACTION_ROW_HEIGHT;
}

interface SurfaceItem {
  id: string;
  actionId: string;
  kind: InterventionKind;
  state: InterventionState;
  title: string;
  summary: string;
  statusLabel: string;
  projectLabel?: string;
  whyNow?: string;
  updatedAt?: string;
  completedAt?: string;
  artifactUrl?: string;
  sourceUrl?: string;
  progress?: {
    value?: number;
    label: string;
    currentStep?: string;
    completedSteps?: number;
    totalSteps?: number;
  };
  actions: OpportunityPresentationAction[];
  receipt?: OpportunityReceipt;
  documents: OutputDocument[];
  deliveries: DeliveryReference[];
  opportunity: Opportunity;
}

const unavailableRuntime: CodexRuntimeState = {
  state: 'unavailable',
  current: null,
  sessions: [],
  resources: { available: false, cpuPercent: 0, memoryBytes: 0, processCount: 0 },
  lastSeen: null,
};

function cleanText(value: unknown, maxLength = 220): string {
  return typeof value === 'string'
    ? value.replace(/[\r\n\t]+/gu, ' ').replace(/[—–]/gu, '-').replace(/\s+/gu, ' ').trim().slice(0, maxLength)
    : '';
}

function compactTitle(value: unknown, fallback = '这里有一项新判断'): string {
  const title = cleanText(value, 80).replace(/^老大[，,:\s]+/u, '');
  return `老大，${title || fallback}`;
}

function formatTime(value?: string): string {
  if (!value) return '刚刚';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '刚刚';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const clock = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return sameDay ? `今天 ${clock}` : `${date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} ${clock}`;
}

function kindLabel(kind: InterventionKind): string {
  if (kind === 'work_progress') return '正在帮你做';
  if (kind === 'work_result') return '结果已就绪';
  if (kind === 'decision') return '等你决定';
  return '此刻建议';
}

function opportunityKind(item: Opportunity): InterventionKind {
  if (item.status === 'preparing') return 'work_progress';
  if (item.status === 'ready') return 'work_result';
  if (item.signalType === 'task_change' || item.autonomy === 'needs_confirm') return 'decision';
  return 'recommendation';
}

function opportunityState(item: Opportunity): InterventionState {
  if (item.status === 'preparing') return 'running';
  if (item.status === 'ready') return 'ready';
  if (item.status === 'completed') return 'completed';
  if (item.status === 'snoozed') return 'snoozed';
  return 'active';
}

function receiptDocuments(receipt?: OpportunityReceipt): OutputDocument[] {
  return receipt?.result?.documents ?? [];
}

function receiptDeliveries(receipt?: OpportunityReceipt): DeliveryReference[] {
  return receipt?.result?.deliveries ?? [];
}

function deliveryAction(deliveries: DeliveryReference[]): OpportunityPresentationAction | null {
  const target = deliveries.find((delivery) => (
    delivery.state === 'ready'
    && delivery.role === 'primary'
    && /^delivery-[a-f0-9]{20}$/u.test(delivery.id)
  )) ?? deliveries.find((delivery) => (
    delivery.state === 'ready' && /^delivery-[a-f0-9]{20}$/u.test(delivery.id)
  ));
  if (!target) return null;
  return {
    intent: 'open_delivery',
    targetId: target.id,
    label: cleanText(target.actionLabel, 24) || '打开结果',
  };
}

function defaultActions(kind: InterventionKind, _artifactUrl?: string, _documents: OutputDocument[] = []): OpportunityPresentationAction[] {
  if (kind === 'work_result') {
    return [
      { intent: 'view_artifact', label: '看完整结果' },
      { intent: 'continue_codex', label: '继续完善' },
      { intent: 'complete', label: '采用并收起' },
    ];
  }
  if (kind === 'decision') {
    return [
      { intent: 'complete', label: '采用这版' },
      { intent: 'continue_codex', label: '继续核对' },
      { intent: 'snooze', label: '稍后决定' },
    ];
  }
  if (kind === 'recommendation') {
    return [
      { intent: 'complete', label: '采用建议' },
      { intent: 'continue_codex', label: '让 Codex 展开' },
      { intent: 'snooze', label: '稍后再看' },
    ];
  }
  return [
    { intent: 'continue_codex', label: '查看执行进度' },
    { intent: 'snooze', label: '稍后再看' },
    { intent: 'dismiss', label: '不再关注' },
  ];
}

function safeActions(
  value: OpportunityPresentationAction[] | undefined,
  kind: InterventionKind,
  artifactUrl?: string,
  documents: OutputDocument[] = [],
  deliveries: DeliveryReference[] = [],
): OpportunityPresentationAction[] {
  const allowed = new Set<Exclude<OpportunityActionIntent, 'open_delivery'>>([
    'view_artifact',
    'continue_codex',
    'ask',
    'complete',
    'snooze',
    'dismiss',
  ]);
  const actions = (value ?? []).flatMap((action) => {
    if (action.intent === 'open_delivery' || !allowed.has(action.intent)) return [];
    const label = cleanText(action.label, 18);
    return label ? [{ intent: action.intent, label }] : [];
  });
  const hostAction = deliveryAction(deliveries);
  const contextualActions = actions.length ? actions : defaultActions(kind, artifactUrl, documents);
  const candidates = [
    ...(hostAction ? [hostAction] : []),
    ...contextualActions,
  ];
  const resolved: OpportunityPresentationAction[] = [];
  const seen = new Set<string>();
  for (const action of candidates) {
    if (hostAction && action.intent === 'view_artifact') continue;
    const identity = `${action.intent}:${action.label}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    resolved.push(action);
  }
  return resolved;
}

function interventionOpportunity(
  item: Intervention,
  documents: OutputDocument[],
  deliveries: DeliveryReference[],
): Opportunity {
  const receipt = item.receipt ?? (documents.length || deliveries.length ? {
    timeline: [{ label: '结果已整理', state: 'done' as const, time: formatTime(item.completedAt ?? item.updatedAt) }],
    result: {
      title: item.title,
      summary: item.summary,
      documents,
      deliveries,
    },
  } : undefined);
  return {
    id: item.opportunityId ?? item.id,
    title: item.title,
    reason: item.summary,
    priority: item.priority ?? 'medium',
    confidence: 1,
    due: item.statusLabel ?? '现在',
    status: item.kind === 'work_progress' ? 'preparing' : item.kind === 'work_result' ? 'ready' : 'active',
    steps: receipt?.timeline ?? [],
    origin: 'Codex',
    ...(item.artifactUrl ? { artifactUrl: item.artifactUrl } : {}),
    ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
    ...(item.projectLabel ? { projectLabel: item.projectLabel } : {}),
    signalType: item.kind,
    presentation: {
      headline: item.title,
      summary: item.summary,
      actions: safeActions(item.actions, item.kind, item.artifactUrl, documents, deliveries),
    },
    ...(deliveries.length ? { deliveries } : {}),
    ...(receipt ? { receipt } : {}),
  };
}

function fromIntervention(item: Intervention): SurfaceItem {
  const documents = item.documents?.length ? item.documents : receiptDocuments(item.receipt);
  const deliveries = item.deliveries?.length ? item.deliveries : receiptDeliveries(item.receipt);
  const opportunity = interventionOpportunity(item, documents, deliveries);
  return {
    id: item.id,
    actionId: item.opportunityId ?? item.id,
    kind: item.kind,
    state: item.state,
    title: compactTitle(item.title),
    summary: cleanText(item.summary) || '已整理成一个可直接判断的结果。',
    statusLabel: cleanText(item.statusLabel, 28) || kindLabel(item.kind),
    projectLabel: cleanText(item.projectLabel, 40) || undefined,
    whyNow: cleanText(item.whyNow) || undefined,
    updatedAt: item.updatedAt,
    completedAt: item.completedAt,
    artifactUrl: item.artifactUrl,
    sourceUrl: item.sourceUrl,
    progress: item.progress,
    actions: safeActions(item.actions, item.kind, item.artifactUrl, documents, deliveries),
    receipt: item.receipt,
    documents,
    deliveries,
    opportunity,
  };
}

function fromOpportunity(item: Opportunity): SurfaceItem {
  const kind = opportunityKind(item);
  const documents = receiptDocuments(item.receipt);
  const deliveries = item.deliveries?.length ? item.deliveries : receiptDeliveries(item.receipt);
  const title = compactTitle(item.presentation?.headline || item.title);
  const summary = cleanText(item.presentation?.summary || item.reason) || '已整理成一个可直接判断的结果。';
  const receipt = item.receipt;
  const steps = receipt?.timeline ?? item.steps;
  const doneSteps = steps.filter((step) => step.state === 'done').length;
  return {
    id: item.id,
    actionId: item.id,
    kind,
    state: opportunityState(item),
    title,
    summary,
    statusLabel: kindLabel(kind),
    projectLabel: cleanText(item.groupLabel || item.projectLabel, 40) || undefined,
    whyNow: cleanText(item.recommendation?.whyNow) || undefined,
    artifactUrl: item.artifactUrl,
    sourceUrl: item.sourceUrl,
    progress: kind === 'work_progress' ? {
      label: steps.find((step) => step.state === 'running')?.label || '正在处理',
      currentStep: steps.find((step) => step.state === 'running')?.label,
      completedSteps: doneSteps,
      totalSteps: steps.length || undefined,
      value: steps.length ? doneSteps / steps.length : undefined,
    } : undefined,
    actions: safeActions(item.presentation?.actions, kind, item.artifactUrl, documents, deliveries),
    receipt,
    documents,
    deliveries,
    opportunity: {
      ...item,
      presentation: {
        headline: title,
        summary,
        actions: safeActions(item.presentation?.actions, kind, item.artifactUrl, documents, deliveries),
      },
      ...(deliveries.length ? { deliveries } : {}),
    },
  };
}

function fromBackground(item: BackgroundWorkItem): SurfaceItem {
  const kind: InterventionKind = item.state === 'complete' ? 'work_result' : 'work_progress';
  const state: InterventionState = item.state === 'complete' ? 'ready' : item.state === 'error' ? 'error' : 'running';
  return fromIntervention({
    id: item.id,
    opportunityId: item.opportunityId,
    kind,
    state,
    title: item.title,
    summary: item.summary || item.progress?.currentStep || item.progress?.label || '后台正在处理。',
    statusLabel: item.state === 'complete' ? '刚完成' : item.state === 'error' ? '需要检查' : '正在处理',
    projectLabel: item.projectLabel,
    updatedAt: item.updatedAt,
    completedAt: item.completedAt,
    artifactUrl: item.artifactUrl,
    progress: item.progress,
    receipt: item.receipt,
    documents: item.documents,
    deliveries: item.deliveries,
  });
}

function selectSurfaceItem(snapshot: AgentSnapshot | null): SurfaceItem | null {
  if (!snapshot) return null;
  // The unified intervention list is authoritative even when it is empty.
  // Falling through would revive completed runner history or a legacy card
  // that the server's Silence Gate intentionally removed.
  if (Array.isArray(snapshot.interventions)) {
    const intervention = snapshot.interventions
      .find((candidate) => !HIDDEN_INTERVENTION_STATES.has(candidate.state));
    return intervention ? fromIntervention(intervention) : null;
  }

  const current = snapshot.background?.current;
  if (current && ['queued', 'running'].includes(current.state)) return fromBackground(current);

  const opportunity = (snapshot.opportunities ?? [])
    .find((item) => !HIDDEN_OPPORTUNITY_STATUSES.has(item.status));
  return opportunity ? fromOpportunity(opportunity) : null;
}

function Dudu({ mode, size = 'normal' }: { mode: DuduMode; size?: 'micro' | 'small' | 'normal' }) {
  const row = mode === 'working' ? 7 : mode === 'notice' ? 3 : 0;
  const style = { '--pet-image': `url("${duduAtlas}")`, '--pet-row': row } as CSSProperties;
  return (
    <span className={`dudu dudu-${mode} dudu-${size}`} style={style} aria-hidden="true">
      <span className="dudu-sprite" />
    </span>
  );
}

function ActionIcon({ intent }: { intent: OpportunityActionIntent }) {
  if (intent === 'view_artifact') return <FileText size={15} weight="duotone" />;
  if (intent === 'open_delivery') return <BookOpen size={15} weight="duotone" />;
  if (intent === 'complete') return <Check size={15} weight="bold" />;
  if (intent === 'snooze') return <Clock size={15} weight="duotone" />;
  if (intent === 'dismiss') return <X size={15} weight="bold" />;
  return <Robot size={15} weight="duotone" />;
}

function HistoryIcon({ item }: { item: SuggestionHistoryItem }) {
  if (item.disposition === 'later') return <Clock size={14} weight="duotone" />;
  if (item.disposition === 'clicked') return <Robot size={14} weight="duotone" />;
  if (item.disposition === 'viewed') return <Eye size={14} weight="duotone" />;
  if (item.disposition === 'expired') return <CalendarX size={14} weight="duotone" />;
  if (['adopted', 'completed'].includes(item.disposition)) return <Check size={14} weight="bold" />;
  return <X size={14} weight="bold" />;
}

function HistoryPanel({
  items,
  onBack,
  onCollapse,
  onOpenResult,
}: {
  items: SuggestionHistoryItem[];
  onBack: () => void;
  onCollapse: () => void;
  onOpenResult: (item: SuggestionHistoryItem) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const today = new Date().toDateString();
  const groups = [
    { label: '今天', items: items.filter((entry) => new Date(entry.archivedAt).toDateString() === today) },
    { label: '更早', items: items.filter((entry) => new Date(entry.archivedAt).toDateString() !== today) },
  ].filter((group) => group.items.length);

  return (
    <section className="history-panel" aria-label="建议历史记录">
      <header className="history-header">
        <button className="history-back" type="button" onClick={onBack} aria-label="返回当前建议"><ArrowLeft size={15} weight="bold" /></button>
        <div><strong>历史记录</strong><small>看过、点击过和稍后处理的建议都在这里</small></div>
        <span>{items.length}</span>
        <button className="collapse-button" type="button" onClick={onCollapse} aria-label="收回灵动岛"><CaretDown size={16} weight="bold" /></button>
      </header>
      <div className="history-scroll">
        {groups.length ? groups.map((group) => (
          <section className="history-group" key={group.label}>
            <h2>{group.label}</h2>
            <div>
              {group.items.map((entry) => {
                const expanded = expandedId === entry.id;
                return (
                  <button
                    className={`history-row is-${entry.disposition} ${expanded ? 'is-expanded' : ''}`}
                    type="button"
                    key={entry.id}
                    onClick={() => {
                      if (entry.resultAvailable && entry.opportunity) onOpenResult(entry);
                      else setExpandedId(expanded ? null : entry.id);
                    }}
                    aria-expanded={entry.resultAvailable ? undefined : expanded}
                    aria-label={entry.resultAvailable ? `查看历史结果：${entry.title}` : undefined}
                  >
                    <span className="history-row-icon"><HistoryIcon item={entry} /></span>
                    <span className="history-row-copy">
                      <span><strong>{cleanText(entry.title, 72).replace(/^老大[，,：:\s]+/u, '')}</strong><time>{formatTime(entry.archivedAt)}</time></span>
                      <small>{[entry.projectLabel, entry.statusLabel].filter(Boolean).join(' · ')}</small>
                      {expanded ? <p>{cleanText(entry.summary, 180)}</p> : null}
                    </span>
                    {entry.resultAvailable && entry.opportunity ? <ArrowRight className="history-row-open" size={13} weight="bold" /> : null}
                  </button>
                );
              })}
            </div>
          </section>
        )) : (
          <div className="history-empty"><ClockCounterClockwise size={20} weight="duotone" /><strong>还没有历史记录</strong><span>看过或移出的建议会保留在这里。</span></div>
        )}
      </div>
    </section>
  );
}

export default function App() {
  const desktop = window.agentDesktop;
  const previewMode = new URLSearchParams(window.location.search).get('view') as IslandMode | null;
  const previewLocked = !desktop && Boolean(previewMode);
  const [mode, setMode] = useState<IslandMode>(desktop ? 'dormant' : previewMode || 'suggestion');
  const [notchReserved, setNotchReserved] = useState(false);
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [runtime, setRuntime] = useState<CodexRuntimeState>(unavailableRuntime);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<OpportunityActionIntent | null>(null);
  const [notice, setNotice] = useState<IslandNotice>(null);
  const [toast, setToast] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  const [isCollapsing, setIsCollapsing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyArtifact, setHistoryArtifact] = useState<SuggestionHistoryItem | null>(null);
  const [artifactView, setArtifactView] = useState<{
    item: SurfaceItem;
    openedDeliveryId?: string;
  } | null>(null);
  const modeRef = useRef(mode);
  const autoCollapseTimer = useRef<number | null>(null);
  const glanceTimer = useRef<number | null>(null);
  const collapseTimer = useRef<number | null>(null);
  const isCollapsingRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const expandedRef = useRef<HTMLElement>(null);
  const viewSession = useRef<{
    actionId: string;
    kind: InterventionKind;
    startedAt: number;
    activation: 'click' | 'hover';
  } | null>(null);

  const item = useMemo(() => selectSurfaceItem(snapshot), [snapshot]);

  const refreshSnapshot = useCallback(async () => {
    try {
      const result = await getSnapshot();
      startTransition(() => setSnapshot(result.snapshot));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshRuntime = useCallback(async () => {
    try {
      const next = await getCodexRuntime();
      startTransition(() => setRuntime(next));
    } catch {
      setRuntime((current) => current.state === 'unavailable' ? unavailableRuntime : current);
    }
  }, []);

  const setWindowMode = useCallback(async (nextMode: IslandMode) => {
    if (desktop) await desktop.setMode(nextMode);
    else setMode(nextMode);
  }, [desktop]);

  const collapse = useCallback(async () => {
    if (isCollapsingRef.current) return;
    const session = viewSession.current;
    viewSession.current = null;
    const likelyViewed = Boolean(
      session
      && session.activation === 'click'
      && session.kind !== 'work_progress'
      && performance.now() - session.startedAt >= VIEWED_DWELL_MS
      && document.visibilityState === 'visible'
      && document.hasFocus(),
    );
    setMenuOpen(false);
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (!reduceMotion && modeRef.current !== 'dormant') {
      isCollapsingRef.current = true;
      setIsCollapsing(true);
      await new Promise<void>((resolve) => {
        collapseTimer.current = window.setTimeout(() => {
          collapseTimer.current = null;
          resolve();
        }, COLLAPSE_ANIMATION_MS);
      });
    }
    setNotice(null);
    setShowWhy(false);
    setHistoryOpen(false);
    setHistoryArtifact(null);
    setArtifactView(null);
    try {
      await setWindowMode('dormant');
    } finally {
      isCollapsingRef.current = false;
      setIsCollapsing(false);
    }
    if (likelyViewed && session) {
      try {
        const next = await actOnOpportunity(session.actionId, 'viewed');
        startTransition(() => setSnapshot(next));
      } catch {
        // The card may already have been consumed by an explicit action.
      }
    }
  }, [setWindowMode]);

  const expand = useCallback(async (activation: 'click' | 'hover' = 'click') => {
    if (isCollapsingRef.current) return;
    setNotice(null);
    setHistoryOpen(false);
    setArtifactView(null);
    setHistoryArtifact(null);
    if (item && item.kind !== 'work_progress') {
      viewSession.current = {
        actionId: item.actionId,
        kind: item.kind,
        startedAt: performance.now(),
        activation,
      };
    } else {
      viewSession.current = null;
    }
    const nextMode = item || loading ? 'suggestion' : 'empty';
    if (desktop?.setContentHeight) {
      await desktop.setContentHeight(expandedHeightForActions(nextMode, item?.actions.length ?? 0));
    }
    await setWindowMode(nextMode);
  }, [desktop, item, loading, setWindowMode]);

  const showGlance = useCallback((nextNotice: NonNullable<IslandNotice>) => {
    setNotice(nextNotice);
    void setWindowMode('glance');
    if (glanceTimer.current) window.clearTimeout(glanceTimer.current);
    glanceTimer.current = window.setTimeout(() => {
      if (modeRef.current === 'glance') void collapse();
    }, GLANCE_DURATION_MS);
  }, [collapse, setWindowMode]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    void refreshSnapshot();
    void refreshRuntime();
    const snapshotTimer = window.setInterval(() => void refreshSnapshot(), SNAPSHOT_POLL_MS);
    const runtimeTimer = window.setInterval(() => void refreshRuntime(), CODEX_POLL_MS);
    return () => {
      window.clearInterval(snapshotTimer);
      window.clearInterval(runtimeTimer);
    };
  }, [refreshRuntime, refreshSnapshot]);

  useEffect(() => {
    if (!desktop) return undefined;
    void desktop.getDockState().then((state) => {
      setMode(state.mode ?? (state.collapsed ? 'dormant' : 'suggestion'));
      setNotchReserved(state.notchReserved === true);
    });
    return desktop.onDockState((state) => {
      if (state.mode === 'dormant' && modeRef.current !== 'dormant') {
        isCollapsingRef.current = false;
        setIsCollapsing(false);
        const session = viewSession.current;
        viewSession.current = null;
        const likelyViewed = Boolean(
          session
          && session.activation === 'click'
          && session.kind !== 'work_progress'
          && performance.now() - session.startedAt >= VIEWED_DWELL_MS
          && document.visibilityState === 'visible',
        );
        setNotice(null);
        setMenuOpen(false);
        setShowWhy(false);
        setHistoryOpen(false);
        setArtifactView(null);
        setHistoryArtifact(null);
        if (likelyViewed && session) {
          void actOnOpportunity(session.actionId, 'viewed')
            .then((next) => setSnapshot(next))
            .catch(() => {});
        }
      }
      setMode(state.mode ?? (state.collapsed ? 'dormant' : 'suggestion'));
      setNotchReserved(state.notchReserved === true);
    });
  }, [desktop]);

  useEffect(() => desktop?.onHoverExpand?.(() => {
    if (modeRef.current === 'dormant') void expand('hover');
  }), [desktop, expand]);

  useEffect(() => desktop?.onNotification?.((next) => {
    if (next) showGlance({ ...next });
  }), [desktop, showGlance]);

  useEffect(() => {
    if (previewLocked || loading || historyOpen || mode === 'dormant' || mode === 'glance') return;
    const target = artifactView || historyArtifact ? 'codex' : item ? 'suggestion' : 'empty';
    if (mode !== target) void setWindowMode(target);
  }, [artifactView, historyArtifact, historyOpen, item, loading, mode, previewLocked, setWindowMode]);

  useLayoutEffect(() => {
    if (!desktop?.setContentHeight || mode === 'dormant' || mode === 'glance') return undefined;
    const contentMode: Extract<IslandMode, 'empty' | 'suggestion' | 'codex'> = artifactView || historyArtifact
      ? 'codex'
      : item
        ? 'suggestion'
        : 'empty';
    const displayedActions = artifactView?.item.actions.length
      ?? (historyArtifact ? 1 : item?.actions.length ?? 0);
    let frame = 0;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        let height = expandedHeightForActions(contentMode, displayedActions);
        const root = expandedRef.current;
        const header = root?.querySelector<HTMLElement>('.island-header');
        const card = root?.querySelector<HTMLElement>('.single-object');
        if (header && card) height = Math.max(height, header.offsetHeight + card.scrollHeight);
        void desktop.setContentHeight(height);
      });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (observer && expandedRef.current) {
      observer.observe(expandedRef.current);
      const card = expandedRef.current.querySelector<HTMLElement>('.single-object');
      const actions = expandedRef.current.querySelector<HTMLElement>('.object-actions, .artifact-native-actions');
      if (card) observer.observe(card);
      if (actions) observer.observe(actions);
    }
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [artifactView, desktop, historyArtifact, historyOpen, item, mode, showWhy]);

  useEffect(() => {
    if (mode === 'dormant' || mode === 'glance') return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void collapse();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [collapse, mode]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const closeMenu = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeMenu);
    return () => document.removeEventListener('pointerdown', closeMenu);
  }, [menuOpen]);

  useEffect(() => () => {
    if (autoCollapseTimer.current) window.clearTimeout(autoCollapseTimer.current);
    if (glanceTimer.current) window.clearTimeout(glanceTimer.current);
    if (collapseTimer.current) window.clearTimeout(collapseTimer.current);
  }, []);

  const cancelAutoCollapse = () => {
    if (!autoCollapseTimer.current) return;
    window.clearTimeout(autoCollapseTimer.current);
    autoCollapseTimer.current = null;
  };

  const markDeliberateView = () => {
    const session = viewSession.current;
    if (!item || item.kind === 'work_progress') return;
    if (!session || session.actionId !== item.actionId || session.activation === 'hover') {
      viewSession.current = {
        actionId: item.actionId,
        kind: item.kind,
        startedAt: performance.now(),
        activation: 'click',
      };
    }
  };

  const scheduleAutoCollapse = () => {
    if (!desktop || mode === 'dormant' || menuOpen || isCollapsingRef.current) return;
    cancelAutoCollapse();
    autoCollapseTimer.current = window.setTimeout(() => {
      if (modeRef.current !== 'dormant') void collapse();
    }, LEAVE_COLLAPSE_MS);
  };

  const act = async (target: SurfaceItem | null, action: OpportunityAction, message: string) => {
    if (!target || pendingAction) return;
    viewSession.current = null;
    setPendingAction(
      action === 'unimportant' || action === 'expired'
        ? 'dismiss'
        : action === 'continue'
          ? 'continue_codex'
          : action === 'viewed'
            ? 'view_artifact'
            : action as OpportunityActionIntent,
    );
    try {
      const next = await actOnOpportunity(target.actionId, action);
      setSnapshot(next);
      setToast(message);
      window.setTimeout(() => setToast(''), 1_800);
    } catch {
      setToast('这次没有保存成功');
    } finally {
      setPendingAction(null);
    }
  };

  const openInCodex = async (
    target: SurfaceItem | null,
    selectedAction?: string,
    learningAction: Extract<OpportunityAction, 'continue' | 'ask'> = 'continue',
  ) => {
    if (!target || !desktop?.openInCodex || pendingAction) return;
    setPendingAction('continue_codex');
    const result = await desktop.openInCodex({
      title: target.title,
      context: [
        target.summary,
        target.whyNow ? `现在值得处理的原因：${target.whyNow}` : '',
        selectedAction ? `用户选择的下一步：${selectedAction}` : '',
      ].filter(Boolean).join('\n\n'),
      ...(target.artifactUrl ? { artifactUrl: target.artifactUrl } : {}),
      ...(target.projectLabel ? { projectLabel: target.projectLabel } : {}),
    });
    if (result.opened || result.copied) {
      try {
        viewSession.current = null;
        const next = await actOnOpportunity(target.actionId, learningAction);
        setSnapshot(next);
        setToast(result.opened ? '已转到 Codex，并从主面板移出' : '任务已复制，并从主面板移出');
      } catch {
        setToast(result.opened ? '已打开 Codex，但历史状态未保存' : '任务已复制');
      }
    } else {
      setToast('暂时无法打开 Codex');
    }
    setPendingAction(null);
  };

  const openDelivery = async (targetId: string | undefined, target: SurfaceItem | null) => {
    if (!target || !targetId || !desktop?.openDelivery || pendingAction) {
      setToast('这份交付暂时无法打开');
      return;
    }
    setPendingAction('open_delivery');
    let result: Awaited<ReturnType<NonNullable<typeof desktop.openDelivery>>>;
    try {
      result = await desktop.openDelivery(targetId);
    } catch {
      setToast('暂时无法打开这份交付');
      setPendingAction(null);
      return;
    }
    if (!result.opened) {
      setToast('交付内容已移动或尚未准备完成');
      setPendingAction(null);
      return;
    }
    if (result.presentation === 'in_app') {
      setArtifactView({ item: target, openedDeliveryId: targetId });
    }
    viewSession.current = null;
    try {
      const next = await actOnOpportunity(target.actionId, 'viewed');
      setSnapshot(next);
    } catch {
      setToast('交付已打开，但历史状态未保存');
    }
    setPendingAction(null);
  };

  const handleAction = async (
    intent: OpportunityActionIntent,
    targetId?: string,
    target: SurfaceItem | null = item,
    actionLabel?: string,
  ) => {
    if (intent === 'open_delivery') {
      await openDelivery(targetId, target);
      return;
    }
    if (intent === 'view_artifact') {
      if (target) {
        setArtifactView({ item: target });
        await act(target, 'viewed', '已看过，记录已放入历史');
      }
      return;
    }
    if (intent === 'continue_codex' || intent === 'ask') {
      await openInCodex(target, actionLabel, intent === 'ask' ? 'ask' : 'continue');
      return;
    }
    if (intent === 'complete') {
      await act(target, 'complete', '已确认并收起');
      if (target && artifactView?.item.actionId === target.actionId) setArtifactView(null);
      return;
    }
    if (intent === 'snooze') {
      await act(target, 'snooze', '已移到历史，可稍后查看');
      if (target && artifactView?.item.actionId === target.actionId) setArtifactView(null);
      return;
    }
    await act(target, 'unimportant', '记住了，这类内容会降权');
    if (target && artifactView?.item.actionId === target.actionId) setArtifactView(null);
  };

  const markExpired = async (target: SurfaceItem | null = item) => {
    await act(target, 'expired', '已标为过期并移到历史');
    if (target && artifactView?.item.actionId === target.actionId) setArtifactView(null);
  };

  const mascotMode: DuduMode = item?.kind === 'work_progress' || runtime.state === 'running'
    ? 'working'
    : item || notice
      ? 'notice'
      : 'idle';
  const compactState = item?.kind === 'work_progress'
    ? cleanText(item.progress?.currentStep || item.progress?.label || '处理中', 12)
    : item?.kind === 'work_result'
      ? '结果就绪'
      : item?.kind === 'decision'
        ? '等你决定'
        : item
          ? '判断已备好'
          : runtime.state === 'running'
            ? '处理中'
            : '';
  const progressValue = item?.progress?.value == null
    ? undefined
    : Math.min(1, Math.max(0, item.progress.value > 1 ? item.progress.value / 100 : item.progress.value));
  const resultPreview = item?.kind === 'work_result'
    ? item.receipt?.result?.sections?.find((section) => section.kind === 'conclusion')
      || item.receipt?.result?.sections?.[0]
    : undefined;
  const history = snapshot?.history ?? [];
  const visibleActionIntents = new Set(item?.actions.map((action) => action.intent) ?? []);

  const openHistory = async () => {
    const session = viewSession.current;
    viewSession.current = null;
    setMenuOpen(false);
    setShowWhy(false);
    setArtifactView(null);
    setHistoryArtifact(null);
    setHistoryOpen(true);
    await setWindowMode('suggestion');
    const likelyViewed = Boolean(
      session
      && session.activation === 'click'
      && session.kind !== 'work_progress'
      && performance.now() - session.startedAt >= VIEWED_DWELL_MS
      && document.visibilityState === 'visible'
      && document.hasFocus(),
    );
    if (likelyViewed && session) {
      try {
        const next = await actOnOpportunity(session.actionId, 'viewed');
        setSnapshot(next);
      } catch {
        // Keep history available even when the consumed state was already saved.
      }
    }
  };

  const closeHistory = () => {
    setHistoryOpen(false);
    setHistoryArtifact(null);
  };

  const openHistoryResult = async (entry: SuggestionHistoryItem) => {
    setHistoryArtifact(entry);
    await setWindowMode('codex');
  };

  const closeHistoryResult = async () => {
    setHistoryArtifact(null);
    await setWindowMode('suggestion');
  };

  if (mode === 'dormant') {
    return (
      <main className={`island-stage mode-dormant ${notchReserved ? 'has-notch' : ''} ${desktop ? 'is-native' : ''}`}>
        <button className={`dormant-notch is-${item?.kind ?? runtime.state}`} type="button" onClick={() => void expand()} aria-label={compactState ? `${compactState}，展开此刻` : '展开此刻'}>
          <span className="dormant-wing dormant-wing-left"><Dudu mode={mascotMode} size="micro" /></span>
          <span className="dormant-camera-space" aria-hidden="true" />
          <span className={`dormant-wing dormant-wing-right ${compactState ? '' : 'is-quiet'}`}>
            {compactState ? <><span className="dormant-state"><i /><strong>{compactState}</strong></span><span className="dormant-progress" style={progressValue == null ? undefined : { '--progress': progressValue } as CSSProperties}><i /></span></> : null}
          </span>
        </button>
      </main>
    );
  }

  if (mode === 'glance') {
    const glanceTitle = notice?.title || item?.title || '此刻已整理好';
    const glanceDetail = notice?.detail || item?.summary || '点击查看';
    return (
      <main className={`island-stage mode-glance ${notchReserved ? 'has-notch' : ''} ${desktop ? 'is-native' : ''} ${isCollapsing ? 'is-closing' : ''}`} onPointerEnter={cancelAutoCollapse} onPointerLeave={scheduleAutoCollapse}>
        <section className={`glance-island is-${notice?.kind ?? item?.kind ?? 'recommendation'} ${isCollapsing ? 'is-closing' : ''}`} aria-label="此刻提醒">
          <button className="glance-main" type="button" onClick={() => void expand()}>
            <Dudu mode={mascotMode} size="normal" />
            <span className="glance-copy">
              <small>{kindLabel(notice?.kind ?? item?.kind ?? 'recommendation')}</small>
              <strong>{glanceTitle}</strong>
              <span>{glanceDetail}</span>
            </span>
            <ArrowRight size={16} weight="bold" />
          </button>
          <button className="glance-close" type="button" onClick={() => void collapse()} aria-label="收起"><X size={12} weight="bold" /></button>
        </section>
      </main>
    );
  }

  return (
    <main className={`island-stage mode-${mode} ${notchReserved ? 'has-notch' : ''} ${desktop ? 'is-native' : ''} ${isCollapsing ? 'is-closing' : ''}`} onPointerEnter={cancelAutoCollapse} onPointerLeave={scheduleAutoCollapse}>
      <section ref={expandedRef} className={`expanded-island ${!item ? 'is-empty' : ''} ${artifactView || historyArtifact ? 'is-artifact' : ''} ${historyOpen ? 'is-history' : ''} ${isCollapsing ? 'is-closing' : ''}`} aria-label="此刻灵动岛">
        {historyArtifact?.opportunity ? (
          <ArtifactViewer
            item={historyArtifact.opportunity}
            readOnly
            pendingActions={new Set()}
            onBack={() => void closeHistoryResult()}
            onAction={() => {}}
            onSourceOpen={() => void recordInteraction({
              kind: 'artifact_source_opened',
              opportunityId: historyArtifact.opportunityId,
              projectLabel: historyArtifact.projectLabel,
            }).catch(() => {})}
          />
        ) : historyOpen ? (
          <HistoryPanel items={history} onBack={closeHistory} onCollapse={() => void collapse()} onOpenResult={(entry) => void openHistoryResult(entry)} />
        ) : artifactView ? (
          <ArtifactViewer
            item={artifactView.item.opportunity}
            openedDeliveryId={artifactView.openedDeliveryId}
            pendingActions={pendingAction ? new Set([`${artifactView.item.actionId}:${pendingAction}`]) : new Set()}
            onBack={() => setArtifactView(null)}
            onAction={(intent, label, targetId) => void handleAction(intent, targetId, artifactView.item, label)}
            onSourceOpen={() => void recordInteraction({
              kind: 'artifact_source_opened',
              opportunityId: artifactView.item.actionId,
              projectLabel: artifactView.item.projectLabel,
            }).catch(() => {})}
          />
        ) : (
          <>
            <header className="island-header">
              <div className="island-brand"><Dudu mode={mascotMode} size="small" /><span><strong>此刻</strong><small>{item ? kindLabel(item.kind) : '不打扰'}</small></span></div>
              {item ? <span className={`state-chip is-${item.kind}`}>{item.statusLabel}</span> : null}
              <button className="history-button" type="button" onClick={() => void openHistory()} aria-label="查看历史记录">
                <ClockCounterClockwise size={15} weight="duotone" />
                {history.length ? <span>{Math.min(99, history.length)}</span> : null}
              </button>
              <div className="island-menu-wrap" ref={menuRef}>
                {item ? <button className="menu-button" type="button" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-label="更多操作"><DotsThree size={18} weight="bold" /></button> : null}
                {menuOpen ? (
                  <div className="island-menu" role="menu">
                    {!visibleActionIntents.has('dismiss') ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void handleAction('dismiss'); }}><X size={14} />不重要</button> : null}
                    <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void markExpired(); }}><CalendarX size={14} />已过期</button>
                    {!visibleActionIntents.has('snooze') ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void handleAction('snooze'); }}><Clock size={14} />稍后再看</button> : null}
                    <button type="button" role="menuitem" onClick={() => {
                      setMenuOpen(false);
                      setShowWhy((show) => {
                        if (!show && item) {
                          void recordInteraction({
                            kind: 'suggestion_expanded',
                            opportunityId: item.actionId,
                            projectLabel: item.projectLabel,
                          }).catch(() => {});
                        }
                        return !show;
                      });
                    }}><Info size={14} />为什么推给我</button>
                  </div>
                ) : null}
              </div>
              <button className="collapse-button" type="button" onClick={() => void collapse()} aria-label="收回灵动岛"><CaretDown size={16} weight="bold" /></button>
            </header>

            {loading ? (
              <div className="compact-empty"><SpinnerGap className="is-spinning" size={18} weight="bold" /><span>正在理解此刻</span></div>
            ) : item ? (
              <article key={item.id} className={`single-object is-${item.kind} is-${item.state}`} onPointerDown={markDeliberateView} onWheel={markDeliberateView}>
                <div className="object-kicker"><span>{item.projectLabel || kindLabel(item.kind)}</span>{item.kind === 'work_result' ? <time>{formatTime(item.completedAt || item.updatedAt)}</time> : null}</div>
                <h1>{item.title}</h1>
                <p>{item.summary}</p>

                {showWhy ? (
                  <aside className="why-panel"><Info size={15} weight="duotone" /><div><strong>为什么现在出现</strong><span>{item.whyNow || '这项内容与你当前负责的事相关，且现在有可以直接采用的新增价值。'}</span></div></aside>
                ) : null}

                {item.kind === 'work_progress' ? (
                  <section className="work-progress" aria-label="后台工作进度">
                    <div><span>{item.progress?.currentStep || item.progress?.label || '正在处理'}</span><strong>{progressValue == null ? '进行中' : `${Math.round(progressValue * 100)}%`}</strong></div>
                    <span className="progress-track" style={{ '--progress': progressValue ?? 0.34 } as CSSProperties}><i /></span>
                    {item.progress?.totalSteps ? <small>已完成 {item.progress.completedSteps ?? 0} / {item.progress.totalSteps} 步</small> : null}
                  </section>
                ) : null}

                {resultPreview?.items?.length ? (
                  <section className="result-preview" aria-label="结果预览">
                    <header><Sparkle size={13} weight="duotone" /><span>{resultPreview.title || '可直接采用的结论'}</span></header>
                    <ul>{resultPreview.items.slice(0, 2).map((entry) => <li key={entry}>{cleanText(entry, 88)}</li>)}</ul>
                  </section>
                ) : null}

                {item.kind === 'work_result' && item.documents.length ? (
                  <section className="result-files"><header><span><FileText size={14} weight="duotone" />可查看的产物</span><small>{item.documents.length} 个文件</small></header><DocumentLinks documents={item.documents} compact onOpened={() => void act(item, 'viewed', '已看过，记录已放入历史')} /></section>
                ) : null}

                {item.state === 'error' ? <div className="error-note"><WarningCircle size={15} weight="duotone" />处理时遇到问题，请查看后再决定。</div> : null}

                {item.actions.length ? (
                  <div className="object-actions" data-count={item.actions.length}>
                    {item.actions.map((action, index) => (
                      <button className={`is-${action.intent} ${index === 0 ? 'is-primary' : ''}`} type="button" key={`${action.intent}:${action.label}:${action.intent === 'open_delivery' ? action.targetId : index}`} disabled={Boolean(pendingAction)} onClick={() => void handleAction(action.intent, action.intent === 'open_delivery' ? action.targetId : undefined, item, action.label)}>
                        {pendingAction === action.intent ? <SpinnerGap className="is-spinning" size={15} weight="bold" /> : <ActionIcon intent={action.intent} />}
                        <span>{action.label}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </article>
            ) : (
              <div className="compact-empty"><Sparkle size={17} weight="duotone" /><div><strong>没有需要你处理的事</strong><span>此刻会继续筛选，有新价值时再出现。</span></div></div>
            )}
          </>
        )}
        {toast ? <div className="island-toast" role="status">{toast}</div> : null}
      </section>
    </main>
  );
}

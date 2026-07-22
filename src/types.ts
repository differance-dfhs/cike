export type SourceState = 'live' | 'connected' | 'available' | 'unavailable' | 'error' | 'stale';
export type OpportunityStatus = 'active' | 'preparing' | 'ready' | 'snoozed' | 'completed' | 'viewed';
export type StepState = 'done' | 'running' | 'pending' | 'error';
export type PlanItemState = 'working' | 'next' | 'waiting' | 'done';
export type PlanAutonomy = 'auto_change' | 'auto_read' | 'needs_confirm';
export type ProjectResponsibility = 'owner' | 'driver' | 'reviewer' | 'automation' | 'observer';
export type ProjectStatus = 'working' | 'waiting' | 'planned' | 'blocked';
export type TrajectoryStepState = 'done' | 'current' | 'next' | 'waiting' | 'blocked';

export interface CurrentContext {
  state: 'meeting' | 'post_meeting' | 'focus' | 'available' | 'stale';
  title: string;
  detail: string;
  elapsed?: string;
  meetingTitle?: string;
}

export interface SourceStatus {
  id: string;
  name: string;
  state: SourceState;
  detail: string;
  lastSeen?: string;
}

export interface SetupCheck {
  id: 'codex' | 'local' | 'chronicle' | 'lark' | 'deepread' | 'lark-publisher';
  label: string;
  required: boolean;
  state: 'ready' | 'missing' | 'error';
  detail: string;
  recovery?: string;
}

export interface AgentSetup {
  state: 'needs_setup' | 'partial' | 'ready';
  readyCount: number;
  totalCount: number;
  autoExecute: boolean;
  contextSourcesEnabled: boolean;
  checks: SetupCheck[];
}

export interface OpportunityStep {
  label: string;
  state: StepState;
  time?: string;
}

export type OpportunityActionIntent =
  | 'view_artifact'
  | 'open_delivery'
  | 'continue_codex'
  | 'ask'
  | 'complete'
  | 'snooze'
  | 'dismiss';

export interface StandardOpportunityPresentationAction {
  intent: Exclude<OpportunityActionIntent, 'open_delivery'>;
  label: string;
}

export interface DeliveryOpportunityPresentationAction {
  intent: 'open_delivery';
  label: string;
  targetId: string;
}

export type OpportunityPresentationAction =
  | StandardOpportunityPresentationAction
  | DeliveryOpportunityPresentationAction;

// Delivery kinds are adapter identifiers, not task types. The built-in
// adapters cover papers, trusted Feishu docs and local/generic results, while
// the opaque envelope remains forward-compatible with additional adapters.
export type DeliveryKind =
  | 'PAPER_BUNDLE'
  | 'LARK_DOC'
  | 'LOCAL_FILE'
  | 'GENERIC_RESULT'
  | (string & {});
export type DeliveryRole =
  | 'primary'
  | 'original'
  | 'zh_version'
  | 'supporting'
  | (string & {});

export interface DeliveryReference {
  id: string;
  label: string;
  actionLabel: string;
  kind: DeliveryKind;
  role: DeliveryRole;
  state: 'ready' | 'error';
  error?: string;
}

export interface OpportunityPresentation {
  headline: string;
  summary?: string;
  actions: OpportunityPresentationAction[];
}

export interface OutputDocument {
  id: string;
  label: string;
  kind: 'MD' | 'TXT' | 'JSON' | 'PDF' | 'DOCX' | 'XLSX' | 'CSV' | 'RTF' | 'PPTX';
}

export type OpportunityResultSectionKind = 'conclusion' | 'evidence' | 'next';

export interface OpportunityResultSection {
  kind: OpportunityResultSectionKind;
  title: string;
  items: string[];
}

export interface OpportunityReceipt {
  timeline: OpportunityStep[];
  result?: {
    title: string;
    summary?: string;
    deliverableLabel?: string;
    metrics?: Array<{
      label: string;
      value: string;
    }>;
    sections?: OpportunityResultSection[];
    documents?: OutputDocument[];
    deliveries?: DeliveryReference[];
  };
}

export interface Opportunity {
  id: string;
  title: string;
  reason: string;
  priority: 'high' | 'medium' | 'low';
  confidence: number;
  due: string;
  status: OpportunityStatus;
  steps: OpportunityStep[];
  origin: string;
  artifactUrl?: string;
  sourceUrl?: string;
  groupKey?: string;
  groupLabel?: string;
  projectLabel?: string;
  signalType?: string;
  autonomy?: PlanAutonomy;
  recommendation?: {
    category: 'work' | 'project' | 'rhythm' | 'life';
    whyNow: string;
    evidence: Array<{
      label: string;
      detail: string;
    }>;
  };
  presentation?: OpportunityPresentation;
  receipt?: OpportunityReceipt;
  deliveries?: DeliveryReference[];
  feedback?: {
    rating: 'good' | 'bad';
    note?: string;
    recordedAt: string;
  };
}

export type InterventionKind = 'recommendation' | 'work_progress' | 'work_result' | 'decision';
export type InterventionState =
  | 'active'
  | 'running'
  | 'ready'
  | 'waiting'
  | 'completed'
  | 'snoozed'
  | 'dismissed'
  | 'error';

export interface InterventionProgress {
  value?: number;
  label: string;
  currentStep?: string;
  completedSteps?: number;
  totalSteps?: number;
}

export interface Intervention {
  id: string;
  kind: InterventionKind;
  state: InterventionState;
  title: string;
  summary: string;
  statusLabel?: string;
  projectLabel?: string;
  whyNow?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  artifactUrl?: string;
  sourceUrl?: string;
  opportunityId?: string;
  progress?: InterventionProgress;
  actions?: OpportunityPresentationAction[];
  receipt?: OpportunityReceipt;
  documents?: OutputDocument[];
  deliveries?: DeliveryReference[];
  priority?: 'high' | 'medium' | 'low';
}

export interface BackgroundWorkItem {
  id: string;
  title: string;
  summary?: string;
  state: 'queued' | 'running' | 'complete' | 'error';
  projectLabel?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  progress?: InterventionProgress;
  artifactUrl?: string;
  opportunityId?: string;
  receipt?: OpportunityReceipt;
  documents?: OutputDocument[];
  deliveries?: DeliveryReference[];
}

export interface BackgroundWorkState {
  state: 'idle' | 'working' | 'complete' | 'error';
  current?: BackgroundWorkItem | null;
  recent?: BackgroundWorkItem[];
}

export interface PlanItem {
  id: string;
  title: string;
  detail: string;
  state: PlanItemState;
  priority: 'high' | 'medium' | 'low';
  due?: string;
  projectLabel?: string;
  sourceLabel?: string;
  opportunityId?: string;
  autonomy: PlanAutonomy;
  progressLabel?: string;
}

export interface AgentPlan {
  generatedAt: string;
  focus?: PlanItem;
  items: PlanItem[];
}

export interface ProjectTrajectoryStep {
  id: string;
  label: string;
  state: TrajectoryStepState;
  statusLabel?: string;
  detail?: string;
  at?: string;
  due?: string;
  sourceLabel?: string;
  opportunityId?: string;
}

export interface ProjectTrajectory {
  id: string;
  label: string;
  responsibility: ProjectResponsibility;
  status: ProjectStatus;
  summary: string;
  updatedAt: string;
  steps: ProjectTrajectoryStep[];
  sourceLabels: string[];
  counts: {
    done: number;
    active: number;
    next: number;
    blocked: number;
  };
  attention?: string;
}

export interface PreparedItem {
  id: string;
  title: string;
  why: string;
  source: string;
  verification: 'verified' | 'checking' | 'unverified';
}

export interface Deliverable {
  label: string;
  detail: string;
}

export interface PreparedResult {
  title: string;
  subtitle: string;
  items: PreparedItem[];
  deliverables: Deliverable[];
  artifactUrl?: string;
  status: 'ready' | 'preparing' | 'empty';
}

export interface EvidenceItem {
  id: string;
  label: string;
  source: string;
  at: string;
  detail?: string;
}

export interface ActivityItem {
  id: string;
  time: string;
  title: string;
  detail?: string;
  state?: 'done' | 'running' | 'error';
}

export type SuggestionHistoryDisposition =
  | 'viewed'
  | 'clicked'
  | 'later'
  | 'adopted'
  | 'completed'
  | 'unimportant'
  | 'expired'
  | 'dismissed'
  | 'superseded';

export interface SuggestionHistoryItem {
  id: string;
  opportunityId: string;
  title: string;
  summary: string;
  projectLabel?: string;
  sourceLabel?: string;
  disposition: SuggestionHistoryDisposition;
  statusLabel: string;
  archivedAt: string;
  resultAvailable: boolean;
  opportunity?: Opportunity;
}

export interface AgentSnapshot {
  generatedAt: string;
  startupSync?: {
    state: 'ready' | 'partial';
    completedAt: string;
    detail: string;
  };
  plan?: AgentPlan;
  projects?: ProjectTrajectory[];
  now: CurrentContext;
  policy: {
    label: string;
    detail: string;
  };
  sources: SourceStatus[];
  setup?: AgentSetup;
  opportunities: Opportunity[];
  interventions?: Intervention[];
  history?: SuggestionHistoryItem[];
  background?: BackgroundWorkState;
  learning?: {
    baselineLoaded: boolean;
    totalActions: number;
    explicitFeedback: number;
    ratings: { good: number; bad: number };
    correctionCandidates: string[];
    updatedAt: string | null;
  };
  memory?: {
    state: 'ready' | 'empty';
    updatedAt: string | null;
    sourceCount: number;
    totalEntries: number;
    privacy: string;
    layers: Array<{
      id: 'working' | 'project' | 'preference' | 'expertise' | 'long_term';
      label: string;
      purpose: string;
      count: number;
    }>;
  };
  codexRuntime?: {
    state: 'running' | 'complete' | 'idle' | 'unavailable';
    current: CodexRuntimeSession | null;
    sessions: CodexRuntimeSession[];
    resources: {
      available: boolean;
      cpuPercent: number;
      memoryBytes: number;
      processCount: number;
    };
    lastSeen: string | null;
  };
  prepared: PreparedResult;
  evidence: EvidenceItem[];
  activity: ActivityItem[];
  connectorIssue?: {
    source: string;
    message: string;
    recovery: string;
  };
}

export interface CodexRuntimeSession {
  id: string;
  title: string;
  project: string;
  state: 'running' | 'complete' | 'idle';
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  usage: {
    turnTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    sessionTokens: number;
    contextWindow: number;
    contextPercent: number | null;
  };
  quota: {
    available: boolean;
    usedPercent: number | null;
    remainingPercent: number | null;
    windowMinutes: number;
    resetsAt: string | null;
    planType: string;
    credits: {
      hasCredits: boolean;
      unlimited: boolean;
      balance: string;
    };
  };
}

export type OpportunityAction = 'continue' | 'ask' | 'snooze' | 'dismiss' | 'unimportant' | 'expired' | 'complete' | 'viewed';
export type RecommendationRating = 'good' | 'bad';

export type InteractionKind =
  | 'artifact_opened'
  | 'artifact_source_opened'
  | 'codex_handoff'
  | 'suggestion_expanded'
  | 'project_opened'
  | 'sources_opened';

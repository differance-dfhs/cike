import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowSquareOut,
  BookOpen,
  CaretRight,
  ChatCircleText,
  Check,
  CheckCircle,
  Clock,
  FileText,
  Flag,
  Lightbulb,
  ListChecks,
  MagnifyingGlass,
  Robot,
  SpinnerGap,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import {
  extractNativeArtifactSections,
  fetchArtifactPayload,
  sanitizeArtifactDocument,
  trustedArtifactUrl,
} from '../artifact-preview';
import { DocumentLinks } from './DocumentLinks';
import {
  resolveOpportunityPresentation,
  resolveOpportunityReceipt,
} from '../opportunity-presentation';
import type {
  Opportunity,
  OpportunityActionIntent,
  OpportunityResultSection,
} from '../types';

interface ArtifactViewerProps {
  item: Opportunity;
  openedDeliveryId?: string;
  readOnly?: boolean;
  pendingActions: Set<string>;
  onBack: () => void;
  onAction: (intent: OpportunityActionIntent, label: string, targetId?: string) => void;
  onSourceOpen?: () => void;
}

type PreviewState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; url: string; srcDoc: string; sections: OpportunityResultSection[] }
  | { state: 'error'; message: string };

const SECTION_META = {
  conclusion: { label: '结论', Icon: Lightbulb },
  evidence: { label: '依据', Icon: MagnifyingGlass },
  next: { label: '下一步', Icon: ListChecks },
} as const;

const MEETING_SECTION_META = {
  conclusion: { label: '会议内容', Icon: ChatCircleText },
  evidence: { label: '会上确认', Icon: Flag },
  next: { label: '需要你做', Icon: ListChecks },
} as const;

const ACTION_ICONS = {
  view_artifact: FileText,
  open_delivery: BookOpen,
  continue_codex: Robot,
  ask: Robot,
  complete: Check,
  snooze: Clock,
  dismiss: X,
} as const;

export const ArtifactViewer = memo(function ArtifactViewer({
  item,
  openedDeliveryId,
  readOnly = false,
  pendingActions,
  onBack,
  onAction,
  onSourceOpen,
}: ArtifactViewerProps) {
  const titleId = useId();
  const backRef = useRef<HTMLButtonElement>(null);
  const presentation = useMemo(() => resolveOpportunityPresentation(item), [item]);
  const receipt = useMemo(() => resolveOpportunityReceipt(item), [item]);
  const result = receipt.result;
  const hasStructuredSections = Boolean(result?.sections.length);
  const safeArtifactUrl = useMemo(() => (
    item.artifactUrl
      ? trustedArtifactUrl(item.artifactUrl, window.location.href, window.agentDesktop?.apiBase)
      : null
  ), [item.artifactUrl]);
  const readyPreviewRef = useRef<Extract<PreviewState, { state: 'ready' }> | null>(null);
  const [preview, setPreview] = useState<PreviewState>(hasStructuredSections
    ? { state: 'idle' }
    : { state: 'loading' });
  const [showSource, setShowSource] = useState(false);
  const availableActions = useMemo(() => {
    const actions = presentation.actions.filter((action) => (
      (!readOnly || action.intent === 'view_artifact')
      && (action.intent !== 'open_delivery' || action.targetId !== openedDeliveryId)
    ));
    return readOnly ? actions.slice(0, 1) : actions;
  }, [openedDeliveryId, presentation.actions, readOnly]);
  const isMeetingDigest = item.signalType === 'meeting_digest';
  const sourceSections = preview.state === 'ready' && preview.url === safeArtifactUrl ? preview.sections : [];
  const sections = result?.sections.length ? result.sections : sourceSections;

  useEffect(() => {
    backRef.current?.focus();
  }, []);

  useEffect(() => {
    if (hasStructuredSections && !showSource) return undefined;

    const controller = new AbortController();
    if (!safeArtifactUrl) {
      setPreview({ state: 'error', message: '这份产物不是可信的本地文件，已停止加载。' });
      return () => controller.abort();
    }

    if (readyPreviewRef.current?.url === safeArtifactUrl) {
      setPreview(readyPreviewRef.current);
      return () => controller.abort();
    }

    setPreview({ state: 'loading' });
    void (async () => {
      try {
        let content: string;
        let contentType = 'text/html';
        if (window.agentDesktop?.readArtifact) {
          const response = await window.agentDesktop.readArtifact(safeArtifactUrl);
          if (!response.ok) throw new Error(response.error);
          content = response.content;
          contentType = response.contentType;
        } else {
          const response = await fetchArtifactPayload(safeArtifactUrl, controller.signal);
          content = response.content;
          contentType = response.contentType;
        }
        if (!controller.signal.aborted) {
          const readyPreview: Extract<PreviewState, { state: 'ready' }> = {
            state: 'ready',
            url: safeArtifactUrl,
            srcDoc: sanitizeArtifactDocument(content, contentType),
            sections: extractNativeArtifactSections(content, contentType),
          };
          readyPreviewRef.current = readyPreview;
          setPreview(readyPreview);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const tooLarge = error instanceof Error && error.message === 'artifact-too-large';
          setPreview({
            state: 'error',
            message: tooLarge ? '产物超过 2 MB，可从文件列表直接打开。' : '暂时无法在面板内读取这份产物。',
          });
        }
      }
    })();

    return () => controller.abort();
  }, [hasStructuredSections, safeArtifactUrl, showSource]);

  const handleAction = (intent: OpportunityActionIntent, label: string, targetId?: string) => {
    if (intent === 'view_artifact') {
      setShowSource((current) => {
        if (!current) onSourceOpen?.();
        return !current;
      });
      return;
    }
    onAction(intent, label, targetId);
  };

  const openMeetingSource = () => {
    if (!item.sourceUrl) return;
    onSourceOpen?.();
    if (window.agentDesktop?.openExternal) {
      void window.agentDesktop.openExternal(item.sourceUrl);
    } else {
      window.open(item.sourceUrl, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <section className="artifact-viewer" aria-labelledby={titleId}>
      <header className="artifact-viewer-header">
        <button ref={backRef} type="button" className="artifact-back" onClick={onBack}>
          <ArrowLeft size={15} weight="bold" aria-hidden="true" />
          <span>返回</span>
        </button>
        <span className="artifact-context">{item.groupLabel ?? item.projectLabel ?? '执行结果'}</span>
        <span className="artifact-ready-state">
          <CheckCircle size={12} weight="fill" aria-hidden="true" />
          {readOnly ? '历史结果' : '结果已就绪'}
        </span>
      </header>

      <div className="artifact-native-scroll">
        <section className="artifact-native-card">
          <div className="artifact-native-heading">
            <span>{item.origin.includes('Codex') ? item.origin : `${item.origin} + Codex`}</span>
            <h1 id={titleId}>{presentation.headline}</h1>
            <p>{result?.summary ?? presentation.summary}</p>
            {isMeetingDigest && item.sourceUrl ? (
              <button type="button" className="artifact-meeting-source" onClick={openMeetingSource}>
                <span>查看原始飞书妙记</span>
                <ArrowSquareOut size={13} weight="bold" aria-hidden="true" />
              </button>
            ) : null}
          </div>

          {result?.metrics.length ? (
            <dl className="artifact-metrics" aria-label="结果指标">
              {result.metrics.map((metric) => (
                <div key={`${metric.label}-${metric.value}`}>
                  <dd>{metric.value}</dd>
                  <dt>{metric.label}</dt>
                </div>
              ))}
            </dl>
          ) : null}

          <div className="artifact-native-sections" aria-label="结构化执行结果">
            {sections.length ? sections.map((section) => {
              const { Icon, label } = (isMeetingDigest ? MEETING_SECTION_META : SECTION_META)[section.kind];
              return (
                <section className={`artifact-native-section is-${section.kind}`} key={`${section.kind}-${section.title}`}>
                  <header>
                    <span><Icon size={14} weight="duotone" aria-hidden="true" /></span>
                    <div>
                      <small>{label}</small>
                      <h2>{section.title}</h2>
                    </div>
                  </header>
                  <ul>
                    {section.items.map((entry, index) => <li key={`${entry}-${index}`}>{entry}</li>)}
                  </ul>
                </section>
              );
            }) : preview.state === 'loading' || preview.state === 'idle' ? (
              <div className="artifact-native-state" role="status">
                <SpinnerGap className="is-spinning" size={17} weight="bold" aria-hidden="true" />
                <span>正在把结果整理成系统视图</span>
              </div>
            ) : (
              <section className="artifact-native-section is-conclusion">
                <header>
                  <span><Lightbulb size={14} weight="duotone" aria-hidden="true" /></span>
                  <div><small>结论</small><h2>处理结果</h2></div>
                </header>
                <ul><li>{result?.summary ?? presentation.summary}</li></ul>
              </section>
            )}
          </div>

          {result?.documents.length ? (
            <section className="artifact-deliverables" aria-label="可打开的交付文件">
              <header><span>相关文件</span><small>{result.documents.length} 个</small></header>
              <DocumentLinks documents={result.documents} />
            </section>
          ) : null}

          {availableActions.length ? <div className="artifact-native-actions" data-count={availableActions.length} aria-label="可用操作">
            {availableActions.map((action) => {
              const Icon = ACTION_ICONS[action.intent];
              const pending = pendingActions.has(`${item.id}:${action.intent}`);
              const label = action.intent === 'view_artifact' && showSource ? '收起完整文件' : action.label;
              return (
                <button
                  type="button"
                  className={`is-${action.tone} is-${action.intent}`}
                  key={`${action.intent}:${action.label}:${action.intent === 'open_delivery' ? action.targetId : ''}`}
                  disabled={pending}
                  onClick={() => handleAction(
                    action.intent,
                    action.label,
                    action.intent === 'open_delivery' ? action.targetId : undefined,
                  )}
                >
                  {pending ? <SpinnerGap className="is-spinning" size={16} weight="bold" aria-hidden="true" /> : <Icon size={16} weight="duotone" aria-hidden="true" />}
                  <span>{pending ? '正在处理' : label}</span>
                  {action.intent !== 'complete' ? <CaretRight size={14} weight="bold" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div> : null}
        </section>

        {showSource ? (
          <section className="artifact-source-panel" aria-label="完整本地文件">
            <header>
              <div><span>完整文件</span><small>只读隔离预览</small></div>
              <button type="button" onClick={() => setShowSource(false)}>收起</button>
            </header>
            <div className={`artifact-frame-shell is-${preview.state}`} aria-live="polite">
              {preview.state === 'loading' || preview.state === 'idle' ? (
                <div className="artifact-frame-state">
                  <SpinnerGap className="is-spinning" size={20} weight="bold" aria-hidden="true" />
                  <strong>正在读取本地文件</strong>
                </div>
              ) : preview.state === 'error' ? (
                <div className="artifact-frame-state is-error" role="alert">
                  <WarningCircle size={21} weight="duotone" aria-hidden="true" />
                  <strong>无法内嵌预览</strong>
                  <span>{preview.message}</span>
                </div>
              ) : (
                <iframe
                  className="artifact-frame"
                  title={`${result?.title ?? item.groupLabel ?? '执行结果'}完整文件`}
                  sandbox=""
                  referrerPolicy="no-referrer"
                  srcDoc={preview.srcDoc}
                />
              )}
            </div>
          </section>
        ) : null}
      </div>
    </section>
  );
});

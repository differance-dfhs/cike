import { memo, useState } from 'react';
import {
  ArrowUpRight,
  CheckCircle,
  FileText,
  SpinnerGap,
  WarningCircle,
} from '@phosphor-icons/react';
import type { OutputDocument } from '../types';

interface DocumentLinksProps {
  documents: OutputDocument[];
  compact?: boolean;
  onOpened?: (document: OutputDocument) => void;
}

type OpenState = {
  openingId?: string;
  openedId?: string;
  message?: string;
  tone?: 'status' | 'error';
};

export const DocumentLinks = memo(function DocumentLinks({ documents, compact = false, onOpened }: DocumentLinksProps) {
  const [state, setState] = useState<OpenState>({});
  if (!documents.length) return null;

  const openDocument = async (document: OutputDocument) => {
    if (state.openingId) return;
    if (!window.agentDesktop?.openDocument) {
      setState({ message: '桌面版可直接打开这个本地文件。', tone: 'status' });
      return;
    }
    setState({ openingId: document.id });
    try {
      const result = await window.agentDesktop.openDocument(document.id);
      if (!result.opened) throw new Error(result.error);
      setState({ openedId: document.id, message: `已打开 ${document.label}`, tone: 'status' });
      onOpened?.(document);
    } catch {
      setState({ message: '文件已移动、删除，或暂时没有可用的打开方式。', tone: 'error' });
    }
  };

  return (
    <div className={compact ? 'document-links is-compact' : 'document-links'} aria-label="Codex 交付文件">
      {documents.map((document) => {
        const opening = state.openingId === document.id;
        const opened = state.openedId === document.id;
        return (
          <button
            key={document.id}
            type="button"
            className="document-link"
            data-document-id={document.id}
            title={document.label}
            aria-label={`打开文档：${document.label}`}
            aria-busy={opening || undefined}
            disabled={Boolean(state.openingId)}
            onClick={() => void openDocument(document)}
          >
            <span className="document-link-icon" aria-hidden="true"><FileText size={14} weight="duotone" /></span>
            <span className="document-link-name">{document.label}</span>
            <span className="document-link-kind">{document.kind}</span>
            <span className="document-link-state" aria-hidden="true">
              {opening
                ? <SpinnerGap size={12} weight="bold" />
                : opened
                  ? <CheckCircle size={12} weight="fill" />
                  : <ArrowUpRight size={12} weight="bold" />}
            </span>
          </button>
        );
      })}
      {state.message ? (
        <p className={state.tone === 'error' ? 'document-link-message is-error' : 'document-link-message'} role={state.tone === 'error' ? 'alert' : 'status'}>
          {state.tone === 'error' ? <WarningCircle size={11} weight="fill" aria-hidden="true" /> : null}
          {state.message}
        </p>
      ) : null}
    </div>
  );
});

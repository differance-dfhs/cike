import { fallbackSnapshot } from './data/fallback';
import { demoSnapshot } from './data/demo';
import type {
  AgentSnapshot,
  CodexRuntimeSession,
  InteractionKind,
  OpportunityAction,
  RecommendationRating,
} from './types';

export interface CodexRuntimeState {
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
}

// A cold read can include a 15-second Lark allowlisted call. Keep the renderer
// timeout above that ceiling so a slow refresh does not replace live state with
// the interactive preview.
const API_TIMEOUT_MS = 25_000;

function apiUrl(path: string): string {
  const base = window.agentDesktop?.apiBase?.replace(/\/$/u, '') ?? '';
  return `${base}${path}`;
}

function normalizeSnapshot(snapshot: AgentSnapshot): AgentSnapshot {
  const artifactUrl = snapshot.prepared?.artifactUrl;
  const normalizeArtifactUrl = (value: string | undefined) => {
    if (!value || /^(?:https?:)?\/\//iu.test(value)) return value;
    return apiUrl(value.startsWith('/') ? value : `/${value}`);
  };
  return {
    ...snapshot,
    ...(snapshot.prepared ? {
      prepared: {
        ...snapshot.prepared,
        ...(artifactUrl ? { artifactUrl: normalizeArtifactUrl(artifactUrl) } : {}),
      },
    } : {}),
    opportunities: (snapshot.opportunities ?? []).map((item) => (
      item.artifactUrl ? { ...item, artifactUrl: normalizeArtifactUrl(item.artifactUrl) } : item
    )),
    interventions: (snapshot.interventions ?? []).map((item) => (
      item.artifactUrl ? { ...item, artifactUrl: normalizeArtifactUrl(item.artifactUrl) } : item
    )),
    history: (snapshot.history ?? []).map((entry) => (
      entry.opportunity?.artifactUrl
        ? {
            ...entry,
            opportunity: {
              ...entry.opportunity,
              artifactUrl: normalizeArtifactUrl(entry.opportunity.artifactUrl),
            },
          }
        : entry
    )),
    ...(snapshot.background ? {
      background: {
        ...snapshot.background,
        ...(snapshot.background.current ? {
          current: snapshot.background.current.artifactUrl
            ? {
                ...snapshot.background.current,
                artifactUrl: normalizeArtifactUrl(snapshot.background.current.artifactUrl),
              }
            : snapshot.background.current,
        } : {}),
        recent: (snapshot.background.recent ?? []).map((item) => (
          item.artifactUrl ? { ...item, artifactUrl: normalizeArtifactUrl(item.artifactUrl) } : item
        )),
      },
    } : {}),
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl(path), {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(window.agentDesktop?.apiToken
          ? { 'X-Cike-Session-Token': window.agentDesktop.apiToken }
          : {}),
        ...init?.headers,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function getSnapshot(): Promise<{ snapshot: AgentSnapshot; isFallback: boolean }> {
  const scenario = new URLSearchParams(window.location.search).get('demo');
  if (scenario) return { snapshot: demoSnapshot(scenario), isFallback: false };
  try {
    return { snapshot: normalizeSnapshot(await request<AgentSnapshot>('/api/snapshot')), isFallback: false };
  } catch {
    return {
      snapshot: { ...fallbackSnapshot, generatedAt: new Date().toISOString() },
      isFallback: true,
    };
  }
}

export async function scanNow(): Promise<AgentSnapshot> {
  return normalizeSnapshot(await request<AgentSnapshot>('/api/scan', { method: 'POST', body: '{}' }));
}

export async function getCodexRuntime(): Promise<CodexRuntimeState> {
  const scenario = new URLSearchParams(window.location.search).get('demo');
  if (scenario) {
    const runtime = demoSnapshot(scenario).codexRuntime;
    if (runtime) return runtime;
  }
  return request<CodexRuntimeState>('/api/codex-runtime');
}

export async function actOnOpportunity(id: string, action: OpportunityAction): Promise<AgentSnapshot> {
  return normalizeSnapshot(await request<AgentSnapshot>(`/api/opportunities/${encodeURIComponent(id)}/action`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  }));
}

export async function rateOpportunity(
  id: string,
  rating: RecommendationRating,
  note = '',
): Promise<AgentSnapshot> {
  return normalizeSnapshot(await request<AgentSnapshot>(`/api/opportunities/${encodeURIComponent(id)}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ rating, note }),
  }));
}

export async function recordInteraction(input: {
  kind: InteractionKind;
  opportunityId?: string;
  projectId?: string;
  projectLabel?: string;
  note?: string;
}): Promise<void> {
  await request('/api/interactions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

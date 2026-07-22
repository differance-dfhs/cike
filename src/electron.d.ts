export {};

type IslandWindowMode = 'dormant' | 'glance' | 'empty' | 'suggestion' | 'codex';
type IslandWindowState = {
  mode: IslandWindowMode;
  collapsed: boolean;
  expanded: boolean;
  displayId?: number | null;
  notchReserved?: boolean;
};

declare global {
  interface Window {
    agentDesktop?: {
      apiBase: string;
      apiToken?: string;
      toggleDock: () => Promise<boolean | void>;
      collapse: () => Promise<IslandWindowState | void>;
      expand: (mode?: IslandWindowMode) => Promise<IslandWindowState | void>;
      setMode: (mode: IslandWindowMode) => Promise<IslandWindowState | void>;
      setContentHeight: (height: number) => Promise<{ updated: boolean; height?: number }>;
      getDockState: () => Promise<IslandWindowState>;
      onDockState: (listener: (state: IslandWindowState) => void) => () => void;
      onHoverExpand?: (listener: () => void) => () => void;
      onNotification?: (
        listener: (notice: { title: string; detail: string } | null) => void
      ) => () => void;
      dismissNotification?: () => Promise<{ dismissed: boolean }>;
      readArtifact?: (url: string) => Promise<
        | { ok: true; content: string; contentType: 'text/html' | 'text/plain' | 'application/json' }
        | { ok: false; error: string }
      >;
      openDocument?: (id: string) => Promise<
        | { opened: true }
        | { opened: false; error: 'DESKTOP_UNAVAILABLE' | 'FILE_UNAVAILABLE' | 'OPEN_FAILED' }
      >;
      openDelivery?: (id: string) => Promise<
        | { opened: true; presentation: 'in_app' | 'external'; loadedTarget: string }
        | { opened: false; error: 'DESKTOP_UNAVAILABLE' | 'DELIVERY_NOT_FOUND' | 'DELIVERY_UNAVAILABLE' | 'OPEN_FAILED' }
      >;
      openExternal?: (url: string) => Promise<{ opened: boolean }>;
      openInCodex?: (payload: {
        title: string;
        context: string;
        artifactUrl?: string;
        projectLabel?: string;
      }) => Promise<{ opened: boolean; copied: boolean; prefilled: boolean }>;
      openCodexApp?: () => Promise<{ opened: boolean }>;
      chooseProjectRoot?: () => Promise<{ selected?: boolean; updated?: boolean; restarting?: boolean }>;
      setAutoExecute?: (enabled: boolean) => Promise<{ updated: boolean; restarting?: boolean }>;
      setContextSourcesEnabled?: (enabled: boolean) => Promise<{ updated: boolean; restarting?: boolean }>;
    };
  }
}

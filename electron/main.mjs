import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
} from 'electron';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  isSafeAppNavigation,
  isSafeEmbeddedFrameNavigation,
  normalizeLocalArtifactUrl,
  readArtifactResponse,
} from '../server/artifact-security.mjs';
import {
  normalizeLarkDocumentUrl,
  normalizePaperReaderUrl,
} from '../server/delivery-registry.mjs';
import { safeLabel } from '../server/security.mjs';
import { startService } from '../server/index.mjs';
import {
  codexDesktopAppCandidates,
  configuredAutoExecuteOverride,
  configuredContextSourcesOverride,
  configuredPublishLarkDocumentsOverride,
  configuredProjectRootsOverride,
  DEFAULT_DESKTOP_SETTINGS,
  loadDesktopSettings,
  resolveServiceDataDir,
  saveDesktopSettings,
} from './runtime-config.mjs';
import {
  displayHasCameraHousing,
  islandBounds,
  isExpandedIslandMode,
  normalizeIslandMode,
} from './island-layout.mjs';
import { normalizeExternalUrl } from './external-links.mjs';
import { notificationKeysForSnapshot, selectNotificationCandidate } from './notification-policy.mjs';
import { ensureDeepReadRuntime } from './deepread-runtime.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const preloadPath = path.join(__dirname, 'preload.cjs');
const devServerUrl = process.env.VITE_DEV_SERVER_URL || '';
const accelerator = 'CommandOrControl+Shift+Space';
const CODEX_HANDOFF_LIMITS = Object.freeze({ title: 120, context: 4_000, artifactUrl: 1_000, projectLabel: 120 });
const TRAY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
  <path d="M3 13.4c2.5 0 2.1-4.4 4.8-4.4 2.8 0 2.3-4.5 7.2-4.5" fill="none" stroke="#000" stroke-width="1.55" stroke-linecap="round"/>
  <circle cx="3" cy="13.4" r="1.55" fill="#000"/>
  <circle cx="7.8" cy="9" r="1.55" fill="#000"/>
  <circle cx="15" cy="4.5" r="1.55" fill="#000"/>
</svg>`;
const BACKGROUND_SCAN_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.PROACTIVE_AGENT_SCAN_INTERVAL_MS) || 30_000,
);
const DORMANT_HOVER_DELAY_MS = 140;
const startupTraceEnabled = process.env.CIKE_STARTUP_TRACE === '1';
let service = null;
let deepReadRuntime = null;
let deepReadRuntimePromise = null;
let drawerWindow = null;
let tray = null;
let notificationTimer = null;
let backgroundTimer = null;
let pointerMonitorTimer = null;
let pointerOutsideSince = 0;
let pointerMonitorArmedAt = 0;
let dormantHoverSince = 0;
let dormantHoverTriggered = false;
let backgroundScanInFlight = false;
let isQuitting = false;
let activeDisplayId = null;
let runtimeApiBase = 'http://127.0.0.1:4318';
let runtimeAccessToken = '';
let runtimeSettings = structuredClone(DEFAULT_DESKTOP_SETTINGS);
let runtimeSettingsPath = '';
let runtimeProjectRoots;
let runtimeContextSourcesEnabled = true;
let runtimeAutoExecute = false;
let runtimePublishLarkDocuments = false;
let lastNotificationKey = '';
let lastSuggestionCount = -1;
let lastWindowStateKey = '';
let islandMode = 'dormant';
let requestedExpandedHeight = null;
const notifiedInterventionKeys = new Set();

function traceStartup(phase) {
  if (!startupTraceEnabled) return;
  process.stderr.write(`[cike-startup] ${phase}\n`);
}

function browserPreferences() {
  const additionalArguments = [
    `--cike-api-base=${runtimeApiBase}`,
    ...(runtimeAccessToken ? [`--cike-session-token=${runtimeAccessToken}`] : []),
  ];
  return {
    preload: preloadPath,
    additionalArguments,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: false,
  };
}

function displayForDock() {
  const displays = screen.getAllDisplays();
  return displays.find((display) => display.id === activeDisplayId) || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function setBoundsIfChanged(window, bounds) {
  if (!window || window.isDestroyed()) return;
  const current = window.getBounds();
  if (
    current.x === bounds.x
    && current.y === bounds.y
    && current.width === bounds.width
    && current.height === bounds.height
  ) return;
  // Native macOS window animation and renderer animation compete for the same
  // frames. Resize once and let the renderer perform the visible reveal.
  window.setBounds(bounds, false);
}

function dockWindows(display = displayForDock()) {
  activeDisplayId = display.id;
  if (drawerWindow && !drawerWindow.isDestroyed()) {
    setBoundsIfChanged(drawerWindow, islandBounds(display, islandMode, requestedExpandedHeight));
  }
}

function cleanHandoffText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '').trim();
  if (!clean || clean.length > maxLength) return null;
  return clean;
}

function cleanArtifactUrl(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > CODEX_HANDOFF_LIMITS.artifactUrl) return undefined;
  return normalizeLocalArtifactUrl(value, { origin: runtimeApiBase }) || undefined;
}

function prepareCodexHandoff(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const keys = Object.keys(payload);
  if (keys.some((key) => !['title', 'context', 'artifactUrl', 'projectLabel'].includes(key))) return null;
  const title = cleanHandoffText(payload.title, CODEX_HANDOFF_LIMITS.title);
  const context = cleanHandoffText(payload.context, CODEX_HANDOFF_LIMITS.context);
  const artifactUrl = cleanArtifactUrl(payload.artifactUrl);
  const projectLabel = payload.projectLabel == null
    ? null
    : cleanHandoffText(payload.projectLabel, CODEX_HANDOFF_LIMITS.projectLabel);
  if (!title || !context || artifactUrl === undefined || (payload.projectLabel != null && !projectLabel)) return null;
  const lines = [
    `请继续执行：${title}`,
    '',
    context,
  ];
  if (artifactUrl) lines.push(`可查看产物：${artifactUrl}`);
  lines.push('', '请先基于以上上下文和我确认下一步，不要自动对外发送或修改共享内容。');
  return { prompt: lines.join('\n'), projectLabel };
}

function normalizedProjectName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\b(project|demo|app)\b/gu, '')
    .replace(/[\s_\-—–/／·（）()]+/gu, '');
}

function projectNameScore(projectLabel, candidateName) {
  const label = normalizedProjectName(projectLabel);
  const candidate = normalizedProjectName(candidateName);
  if (!label || !candidate) return 0;
  if (label === candidate) return 100;
  if (label.includes(candidate) || candidate.includes(label)) return Math.min(label.length, candidate.length) + 40;
  return 0;
}

function isPathWithin(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function resolveCodexProjectPath(projectLabel) {
  const configuredRoots = runtimeProjectRoots ?? runtimeSettings.projectRoots ?? [];
  let best = null;

  for (const configuredRoot of configuredRoots) {
    let canonicalRoot;
    try {
      const rootInfo = await lstat(configuredRoot);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) continue;
      canonicalRoot = await realpath(configuredRoot);
    } catch {
      continue;
    }

    const rootScore = projectNameScore(projectLabel, path.basename(canonicalRoot));
    if (rootScore && (!best || rootScore > best.score)) best = { path: canonicalRoot, score: rootScore };

    try {
      const entries = await readdir(canonicalRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const score = projectNameScore(projectLabel, entry.name);
        if (!score || (best && score <= best.score)) continue;
        const candidate = await realpath(path.join(canonicalRoot, entry.name));
        if (isPathWithin(candidate, canonicalRoot)) best = { path: candidate, score };
      }
    } catch {
      // A configured root can still be used even when its children are unreadable.
    }
  }

  if (best) return best.path;
  if (configuredRoots.length !== 1) return null;
  try {
    const fallback = await realpath(configuredRoots[0]);
    return (await lstat(configuredRoots[0])).isDirectory() ? fallback : null;
  } catch {
    return null;
  }
}

async function openInCodex(payload) {
  const handoff = prepareCodexHandoff(payload);
  if (!handoff) return { opened: false, copied: false, prefilled: false };

  clipboard.writeText(handoff.prompt);
  const copied = clipboard.readText() === handoff.prompt;
  if (!copied) return { opened: false, copied: false, prefilled: false };

  const codexUrl = new URL('codex://new');
  codexUrl.searchParams.set('prompt', handoff.prompt);
  const projectPath = await resolveCodexProjectPath(handoff.projectLabel);
  if (projectPath) codexUrl.searchParams.set('path', projectPath);

  try {
    await shell.openExternal(codexUrl.toString(), { activate: true });
    collapseDrawer();
    return { opened: true, copied: true, prefilled: true };
  } catch {
    // Keep the clipboard fallback for older Codex builds without the new-task deep link.
  }

  for (const applicationPath of codexDesktopAppCandidates()) {
    const errorMessage = await shell.openPath(applicationPath);
    if (errorMessage === '') {
      collapseDrawer();
      return { opened: true, copied: true, prefilled: false };
    }
  }
  return { opened: false, copied: true, prefilled: false };
}

async function activateCodex() {
  for (const applicationPath of codexDesktopAppCandidates()) {
    const errorMessage = await shell.openPath(applicationPath);
    if (errorMessage === '') {
      collapseDrawer();
      return { opened: true };
    }
  }
  return { opened: false };
}

function isWindowMainFrame(event, window) {
  return Boolean(
    window
    && !window.isDestroyed()
    && event?.sender === window.webContents
    && event?.senderFrame === window.webContents.mainFrame,
  );
}

function isDrawerMainFrame(event) {
  return isWindowMainFrame(event, drawerWindow);
}

function isTrustedUiFrame(event) {
  return isWindowMainFrame(event, drawerWindow);
}

async function openGeneratedDocument(event, rawId) {
  if (!isDrawerMainFrame(event) || !service?.runner?.resolveDocumentReference) {
    return { opened: false, error: 'DESKTOP_UNAVAILABLE' };
  }
  const document = await service.runner.resolveDocumentReference(rawId);
  if (!document) return { opened: false, error: 'FILE_UNAVAILABLE' };
  const errorMessage = await shell.openPath(document.path);
  return errorMessage === ''
    ? { opened: true }
    : { opened: false, error: 'OPEN_FAILED' };
}

async function openRegisteredDelivery(event, rawId) {
  if (!isDrawerMainFrame(event) || !service?.deliveryRegistry?.resolve) {
    return { opened: false, error: 'DESKTOP_UNAVAILABLE' };
  }
  const resolution = await service.deliveryRegistry.resolve(rawId);
  if (!resolution?.ok) {
    return {
      opened: false,
      error: resolution?.error === 'DELIVERY_NOT_FOUND' ? 'DELIVERY_NOT_FOUND' : 'DELIVERY_UNAVAILABLE',
    };
  }
  try {
    const launch = resolution.launch;
    if (launch?.type === 'external_url') {
      const safeUrl = launch.policy === 'local_paper_reader'
        ? normalizePaperReaderUrl(launch.url)
        : launch.policy === 'trusted_lark_document'
          ? normalizeLarkDocumentUrl(launch.url)
          : null;
      if (!safeUrl) return { opened: false, error: 'DELIVERY_UNAVAILABLE' };
      await shell.openExternal(safeUrl, { activate: true });
    } else if (launch?.type === 'local_file' && launch.policy === 'registered_local_file') {
      const configuredPath = String(launch.path || '');
      if (!path.isAbsolute(configuredPath)) return { opened: false, error: 'DELIVERY_UNAVAILABLE' };
      const info = await lstat(configuredPath);
      const canonicalPath = await realpath(configuredPath);
      if (!info.isFile() || info.isSymbolicLink() || canonicalPath !== configuredPath) {
        return { opened: false, error: 'DELIVERY_UNAVAILABLE' };
      }
      const errorMessage = await shell.openPath(canonicalPath);
      if (errorMessage !== '') return { opened: false, error: 'OPEN_FAILED' };
    } else if (launch?.type === 'in_app_result' && launch.policy === 'registered_local_result') {
      // The renderer already owns the sanitized artifact URL for this card.
      // The private registry path is used only as an existence/integrity gate;
      // no path crosses IPC and the island stays open for its native viewer.
    } else {
      return { opened: false, error: 'DELIVERY_UNAVAILABLE' };
    }
    const presentation = resolution.presentation === 'in_app' ? 'in_app' : 'external';
    if (presentation !== 'in_app') collapseDrawer();
    const loadedTarget = /^[A-Z][A-Z0-9_]{1,47}$/u.test(String(resolution.loadedTarget || ''))
      ? String(resolution.loadedTarget)
      : 'GENERIC_RESULT';
    return { opened: true, presentation, loadedTarget };
  } catch {
    return { opened: false, error: 'OPEN_FAILED' };
  }
}

async function readArtifactForPreview(rawUrl) {
  const artifactUrl = normalizeLocalArtifactUrl(rawUrl, { origin: runtimeApiBase });
  if (!artifactUrl) return { ok: false, error: '只能读取本机产物。' };
  try {
    const response = await fetch(artifactUrl, {
      headers: {
        Accept: 'text/html, text/plain, application/json',
        ...(runtimeAccessToken ? { 'X-Cike-Session-Token': runtimeAccessToken } : {}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    const result = await readArtifactResponse(response);
    return { ok: true, ...result };
  } catch {
    return { ok: false, error: '产物暂时无法预览。' };
  }
}

async function openTrustedExternal(rawUrl) {
  const url = normalizeExternalUrl(rawUrl);
  if (!url) return { opened: false };
  try {
    await shell.openExternal(url, { activate: true });
    return { opened: true };
  } catch {
    return { opened: false };
  }
}

function broadcastWindowState() {
  const state = windowState();
  const stateKey = `${state.mode}:${state.displayId ?? ''}:${state.notchReserved}`;
  if (stateKey !== lastWindowStateKey) {
    lastWindowStateKey = stateKey;
    if (drawerWindow && !drawerWindow.isDestroyed()) drawerWindow.webContents.send('window:state', state);
  }
  return state;
}

function windowState() {
  const expanded = isExpandedIslandMode(islandMode);
  return {
    mode: islandMode,
    collapsed: !expanded,
    expanded,
    displayId: activeDisplayId,
    notchReserved: displayHasCameraHousing(displayForDock()),
  };
}

function stopPointerMonitor() {
  if (pointerMonitorTimer) clearInterval(pointerMonitorTimer);
  pointerMonitorTimer = null;
  pointerOutsideSince = 0;
  pointerMonitorArmedAt = 0;
  dormantHoverSince = 0;
  dormantHoverTriggered = false;
}

function updatePointerMonitor() {
  if (!drawerWindow || drawerWindow.isDestroyed()) {
    stopPointerMonitor();
    return;
  }
  if (pointerMonitorTimer) return;
  pointerMonitorArmedAt = Date.now() + 700;
  pointerMonitorTimer = setInterval(() => {
    if (
      !drawerWindow
      || drawerWindow.isDestroyed()
    ) {
      return;
    }
    const point = screen.getCursorScreenPoint();
    const bounds = drawerWindow.getBounds();
    const inside = (
      point.x >= bounds.x
      && point.x < bounds.x + bounds.width
      && point.y >= bounds.y
      && point.y < bounds.y + bounds.height
    );
    if (islandMode === 'dormant') {
      pointerOutsideSince = 0;
      if (!inside) {
        dormantHoverSince = 0;
        dormantHoverTriggered = false;
        return;
      }
      if (dormantHoverTriggered) return;
      if (!dormantHoverSince) {
        dormantHoverSince = Date.now();
        return;
      }
      if (Date.now() - dormantHoverSince >= DORMANT_HOVER_DELAY_MS) {
        dormantHoverTriggered = true;
        drawerWindow.webContents.send('window:hover-expand');
      }
      return;
    }
    dormantHoverSince = 0;
    dormantHoverTriggered = false;
    if (!isExpandedIslandMode(islandMode) || Date.now() < pointerMonitorArmedAt) return;
    if (inside) {
      pointerOutsideSince = 0;
      return;
    }
    if (!pointerOutsideSince) {
      pointerOutsideSince = Date.now();
      return;
    }
    if (Date.now() - pointerOutsideSince >= 900) collapseDrawer();
  }, 40);
  pointerMonitorTimer.unref?.();
}

function setIslandMode(rawMode, { focus = false } = {}) {
  if (!drawerWindow || drawerWindow.isDestroyed()) return { expanded: false };
  const nextMode = normalizeIslandMode(rawMode, islandMode);
  const modeChanged = nextMode !== islandMode;
  islandMode = nextMode;
  if (focus) activeDisplayId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
  dockWindows(displayForDock());
  if (!drawerWindow.isVisible()) {
    if (focus) drawerWindow.show();
    else drawerWindow.showInactive();
  }
  if (focus && !drawerWindow.isFocused()) drawerWindow.focus();
  updatePointerMonitor();
  return broadcastWindowState();
}

function setIslandContentHeight(rawHeight) {
  const height = Number(rawHeight);
  if (!Number.isFinite(height) || height <= 0) return { updated: false };
  requestedExpandedHeight = Math.round(height);
  dockWindows(displayForDock());
  return { updated: true, height: drawerWindow?.getBounds().height ?? requestedExpandedHeight };
}

function expandDrawer(mode = 'suggestion') {
  return setIslandMode(normalizeIslandMode(mode, 'suggestion'), { focus: true });
}

function collapseDrawer() {
  return setIslandMode('dormant');
}

function toggleDrawer() {
  return isExpandedIslandMode(islandMode) ? collapseDrawer() : expandDrawer();
}

function dismissNotification() {
  if (notificationTimer) clearTimeout(notificationTimer);
  notificationTimer = null;
  if (drawerWindow && !drawerWindow.isDestroyed()) {
    drawerWindow.webContents.send('notification:update', null);
  }
  if (islandMode === 'glance') setIslandMode('dormant');
  return { dismissed: true };
}

function showNotification(payload) {
  if (!drawerWindow || drawerWindow.isDestroyed()) return false;
  const message = {
    title: safeLabel(payload?.title, '有一条新建议', 70),
    detail: safeLabel(payload?.detail, '点击查看详情。', 150),
  };
  const wasDormant = islandMode === 'dormant';
  if (wasDormant) setIslandMode('glance');
  else dockWindows();
  const messageKey = `${message.title}\u0000${message.detail}`;
  if (messageKey !== lastNotificationKey) {
    lastNotificationKey = messageKey;
    drawerWindow.webContents.send('notification:update', message);
  }
  if (!drawerWindow.isVisible()) drawerWindow.showInactive();
  if (notificationTimer) clearTimeout(notificationTimer);
  notificationTimer = setTimeout(() => {
    if (drawerWindow && !drawerWindow.isDestroyed()) {
      drawerWindow.webContents.send('notification:update', null);
      if (islandMode === 'glance') setIslandMode('dormant');
    }
  }, 8_000);
  return true;
}

function guardNavigation(window, primaryUrl, allowedDevServerUrl = '') {
  const navigationOptions = { primaryUrl, devServerUrl: allowedDevServerUrl };
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => {
    if (!isSafeAppNavigation(event.url, navigationOptions)) event.preventDefault();
  });
  window.webContents.on('will-frame-navigate', (event) => {
    const allowed = event.isMainFrame
      ? isSafeAppNavigation(event.url, navigationOptions)
      : isSafeEmbeddedFrameNavigation(event.url);
    if (!allowed) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

async function initializeRuntime() {
  runtimeSettingsPath = path.join(app.getPath('userData'), 'settings.json');
  runtimeAccessToken = app.isPackaged ? randomBytes(32).toString('base64url') : '';
  if (app.isPackaged) {
    runtimeSettings = await loadDesktopSettings(runtimeSettingsPath);
    const rootsOverride = configuredProjectRootsOverride();
    runtimeProjectRoots = rootsOverride ?? runtimeSettings.projectRoots;
    const contextOverride = configuredContextSourcesOverride();
    runtimeContextSourcesEnabled = contextOverride ?? (
      rootsOverride !== null ? rootsOverride.length > 0 : runtimeSettings.contextSourcesEnabled
    );
    const autoExecuteOverride = configuredAutoExecuteOverride();
    runtimeAutoExecute = autoExecuteOverride ?? runtimeSettings.autoExecute;
    const publishOverride = configuredPublishLarkDocumentsOverride();
    runtimePublishLarkDocuments = publishOverride ?? runtimeSettings.publishLarkDocuments;
    return;
  }

  const rootsOverride = configuredProjectRootsOverride();
  runtimeProjectRoots = rootsOverride ?? undefined;
  runtimeContextSourcesEnabled = configuredContextSourcesOverride() ?? true;
  runtimeAutoExecute = configuredAutoExecuteOverride() ?? true;
  runtimePublishLarkDocuments = configuredPublishLarkDocumentsOverride() ?? false;
}

async function persistSettingsAndRelaunch(nextSettings) {
  if (!app.isPackaged || !runtimeSettingsPath) return { updated: false };
  runtimeSettings = await saveDesktopSettings(runtimeSettingsPath, nextSettings);
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 120).unref?.();
  return { updated: true, restarting: true };
}

async function chooseProjectRoot() {
  const result = await dialog.showOpenDialog(drawerWindow || undefined, {
    title: '选择此刻可以读取的项目目录',
    buttonLabel: '允许此目录',
    properties: ['openDirectory', 'createDirectory'],
    message: '此刻会在你选择的目录内理解项目；只有在识别到明确任务时，才会让 Codex 在该目录内完成必要改动并保留可查结果。',
  });
  if (result.canceled || !result.filePaths[0]) return { selected: false };
  return persistSettingsAndRelaunch({
    ...runtimeSettings,
    setupComplete: true,
    projectRoots: [result.filePaths[0]],
    contextSourcesEnabled: runtimeSettings.contextSourcesEnabled,
  });
}

async function setContextSourcesEnabled(enabled) {
  return persistSettingsAndRelaunch({
    ...runtimeSettings,
    contextSourcesEnabled: enabled === true,
  });
}

async function setAutoExecuteEnabled(enabled) {
  return persistSettingsAndRelaunch({
    ...runtimeSettings,
    autoExecute: enabled === true,
  });
}

async function setPublishLarkDocumentsEnabled(enabled) {
  return persistSettingsAndRelaunch({
    ...runtimeSettings,
    publishLarkDocuments: enabled === true,
  });
}

async function createWindows() {
  drawerWindow = new BrowserWindow({
    ...(process.platform === 'darwin' ? {
      type: 'panel',
      roundedCorners: false,
      acceptFirstMouse: true,
    } : {}),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    enableLargerThanScreen: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // Chromium draws the dark elevation itself. The native transparent-window
    // shadow can flash pale seams while the window is being resized.
    hasShadow: false,
    title: '此刻',
    webPreferences: browserPreferences(),
  });
  drawerWindow.setAlwaysOnTop(true, 'screen-saver');
  drawerWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  drawerWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    collapseDrawer();
  });
  drawerWindow.on('blur', () => {
    if (islandMode !== 'dormant') collapseDrawer();
  });

  const productionUrl = pathToFileURL(path.join(projectRoot, 'dist', 'index.html')).href;
  const mainUrl = devServerUrl || productionUrl;
  guardNavigation(drawerWindow, productionUrl, devServerUrl);
  drawerWindow.webContents.session.on('will-download', (event) => event.preventDefault());
  await drawerWindow.loadURL(mainUrl);
  dockWindows();
  if (process.env.PROACTIVE_AGENT_START_EXPANDED === '1' || (app.isPackaged && !runtimeSettings.setupComplete)) expandDrawer();
  else collapseDrawer();
}

function trayImage() {
  if (process.platform !== 'darwin') return nativeImage.createEmpty();
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(TRAY_ICON_SVG).toString('base64')}`;
  const image = nativeImage.createFromDataURL(dataUrl).resize({ width: 18, height: 18, quality: 'best' });
  image.setTemplateImage?.(true);
  return image;
}

function installTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('此刻 - Codex 主动助手');
  tray.on('click', toggleDrawer);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '展开 / 折叠', click: toggleDrawer },
      {
        label: '立即只读扫描',
        click: async () => {
          if (!service?.engine) return;
          const snapshot = await service.engine.getSnapshot({ force: true, reason: 'tray' }).catch(() => null);
          if (snapshot) showNotification({ title: '工作状态已更新', detail: snapshot.now.detail });
        },
      },
      ...(app.isPackaged
        ? [
            {
              label: runtimeSettings.projectRoots.length ? '更换项目目录…' : '选择项目目录…',
              click: () => { void chooseProjectRoot(); },
            },
            {
              label: '允许读取完整工作上下文',
              type: 'checkbox',
              checked: runtimeSettings.contextSourcesEnabled === true,
              enabled: runtimeSettings.projectRoots.length > 0,
              click: (menuItem) => { void setContextSourcesEnabled(menuItem.checked); },
            },
            {
              label: '允许 Codex 低风险后台工作',
              type: 'checkbox',
              checked: runtimeAutoExecute === true,
              click: (menuItem) => { void setAutoExecuteEnabled(menuItem.checked); },
            },
            {
              label: '允许把完成方案发布到我的飞书文档',
              type: 'checkbox',
              checked: runtimePublishLarkDocuments === true,
              click: (menuItem) => { void setPublishLarkDocumentsEnabled(menuItem.checked); },
            },
          ]
        : []),
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]),
  );
}

function installIpc() {
  ipcMain.handle('window:expand', (event, mode) => (
    isTrustedUiFrame(event) ? expandDrawer(mode) : { expanded: false }
  ));
  ipcMain.handle('window:set-mode', (event, mode) => (
    isTrustedUiFrame(event) ? setIslandMode(mode) : { expanded: false }
  ));
  ipcMain.handle('window:set-content-height', (event, height) => (
    isTrustedUiFrame(event) ? setIslandContentHeight(height) : { updated: false }
  ));
  ipcMain.handle('window:collapse', (event) => isTrustedUiFrame(event) ? collapseDrawer() : { collapsed: false });
  ipcMain.handle('window:toggle', (event) => isTrustedUiFrame(event) ? toggleDrawer() : { expanded: false });
  ipcMain.handle('window:get-state', (event) => isTrustedUiFrame(event) ? broadcastWindowState() : { collapsed: true });
  ipcMain.handle('notification:dismiss', (event) => isTrustedUiFrame(event) ? dismissNotification() : { dismissed: false });
  ipcMain.handle('artifact:read', (event, url) => (
    isDrawerMainFrame(event) ? readArtifactForPreview(url) : { ok: false, error: '无法读取这份产物。' }
  ));
  ipcMain.handle('document:open', (event, id) => openGeneratedDocument(event, id));
  ipcMain.handle('delivery:open', (event, id) => openRegisteredDelivery(event, id));
  ipcMain.handle('external:open', (event, url) => (
    isDrawerMainFrame(event) ? openTrustedExternal(url) : { opened: false }
  ));
  ipcMain.handle('codex:open', (event, payload) => (
    isDrawerMainFrame(event) ? openInCodex(payload) : { opened: false, copied: false, prefilled: false }
  ));
  ipcMain.handle('codex:activate', (event) => (
    isDrawerMainFrame(event) ? activateCodex() : { opened: false }
  ));
  ipcMain.handle('settings:choose-project-root', (event) => (
    isDrawerMainFrame(event) ? chooseProjectRoot() : { selected: false }
  ));
  ipcMain.handle('settings:set-context-sources', (event, enabled) => (
    isDrawerMainFrame(event) ? setContextSourcesEnabled(enabled === true) : { updated: false }
  ));
  ipcMain.handle('settings:set-auto-execute', (event, enabled) => (
    isDrawerMainFrame(event) ? setAutoExecuteEnabled(enabled === true) : { updated: false }
  ));
  ipcMain.handle('settings:set-publish-lark-documents', (event, enabled) => (
    isDrawerMainFrame(event) ? setPublishLarkDocumentsEnabled(enabled === true) : { updated: false }
  ));
}

function maybeNotify(snapshot, meta = {}) {
  const suggestionCount = snapshot?.interventions?.filter((item) => (
    ['active', 'waiting', 'ready'].includes(item.state)
  )).length || 0;
  if (suggestionCount !== lastSuggestionCount && drawerWindow && !drawerWindow.isDestroyed()) {
    lastSuggestionCount = suggestionCount;
    drawerWindow.webContents.send('suggestion:count', { count: Math.min(99, suggestionCount) });
  }
  if (!snapshot || !drawerWindow || drawerWindow.isDestroyed()) return;
  if (meta.reason === 'startup-ui') {
    for (const key of notificationKeysForSnapshot(snapshot)) notifiedInterventionKeys.add(key);
    return;
  }
  if (meta.reason === 'api' || meta.reason === 'view') return;
  const candidate = selectNotificationCandidate(snapshot, notifiedInterventionKeys);
  if (!candidate) return;
  if (showNotification({ title: candidate.item.title, detail: candidate.item.summary })) {
    notifiedInterventionKeys.add(candidate.key);
  }
}

function installBackgroundScanning() {
  if (!service?.engine) return;
  service.engine.on('snapshot', maybeNotify);
  backgroundTimer = setInterval(async () => {
    if (backgroundScanInFlight) return;
    backgroundScanInFlight = true;
    try {
      await service.engine.getSnapshot({ force: true, reason: 'background' });
    } catch {
      // The next scheduled scan can recover without surfacing a desktop error.
    } finally {
      backgroundScanInFlight = false;
    }
  }, BACKGROUND_SCAN_INTERVAL_MS);
  backgroundTimer.unref?.();
  setTimeout(() => {
    service.engine.getSnapshot({ reason: 'startup-ui' }).then((snapshot) => maybeNotify(snapshot, { reason: 'startup-ui' })).catch(() => {});
  }, 8_000).unref?.();
}

async function serviceAlreadyRunning() {
  try {
    const response = await fetch('http://127.0.0.1:4318/api/health', {
      headers: runtimeAccessToken ? { 'X-Cike-Session-Token': runtimeAccessToken } : {},
      signal: AbortSignal.timeout(2_000),
    });
    const payload = await response.json();
    return response.ok && payload?.service === 'cike-proactive-agent';
  } catch {
    return false;
  }
}

async function startLocalService() {
  const dataDir = resolveServiceDataDir({
    isPackaged: app.isPackaged,
    userDataDir: app.getPath('userData'),
    projectRoot,
  });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700).catch(() => {});
  try {
    const nextService = await startService({
      dataDir,
      ...(runtimeProjectRoots === undefined ? {} : { projectRoots: runtimeProjectRoots }),
      contextSourcesEnabled: runtimeContextSourcesEnabled,
      autoExecute: runtimeAutoExecute,
      publishLarkDocuments: runtimePublishLarkDocuments,
      deferProfileLoad: true,
      deliverySources: deepReadRuntime?.source ? [deepReadRuntime.source] : [],
      port: app.isPackaged ? 0 : 4318,
      accessToken: runtimeAccessToken,
    });
    runtimeApiBase = `http://127.0.0.1:${nextService.port}`;
    return nextService;
  } catch (error) {
    if (!app.isPackaged && error?.code === 'EADDRINUSE' && (await serviceAlreadyRunning())) return null;
    throw error;
  }
}

async function startDeliveryHelpers() {
  const dataDir = resolveServiceDataDir({
    isPackaged: app.isPackaged,
    userDataDir: app.getPath('userData'),
    projectRoot,
  });
  try {
    return await ensureDeepReadRuntime({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      projectRoot,
      dataDir,
      projectRoots: runtimeProjectRoots,
    });
  } catch {
    return {
      state: 'unavailable',
      owned: false,
      source: {
        id: 'deepread', name: '论文阅读器', state: 'error',
        detail: 'DeepRead 未通过启动健康检查；论文任务会保持不可交付，不会显示失效阅读按钮。',
      },
      async close() {},
    };
  }
}

function attachDeliveryHelper(runtime) {
  deepReadRuntime = runtime;
  if (isQuitting) {
    void runtime?.close?.();
    return;
  }

  const sources = service?.engine?.deliverySources;
  if (!runtime?.source || !Array.isArray(sources)) return;
  const existingIndex = sources.findIndex((source) => source?.id === runtime.source.id);
  if (existingIndex >= 0) sources[existingIndex] = runtime.source;
  else sources.unshift(runtime.source);
  service.engine.lastSnapshot = null;
  service.engine.lastScanAt = 0;
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => expandDrawer());
  app.whenReady().then(async () => {
    traceStartup('app-ready');
    app.setName('此刻');
    await initializeRuntime();
    traceStartup('runtime-initialized');
    // DeepRead is an optional delivery helper. Start it in parallel so a slow
    // health check can never delay the island, local service, or first paint.
    deepReadRuntimePromise = startDeliveryHelpers();
    traceStartup('delivery-helper-started');
    service = await startLocalService();
    traceStartup('local-service-ready');
    installIpc();
    await createWindows();
    traceStartup('window-created');
    installTray();
    globalShortcut.register(accelerator, () => {
      if (drawerWindow?.isVisible() && drawerWindow.isFocused()) return;
      toggleDrawer();
    });
    installBackgroundScanning();
    screen.on('display-metrics-changed', () => dockWindows());
    screen.on('display-removed', () => dockWindows(screen.getPrimaryDisplay()));
    void deepReadRuntimePromise.then(attachDeliveryHelper).catch(() => {});
  }).catch((error) => {
    process.stderr.write(`Unable to start desktop runtime: ${error?.code || 'unknown error'}\n`);
    app.quit();
  });
}

app.on('activate', () => {
  if (!drawerWindow?.isVisible()) collapseDrawer();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (notificationTimer) clearTimeout(notificationTimer);
  if (backgroundTimer) clearInterval(backgroundTimer);
  stopPointerMonitor();
  globalShortcut.unregisterAll();
  void service?.runner?.shutdown();
  void service?.close();
  void deepReadRuntime?.close?.();
  void deepReadRuntimePromise?.then((runtime) => runtime?.close?.()).catch(() => {});
});

const { contextBridge, ipcRenderer } = require('electron');

function argumentValue(prefix) {
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : '';
}

function trustedApiBase() {
  const fallback = 'http://127.0.0.1:4318';
  try {
    const url = new URL(argumentValue('--cike-api-base=') || fallback);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port) return fallback;
    return url.origin;
  } catch {
    return fallback;
  }
}

const apiBase = trustedApiBase();
const rawSessionToken = argumentValue('--cike-session-token=');
const apiToken = /^[A-Za-z0-9_-]{20,128}$/u.test(rawSessionToken) ? rawSessionToken : '';

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld(
  'proactiveAgent',
  Object.freeze({
    apiBase,
    expand: (mode) => ipcRenderer.invoke('window:expand', mode),
    setMode: (mode) => ipcRenderer.invoke('window:set-mode', mode),
    setContentHeight: (height) => ipcRenderer.invoke('window:set-content-height', height),
    collapse: () => ipcRenderer.invoke('window:collapse'),
    toggle: () => ipcRenderer.invoke('window:toggle'),
    minimize: () => ipcRenderer.invoke('window:collapse'),
    close: () => ipcRenderer.invoke('window:collapse'),
    getWindowState: () => ipcRenderer.invoke('window:get-state'),
    dismissNotification: () => ipcRenderer.invoke('notification:dismiss'),
    onWindowState: (callback) => subscribe('window:state', callback),
    onNotification: (callback) => subscribe('notification:update', callback),
    onSuggestionCount: (callback) => subscribe('suggestion:count', callback),
  }),
);

contextBridge.exposeInMainWorld(
  'agentDesktop',
  Object.freeze({
    apiBase,
    apiToken,
    toggleDock: () => ipcRenderer.invoke('window:toggle'),
    collapse: () => ipcRenderer.invoke('window:collapse'),
    expand: (mode) => ipcRenderer.invoke('window:expand', mode),
    setMode: (mode) => ipcRenderer.invoke('window:set-mode', mode),
    setContentHeight: (height) => ipcRenderer.invoke('window:set-content-height', height),
    getDockState: () => ipcRenderer.invoke('window:get-state'),
    onDockState: (callback) => subscribe('window:state', callback),
    onHoverExpand: (callback) => subscribe('window:hover-expand', callback),
    onNotification: (callback) => subscribe('notification:update', callback),
    dismissNotification: () => ipcRenderer.invoke('notification:dismiss'),
    readArtifact: (url) => ipcRenderer.invoke('artifact:read', url),
    openDocument: (id) => ipcRenderer.invoke('document:open', id),
    openDelivery: (id) => ipcRenderer.invoke('delivery:open', id),
    openExternal: (url) => ipcRenderer.invoke('external:open', url),
    openInCodex: (payload) => ipcRenderer.invoke('codex:open', payload),
    openCodexApp: () => ipcRenderer.invoke('codex:activate'),
    chooseProjectRoot: () => ipcRenderer.invoke('settings:choose-project-root'),
    setAutoExecute: (enabled) => ipcRenderer.invoke('settings:set-auto-execute', enabled === true),
    setContextSourcesEnabled: (enabled) => ipcRenderer.invoke('settings:set-context-sources', enabled === true),
  }),
);

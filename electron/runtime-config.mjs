import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveConfiguredRoot } from '../server/workspace-security.mjs';

const SETTINGS_VERSION = 2;
const MAX_PROJECT_ROOTS = 4;

export const DEFAULT_DESKTOP_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  setupComplete: false,
  projectRoots: [],
  contextSourcesEnabled: false,
  autoExecute: true,
  publishLarkDocuments: false,
});

function cloneDefaults() {
  return structuredClone(DEFAULT_DESKTOP_SETTINGS);
}

async function validatedRoots(values) {
  if (!Array.isArray(values)) return [];
  const roots = [];
  for (const value of values.slice(0, MAX_PROJECT_ROOTS)) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) continue;
    const canonical = await resolveConfiguredRoot(value);
    if (canonical && !roots.includes(canonical)) roots.push(canonical);
  }
  return roots;
}

export async function sanitizeDesktopSettings(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const projectRoots = await validatedRoots(raw.projectRoots);
  return {
    version: SETTINGS_VERSION,
    setupComplete: raw.setupComplete === true && projectRoots.length > 0,
    projectRoots,
    contextSourcesEnabled: raw.contextSourcesEnabled === true && projectRoots.length > 0,
    // Low-risk local research can run without a project root. Workspace
    // mutation remains independently constrained by the verified roots.
    autoExecute: raw.autoExecute !== false,
    // Creating a private Feishu document is an external write. It remains an
    // explicit per-user opt-in even though the resulting document is placed in
    // My Library and read back before delivery.
    publishLarkDocuments: raw.publishLarkDocuments === true,
  };
}

export async function loadDesktopSettings(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return await sanitizeDesktopSettings(parsed);
  } catch {
    return cloneDefaults();
  }
}

export async function saveDesktopSettings(filePath, value) {
  const settings = await sanitizeDesktopSettings(value);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
  return settings;
}

export function resolveServiceDataDir({ isPackaged, userDataDir, projectRoot, env = process.env }) {
  const configured = String(env.PROACTIVE_AGENT_DATA_DIR || '').trim();
  if (configured && path.isAbsolute(configured)) return path.normalize(configured);
  return isPackaged ? path.join(userDataDir, 'data') : path.join(projectRoot, '.data');
}

export function configuredProjectRootsOverride(env = process.env) {
  if (!Object.hasOwn(env, 'PROACTIVE_AGENT_PROJECT_ROOTS')) return null;
  return String(env.PROACTIVE_AGENT_PROJECT_ROOTS || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter((item) => path.isAbsolute(item))
    .slice(0, MAX_PROJECT_ROOTS);
}

export function configuredAutoExecuteOverride(env = process.env) {
  if (!Object.hasOwn(env, 'PROACTIVE_AGENT_AUTO_EXECUTE')) return null;
  return String(env.PROACTIVE_AGENT_AUTO_EXECUTE).trim() === '1';
}

export function configuredContextSourcesOverride(env = process.env) {
  if (!Object.hasOwn(env, 'PROACTIVE_AGENT_CONTEXT_SOURCES')) return null;
  return String(env.PROACTIVE_AGENT_CONTEXT_SOURCES).trim() === '1';
}

export function configuredPublishLarkDocumentsOverride(env = process.env) {
  if (!Object.hasOwn(env, 'PROACTIVE_AGENT_PUBLISH_LARK_DOCUMENTS')) return null;
  return String(env.PROACTIVE_AGENT_PUBLISH_LARK_DOCUMENTS).trim() === '1';
}

export function codexDesktopAppCandidates(env = process.env, homeDir = os.homedir()) {
  const configured = String(env.PROACTIVE_AGENT_CODEX_APP_PATH || '').trim();
  return [...new Set([
    ...(configured && path.isAbsolute(configured) && configured.endsWith('.app') ? [configured] : []),
    '/Applications/Codex.app',
    '/Applications/ChatGPT.app',
    path.join(homeDir, 'Applications', 'Codex.app'),
    path.join(homeDir, 'Applications', 'ChatGPT.app'),
  ])];
}

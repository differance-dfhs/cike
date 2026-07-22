import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { ActivityAdapter } from './adapters/activity.mjs';
import { ChronicleAdapter } from './adapters/chronicle.mjs';
import { CodexRuntimeAdapter } from './adapters/codex-runtime.mjs';
import { LarkAdapter } from './adapters/lark.mjs';
import { LarkDocumentPublisher } from './adapters/lark-document-publisher.mjs';
import { LocalAdapter } from './adapters/local.mjs';
import { CodexRunner } from './codex-runner.mjs';
import { DeliveryCoordinator } from './delivery-coordinator.mjs';
import { DeliveryRegistry } from './delivery-registry.mjs';
import { ProactiveEngine } from './engine.mjs';
import { createHttpService } from './http-service.mjs';
import { JsonStateStore } from './state-store.mjs';
import { UserLearningStore } from './user-learning.mjs';
import { configuredProjectRoots, resolveConfiguredRoot } from './workspace-security.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

function traceStartup(phase) {
  if (process.env.CIKE_STARTUP_TRACE !== '1') return;
  process.stderr.write(`[cike-service] ${phase}\n`);
}

async function configuredActivityProjects(roots) {
  const configured = String(process.env.PROACTIVE_AGENT_ACTIVITY_PROJECTS || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  const candidates = [];
  if (configured.length) {
    candidates.push(...configured);
  } else {
    for (const root of (roots || []).slice(0, 4)) {
      const canonicalRoot = await resolveConfiguredRoot(root);
      if (!canonicalRoot) continue;
      let entries = [];
      try {
        entries = await readdir(canonicalRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
        candidates.push(path.join(canonicalRoot, entry.name));
        if (candidates.length >= 24) break;
      }
    }
  }
  const projects = [];
  for (const candidate of candidates) {
    if (projects.length >= 12) break;
    const canonical = await resolveConfiguredRoot(candidate);
    if (!canonical || projects.some((project) => project.path === canonical)) continue;
    projects.push({ path: canonical, label: path.basename(canonical) });
  }
  return projects;
}

function disabledChronicleAdapter() {
  return {
    collect: async () => ({
      state: 'unavailable',
      classification: 'available',
      lastSeen: null,
      memory: { count: 0, lastSeen: null, topics: [] },
      source: {
        id: 'chronicle',
        name: 'Chronicle',
        state: 'unavailable',
        detail: '尚未授权读取粗粒度屏幕状态。',
      },
    }),
  };
}

function disabledLarkAdapter() {
  return {
    collect: async () => ({
      state: 'unavailable',
      events: [],
      tasks: [],
      mentions: [],
      selfMessages: [],
      meetingTodos: [],
      meetingBriefs: [],
      lastSeen: null,
      source: {
        id: 'lark',
        name: '飞书',
        state: 'unavailable',
        detail: '尚未授权检查飞书只读连接。',
      },
    }),
  };
}

function disabledActivityAdapter() {
  return {
    collect: async () => ({ signals: [], threads: [], loops: [], sources: [] }),
  };
}

export async function createService(options = {}) {
  traceStartup('create-begin');
  const dataDir = options.dataDir || path.join(projectRoot, '.data');
  const now = options.now || (() => new Date());
  const projectRoots = options.projectRoots ?? configuredProjectRoots();
  const contextSourcesEnabled = options.contextSourcesEnabled ?? true;
  const store = options.store || new JsonStateStore(dataDir);
  const learning = options.learning || new UserLearningStore(dataDir, {
    now,
    profilePath: options.profilePath,
    deferProfileLoad: options.deferProfileLoad !== false,
  });
  const local = options.local || new LocalAdapter({ now, roots: projectRoots });
  traceStartup('local-adapter-ready');
  const activity = options.activity || (contextSourcesEnabled
    ? new ActivityAdapter({
        now,
        projectRoots: [],
        projectRootsResolver: () => configuredActivityProjects(local.roots),
        chronicleProxy: true,
      })
    : disabledActivityAdapter());
  traceStartup('activity-adapter-ready');
  const deliveryRegistry = options.deliveryRegistry || new DeliveryRegistry({ dataDir, now });
  await deliveryRegistry.init();
  traceStartup('delivery-registry-ready');
  const publishLarkDocuments = options.publishLarkDocuments === true;
  const larkPublisher = options.larkPublisher || (publishLarkDocuments
    ? new LarkDocumentPublisher({ dataDir, now })
    : null);
  await larkPublisher?.init?.();
  traceStartup('publisher-ready');
  const larkPublisherSource = larkPublisher
    ? typeof larkPublisher.sourceStatus === 'function'
      ? await larkPublisher.sourceStatus().catch(() => ({
        id: 'lark-publisher', name: '飞书文档交付', state: 'error',
        detail: '飞书文档发布授权未通过校验；本地结果仍可正常交付。',
      }))
      : {
          id: 'lark-publisher', name: '飞书文档交付', state: 'available',
          detail: '飞书文档交付由受信任的宿主适配器提供。',
        }
    : {
        id: 'lark-publisher', name: '飞书文档交付', state: 'unavailable',
        detail: '按需在菜单栏开启“允许把完成方案发布到我的飞书文档”。',
      };
  const deliveryCoordinator = options.deliveryCoordinator || new DeliveryCoordinator({
    registry: deliveryRegistry,
    larkPublisher,
    deepReadOrigin: options.deepReadOrigin,
  });
  const runner = options.runner || new CodexRunner({
    dataDir,
    now,
    allowedWorkspaceRoots: local.roots,
    deliveryCoordinator,
  });
  const codexRuntime = options.codexRuntime || new CodexRuntimeAdapter({ now });
  const engine =
    options.engine ||
    new ProactiveEngine({
      chronicle: options.chronicle || (contextSourcesEnabled ? new ChronicleAdapter({ now }) : disabledChronicleAdapter()),
      lark: options.lark || (contextSourcesEnabled ? new LarkAdapter({ now, dataDir }) : disabledLarkAdapter()),
      local,
      activity,
      codexRuntime,
      runner,
      deliveryRegistry,
      store,
      learning,
      now,
      autoExecute: options.autoExecute,
      contextSourcesEnabled,
      publishLarkDocuments,
      deliverySources: [...(options.deliverySources || []), larkPublisherSource],
    });
  await engine.init();
  traceStartup('engine-ready');
  const httpService = createHttpService({
    engine,
    runner,
    deliveryRegistry,
    host: options.host || '127.0.0.1',
    port: options.port ?? 4318,
    accessToken: options.accessToken,
  });
  Object.assign(httpService, {
    engine,
    runner,
    deliveryRegistry,
    deliveryCoordinator,
    larkPublisher,
    learning,
    dataDir,
  });
  return httpService;
}

export async function startService(options = {}) {
  traceStartup('start-begin');
  const service = await createService(options);
  traceStartup('create-ready');
  await service.listen();
  traceStartup('listen-ready');
  // Keep the window launch fast, but make the initial refresh an explicit,
  // awaitable contract. Every enabled read-only source is refreshed once per
  // app start without allowing one connector failure to crash the runtime.
  service.startupRefresh = options.initialScan === false
    ? Promise.resolve(null)
    : new Promise((resolve) => setImmediate(resolve))
        .then(() => service.engine.getSnapshot({ force: true, reason: 'startup-config-refresh' }))
        .catch(() => null);
  return service;
}

const launchedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (launchedDirectly) {
  startService()
    .then((service) => {
      process.stdout.write(`Proactive agent service listening on http://${service.host}:${service.port}\n`);
    })
    .catch((error) => {
      process.stderr.write(`Unable to start proactive agent service: ${error?.code || 'unknown error'}\n`);
      process.exitCode = 1;
    });
}

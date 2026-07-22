import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileText } from '../lib/exec-file.mjs';
import { redactText, safeLabel } from '../security.mjs';

const HOUR_MS = 60 * 60 * 1_000;
const DEFAULT_BROWSER_WINDOW_MS = 2 * HOUR_MS;
const DEFAULT_CODEX_WINDOW_MS = 24 * HOUR_MS;
const CHROME_EPOCH_OFFSET_MICROS = 11_644_473_600_000_000n;
const MAX_INDEX_CHARACTERS = 512 * 1024;
const MAX_GIT_STATUS_LINES = 200;
const MAX_AUTOMATION_CHARACTERS = 256 * 1024;
const MAX_AUTOMATIONS = 16;

const PROJECT_RULES = [
  { label: '主动 Agent', pattern: /(?:主动\s*agent|proactive\s*agent|主动式桌面|此刻|修复完成按钮|演示素材)/iu },
  { label: '客户支持', pattern: /(?:AI\s*代接|代接题库|代接评测)/iu },
  { label: '语音质量评估', pattern: /(?:录音机?|音频|speaker|\basr\b|通话能力)/iu },
  { label: '反馈平台 / 体验反馈', pattern: /(?:反馈平台|体验反馈|反馈\s*demo)/iu },
  { label: '多步骤任务', pattern: /(?:高级条件|条件任务|\bSEQ\b)/iu },
  { label: '论文与前沿', pattern: /(?:论文|AI\s*学习|AI\s*行业|业界前沿|前沿研究|日报)/iu },
  { label: '工作规划与周报', pattern: /(?:每日总览|规划\s*Loop|周报|周会草稿|weekly|\bloop\b)/iu },
  { label: 'Aurora / Atlas Skill', pattern: /(?:Aurora|Atlas|工具清单|skill|技能表)/iu },
  { label: 'Harness', pattern: /(?:Harness|ContextLab)/iu },
];

function stableHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 18);
}

function safeIso(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function sanitizeMetadataText(value, homeDir, fallback = '未命名活动', maxLength = 96) {
  void homeDir;
  return safeLabel(value, fallback, maxLength);
}

function chromeMicrosFromUnixMs(unixMs) {
  return (BigInt(Math.trunc(unixMs)) * 1_000n + CHROME_EPOCH_OFFSET_MICROS).toString();
}

function chromeTimeToIso(value) {
  if (value == null || value === '') return null;
  const directIso = safeIso(value);
  if (typeof value === 'string' && /[-T:]/u.test(value) && directIso) return directIso;
  try {
    const micros = BigInt(String(value).split('.')[0]);
    const unixMs = Number((micros - CHROME_EPOCH_OFFSET_MICROS) / 1_000n);
    return safeIso(unixMs);
  } catch {
    return directIso;
  }
}

function hostnameOnly(value) {
  try {
    const parsed = new URL(String(value));
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    const hostname = parsed.hostname.toLocaleLowerCase('en-US').replace(/^www\./u, '');
    if (!hostname || hostname.length > 128 || /[\s/@?#]/u.test(hostname)) return null;
    return hostname;
  } catch {
    return null;
  }
}

async function defaultExecQuery({ databasePath, sinceChromeMicros, limit, timeoutMs }) {
  const safeLimit = Math.min(50, Math.max(1, Number.parseInt(String(limit), 10) || 10));
  if (!/^\d+$/u.test(String(sinceChromeMicros))) throw new Error('invalid browser time boundary');
  const sql = [
    'SELECT title, url, last_visit_time',
    'FROM urls',
    `WHERE last_visit_time >= ${sinceChromeMicros}`,
    'ORDER BY last_visit_time DESC',
    `LIMIT ${safeLimit};`,
  ].join(' ');
  const { stdout } = await execFileText('sqlite3', ['-json', databasePath, sql], {
    timeout: timeoutMs,
    maxBuffer: 512 * 1024,
    publicMessage: '浏览器活动索引无法读取。',
  });
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [];
}

async function defaultExecCommand(file, args, options) {
  return execFileText(file, args, options);
}

function defaultBrowserHistoryPaths(homeDir) {
  const applicationSupport = path.join(homeDir, 'Library', 'Application Support');
  return [
    {
      name: 'Chrome',
      path: path.join(applicationSupport, 'Google', 'Chrome', 'Default', 'History'),
    },
    {
      name: 'Arc',
      path: path.join(applicationSupport, 'Arc', 'User Data', 'Default', 'History'),
    },
    {
      name: 'Edge',
      path: path.join(applicationSupport, 'Microsoft Edge', 'Default', 'History'),
    },
  ];
}

function unavailableSource(id, name, detail) {
  return { id, name, state: 'unavailable', detail, lastSeen: null };
}

function controlledProjectLabel(value) {
  const text = String(value || '').normalize('NFKC');
  return PROJECT_RULES.find((rule) => rule.pattern.test(text))?.label || null;
}

function parseTomlString(raw, key) {
  const match = String(raw || '').match(new RegExp(`^${key}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")\\s*$`, 'mu'));
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function automationScheduleLabel(rrule) {
  const value = String(rrule || '');
  const hour = value.match(/(?:^|;)BYHOUR=(\d{1,2})(?:;|$)/u)?.[1];
  const minute = value.match(/(?:^|;)BYMINUTE=(\d{1,2})(?:;|$)/u)?.[1] || '0';
  const dayValue = value.match(/(?:^|;)BYDAY=([A-Z,]+)(?:;|$)/u)?.[1] || '';
  const time = hour == null
    ? ''
    : `${String(Math.min(23, Number(hour))).padStart(2, '0')}:${String(Math.min(59, Number(minute))).padStart(2, '0')}`;
  const dayMap = { MO: '一', TU: '二', WE: '三', TH: '四', FR: '五', SA: '六', SU: '日' };
  const days = dayValue.split(',').filter(Boolean);
  const prefix = dayValue === 'MO,TU,WE,TH,FR'
    ? '工作日'
    : days.length === 1 && dayMap[days[0]]
      ? `每周${dayMap[days[0]]}`
      : days.length
        ? `每周${days.map((day) => dayMap[day] || day).join('、')}`
        : /FREQ=DAILY/u.test(value)
          ? '每天'
          : '按计划';
  return time ? `${prefix} ${time}` : prefix;
}

function parseAutomationConfig(raw, directoryName, homeDir) {
  const id = parseTomlString(raw, 'id') || directoryName;
  const name = parseTomlString(raw, 'name');
  const status = parseTomlString(raw, 'status');
  const kind = parseTomlString(raw, 'kind');
  const rrule = parseTomlString(raw, 'rrule');
  if (!name || !status || !rrule) return null;
  const targetLine = String(raw || '').match(/^target\s*=\s*\{[^\n]*project_id\s*=\s*("(?:\\.|[^"\\])*")[^\n]*\}\s*$/mu);
  let targetLabel = null;
  if (targetLine) {
    try {
      targetLabel = path.basename(JSON.parse(targetLine[1]));
    } catch {
      targetLabel = null;
    }
  }
  const projectLabel = controlledProjectLabel(`${name} ${targetLabel || ''}`) || 'Codex 日常 Loop';
  return {
    id: `loop-${stableHash(id)}`,
    name: sanitizeMetadataText(name, homeDir, 'Codex Loop', 72),
    status: String(status).toUpperCase() === 'ACTIVE' ? 'active' : 'paused',
    kind: kind === 'heartbeat' ? 'heartbeat' : 'cron',
    scheduleLabel: automationScheduleLabel(rrule),
    projectLabel,
  };
}

export class ActivityAdapter {
  constructor(options = {}) {
    this.homeDir = options.homeDir || os.homedir();
    this.now = options.now || (() => new Date());
    this.projectRoots = Array.isArray(options.projectRoots) ? options.projectRoots : [];
    this.projectRootsResolver = typeof options.projectRootsResolver === 'function'
      ? options.projectRootsResolver
      : null;
    this.projectRootsResolved = !this.projectRootsResolver;
    this.projectRootsPromise = null;
    this.browserHistoryPaths = options.browserHistoryPaths || defaultBrowserHistoryPaths(this.homeDir);
    this.chronicleProxy = options.chronicleProxy || false;
    this.chronicleLastSeen = options.chronicleLastSeen || null;

    this.readFile = options.readFile || readFile;
    this.stat = options.stat || stat;
    this.lstat = options.lstat || lstat;
    this.readdir = options.readdir || readdir;
    this.copyFile = options.copyFile || copyFile;
    this.mkdtemp = options.mkdtemp || mkdtemp;
    this.rm = options.rm || rm;
    this.execQuery = options.execQuery || defaultExecQuery;
    this.execCommand = options.execCommand || defaultExecCommand;

    this.browserWindowMs = options.browserWindowMs || DEFAULT_BROWSER_WINDOW_MS;
    this.codexWindowMs = options.codexWindowMs || DEFAULT_CODEX_WINDOW_MS;
    this.maxBrowserSignals = Math.min(12, Math.max(1, options.maxBrowserSignals || 8));
    this.maxCodexSignals = Math.min(12, Math.max(1, options.maxCodexSignals || 8));
    this.maxProjects = Math.min(12, Math.max(1, options.maxProjects || 8));
    this.maxSignals = Math.min(32, Math.max(1, options.maxSignals || 24));
    this.automationDir = options.automationDir || path.join(this.homeDir, '.codex', 'automations');
  }

  async resolveProjectRoots() {
    if (this.projectRootsResolved || !this.projectRootsResolver) return this.projectRoots;
    if (!this.projectRootsPromise) {
      this.projectRootsPromise = Promise.resolve()
        .then(() => this.projectRootsResolver())
        .then((roots) => {
          if (Array.isArray(roots)) this.projectRoots = roots;
          this.projectRootsResolved = true;
          return this.projectRoots;
        })
        .catch(() => {
          this.projectRootsResolved = true;
          return this.projectRoots;
        })
        .finally(() => {
          this.projectRootsPromise = null;
        });
    }
    return this.projectRootsPromise;
  }

  async collectCodex(now) {
    const indexPath = path.join(this.homeDir, '.codex', 'session_index.jsonl');
    let raw;
    try {
      raw = await this.readFile(indexPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return {
          source: unavailableSource('codex-activity', 'Codex 历史', '未找到 Codex 本地线程索引。'),
          signals: [],
        };
      }
      return {
        source: {
          id: 'codex-activity',
          name: 'Codex 历史',
          state: 'error',
          detail: 'Codex 线程索引暂时无法读取。',
          lastSeen: null,
        },
        signals: [],
      };
    }

    const bounded = String(raw).slice(-MAX_INDEX_CHARACTERS);
    const records = [];
    for (const line of bounded.split(/\r?\n/u).slice(-2_000)) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        const occurredAt = safeIso(item?.updated_at);
        if (!occurredAt || typeof item?.thread_name !== 'string' || !item.thread_name.trim()) continue;
        records.push({
          rawId: typeof item.id === 'string' ? item.id : '',
          title: sanitizeMetadataText(item.thread_name, this.homeDir, 'Codex 任务', 96),
          occurredAt,
          projectLabel: controlledProjectLabel(item.thread_name),
        });
      } catch {
        // A bounded tail can start in the middle of a JSON line. Ignore malformed entries.
      }
    }
    records.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
    const recordsById = new Map();
    for (const record of records) {
      const key = record.rawId || `${record.title}:${record.occurredAt}`;
      if (!recordsById.has(key)) recordsById.set(key, record);
    }
    const unique = [...recordsById.values()].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
    const nowMs = now.getTime();
    const recent = unique
      .filter((record) => {
        const value = new Date(record.occurredAt).getTime();
        return value <= nowMs + 5 * 60 * 1_000 && nowMs - value <= this.codexWindowMs;
      })
      .slice(0, this.maxCodexSignals);
    const signals = recent.map((record) => ({
      id: `activity-codex-${stableHash(`${record.rawId}:${record.occurredAt}`)}`,
      type: 'codex-thread',
      title: record.title,
      detail: 'Codex 任务最近有更新。',
      occurredAt: record.occurredAt,
      ...(record.projectLabel ? { projectLabel: record.projectLabel } : {}),
      evidenceState: 'activity-only',
    }));
    return {
      source: {
        id: 'codex-activity',
        name: 'Codex 历史',
        state: raw.length > 0 && records.length === 0 ? 'error' : 'available',
        detail:
          raw.length > 0 && records.length === 0
            ? 'Codex 线程索引可读，但没有可解析的元数据记录。'
            : `已只读检查线程标题与更新时间，近 ${Math.round(this.codexWindowMs / HOUR_MS)} 小时 ${signals.length} 项。`,
        lastSeen: unique[0]?.occurredAt || null,
      },
      signals,
    };
  }

  async collectAutomations() {
    let entries;
    try {
      entries = await this.readdir(this.automationDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return {
          source: unavailableSource('codex-loops', 'Codex Loop', '未找到 Codex 自动化目录。'),
          loops: [],
        };
      }
      return {
        source: { id: 'codex-loops', name: 'Codex Loop', state: 'error', detail: '自动化配置暂时无法读取。', lastSeen: null },
        loops: [],
      };
    }

    const directories = entries
      .filter((entry) => entry?.isDirectory?.() && /^[A-Za-z0-9._-]{1,64}$/u.test(entry.name))
      .slice(0, MAX_AUTOMATIONS);
    const loops = [];
    for (const entry of directories) {
      const configPath = path.join(this.automationDir, entry.name, 'automation.toml');
      const memoryPath = path.join(this.automationDir, entry.name, 'memory.md');
      try {
        const info = await this.lstat(configPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_AUTOMATION_CHARACTERS) continue;
        const raw = await this.readFile(configPath, 'utf8');
        const parsed = parseAutomationConfig(raw, entry.name, this.homeDir);
        if (!parsed) continue;
        let memoryUpdatedAt = null;
        let memoryExcerpt = '';
        try {
          const memoryInfo = await this.lstat(memoryPath);
          if (memoryInfo.isFile() && !memoryInfo.isSymbolicLink()) {
            memoryUpdatedAt = safeIso(memoryInfo.mtimeMs);
            if (memoryInfo.size > 0 && memoryInfo.size <= 256 * 1024) {
              memoryExcerpt = redactText(await this.readFile(memoryPath, 'utf8'), { maxLength: 2_000 });
            }
          }
        } catch {
          memoryUpdatedAt = null;
        }
        loops.push({
          ...parsed,
          recordState: memoryUpdatedAt ? 'recorded' : 'missing',
          ...(memoryUpdatedAt ? { memoryUpdatedAt } : {}),
          ...(memoryExcerpt ? { memoryExcerpt } : {}),
        });
      } catch {
        // A malformed or rotating automation is skipped without exposing paths or prompt content.
      }
    }
    loops.sort((left, right) => (
      Number(right.status === 'active') - Number(left.status === 'active')
      || left.scheduleLabel.localeCompare(right.scheduleLabel, 'zh-CN')
      || left.name.localeCompare(right.name, 'zh-CN')
    ));
    const latest = loops
      .map((loop) => loop.memoryUpdatedAt)
      .filter(Boolean)
      .sort((left, right) => right.localeCompare(left))[0] || null;
    return {
      source: {
        id: 'codex-loops',
        name: 'Codex Loop',
        state: loops.length ? 'available' : 'unavailable',
        detail: loops.length
          ? `已接入 ${loops.filter((loop) => loop.status === 'active').length} 个主动 Loop，并读取最近运行记录。`
          : '未发现可解析的 Codex Loop。',
        lastSeen: latest,
      },
      loops,
    };
  }

  async collectBrowser(now) {
    const candidates = [];
    for (const [index, entry] of this.browserHistoryPaths.slice(0, 6).entries()) {
      const normalized = typeof entry === 'string' ? { name: `浏览器 ${index + 1}`, path: entry } : entry;
      if (!normalized?.path || typeof normalized.path !== 'string') continue;
      try {
        const info = await this.stat(normalized.path);
        if (info.isFile()) {
          candidates.push({
            name: sanitizeMetadataText(normalized.name, this.homeDir, '浏览器', 32),
            path: normalized.path,
          });
        }
      } catch {
        // A missing browser profile is expected and not an error.
      }
    }
    if (!candidates.length) {
      return {
        source: unavailableSource('browser-activity', '浏览器活动', '未找到可读的浏览器 History 索引。'),
        signals: [],
      };
    }

    const nowMs = now.getTime();
    const sinceMs = nowMs - this.browserWindowMs;
    const rows = [];
    let successfulProfiles = 0;
    let tempDir = null;
    try {
      tempDir = await this.mkdtemp(path.join(os.tmpdir(), 'proactive-activity-'));
      for (const [index, candidate] of candidates.entries()) {
        const databasePath = path.join(tempDir, `history-${index}.sqlite`);
        try {
          await this.copyFile(candidate.path, databasePath);
          const queried = await this.execQuery({
            databasePath,
            sinceChromeMicros: chromeMicrosFromUnixMs(sinceMs),
            limit: this.maxBrowserSignals,
            timeoutMs: 3_000,
          });
          successfulProfiles += 1;
          if (Array.isArray(queried)) {
            for (const item of queried.slice(0, this.maxBrowserSignals)) rows.push({ ...item, browser: candidate.name });
          }
        } catch {
          // Continue with another installed browser profile. No private error text leaves the adapter.
        }
      }
    } catch {
      successfulProfiles = 0;
    } finally {
      if (tempDir) await this.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    if (successfulProfiles === 0) {
      return {
        source: {
          id: 'browser-activity',
          name: '浏览器活动',
          state: 'error',
          detail: '浏览器索引存在，但复制或只读查询失败。',
          lastSeen: null,
        },
        signals: [],
      };
    }

    const prepared = [];
    for (const item of rows) {
      const domain = hostnameOnly(item?.url);
      const occurredAt = chromeTimeToIso(item?.last_visit_time);
      if (!domain || !occurredAt) continue;
      const occurredMs = new Date(occurredAt).getTime();
      if (occurredMs < sinceMs || occurredMs > nowMs + 5 * 60 * 1_000) continue;
      const title = sanitizeMetadataText(item?.title, this.homeDir, domain, 96);
      const url = redactText(item?.url, { maxLength: 800 });
      prepared.push({ browser: item.browser, domain, url, occurredAt, title });
    }
    prepared.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
    const browserItemsByKey = new Map();
    for (const item of prepared) {
      const key = `${item.url}:${item.title}`;
      if (!browserItemsByKey.has(key)) browserItemsByKey.set(key, item);
    }
    const deduped = [...browserItemsByKey.values()]
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, this.maxBrowserSignals);
    const signals = deduped.map((item) => ({
      id: `activity-browser-${stableHash(`${item.browser}:${item.domain}:${item.title}:${item.occurredAt}`)}`,
      type: 'browser-activity',
      title: item.title,
      detail: `${item.browser} · ${item.url}`,
      occurredAt: item.occurredAt,
      domain: item.domain,
      url: item.url,
    }));
    return {
      source: {
        id: 'browser-activity',
        name: '浏览器活动',
        state: 'available',
        detail: `已只读检查近 ${Math.round(this.browserWindowMs / HOUR_MS)} 小时的完整页面标题与 URL，共 ${signals.length} 项。`,
        lastSeen: signals[0]?.occurredAt || null,
      },
      signals,
    };
  }

  collectGpt() {
    const proxy = typeof this.chronicleProxy === 'function' ? this.chronicleProxy() : this.chronicleProxy;
    if (proxy) {
      return {
        source: {
          id: 'gpt-activity',
          name: 'GPT / ChatGPT',
          state: 'available',
          detail: '仅由 Chronicle 屏幕记忆代理覆盖；未读取本地对话正文。',
          lastSeen: safeIso(this.chronicleLastSeen),
        },
        signals: [],
      };
    }
    return {
      source: unavailableSource(
        'gpt-activity',
        'GPT / ChatGPT',
        '未发现可靠的本地结构化历史；可由 Chronicle 代理覆盖。',
      ),
      signals: [],
    };
  }

  async collectLocalChanges(now) {
    const roots = this.projectRoots.slice(0, this.maxProjects).map((entry) => {
      if (typeof entry === 'string') return { path: entry, label: path.basename(entry) };
      return { path: entry?.path, label: entry?.label || path.basename(entry?.path || '') };
    }).filter((entry) => typeof entry.path === 'string' && path.isAbsolute(entry.path));
    if (!roots.length) {
      return {
        source: unavailableSource('local-changes', '本地改动', '未配置允许检查的项目目录。'),
        signals: [],
      };
    }

    const checked = [];
    await Promise.all(roots.map(async (root) => {
      try {
        const result = await this.execCommand(
          'git',
          ['-C', root.path, 'status', '--porcelain=v1', '--untracked-files=normal'],
          {
            timeout: 2_500,
            maxBuffer: 128 * 1024,
            publicMessage: '本地项目改动无法检查。',
          },
        );
        const statusLines = String(result?.stdout || '').split(/\r?\n/u).filter(Boolean).slice(0, MAX_GIT_STATUS_LINES);
        checked.push({
          root: root.path,
          projectLabel: controlledProjectLabel(root.label)
            || sanitizeMetadataText(root.label, this.homeDir, '本地项目', 64),
          statusLines,
        });
      } catch {
        // Non-git and inaccessible roots are reported only as aggregate availability.
      }
    }));
    if (!checked.length) {
      return {
        source: {
          id: 'local-changes',
          name: '本地改动',
          state: 'error',
          detail: '已配置项目，但未能完成任何一个 Git 状态检查。',
          lastSeen: null,
        },
        signals: [],
      };
    }

    const occurredAt = now.toISOString();
    const changed = checked.filter((item) => item.statusLines.length > 0);
    const signals = changed.map((item) => ({
      id: `activity-local-${stableHash(`${item.root}:${item.statusLines.join('\n')}`)}`,
      type: 'local-changes',
      title: `${item.projectLabel} 有 ${item.statusLines.length} 项本地改动`,
      detail: `改动文件：${safeLabel(item.statusLines.join('；'), '存在未收口改动', 800)}`,
      occurredAt,
      projectLabel: item.projectLabel,
      workspacePath: item.root,
      changedFiles: item.statusLines,
    }));
    return {
      source: {
        id: 'local-changes',
        name: '本地改动',
        state: 'available',
        detail: `已限定检查 ${checked.length} 个项目，${changed.length} 个存在未提交改动。`,
        lastSeen: signals.length ? occurredAt : null,
      },
      signals,
    };
  }

  async collect() {
    await this.resolveProjectRoots();
    const now = this.now();
    const safeNow = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
    const [codex, automations, browser, localChanges] = await Promise.all([
      this.collectCodex(safeNow),
      this.collectAutomations(),
      this.collectBrowser(safeNow),
      this.collectLocalChanges(safeNow),
    ]);
    const gpt = this.collectGpt();
    const signals = [...codex.signals, ...browser.signals, ...localChanges.signals]
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, this.maxSignals);
    return {
      sources: [codex.source, automations.source, browser.source, gpt.source, localChanges.source],
      signals,
      threads: codex.signals,
      loops: automations.loops,
    };
  }
}

export const activityInternals = {
  chromeMicrosFromUnixMs,
  chromeTimeToIso,
  defaultBrowserHistoryPaths,
  hostnameOnly,
  automationScheduleLabel,
  controlledProjectLabel,
  parseAutomationConfig,
  sanitizeMetadataText,
  stableHash,
};

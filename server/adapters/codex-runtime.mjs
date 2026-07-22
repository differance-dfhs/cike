import { open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileText } from '../lib/exec-file.mjs';
import { safeLabel } from '../security.mjs';

const MAX_INDEX_BYTES = 512 * 1024;
const MAX_SESSION_HEAD_BYTES = 128 * 1024;
const MAX_SESSION_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_CANDIDATE_IDS = 48;
const MAX_PARSED_SESSIONS = 4;
const DIRECTORY_CACHE_MS = 60_000;

function validDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function percent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function integer(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

async function readFileSlice(filePath, { headBytes = 0, tailBytes = 0 } = {}) {
  const handle = await open(filePath, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0) return { text: '', info };
    const length = headBytes
      ? Math.min(info.size, headBytes)
      : Math.min(info.size, tailBytes);
    const start = headBytes ? 0 : Math.max(0, info.size - length);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return { text: buffer.toString('utf8'), info };
  } finally {
    await handle.close();
  }
}

function parseJsonLines(raw) {
  const values = [];
  for (const line of String(raw || '').split(/\r?\n/u)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      // A bounded tail may start midway through a JSON line.
    }
  }
  return values;
}

function sessionIdFromName(value) {
  return String(value || '').match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/iu)?.[1] || '';
}

function latestEvent(events, predicate) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index])) return events[index];
  }
  return null;
}

function cleanPrompt(value) {
  return safeLabel(
    String(value || '')
      .replace(/<[^>]{1,80}>/gu, ' ')
      .replace(/[#*_`]+/gu, ' '),
    'Codex 任务',
    96,
  );
}

function parseSession({ filePath, info, head, tail, indexTitle = '' }) {
  const headEvents = parseJsonLines(head);
  const events = parseJsonLines(tail);
  const meta = headEvents.find((event) => event?.type === 'session_meta')?.payload || {};
  const userMessage = latestEvent(
    events,
    (event) => event?.type === 'event_msg' && event?.payload?.type === 'user_message',
  )?.payload?.message;
  const tokenEvent = latestEvent(
    events,
    (event) => event?.type === 'event_msg' && event?.payload?.type === 'token_count',
  )?.payload;
  const started = latestEvent(
    events,
    (event) => event?.type === 'event_msg' && event?.payload?.type === 'task_started',
  )?.payload;
  const completed = latestEvent(
    events,
    (event) => event?.type === 'event_msg' && event?.payload?.type === 'task_complete',
  )?.payload;
  const aborted = latestEvent(
    events,
    (event) => event?.type === 'event_msg' && event?.payload?.type === 'turn_aborted',
  )?.payload;
  const startedAt = Number(started?.started_at || 0) * 1_000;
  const abortedAt = Number(aborted?.timestamp || 0) || validDate(aborted?.timestamp)?.getTime() || 0;
  const completedAt = Math.max(Number(completed?.completed_at || 0) * 1_000, abortedAt);
  const running = Number.isFinite(startedAt) && startedAt > 0 && startedAt > completedAt;
  const lastTimestamp = latestEvent(events, (event) => validDate(event?.timestamp))?.timestamp;
  const updatedAt = validDate(lastTimestamp)?.toISOString() || new Date(info.mtimeMs).toISOString();
  const usage = tokenEvent?.info || {};
  const lastUsage = usage.last_token_usage || {};
  const totalUsage = usage.total_token_usage || {};
  const contextWindow = integer(usage.model_context_window);
  const contextTokens = integer(lastUsage.total_tokens);
  const rateLimit = tokenEvent?.rate_limits || {};
  const primaryLimit = rateLimit.primary || {};
  const usedPercent = percent(primaryLimit.used_percent);
  const credits = rateLimit.credits || {};

  return {
    id: safeLabel(meta.id || sessionIdFromName(filePath), 'codex-session', 64),
    title: cleanPrompt(userMessage || indexTitle),
    project: safeLabel(path.basename(meta.cwd || ''), '未关联项目', 64),
    state: running ? 'running' : completedAt > 0 ? 'complete' : 'idle',
    updatedAt,
    ...(running && startedAt > 0 ? { startedAt: new Date(startedAt).toISOString() } : {}),
    ...(!running && completedAt > 0 ? { completedAt: new Date(completedAt).toISOString() } : {}),
    usage: {
      turnTokens: contextTokens,
      inputTokens: integer(lastUsage.input_tokens),
      cachedInputTokens: integer(lastUsage.cached_input_tokens),
      outputTokens: integer(lastUsage.output_tokens),
      reasoningTokens: integer(lastUsage.reasoning_output_tokens),
      sessionTokens: integer(totalUsage.total_tokens),
      contextWindow,
      contextPercent: contextWindow ? Math.min(100, Math.round((contextTokens / contextWindow) * 100)) : null,
    },
    quota: {
      available: usedPercent != null,
      usedPercent,
      remainingPercent: usedPercent == null ? null : Math.round(100 - usedPercent),
      windowMinutes: integer(primaryLimit.window_minutes),
      resetsAt: Number(primaryLimit.resets_at) > 0
        ? new Date(Number(primaryLimit.resets_at) * 1_000).toISOString()
        : null,
      planType: safeLabel(rateLimit.plan_type, 'unknown', 20),
      credits: {
        hasCredits: credits.has_credits === true,
        unlimited: credits.unlimited === true,
        balance: safeLabel(credits.balance, '0', 32),
      },
    },
  };
}

function parseProcessResources(raw) {
  let cpuPercent = 0;
  let memoryBytes = 0;
  let processCount = 0;
  for (const line of String(raw || '').split(/\r?\n/u)) {
    const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/u);
    if (!match) continue;
    const command = match[4];
    if (!/(?:\/Codex\.app\/|\bcodex(?:\s|$)|codex-cli)/iu.test(command)) continue;
    if (/cike-proactive-agent|此刻/u.test(command)) continue;
    cpuPercent += Number(match[2]) || 0;
    memoryBytes += (Number(match[3]) || 0) * 1024;
    processCount += 1;
  }
  return {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memoryBytes,
    processCount,
  };
}

export class CodexRuntimeAdapter {
  constructor(options = {}) {
    this.homeDir = options.homeDir || os.homedir();
    this.sessionsDir = options.sessionsDir || path.join(this.homeDir, '.codex', 'sessions');
    this.indexPath = options.indexPath || path.join(this.homeDir, '.codex', 'session_index.jsonl');
    this.now = options.now || (() => new Date());
    this.execCommand = options.execCommand || ((file, args, config) => execFileText(file, args, config));
    this.directoryCache = { checkedAt: 0, paths: [] };
  }

  async candidatePaths() {
    const nowMs = this.now().getTime();
    let paths = this.directoryCache.paths;
    if (!paths.length || nowMs - this.directoryCache.checkedAt > DIRECTORY_CACHE_MS) {
      const entries = await readdir(this.sessionsDir, { recursive: true, withFileTypes: true });
      paths = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => path.join(entry.parentPath, entry.name));
      this.directoryCache = { checkedAt: nowMs, paths };
    }

    let indexRecords = [];
    try {
      const { text } = await readFileSlice(this.indexPath, { tailBytes: MAX_INDEX_BYTES });
      indexRecords = parseJsonLines(text)
        .filter((record) => record?.id)
        .slice(-MAX_CANDIDATE_IDS);
    } catch {
      indexRecords = [];
    }
    const indexById = new Map(indexRecords.map((record) => [
      String(record.id),
      safeLabel(record.thread_name, '', 96),
    ]));
    const wanted = new Set(indexById.keys());
    const candidates = paths.filter((filePath) => wanted.has(sessionIdFromName(filePath)));
    const fallback = [...paths].sort().slice(-12);
    const unique = [...new Set([...candidates, ...fallback])];
    const ranked = await Promise.all(unique.map(async (filePath) => {
      try {
        return {
          filePath,
          info: await stat(filePath),
          indexTitle: indexById.get(sessionIdFromName(filePath)) || '',
        };
      } catch {
        return null;
      }
    }));
    return ranked
      .filter(Boolean)
      .sort((left, right) => right.info.mtimeMs - left.info.mtimeMs)
      .slice(0, MAX_PARSED_SESSIONS);
  }

  async collectResources() {
    try {
      const { stdout } = await this.execCommand(
        'ps',
        ['-axo', 'pid=,pcpu=,rss=,command='],
        { timeout: 2_000, maxBuffer: 1024 * 1024, publicMessage: 'Codex 资源状态暂不可用。' },
      );
      return { available: true, ...parseProcessResources(stdout) };
    } catch {
      return { available: false, cpuPercent: 0, memoryBytes: 0, processCount: 0 };
    }
  }

  async collect() {
    try {
      const candidates = await this.candidatePaths();
      const sessions = [];
      for (const candidate of candidates) {
        try {
          const [{ text: head }, { text: tail }] = await Promise.all([
            readFileSlice(candidate.filePath, { headBytes: MAX_SESSION_HEAD_BYTES }),
            readFileSlice(candidate.filePath, { tailBytes: MAX_SESSION_TAIL_BYTES }),
          ]);
          sessions.push(parseSession({ ...candidate, head, tail }));
        } catch {
          // Rotating or malformed sessions are skipped without blocking other data.
        }
      }
      sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const resources = await this.collectResources();
      const current = sessions.find((session) => session.state === 'running') || sessions[0] || null;
      return {
        state: current?.state || 'unavailable',
        current,
        sessions,
        resources,
        lastSeen: current?.updatedAt || null,
        source: {
          id: 'codex-runtime',
          name: 'Codex 实时状态',
          state: current ? 'live' : 'unavailable',
          detail: current
            ? '已从本机会话事件读取任务状态、token、额度窗口和进程资源。'
            : '暂未发现可读取的 Codex 会话事件。',
          lastSeen: current?.updatedAt || null,
        },
      };
    } catch {
      return {
        state: 'unavailable',
        current: null,
        sessions: [],
        resources: { available: false, cpuPercent: 0, memoryBytes: 0, processCount: 0 },
        lastSeen: null,
        source: {
          id: 'codex-runtime',
          name: 'Codex 实时状态',
          state: 'unavailable',
          detail: 'Codex 会话目录暂不可读。',
          lastSeen: null,
        },
      };
    }
  }
}

export const codexRuntimeInternals = {
  cleanPrompt,
  parseJsonLines,
  parseProcessResources,
  parseSession,
  readFileSlice,
  sessionIdFromName,
};

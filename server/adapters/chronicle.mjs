import { open, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileText } from '../lib/exec-file.mjs';
import { redactText } from '../security.mjs';

const LIVE_MS = 3 * 60 * 1_000;
const FRESH_MS = 5 * 60 * 1_000;
const MEMORY_WINDOW_MS = 8 * 60 * 60 * 1_000;
const OCR_TAIL_BYTES = 128 * 1024;

function toIso(value, fallback) {
  const raw = String(value ?? '');
  const date = /^\d{10}$/u.test(raw) ? new Date(Number(raw) * 1_000) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

async function readTail(filePath, byteCount = OCR_TAIL_BYTES) {
  const info = await stat(filePath);
  const length = Math.min(info.size, byteCount);
  if (length <= 0) return '';
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function parseLatestOcrEvent(tail) {
  const lines = tail.split(/\r?\n/u).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // A tail read can begin in the middle of a JSON line. Continue backwards.
    }
  }
  return null;
}

function classifyCoarseState(text) {
  const normalized = String(text || '').toLocaleLowerCase('zh-CN');
  const meetingSignals = [
    '飞书会议',
    '正在共享',
    '共享屏幕',
    '参会人',
    '离开会议',
    '视频会议',
    'google meet',
    'microsoft teams',
    'zoom meeting',
    'unmute',
  ];
  const focusSignals = [
    'codex',
    'visual studio code',
    'xcode',
    'terminal',
    '飞书文档',
    '评测',
    '编辑',
    '代码',
    '项目',
    'figma',
  ];

  if (meetingSignals.some((signal) => normalized.includes(signal))) return 'meeting';
  if (normalized.length >= 80 && focusSignals.some((signal) => normalized.includes(signal))) return 'focus';
  return 'available';
}

function extractControlledTopics(text) {
  const rules = [
    { id: 'research', pattern: /(?:论文|业界前沿|研究|调研|research|paper)/iu, label: '业界前沿研究' },
    { id: 'followup', pattern: /(?:待办|todo|action item|follow[- ]?up|会后|下一步)/iu, label: '会后跟进' },
    { id: 'proactive', pattern: /(?:主动\s*agent|proactive agent|主动式桌面)/iu, label: '主动 Agent' },
    { id: 'evaluation', pattern: /(?:评测|标注|benchmark|rubric|judge)/iu, label: '评测工作' },
    { id: 'recording', pattern: /(?:录音|语音|audio|speaker|asr)/iu, label: '语音质量评估' },
    { id: 'meeting', pattern: /(?:会议|周会|会中|meeting)/iu, label: '会议协作' },
  ];
  return rules.filter((rule) => rule.pattern.test(text)).map(({ id, label }) => ({ id, label }));
}

async function readRecentMemorySignals(memoryDir, nowMs) {
  let names;
  try {
    names = await readdir(memoryDir);
  } catch {
    return { count: 0, lastSeen: null, topics: [], excerpts: [] };
  }

  const candidates = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const filePath = path.join(memoryDir, name);
    try {
      const info = await stat(filePath);
      if (nowMs - info.mtimeMs <= MEMORY_WINDOW_MS) candidates.push({ filePath, mtimeMs: info.mtimeMs });
    } catch {
      // Ignore files that disappear during rotation.
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const selected = candidates.slice(0, 4);
  const texts = [];
  for (const candidate of selected) {
    try {
      const text = await readFile(candidate.filePath, 'utf8');
      texts.push(text.slice(0, 48 * 1024));
    } catch {
      // A single malformed summary must not break the adapter.
    }
  }

  const combined = texts.join('\n');
  return {
    count: texts.length,
    lastSeen: selected[0] ? new Date(selected[0].mtimeMs).toISOString() : null,
    topics: extractControlledTopics(combined),
    excerpts: texts.map((text) => redactText(text, { maxLength: 1_600 })).filter(Boolean),
  };
}

async function verifyChronicleProcess(tmpDir) {
  const pidPath = path.join(tmpDir, 'codex_chronicle', 'chronicle-started.pid');
  const rawPid = (await readFile(pidPath, 'utf8')).trim();
  if (!/^\d{1,10}$/u.test(rawPid)) return false;

  const { stdout } = await execFileText('/bin/ps', ['-p', rawPid, '-o', 'command='], {
    timeout: 3_000,
    maxBuffer: 16 * 1024,
    publicMessage: 'Chronicle 进程无法验证。',
  });
  const executable = stdout.trim().split(/\s+/u)[0] || '';
  return path.basename(executable) === 'codex_chronicle';
}

async function findLatestOcrPerDisplay(screenDir) {
  const names = (await readdir(screenDir)).filter((name) => name.endsWith('.ocr.jsonl'));
  const entriesByDisplay = new Map();
  for (const name of names) {
    const filePath = path.join(screenDir, name);
    try {
      const info = await stat(filePath);
      const displayMatch = name.match(/-display-(.+)\.ocr\.jsonl$/u);
      const display = displayMatch?.[1] || name;
      const current = entriesByDisplay.get(display);
      if (!current || info.mtimeMs > current.mtimeMs) {
        entriesByDisplay.set(display, { filePath, mtimeMs: info.mtimeMs, display });
      }
    } catch {
      // Ignore a segment that rotated during the scan.
    }
  }
  return [...entriesByDisplay.values()].sort((left, right) => right.mtimeMs - left.mtimeMs);
}

export class ChronicleAdapter {
  constructor(options = {}) {
    this.tmpDir = options.tmpDir || os.tmpdir();
    this.screenDir = options.screenDir || path.join(this.tmpDir, 'chronicle', 'screen_recording');
    this.memoryDir =
      options.memoryDir ||
      path.join(os.homedir(), '.codex', 'memories', 'extensions', 'chronicle', 'resources');
    this.now = options.now || (() => new Date());
  }

  async collect() {
    const now = this.now();
    const nowMs = now.getTime();
    let processVerified = false;
    try {
      processVerified = await verifyChronicleProcess(this.tmpDir);
    } catch {
      processVerified = false;
    }

    const memory = await readRecentMemorySignals(this.memoryDir, nowMs);
    if (!processVerified) {
      return {
        state: 'stale',
        classification: 'stale',
        lastSeen: memory.lastSeen,
        memory,
        source: {
          id: 'chronicle',
          name: 'Chronicle',
          state: 'error',
          detail: '屏幕记忆进程未能通过本机验证。',
          ...(memory.lastSeen ? { lastSeen: memory.lastSeen } : {}),
        },
        issue: {
          source: 'Chronicle',
          message: '无法确认 Chronicle 正在运行。',
          recovery: '在 Codex 桌面端确认屏幕记忆已开启，然后重新扫描。',
        },
      };
    }

    let latestPerDisplay;
    try {
      latestPerDisplay = await findLatestOcrPerDisplay(this.screenDir);
    } catch {
      latestPerDisplay = [];
    }
    if (!latestPerDisplay.length) {
      return {
        state: 'stale',
        classification: 'stale',
        lastSeen: memory.lastSeen,
        memory,
        source: {
          id: 'chronicle',
          name: 'Chronicle',
          state: 'stale',
          detail: '进程在运行，但尚未发现可用的屏幕状态。',
          ...(memory.lastSeen ? { lastSeen: memory.lastSeen } : {}),
        },
        issue: {
          source: 'Chronicle',
          message: '当前没有可用的 Chronicle OCR 状态。',
          recovery: '稍后重新扫描，或检查屏幕录制权限。',
        },
      };
    }

    const displayStates = [];
    for (const latest of latestPerDisplay) {
      try {
        const event = parseLatestOcrEvent(await readTail(latest.filePath));
        const capturedAt = toIso(event?.captured_at, new Date(latest.mtimeMs).toISOString());
        const capturedMs = new Date(capturedAt).getTime();
        const ageMs = Math.max(0, nowMs - (Number.isFinite(capturedMs) ? capturedMs : latest.mtimeMs));
        displayStates.push({
          capturedAt,
          ageMs,
          classification: ageMs <= FRESH_MS ? classifyCoarseState(event?.normalized_text) : 'stale',
          text: ageMs <= FRESH_MS ? redactText(event?.normalized_text, { maxLength: 2_400 }) : '',
        });
      } catch {
        // One display can rotate independently. Other active displays remain usable.
      }
    }
    displayStates.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
    const latestState = displayStates[0];
    if (!latestState) {
      return {
        state: 'stale',
        classification: 'stale',
        lastSeen: memory.lastSeen,
        memory,
        source: {
          id: 'chronicle',
          name: 'Chronicle',
          state: 'stale',
          detail: '屏幕状态文件暂时无法解析。',
          ...(memory.lastSeen ? { lastSeen: memory.lastSeen } : {}),
        },
      };
    }
    const usable = displayStates.filter((item) => item.ageMs <= FRESH_MS);
    const classification = usable.some((item) => item.classification === 'meeting')
      ? 'meeting'
      : usable.some((item) => item.classification === 'focus')
        ? 'focus'
        : usable.length
          ? 'available'
          : 'stale';
    const freshness = latestState.ageMs <= LIVE_MS ? 'live' : latestState.ageMs <= FRESH_MS ? 'fresh' : 'stale';
    const sourceState = freshness === 'live' ? 'live' : freshness === 'fresh' ? 'connected' : 'stale';

    return {
      state: freshness,
      classification,
      lastSeen: latestState.capturedAt,
      memory,
      screenContexts: usable.map((item) => ({ capturedAt: item.capturedAt, text: item.text })).filter((item) => item.text),
      source: {
        id: 'chronicle',
        name: 'Chronicle',
        state: sourceState,
        detail:
          freshness === 'live'
            ? `已读取 ${usable.length} 块屏幕的最新 OCR，并用于当前任务与项目判断。`
            : freshness === 'fresh'
              ? '屏幕状态超过 3 分钟，但仍在 5 分钟容忍窗口内。'
              : '屏幕状态已超过 5 分钟未更新。',
        lastSeen: latestState.capturedAt,
      },
      ...(freshness !== 'stale'
        ? {}
        : {
            issue: {
              source: 'Chronicle',
              message: 'Chronicle 屏幕状态已过期。',
              recovery: '确认 Codex 桌面端仍在录制屏幕，然后手动刷新。',
            },
          }),
    };
  }
}

export const chronicleInternals = {
  classifyCoarseState,
  extractControlledTopics,
  findLatestOcrPerDisplay,
  parseLatestOcrEvent,
  readRecentMemorySignals,
};

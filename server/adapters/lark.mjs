import { createHash } from 'node:crypto';
import { access, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileJson } from '../lib/exec-file.mjs';
import { redactText, safeLabel } from '../security.mjs';

const CLI_ENV = Object.freeze({
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
});

async function discoverLarkBinary(configured = 'lark-cli', homeDir = os.homedir()) {
  if (path.isAbsolute(configured)) {
    await access(configured);
    return configured;
  }
  if (configured !== 'lark-cli') return configured;
  const candidates = [
    path.join(homeDir, '.local', 'bin', 'lark-cli'),
    '/opt/homebrew/bin/lark-cli',
    '/usr/local/bin/lark-cli',
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to PATH fallback for development shells.
    }
  }
  return configured;
}

const AUTH_ARGS = Object.freeze(['auth', 'status', '--json', '--verify']);
const INITIAL_MENTION_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
const MENTION_OVERLAP_MS = 35 * 60 * 1_000;
const INITIAL_MEETING_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1_000;
const MEETING_OVERLAP_MS = 3 * 60 * 60 * 1_000;
const MEETING_SCAN_INTERVAL_MS = 2 * 60 * 1_000;
const MINUTE_CACHE_TTL_MS = 30 * 60 * 1_000;
const MAX_MEETINGS_PER_SCAN = 12;
const OPEN_TASK_ARGS = Object.freeze([
  'task',
  '+get-my-tasks',
  '--complete=false',
  '--page-limit',
  '1',
  '--as',
  'user',
  '--format',
  'json',
]);
const COMPLETED_TASK_ARGS = Object.freeze([
  'task',
  '+get-my-tasks',
  '--complete=true',
  '--page-limit',
  '3',
  '--as',
  'user',
  '--format',
  'json',
]);

function agendaArgs(start, end) {
  return Object.freeze([
    'calendar',
    '+agenda',
    '--as',
    'user',
    '--start',
    start,
    '--end',
    end,
    '--format',
    'json',
  ]);
}

function mentionArgs(start, end) {
  return Object.freeze([
    'im',
    '+messages-search',
    '--as',
    'user',
    '--query',
    '',
    '--is-at-me',
    '--start',
    start,
    '--end',
    end,
    '--page-size',
    '20',
    '--page-limit',
    '1',
    '--no-reactions',
    '--format',
    'json',
  ]);
}

function selfMessageArgs(start, end, selfOpenId) {
  return Object.freeze([
    'im',
    '+messages-search',
    '--as',
    'user',
    '--query',
    '',
    '--sender',
    selfOpenId,
    '--start',
    start,
    '--end',
    end,
    '--page-size',
    '20',
    '--page-limit',
    '1',
    '--no-reactions',
    '--format',
    'json',
  ]);
}

function meetingSearchArgs(start, end, selfOpenId, pageToken = '') {
  return Object.freeze([
    'vc',
    '+search',
    '--as',
    'user',
    '--participant-ids',
    selfOpenId,
    '--start',
    start,
    '--end',
    end,
    '--page-size',
    '30',
    ...(pageToken ? ['--page-token', pageToken] : []),
    '--format',
    'json',
  ]);
}

function meetingRecordingArgs(meetingIds) {
  return Object.freeze([
    'vc',
    '+recording',
    '--meeting-ids',
    meetingIds.join(','),
    '--as',
    'user',
    '--format',
    'json',
  ]);
}

function meetingDetailArgs(meetingIds) {
  return Object.freeze([
    'vc',
    '+detail',
    '--meeting-ids',
    meetingIds.join(','),
    '--as',
    'user',
    '--format',
    'json',
  ]);
}

function minuteDetailArgs(minuteTokens) {
  return Object.freeze([
    'minutes',
    '+detail',
    '--minute-tokens',
    minuteTokens.join(','),
    '--todo',
    '--summary',
    '--transcript',
    '--output-dir',
    'lark-minutes',
    '--overwrite',
    '--as',
    'user',
    '--format',
    'json',
  ]);
}

function noteDetailArgs(noteId) {
  return Object.freeze([
    'note',
    '+detail',
    '--note-id',
    noteId,
    '--as',
    'user',
    '--format',
    'json',
  ]);
}

function documentFetchArgs(documentToken) {
  return Object.freeze([
    'docs',
    '+fetch',
    '--doc',
    documentToken,
    '--doc-format',
    'markdown',
    '--detail',
    'simple',
    '--as',
    'user',
    '--format',
    'json',
  ]);
}

function noteTranscriptArgs(noteId, outputPath) {
  return Object.freeze([
    'note',
    '+transcript',
    '--note-id',
    noteId,
    '--transcript-format',
    'plain_text',
    '--output',
    outputPath,
    '--overwrite',
    '--as',
    'user',
    '--format',
    'json',
  ]);
}

function mentionWindow(now, lastMentionScanAt) {
  const nowMs = now.getTime();
  const previousMs = lastMentionScanAt instanceof Date ? lastMentionScanAt.getTime() : Number.NaN;
  const hasPreviousScan = Number.isFinite(previousMs);
  const anchorMs = hasPreviousScan ? Math.min(previousMs, nowMs) : nowMs;
  const lookbackMs = hasPreviousScan ? MENTION_OVERLAP_MS : INITIAL_MENTION_LOOKBACK_MS;
  return {
    start: new Date(anchorMs - lookbackMs),
    end: now,
  };
}

function meetingWindow(now, lastMeetingScanAt) {
  const nowMs = now.getTime();
  const previousMs = lastMeetingScanAt instanceof Date ? lastMeetingScanAt.getTime() : Number.NaN;
  const hasPreviousScan = Number.isFinite(previousMs);
  const anchorMs = hasPreviousScan ? Math.min(previousMs, nowMs) : nowMs;
  return {
    start: new Date(anchorMs - (hasPreviousScan ? MEETING_OVERLAP_MS : INITIAL_MEETING_LOOKBACK_MS)),
    end: now,
  };
}

function parseDateTime(value) {
  const raw = value && typeof value === 'object' ? value.datetime ?? value.date ?? value.timestamp : value;
  if (raw == null) return null;
  if (/^\d{10,13}$/u.test(String(raw))) {
    const numeric = Number(raw);
    const date = new Date(String(raw).length === 10 ? numeric * 1_000 : numeric);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function sanitizeAgendaEvent(event) {
  const start = parseDateTime(event?.start_time);
  const end = parseDateTime(event?.end_time);
  if (!start || !end) return null;
  const title = safeLabel(event?.summary, '未命名日程', 120);
  return {
    title,
    start,
    end,
    busy: event?.free_busy_status !== 'free',
    accepted: !['decline', 'removed'].includes(event?.self_rsvp_status),
    allDay: Boolean(event?.start_time?.date && !event?.start_time?.datetime),
  };
}

function sanitizeTask(task) {
  if (!task || typeof task !== 'object') return null;
  return {
    title: safeLabel(task.summary, '未命名任务', 120),
    due: parseDateTime(task.due_at),
    completed: task.completed === true,
  };
}

function plainTextSummary(value) {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/<at\b[^>]*>(.*?)<\/at>/giu, '@$1')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/[`*~>#]+/gu, ' ');
  return safeLabel(text, '', 1_000);
}

function mentionHash(message) {
  const identityParts = [message?.message_id, message?.chat_id].filter(Boolean);
  const fallbackParts = [message?.create_time, message?.sender?.name, message?.chat_name, message?.content].filter(Boolean);
  return `mention-${createHash('sha256')
    .update((identityParts.length ? identityParts : fallbackParts).join('|'))
    .digest('hex')
    .slice(0, 16)}`;
}

function safeChatKey(message) {
  const identity = message?.chat_id
    || message?.chat_name
    || message?.chat_partner?.name
    || 'lark-chat';
  return `chat-${createHash('sha256').update(String(identity)).digest('hex').slice(0, 16)}`;
}

function safeThreadKey(message) {
  if (!message?.thread_id) return null;
  return `thread-${createHash('sha256').update(String(message.thread_id)).digest('hex').slice(0, 16)}`;
}

function sanitizeMessage(message, { mentionedMe = false, isMine = false } = {}) {
  if (!message || typeof message !== 'object' || message.deleted === true) return null;
  const senderType = String(message?.sender?.sender_type ?? message?.sender_type ?? '').toLowerCase();
  if (senderType === 'bot' || senderType === 'app') return null;
  const text = plainTextSummary(message.content);
  const createdAt = parseDateTime(message.create_time);
  if (!text || !createdAt) return null;
  return {
    id: mentionHash(message),
    sender: isMine ? '你' : safeLabel(message?.sender?.name, '飞书成员', 60),
    chat: safeLabel(message?.chat_name ?? message?.chat_partner?.name, '飞书会话', 80),
    chatKey: safeChatKey(message),
    ...(safeThreadKey(message) ? { threadKey: safeThreadKey(message) } : {}),
    createdAt,
    text,
    deleted: false,
    updated: message.updated === true || Boolean(message.update_time),
    threadPresent: Boolean(message.thread_id),
    mentionedMe,
    isMine,
  };
}

function sanitizeMention(message) {
  return sanitizeMessage(message, { mentionedMe: true, isMine: false });
}

function sanitizeSelfMessage(message) {
  return sanitizeMessage(message, { mentionedMe: false, isMine: true });
}

function meetingTitle(item) {
  const firstLine = String(item?.display_info || '').split(/\r?\n/u)[0];
  return safeLabel(firstLine, '未命名会议', 120);
}

function meetingSourceUrl(item) {
  const value = item?.meta_data?.app_link;
  return typeof value === 'string' && /^https?:\/\//iu.test(value.trim())
    ? safeLabel(value, '', 1_000)
    : '';
}

function documentContent(envelope) {
  return typeof envelope?.data?.document?.content === 'string'
    ? envelope.data.document.content
    : '';
}

function contentSourceUrl(value) {
  const text = String(value || '');
  const match = text.match(/https?:\/\/[^\s)>\]]*larkoffice\.com\/docx\/[^\s)>\]]+/iu)
    || text.match(/https?:\/\/[^\s)>\]]*feishu\.cn\/docx\/[^\s)>\]]+/iu);
  return match ? safeLabel(match[0], '', 1_000) : '';
}

function artifactText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
}

function boundedMeetingSummary(value) {
  const full = redactText(value, { maxLength: 16_000 });
  if (full.length <= 7_500) return full;
  const todoIndex = Math.max(full.lastIndexOf('# 待办'), full.lastIndexOf('待办 - [ ]'));
  const tailStart = todoIndex >= 0 ? todoIndex : Math.max(4_800, full.length - 2_700);
  return `${full.slice(0, 4_800).trimEnd()} … ${full.slice(tailStart, tailStart + 2_700).trim()}`;
}

function meetingDocumentTitle(value) {
  const text = String(value || '');
  const raw = text.match(/<title>([^<]{2,180})<\/title>/iu)?.[1]
    || text.match(/^#{1,2}\s+([^\n]{2,180})/mu)?.[1]
    || '';
  const cleaned = raw.replace(/^(?:智能纪要|文字记录)[:：]\s*/u, '').trim();
  if (/^(?:智能纪要|文字记录)$/u.test(cleaned)) return '';
  return safeLabel(cleaned, '', 120);
}

function extractOwnedNoteTodos(summary, selfName) {
  const text = String(summary || '');
  const sectionMatch = text.match(/(?:^|\n)#{1,3}\s*待办\s*\n([\s\S]*?)(?=\n#{1,3}\s|$)/iu);
  if (!sectionMatch) return [];
  const items = [...sectionMatch[1].matchAll(/-\s*\[\s*\]\s*([\s\S]*?)(?=\n\s*-\s*\[\s*\]|$)/gu)];
  const selfKey = normalizedPerson(selfName);
  return items.map((match) => match[1].trim()).filter((item) => {
    const owners = [...item.matchAll(/user-name="([^"]+)"/giu)].map((owner) => normalizedPerson(owner[1]));
    return Boolean(selfKey && (owners.includes(selfKey) || normalizedPerson(item).includes(selfKey)));
  }).map((item) => ({
    title: safeLabel(
      item
        .replace(/<cite\b[^>]*><\/cite>/giu, ' ')
        .replace(/<[^>]+>/gu, ' ')
        .replace(/[*_`#]/gu, '')
        .replace(/\s+/gu, ' '),
      '会后待办',
      140,
    ),
    assignees: [{ name: selfName }],
  })).slice(0, 8);
}

function meetingBriefId(meetingId, sourceKind) {
  return `meeting-brief-${createHash('sha256')
    .update(`${meetingId}|${sourceKind}`)
    .digest('hex')
    .slice(0, 16)}`;
}

function sanitizeMeetingBrief({ meeting, sourceKind, sourceUrl, summary, transcript, todos, now }) {
  const summaryText = boundedMeetingSummary(summary);
  const transcriptText = redactText(transcript, { maxLength: 6_500 });
  if (!summaryText && !transcriptText) return null;
  const title = safeLabel(
    sourceKind === 'note' ? meetingDocumentTitle(summary) : '',
    safeLabel(meeting?.title, '未命名会议', 120),
    120,
  );
  return {
    id: meetingBriefId(meeting?.id || title, sourceKind),
    meetingTitle: title,
    occurredAt: meeting?.start || now.toISOString(),
    endedAt: meeting?.end || null,
    source: sourceKind === 'minute' ? '飞书妙记' : '飞书智能纪要',
    sourceUrl: safeLabel(sourceUrl || meeting?.sourceUrl, '', 1_000),
    content: [summaryText ? `会议纪要：${summaryText}` : '', transcriptText ? `会议逐字稿：${transcriptText}` : '']
      .filter(Boolean)
      .join('\n'),
    todos: (todos || []).map((todo) => ({
      title: safeLabel(todo.title, '会后待办', 140),
      due: todo.due || null,
      evidence: safeLabel(todo.evidence, '', 220),
    })).slice(0, 8),
  };
}

function parseTranscript(text) {
  if (typeof text !== 'string' || !text.trim()) return { occurredAt: null, turns: [] };
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const metadata = lines[0]?.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(?:CST|UTC\+8)/u);
  const occurredAt = metadata
    ? parseDateTime(`${metadata[1]}T${metadata[2]}+08:00`)
    : null;
  const turns = [];
  let current = null;
  for (const rawLine of lines.slice(metadata ? 1 : 0)) {
    const line = rawLine.trim();
    const docHeader = line.match(/<cite\b[^>]*user-name="([^"]{1,80})"[^>]*><\/cite>\s+(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)/iu);
    const header = docHeader || line.match(/^(.{1,80}?)\s+(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\s*$/u);
    if (header) {
      if (current?.text?.trim()) turns.push({ ...current, text: current.text.trim() });
      current = { speaker: safeLabel(header[1], '', 80), offset: header[2], text: '' };
    } else if (line && current) {
      current.text = `${current.text}${current.text ? ' ' : ''}${line}`;
    }
  }
  if (current?.text?.trim()) turns.push({ ...current, text: current.text.trim() });
  return { occurredAt, turns };
}

function normalizedPerson(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function isSelfSpeaker(speaker, selfName) {
  const speakerKey = normalizedPerson(speaker);
  const selfKey = normalizedPerson(selfName);
  return Boolean(selfKey && speakerKey && (speakerKey === selfKey || speakerKey.includes(selfKey) || selfKey.includes(speakerKey)));
}

const COMMITMENT_CUE_PATTERN = /(?:我(?:来|会|负责|今天|明天|今晚|晚上|本周|下周|稍后|待会|先|去|把|准备|计划|这边)|这(?:个|块)我|我这边(?:来|会|负责|先)|我们(?:先|来|会|负责|准备|计划|把|去|出|写|做))/iu;
const COMMITMENT_ACTION_PATTERN = /(?:整理|梳理|分析|调研|研究|检索|汇总|总结|核对|审阅|更新|修复|补充|准备|生成|产出|输出|撰写|写|制定|设计|搭建|实现|跟进|跑|看|做|处理|推进|修改|优化|标注|review|research|analy[sz]e|draft|prepare|build|fix|update)/iu;
const NEGATED_COMMITMENT_PATTERN = /(?:不用我|不需要我|我不负责|我不做|先不做|不用做|不再做|我(?:不太)?(?:清楚|知道|确定)|不归我)/iu;

function taskSentences(text) {
  return String(text || '')
    .split(/[。！？!?；;\n]+/u)
    .map((item) => item.replace(/^(?:(?:嗯+|呃+|诶+|哦+|那个|好的?|然后|OK|ok)[，,\s]*)+/iu, '').trim())
    .filter((item) => item.length >= 4 && item.length <= 240);
}

function commitmentTaskTitle(sentence) {
  return safeLabel(
    String(sentence || '')
      .replace(/^(?:这(?:个|块)我(?:来|负责|先)?|我这边(?:来|会|负责|先)?|我(?:来|会|负责|今天|明天|今晚|晚上|本周|下周|稍后|待会|先|去|准备|计划|把)|我们(?:先|来|会|负责|准备|计划|把|去)?)\s*/u, '')
      .replace(/^(?:看一下|看下|看看)[，,\s]*(?:我们)?\s*/u, '')
      .replace(/^[，,\s]+/u, '')
      .trim(),
    '会后待办',
    140,
  );
}

function commitmentDue(sentence) {
  const match = String(sentence || '').match(/(?:今天|明天|后天|今晚|本周|下周|月底|周[一二三四五六日天])/u);
  return match ? safeLabel(match[0], '', 48) : null;
}

function extractTranscriptCommitments(transcript, selfName) {
  const parsed = parseTranscript(transcript);
  const items = [];
  for (const turn of parsed.turns) {
    if (!isSelfSpeaker(turn.speaker, selfName)) continue;
    for (const sentence of taskSentences(turn.text)) {
      if (
        NEGATED_COMMITMENT_PATTERN.test(sentence)
        || !COMMITMENT_CUE_PATTERN.test(sentence)
        || !COMMITMENT_ACTION_PATTERN.test(sentence)
      ) continue;
      items.push({
        title: commitmentTaskTitle(sentence),
        due: commitmentDue(sentence),
        evidence: safeLabel(`${turn.speaker} ${turn.offset}：${sentence}`, '', 220),
        confidence: 0.96,
      });
    }
  }
  return { occurredAt: parsed.occurredAt, items };
}

const TODO_TEXT_KEYS = new Set(['title', 'task', 'content', 'text', 'description', 'todo', 'summary', 'name']);
const TODO_OWNER_KEYS = /(?:owner|assignee|assignees|responsible|executor|assigned|负责人|执行人|处理人)/iu;
const TODO_DUE_KEYS = /(?:due|deadline|end_time|截止)/iu;

function valuesForMatchingKeys(value, predicate, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    for (const item of value) valuesForMatchingKeys(item, predicate, output);
    return output;
  }
  for (const [key, item] of Object.entries(value)) {
    if (predicate(key)) output.push(item);
    if (item && typeof item === 'object') valuesForMatchingKeys(item, predicate, output);
  }
  return output;
}

function flattenedStrings(value, output = []) {
  if (typeof value === 'string' || typeof value === 'number') output.push(String(value));
  else if (Array.isArray(value)) value.forEach((item) => flattenedStrings(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => flattenedStrings(item, output));
  return output;
}

function aiTodoAssignedToSelf(todo, selfName, selfOpenId) {
  if (!todo || typeof todo !== 'object') return false;
  const owners = valuesForMatchingKeys(todo, (key) => TODO_OWNER_KEYS.test(key)).flatMap((value) => flattenedStrings(value));
  const ownerText = normalizedPerson(owners.join(' '));
  return Boolean(
    ownerText
    && (
      normalizedPerson(selfName) && ownerText.includes(normalizedPerson(selfName))
      || selfOpenId && ownerText.includes(normalizedPerson(selfOpenId))
      || owners.some((owner) => /^(?:我|本人|你)$/u.test(owner.trim()))
    )
  );
}

function aiTodoTitle(todo) {
  if (typeof todo === 'string') return safeLabel(todo, '', 140);
  if (!todo || typeof todo !== 'object') return '';
  for (const [key, value] of Object.entries(todo)) {
    if (TODO_TEXT_KEYS.has(key.toLocaleLowerCase('en-US')) && typeof value === 'string' && value.trim()) {
      return safeLabel(value, '', 140);
    }
  }
  return '';
}

function aiTodoDue(todo) {
  const values = valuesForMatchingKeys(todo, (key) => TODO_DUE_KEYS.test(key)).flatMap((value) => flattenedStrings(value));
  for (const value of values) {
    const parsed = parseDateTime(value);
    if (parsed) return parsed;
    if (/^(?:今天|明天|后天|本周|下周|会后|月底|周[一二三四五六日天])/u.test(value.trim())) {
      return safeLabel(value, '', 48);
    }
  }
  return null;
}

function extractOwnedAiTodos(todos, selfName, selfOpenId) {
  return (Array.isArray(todos) ? todos : [])
    .filter((todo) => aiTodoAssignedToSelf(todo, selfName, selfOpenId))
    .map((todo) => ({
      title: aiTodoTitle(todo),
      due: aiTodoDue(todo),
      evidence: '妙记待办明确指向你负责。',
      confidence: 0.98,
    }))
    .filter((todo) => todo.title);
}

function normalizeTodoText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/(?:我(?:来|会|负责|先|去|把|这边)|今天|明天|今晚|晚上|稍后|待会)/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function dedupeTodoCandidates(candidates) {
  const result = [];
  for (const candidate of candidates) {
    const key = normalizeTodoText(candidate.title);
    if (key.length < 3) continue;
    const existing = result.find((item) => {
      const existingKey = normalizeTodoText(item.title);
      return existingKey === key
        || key.length >= 6 && existingKey.includes(key)
        || existingKey.length >= 6 && key.includes(existingKey);
    });
    if (!existing) result.push(candidate);
    else if (candidate.confidence > existing.confidence) Object.assign(existing, candidate);
  }
  return result.slice(0, 8);
}

function sanitizeMeetingTodos({ minute, meeting, transcript, selfName, selfOpenId, now }) {
  const transcriptResult = extractTranscriptCommitments(transcript, selfName);
  const candidates = dedupeTodoCandidates([
    ...extractOwnedAiTodos(minute?.artifacts?.todos, selfName, selfOpenId),
    ...transcriptResult.items,
  ]);
  const safeMeetingTitle = safeLabel(minute?.title || meeting?.title, '未命名会议', 120);
  const occurredAt = transcriptResult.occurredAt || now.toISOString();
  return candidates.map((candidate) => {
    const semanticKey = normalizeTodoText(candidate.title);
    return {
      id: `meeting-todo-${createHash('sha256')
        .update(`${minute?.minute_token || meeting?.id || safeMeetingTitle}|${semanticKey}`)
        .digest('hex')
        .slice(0, 16)}`,
      title: safeLabel(candidate.title, '会后待办', 140),
      meetingTitle: safeMeetingTitle,
      occurredAt,
      due: candidate.due || null,
      evidence: safeLabel(candidate.evidence, '由妙记逐字稿确认。', 220),
      confidence: candidate.confidence,
      source: '飞书妙记',
      responsibility: 'owner',
    };
  });
}

export class LarkAdapter {
  constructor(options = {}) {
    this.binary = options.binary || process.env.LARK_CLI_BIN || 'lark-cli';
    this.execJson = options.execJson || execFileJson;
    this.resolveBinary = options.resolveBinary || (options.execJson
      ? async () => this.binary
      : () => discoverLarkBinary(this.binary));
    this.resolvedBinary = null;
    this.now = options.now || (() => new Date());
    this.dataDir = options.dataDir || path.join(os.tmpdir(), 'cike-proactive-agent-lark');
    this.readText = options.readText || ((filePath) => readFile(filePath, 'utf8'));
    this.ensureDir = options.ensureDir || ((directory) => mkdir(directory, { recursive: true, mode: 0o700 }));
    this.lastMentionScanAt = null;
    this.lastSelfMessageScanAt = null;
    this.lastMeetingScanAt = null;
    this.minuteCache = new Map();
    this.noteCache = new Map();
    this.meetingScanCache = {
      available: true,
      meetingTodos: [],
      meetingBriefs: [],
      checked: 0,
      readable: 0,
      unavailable: 0,
      noRecording: 0,
    };
  }

  async #collectMeetingTodos(binary, now, userIdentity) {
    const nowMs = now.getTime();
    if (
      this.lastMeetingScanAt
      && nowMs - this.lastMeetingScanAt.getTime() < MEETING_SCAN_INTERVAL_MS
    ) return this.meetingScanCache;

    const selfOpenId = typeof userIdentity?.openId === 'string' ? userIdentity.openId.trim() : '';
    const selfName = typeof userIdentity?.userName === 'string' ? safeLabel(userIdentity.userName, '', 60) : '';
    if (!selfOpenId || !selfName) {
      return { ...this.meetingScanCache, available: false };
    }

    try {
      const range = meetingWindow(now, this.lastMeetingScanAt);
      const search = await this.execJson(
        binary,
        meetingSearchArgs(formatShanghaiIso(range.start), formatShanghaiIso(range.end), selfOpenId),
        {
          timeout: 20_000,
          env: CLI_ENV,
          publicMessage: '最近已结束会议暂时不可用。',
        },
      );
      if (search?.ok !== true || !Array.isArray(search?.data?.items)) {
        throw new Error('unexpected meeting search envelope');
      }
      const meetings = search.data.items
        .filter((item) => item && typeof item.id === 'string' && item.id.trim())
        .slice(0, MAX_MEETINGS_PER_SCAN)
        .map((item) => ({
          id: item.id.trim(),
          title: meetingTitle(item),
          sourceUrl: meetingSourceUrl(item),
        }));
      const meetingById = new Map(meetings.map((meeting) => [meeting.id, meeting]));
      let recordings = [];
      let details = [];
      if (meetings.length) {
        const meetingIds = meetings.map((meeting) => meeting.id);
        const [recordingResult, detailResult] = await Promise.allSettled([
          this.execJson(binary, meetingRecordingArgs(meetingIds), {
            timeout: 30_000,
            env: CLI_ENV,
            publicMessage: '会后妙记录制索引暂时不可用。',
          }),
          this.execJson(binary, meetingDetailArgs(meetingIds), {
            timeout: 30_000,
            env: CLI_ENV,
            publicMessage: '会议智能纪要索引暂时不可用。',
          }),
        ]);
        const recordingEnvelope = recordingResult.status === 'fulfilled' ? recordingResult.value : null;
        const detailEnvelope = detailResult.status === 'fulfilled' ? detailResult.value : null;
        recordings = Array.isArray(recordingEnvelope?.data?.recordings)
          ? recordingEnvelope.data.recordings.filter((recording) => recording?.minute_token && !recording?.error)
          : [];
        details = Array.isArray(detailEnvelope?.data?.meetings)
          ? detailEnvelope.data.meetings.filter((detail) => detail && !detail.error)
          : [];
        for (const detail of details) {
          const meeting = meetingById.get(detail.meeting_id);
          if (!meeting) continue;
          meeting.title = safeLabel(detail.topic, meeting.title, 120);
          meeting.start = parseDateTime(detail.start_time);
          meeting.end = parseDateTime(detail.end_time);
          meeting.noteId = typeof detail.note_id === 'string' ? detail.note_id.trim() : '';
        }
      }

      const freshRecordings = recordings.filter((recording) => {
        const cached = this.minuteCache.get(recording.minute_token);
        return !cached || nowMs - cached.scannedAt >= MINUTE_CACHE_TTL_MS;
      });
      if (freshRecordings.length) {
        await this.ensureDir(this.dataDir);
        let minuteEnvelope = null;
        try {
          minuteEnvelope = await this.execJson(
            binary,
            minuteDetailArgs(freshRecordings.map((recording) => recording.minute_token)),
            {
              timeout: 75_000,
              maxBuffer: 16 * 1024 * 1024,
              cwd: this.dataDir,
              env: CLI_ENV,
              publicMessage: '会后妙记正文暂时不可用。',
            },
          );
        } catch {
          // A batch of recordings commonly contains files the current user
          // cannot read. That must never abort the independent intelligent-note
          // fallback for the same or other meetings.
          minuteEnvelope = null;
        }
        const recordingByToken = new Map(freshRecordings.map((recording) => [recording.minute_token, recording]));
        const minuteItems = Array.isArray(minuteEnvelope?.data?.minutes) ? minuteEnvelope.data.minutes : [];
        for (const minute of minuteItems) {
          const token = typeof minute?.minute_token === 'string' ? minute.minute_token : '';
          if (!token) continue;
          const recording = recordingByToken.get(token);
          const meeting = meetingById.get(recording?.meeting_id) || { id: recording?.meeting_id, title: minute?.title };
          if (minute?.error) {
            this.minuteCache.set(token, { scannedAt: nowMs, readable: false, meetingTodos: [] });
            continue;
          }
          let transcript = '';
          const transcriptFile = minute?.artifacts?.transcript_file;
          if (typeof transcriptFile === 'string' && transcriptFile.trim()) {
            const root = path.resolve(this.dataDir);
            const candidate = path.resolve(root, transcriptFile);
            if (candidate === root || candidate.startsWith(`${root}${path.sep}`)) {
              try {
                transcript = await this.readText(candidate);
              } catch {
                transcript = '';
              }
            }
          }
          const meetingTodos = sanitizeMeetingTodos({
            minute,
            meeting,
            transcript,
            selfName,
            selfOpenId,
            now,
          });
          const summary = artifactText(minute?.artifacts?.summary || minute?.summary);
          const sourceUrl = typeof recording?.recording_url === 'string'
            ? recording.recording_url
            : meeting?.sourceUrl;
          const meetingBrief = sanitizeMeetingBrief({
            meeting,
            sourceKind: 'minute',
            sourceUrl,
            summary,
            transcript,
            todos: meetingTodos,
            now,
          });
          this.minuteCache.set(token, {
            scannedAt: nowMs,
            readable: Boolean(meetingBrief),
            meetingId: meeting?.id,
            meetingTodos,
            meetingBrief,
          });
        }
        for (const recording of freshRecordings) {
          if (!this.minuteCache.has(recording.minute_token)) {
            this.minuteCache.set(recording.minute_token, { scannedAt: nowMs, readable: false, meetingTodos: [] });
          }
        }
      }

      const recordingByMeetingId = new Map(recordings.map((recording) => [recording.meeting_id, recording]));
      await this.ensureDir(this.dataDir);
      for (const meeting of meetings) {
        const recording = recordingByMeetingId.get(meeting.id);
        const minuteEntry = recording ? this.minuteCache.get(recording.minute_token) : null;
        if (minuteEntry?.readable || !meeting.noteId) continue;
        const cached = this.noteCache.get(meeting.noteId);
        if (cached && nowMs - cached.scannedAt < MINUTE_CACHE_TTL_MS) continue;
        try {
          const noteEnvelope = await this.execJson(binary, noteDetailArgs(meeting.noteId), {
            timeout: 20_000,
            env: CLI_ENV,
            publicMessage: '飞书智能纪要详情暂时不可用。',
          });
          const note = noteEnvelope?.data?.note;
          if (!note || typeof note !== 'object') throw new Error('unexpected note detail envelope');
          let summary = '';
          let transcript = '';
          if (note.note_display_type === 'normal') {
            const documentTokens = [note.note_doc_token, note.verbatim_doc_token]
              .filter((token, index, values) => typeof token === 'string' && token && values.indexOf(token) === index);
            const documentResults = await Promise.allSettled(documentTokens.map((token) => this.execJson(
              binary,
              documentFetchArgs(token),
              {
                timeout: 30_000,
                maxBuffer: 16 * 1024 * 1024,
                env: CLI_ENV,
                publicMessage: '飞书智能纪要正文暂时不可用。',
              },
            )));
            const documents = documentResults.map((result) => result.status === 'fulfilled' ? documentContent(result.value) : '');
            summary = documents[0] || '';
            transcript = documents[1] || documents[0] || '';
          } else {
            const outputPath = path.join(this.dataDir, `note-${createHash('sha256').update(meeting.noteId).digest('hex').slice(0, 16)}.txt`);
            await this.execJson(binary, noteTranscriptArgs(meeting.noteId, outputPath), {
              timeout: 45_000,
              maxBuffer: 16 * 1024 * 1024,
              cwd: this.dataDir,
              env: CLI_ENV,
              publicMessage: '飞书智能纪要逐字稿暂时不可用。',
            });
            transcript = await this.readText(outputPath);
          }
          const meetingTodos = sanitizeMeetingTodos({
            minute: {
              title: meeting.title,
              artifacts: { todos: extractOwnedNoteTodos(summary, selfName) },
            },
            meeting,
            transcript,
            selfName,
            selfOpenId,
            now,
          });
          const sourceUrl = typeof note.note_doc_token === 'string'
            ? `https://www.feishu.cn/docx/${note.note_doc_token}`
            : contentSourceUrl(summary || transcript) || meeting.sourceUrl;
          const meetingBrief = sanitizeMeetingBrief({
            meeting,
            sourceKind: 'note',
            sourceUrl,
            summary,
            transcript,
            todos: meetingTodos,
            now,
          });
          this.noteCache.set(meeting.noteId, {
            scannedAt: nowMs,
            readable: Boolean(meetingBrief),
            meetingId: meeting.id,
            meetingTodos,
            meetingBrief,
          });
        } catch {
          this.noteCache.set(meeting.noteId, {
            scannedAt: nowMs,
            readable: false,
            meetingId: meeting.id,
            meetingTodos: [],
            meetingBrief: null,
          });
        }
      }

      const currentEntries = meetings.map((meeting) => {
        const recording = recordingByMeetingId.get(meeting.id);
        const minuteEntry = recording ? this.minuteCache.get(recording.minute_token) : null;
        const noteEntry = meeting.noteId ? this.noteCache.get(meeting.noteId) : null;
        return minuteEntry?.readable ? minuteEntry : noteEntry || minuteEntry || null;
      });
      const allContentEntries = [...this.minuteCache.values(), ...this.noteCache.values()];
      const meetingTodos = allContentEntries
        .flatMap((entry) => entry.meetingTodos || [])
        .filter((todo, index, items) => items.findIndex((candidate) => candidate.id === todo.id) === index)
        .sort((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt)))
        .slice(0, 30);
      const meetingBriefs = allContentEntries
        .map((entry) => entry.meetingBrief)
        .filter(Boolean)
        .filter((brief, index, items) => items.findIndex((candidate) => candidate.id === brief.id) === index)
        .sort((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt)))
        .slice(0, 12);
      this.lastMeetingScanAt = new Date(nowMs);
      this.meetingScanCache = {
        available: true,
        meetingTodos,
        meetingBriefs,
        checked: meetings.length,
        readable: currentEntries.filter((entry) => entry?.readable).length,
        unavailable: currentEntries.filter((entry) => entry && !entry.readable).length,
        noRecording: currentEntries.filter((entry) => !entry).length,
      };
      return this.meetingScanCache;
    } catch {
      return { ...this.meetingScanCache, available: false };
    }
  }

  async collect() {
    if (!this.resolvedBinary) {
      try {
        this.resolvedBinary = await this.resolveBinary();
      } catch {
        return this.#errorResult(
          '未能找到飞书 CLI。',
          '安装 lark-cli，或通过 LARK_CLI_BIN 指定绝对路径。',
        );
      }
    }
    const binary = this.resolvedBinary;
    let status;
    try {
      status = await this.execJson(binary, AUTH_ARGS, {
        timeout: 8_000,
        env: CLI_ENV,
        publicMessage: '飞书认证状态不可用。',
      });
    } catch {
      return this.#errorResult(
        '未能验证飞书只读连接。',
        '在终端运行 lark-cli auth status --json --verify 检查登录状态。',
      );
    }

    const userIdentity = status?.identities?.user;
    const verified = status?.verified === true && userIdentity?.status === 'ready' && userIdentity?.tokenStatus === 'valid';
    if (!verified) {
      return this.#errorResult(
        '飞书用户身份尚未就绪。',
        '使用最小日历只读权限完成 lark-cli 授权后重试。',
        'available',
      );
    }

    const now = this.now();
    const selfName = typeof userIdentity?.userName === 'string'
      ? safeLabel(userIdentity.userName, '', 60)
      : '';
    const today = formatShanghaiDate(now);
    const tomorrow = formatShanghaiDate(new Date(now.getTime() + 24 * 60 * 60 * 1_000));
    const mentionRange = mentionWindow(now, this.lastMentionScanAt);
    const mentionEnd = formatShanghaiIso(mentionRange.end);
    const mentionStart = formatShanghaiIso(mentionRange.start);
    const selfOpenId = typeof userIdentity?.openId === 'string' && userIdentity.openId.trim()
      ? userIdentity.openId.trim()
      : null;
    const selfMessageRange = mentionWindow(now, this.lastSelfMessageScanAt);
    const selfMessageStart = formatShanghaiIso(selfMessageRange.start);
    const selfMessageEnd = formatShanghaiIso(selfMessageRange.end);
    const [agendaResult, taskResult, completedTaskResult, mentionResult, selfMessageResult, meetingResult] = await Promise.allSettled([
      this.execJson(binary, agendaArgs(today, tomorrow), {
        timeout: 15_000,
        env: CLI_ENV,
        publicMessage: '今日飞书日程暂时不可用。',
      }),
      this.execJson(binary, OPEN_TASK_ARGS, {
        timeout: 15_000,
        env: CLI_ENV,
        publicMessage: '未完成飞书任务暂时不可用。',
      }),
      this.execJson(binary, COMPLETED_TASK_ARGS, {
        timeout: 15_000,
        env: CLI_ENV,
        publicMessage: '已完成飞书任务暂时不可用。',
      }),
      this.execJson(binary, mentionArgs(mentionStart, mentionEnd), {
        timeout: 15_000,
        env: CLI_ENV,
        publicMessage: '最近 @我 消息暂时不可用。',
      }),
      selfOpenId
        ? this.execJson(binary, selfMessageArgs(selfMessageStart, selfMessageEnd, selfOpenId), {
            timeout: 15_000,
            env: CLI_ENV,
            publicMessage: '最近本人发言暂时不可用。',
          })
        : Promise.reject(new Error('self identity unavailable')),
      this.#collectMeetingTodos(binary, now, userIdentity),
    ]);

    try {
      if (agendaResult.status !== 'fulfilled') throw agendaResult.reason;
      const agenda = agendaResult.value;
      if (agenda?.ok !== true || !Array.isArray(agenda?.data)) {
        throw new Error('unexpected agenda envelope');
      }
      const events = agenda.data
        .map(sanitizeAgendaEvent)
        .filter(Boolean)
        .filter((event) => event.accepted)
        .sort((left, right) => left.start.localeCompare(right.start));

      const taskEnvelope = taskResult.status === 'fulfilled' ? taskResult.value : null;
      const taskAvailable = taskEnvelope?.ok === true && Array.isArray(taskEnvelope?.data?.items);
      const openTasks = taskAvailable
        ? taskEnvelope.data.items.map(sanitizeTask).filter(Boolean).slice(0, 30)
        : [];
      const completedTaskEnvelope = completedTaskResult.status === 'fulfilled' ? completedTaskResult.value : null;
      const completedTaskAvailable = completedTaskEnvelope?.ok === true
        && Array.isArray(completedTaskEnvelope?.data?.items);
      const completedTasks = completedTaskAvailable
        ? completedTaskEnvelope.data.items.map(sanitizeTask).filter(Boolean).filter((task) => task.completed).slice(0, 120)
        : [];
      const tasks = [...openTasks, ...completedTasks].filter((task, index, items) => (
        items.findIndex((candidate) => (
          candidate.completed === task.completed
          && candidate.title === task.title
          && candidate.due === task.due
        )) === index
      ));
      const mentionEnvelope = mentionResult.status === 'fulfilled' ? mentionResult.value : null;
      const mentionAvailable = mentionEnvelope?.ok === true && Array.isArray(mentionEnvelope?.data?.messages);
      const mentions = mentionAvailable
        ? mentionEnvelope.data.messages.map(sanitizeMention).filter(Boolean).slice(0, 20)
        : [];
      const selfMessageEnvelope = selfMessageResult.status === 'fulfilled' ? selfMessageResult.value : null;
      const selfMessageAvailable = selfMessageEnvelope?.ok === true
        && Array.isArray(selfMessageEnvelope?.data?.messages);
      const selfMessages = selfMessageAvailable
        ? selfMessageEnvelope.data.messages.map(sanitizeSelfMessage).filter(Boolean).slice(0, 20)
        : [];
      const meetingEnvelope = meetingResult.status === 'fulfilled' ? meetingResult.value : null;
      const meetingAvailable = meetingEnvelope?.available === true;
      const meetingTodos = Array.isArray(meetingEnvelope?.meetingTodos) ? meetingEnvelope.meetingTodos : [];
      const meetingBriefs = Array.isArray(meetingEnvelope?.meetingBriefs) ? meetingEnvelope.meetingBriefs : [];
      const nowIso = now.toISOString();
      const synced = [`今日 ${events.length} 个日程`];
      if (taskAvailable) synced.push(`${openTasks.length} 个未完成任务`);
      if (completedTaskAvailable) synced.push(`${completedTasks.length} 个已完成任务用于静默去重`);
      if (mentionAvailable) synced.push(`最近 ${mentions.length} 条 @我 消息`);
      if (selfMessageAvailable) synced.push(`最近 ${selfMessages.length} 条本人发言`);
      if (meetingAvailable) {
        synced.push(`会后妙记读取 ${meetingBriefs.length} 场正文、提炼 ${meetingTodos.length} 个本人待办`);
        if (meetingEnvelope.checked) {
          synced.push(`检查 ${meetingEnvelope.checked} 场已结束会议（${meetingEnvelope.readable} 场可读${meetingEnvelope.unavailable ? `、${meetingEnvelope.unavailable} 场无权限` : ''}${meetingEnvelope.noRecording ? `、${meetingEnvelope.noRecording} 场无妙记` : ''}）`);
        }
      }
      const degraded = [];
      if (!taskAvailable) degraded.push('未完成任务');
      if (!completedTaskAvailable) degraded.push('已完成任务');
      if (!mentionAvailable) degraded.push('@我 消息');
      if (!selfMessageAvailable) degraded.push('本人发言');
      if (!meetingAvailable) degraded.push('会后妙记');
      const sourceDetail = `已以用户身份只读同步${synced.join('、')}。${
        degraded.length ? `${degraded.join('、')}读取已部分降级。` : ''
      }`;
      if (mentionAvailable) this.lastMentionScanAt = new Date(now.getTime());
      if (selfMessageAvailable) this.lastSelfMessageScanAt = new Date(now.getTime());
      return {
        state: 'connected',
        selfName,
        lastSeen: nowIso,
        events,
        tasks,
        mentions,
        selfMessages,
        meetingTodos,
        meetingBriefs,
        source: {
          id: 'lark',
          name: '飞书',
          state: 'connected',
          detail: sourceDetail,
          lastSeen: nowIso,
        },
        ...(degraded.length
          ? {
              issue: {
                source: degraded.map((item) => `飞书${item}`).join('、'),
                message: `飞书日程已同步，但${degraded.join('、')}暂时不可用。`,
                recovery: `检查${[
                  !taskAvailable ? ' task:task:read' : '',
                  !mentionAvailable ? ' search:message' : '',
                  !selfMessageAvailable ? ' search:message' : '',
                  !meetingAvailable ? ' vc:meeting.search:read、vc:record:readonly 与 minutes 只读权限' : '',
                ]
                  .filter(Boolean)
                  .join(' 和')} 只读权限后重新扫描。`,
              },
            }
          : {}),
      };
    } catch {
      return this.#errorResult(
        '已连接飞书，但今日日程读取失败。',
        '检查 calendar 只读 scope，然后重新扫描。',
      );
    }
  }

  #errorResult(message, recovery, state = 'error') {
    return {
      state,
      selfName: '',
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
        state,
        detail: message,
      },
      issue: {
        source: '飞书',
        message,
        recovery,
      },
    };
  }
}

function formatShanghaiDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function formatShanghaiIso(date) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1_000).toISOString().replace(/\.\d{3}Z$/u, '+08:00');
}

export const larkInternals = {
  AUTH_ARGS,
  OPEN_TASK_ARGS,
  COMPLETED_TASK_ARGS,
  agendaArgs,
  mentionArgs,
  selfMessageArgs,
  meetingSearchArgs,
  meetingRecordingArgs,
  meetingDetailArgs,
  minuteDetailArgs,
  noteDetailArgs,
  documentFetchArgs,
  noteTranscriptArgs,
  formatShanghaiDate,
  formatShanghaiIso,
  mentionHash,
  mentionWindow,
  meetingWindow,
  parseDateTime,
  plainTextSummary,
  sanitizeAgendaEvent,
  sanitizeMention,
  sanitizeSelfMessage,
  sanitizeTask,
  parseTranscript,
  extractTranscriptCommitments,
  extractOwnedAiTodos,
  extractOwnedNoteTodos,
  sanitizeMeetingTodos,
  sanitizeMeetingBrief,
  meetingDocumentTitle,
  discoverLarkBinary,
};

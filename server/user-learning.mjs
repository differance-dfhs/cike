import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { redactText, safeLabel } from './security.mjs';

const ALLOWED_KINDS = new Set([
  'opportunity_action',
  'artifact_opened',
  'artifact_source_opened',
  'codex_handoff',
  'suggestion_expanded',
  'project_opened',
  'sources_opened',
  'feedback',
]);
const ALLOWED_ACTIONS = new Set(['continue', 'ask', 'snooze', 'dismiss', 'unimportant', 'expired', 'complete', 'viewed']);
const ALLOWED_RATINGS = new Set(['good', 'bad']);
const CONSUMPTION_KINDS = new Set(['artifact_opened', 'codex_handoff']);
const MAX_EVENTS_ON_INIT = 5_000;

function emptyStats() {
  return {
    events: 0,
    engaged: 0,
    completed: 0,
    deferred: 0,
    dismissed: 0,
    unimportant: 0,
    expired: 0,
    good: 0,
    bad: 0,
  };
}

function emptySummary() {
  return {
    version: 1,
    updatedAt: null,
    totalActions: 0,
    explicitFeedback: 0,
    ratings: { good: 0, bad: 0 },
    byProject: {},
    byRecipe: {},
    recentFeedback: [],
  };
}

function normalizedKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '')
    .slice(0, 96);
}

function eventIdentity(event) {
  return `learn-${createHash('sha256')
    .update([
      event.at,
      event.kind,
      event.opportunityId,
      event.projectLabel,
      event.action,
      event.rating,
      event.note,
    ].join('|'))
    .digest('hex')
    .slice(0, 16)}`;
}

function sanitizeEvent(input, now) {
  if (!input || typeof input !== 'object' || !ALLOWED_KINDS.has(input.kind)) return null;
  const kind = input.kind;
  const action = ALLOWED_ACTIONS.has(input.action) ? input.action : null;
  const rating = ALLOWED_RATINGS.has(input.rating) ? input.rating : null;
  if (kind === 'opportunity_action' && !action) return null;
  if (kind === 'feedback' && !rating) return null;
  const event = {
    version: 1,
    at: now.toISOString(),
    kind,
    opportunityId: safeLabel(input.opportunityId, '', 96),
    projectId: safeLabel(input.projectId, '', 96),
    projectLabel: safeLabel(input.projectLabel, '', 72),
    recipeId: safeLabel(input.recipeId, '', 72),
    signalType: safeLabel(input.signalType, '', 48),
    title: safeLabel(input.title, '', 180),
    action,
    rating,
    note: redactText(input.note, { maxLength: 500 }),
  };
  event.id = eventIdentity(event);
  return event;
}

function bumpStats(stats, event) {
  stats.events += 1;
  if (['artifact_opened', 'artifact_source_opened', 'codex_handoff', 'suggestion_expanded', 'project_opened', 'sources_opened'].includes(event.kind)) {
    stats.engaged += 1;
  }
  if (event.kind === 'opportunity_action') {
    if (['continue', 'ask', 'viewed'].includes(event.action)) stats.engaged += 1;
    if (event.action === 'complete') stats.completed += 1;
    if (event.action === 'snooze') stats.deferred += 1;
    if (event.action === 'dismiss' || event.action === 'unimportant' || event.action === 'expired') stats.dismissed += 1;
    if (event.action === 'unimportant') stats.unimportant += 1;
    if (event.action === 'expired') stats.expired += 1;
  }
  if (event.rating === 'good') stats.good += 1;
  if (event.rating === 'bad') stats.bad += 1;
}

function addEvent(summary, event) {
  summary.updatedAt = event.at;
  summary.totalActions += 1;
  if (event.rating) {
    summary.explicitFeedback += 1;
    summary.ratings[event.rating] += 1;
    summary.recentFeedback.unshift({
      id: event.id,
      at: event.at,
      opportunityId: event.opportunityId,
      projectLabel: event.projectLabel,
      recipeId: event.recipeId,
      rating: event.rating,
      note: event.note,
      title: event.title,
    });
    summary.recentFeedback = summary.recentFeedback.slice(0, 24);
  }
  const dimensions = [
    ['byProject', event.projectLabel],
    ['byRecipe', event.recipeId],
  ];
  for (const [bucketName, label] of dimensions) {
    const key = normalizedKey(label);
    if (!key) continue;
    const existing = summary[bucketName][key] || { label, ...emptyStats() };
    bumpStats(existing, event);
    summary[bucketName][key] = existing;
  }
}

function rebuildSummary(events) {
  const summary = emptySummary();
  for (const event of events) addEvent(summary, event);
  return summary;
}

function relevantStats(summary, spec) {
  const project = summary.byProject[normalizedKey(spec?.projectLabel)];
  if (project) return project;
  return summary.byRecipe[normalizedKey(spec?.recipeId)] || emptyStats();
}

function calibrationFromStats(stats) {
  const positive = stats.good * 0.04 + stats.completed * 0.012 + stats.engaged * 0.005;
  const negative = stats.bad * 0.065
    + stats.dismissed * 0.018
    + stats.unimportant * 0.018
    + stats.expired * 0.024
    + stats.deferred * 0.006;
  const confidenceDelta = Math.max(-0.18, Math.min(0.12, positive - negative));
  const repeatedNegative = stats.bad + stats.unimportant + stats.expired;
  const suppressAuto = repeatedNegative >= 3 && repeatedNegative >= stats.good + stats.completed + 2;
  const semanticRejections = stats.unimportant + stats.expired;
  const suppressSuggestion = semanticRejections >= 2
    && semanticRejections >= stats.good + stats.completed + 2;
  const priorityDirection = stats.good >= 2 && stats.good > stats.bad
    ? 'up'
    : stats.bad >= 2 && stats.bad > stats.good
      ? 'down'
      : 'keep';
  return { confidenceDelta, suppressAuto, suppressSuggestion, priorityDirection, stats };
}

function profileExcerpt(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const selected = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^(?:\d+\.\s+\*\*|[-*]\s+|##\s+(?:Their Laws|Their Taste|How They Work|How To Talk))/u.test(line))
    .slice(0, 20)
    .join('\n');
  return redactText(selected, { maxLength: 3_200 });
}

function correctionCandidates(summary) {
  const candidates = [];
  for (const bucket of [summary.byProject, summary.byRecipe]) {
    for (const stats of Object.values(bucket)) {
      if (stats.good >= 2 && stats.good >= stats.bad + 2) {
        candidates.push(`加强「${stats.label}」：连续 ${stats.good} 次明确好评。`);
      } else if (stats.bad >= 2 && stats.bad >= stats.good + 2) {
        candidates.push(`收紧「${stats.label}」：连续 ${stats.bad} 次明确差评。`);
      }
    }
  }
  return [...new Set(candidates)].slice(0, 10);
}

function renderOverlay(summary, baselineName) {
  const corrections = correctionCandidates(summary);
  const feedback = summary.recentFeedback.filter((item) => item.note).slice(0, 12);
  return [
    '# 此刻 · 用户画像学习覆盖层',
    '',
    `更新时间：${summary.updatedAt || '尚无记录'}`,
    `稳定基线：${baselineName || '尚未发现 you / ditto 用户画像'}`,
    '',
    '## 学习概览',
    '',
    `- 语义动作：${summary.totalActions}`,
    `- 明确反馈：${summary.explicitFeedback}（好 ${summary.ratings.good} / 差 ${summary.ratings.bad}）`,
    '',
    '## 画像修正候选',
    '',
    ...(corrections.length ? corrections.map((item) => `- ${item}`) : ['- 证据尚不足；至少需要同一方向 2 次明确反馈。']),
    '',
    '## 最近反馈原话',
    '',
    ...(feedback.length
      ? feedback.map((item) => `- [${item.rating === 'good' ? '好' : '差'}] ${item.projectLabel || item.title || '未分类建议'}：${item.note}`)
      : ['- 暂无文字反馈。']),
    '',
    '> 该文件是反馈学习覆盖层，不会自动覆盖 ditto_you.md。推荐时会实时合并两者。',
    '',
  ].join('\n');
}

async function discoverProfilePath(configured, homeDir) {
  const candidates = [
    configured,
    path.join(homeDir, 'Documents', 'Codex', 'ditto_you.md'),
    path.join(homeDir, '.codex', 'skills', 'you', 'SKILL.md'),
  ].filter((candidate) => typeof candidate === 'string' && path.isAbsolute(candidate));
  for (const candidate of [...new Set(candidates)]) {
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      // Continue to the next local baseline candidate.
    }
  }
  return null;
}

export class UserLearningStore {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.eventsPath = path.join(dataDir, 'interaction-events.jsonl');
    this.summaryPath = path.join(dataDir, 'feedback-profile.json');
    this.overlayPath = path.join(dataDir, 'user-profile-feedback.md');
    this.profilePath = options.profilePath || process.env.PROACTIVE_AGENT_PROFILE_PATH || '';
    this.homeDir = options.homeDir || os.homedir();
    this.now = options.now || (() => new Date());
    this.summary = emptySummary();
    this.baselineText = '';
    this.baselineName = '';
    this.deferProfileLoad = options.deferProfileLoad === true;
    this.profileLoaded = false;
    this.profileLoadPromise = null;
    this.latestFeedback = new Map();
    this.consumptionEvents = new Map();
    this.writeChain = Promise.resolve();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    if (!this.deferProfileLoad) await this.#loadBaseline();
    let events = [];
    try {
      const lines = (await readFile(this.eventsPath, 'utf8')).trim().split(/\r?\n/u).filter(Boolean).slice(-MAX_EVENTS_ON_INIT);
      events = lines.flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed?.version === 1 && ALLOWED_KINDS.has(parsed.kind) ? [parsed] : [];
        } catch {
          return [];
        }
      });
    } catch {
      events = [];
    }
    this.summary = rebuildSummary(events);
    for (const event of events) {
      if (event.opportunityId && CONSUMPTION_KINDS.has(event.kind)) {
        this.consumptionEvents.set(event.opportunityId, {
          opportunityId: event.opportunityId,
          kind: event.kind,
          at: event.at,
        });
      }
    }
    for (const item of [...this.summary.recentFeedback].reverse()) {
      if (item.opportunityId) this.latestFeedback.set(item.opportunityId, item);
    }
    await this.#persistDerived();
    return this;
  }

  async refreshProfile() {
    if (this.profileLoaded) return this;
    if (!this.profileLoadPromise) {
      this.profileLoadPromise = (async () => {
        await this.#loadBaseline();
        const persist = () => this.#persistDerived();
        this.writeChain = this.writeChain.then(persist, persist);
        await this.writeChain;
        return this;
      })().finally(() => {
        this.profileLoadPromise = null;
      });
    }
    return this.profileLoadPromise;
  }

  getContext() {
    const corrections = correctionCandidates(this.summary);
    const recentNotes = this.summary.recentFeedback
      .filter((item) => item.note)
      .slice(0, 6)
      .map((item) => `${item.rating === 'good' ? '保留' : '纠正'}「${item.projectLabel || item.title || item.recipeId}」：${item.note}`);
    return {
      baselineExcerpt: profileExcerpt(this.baselineText),
      baselineName: this.baselineName,
      recommendationHints: [...corrections, ...recentNotes].slice(0, 12),
      summary: structuredClone(this.summary),
      source: {
        id: 'user-profile',
        name: '用户画像',
        state: 'available',
        detail: this.baselineName
          ? `已读取 ${this.baselineName}，并合并 ${this.summary.totalActions} 次语义动作、${this.summary.explicitFeedback} 条明确反馈。`
          : `尚未发现 you 用户画像；已用 ${this.summary.totalActions} 次本地语义动作建立学习覆盖层。`,
        ...(this.summary.updatedAt ? { lastSeen: this.summary.updatedAt } : {}),
      },
      publicSummary: {
        baselineLoaded: Boolean(this.baselineName),
        totalActions: this.summary.totalActions,
        explicitFeedback: this.summary.explicitFeedback,
        ratings: structuredClone(this.summary.ratings),
        correctionCandidates: corrections,
        updatedAt: this.summary.updatedAt,
      },
    };
  }

  feedbackForOpportunity(opportunityId) {
    const item = this.latestFeedback.get(opportunityId);
    if (!item) return null;
    return { rating: item.rating, note: item.note, recordedAt: item.at };
  }

  consumedInteractions() {
    return [...this.consumptionEvents.values()].map((item) => structuredClone(item));
  }

  calibrationFor(spec) {
    return calibrationFromStats(relevantStats(this.summary, spec));
  }

  async record(input) {
    const event = sanitizeEvent(input, this.now());
    if (!event) throw new Error('invalid learning event');
    const run = async () => {
      await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
      addEvent(this.summary, event);
      if (event.rating && event.opportunityId) {
        this.latestFeedback.set(event.opportunityId, {
          id: event.id,
          at: event.at,
          opportunityId: event.opportunityId,
          projectLabel: event.projectLabel,
          recipeId: event.recipeId,
          rating: event.rating,
          note: event.note,
          title: event.title,
        });
      }
      if (event.opportunityId && CONSUMPTION_KINDS.has(event.kind)) {
        this.consumptionEvents.set(event.opportunityId, {
          opportunityId: event.opportunityId,
          kind: event.kind,
          at: event.at,
        });
      }
      await this.#persistDerived();
      return structuredClone(event);
    };
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }

  async #loadBaseline() {
    const discovered = await discoverProfilePath(this.profilePath, this.homeDir);
    this.profileLoaded = true;
    if (!discovered) return;
    this.profilePath = discovered;
    try {
      this.baselineText = await readFile(discovered, 'utf8');
      this.baselineName = path.basename(discovered);
    } catch {
      this.baselineText = '';
      this.baselineName = '';
    }
  }

  async #persistDerived() {
    const jsonTemporary = `${this.summaryPath}.tmp`;
    const markdownTemporary = `${this.overlayPath}.tmp`;
    await writeFile(jsonTemporary, `${JSON.stringify(this.summary, null, 2)}\n`, { mode: 0o600 });
    await writeFile(markdownTemporary, renderOverlay(this.summary, this.baselineName), { mode: 0o600 });
    await rename(jsonTemporary, this.summaryPath);
    await rename(markdownTemporary, this.overlayPath);
  }
}

export const userLearningInternals = {
  calibrationFromStats,
  correctionCandidates,
  profileExcerpt,
  rebuildSummary,
  sanitizeEvent,
};

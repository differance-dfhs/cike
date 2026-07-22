import { createHash } from 'node:crypto';

const TERMINAL_DECISION_STATES = new Set(['archived', 'dismissed', 'superseded_pending']);
const NON_OWNER_RESPONSIBILITIES = new Set(['other', 'observer', 'none', 'not_owner']);
const COMPLETION_TEXT_PATTERN = /(?:已完成|已经完成|已取消|已经取消|不需要了|无需处理|不用再做|任务结束)/iu;
const VALUELESS_RECIPES = new Set(['meeting-digest']);

const MAX_AGE_BY_RECIPE = Object.freeze({
  'lark-mention-work-request': 24 * 60 * 60 * 1_000,
  'meeting-action': 7 * 24 * 60 * 60 * 1_000,
  'meeting-prep': 3 * 60 * 60 * 1_000,
  'rhythm-guidance': 90 * 60 * 1_000,
  'work-command-brief': 8 * 60 * 60 * 1_000,
  'local-change-triage': 7 * 24 * 60 * 60 * 1_000,
  'frontier-research-brief': 24 * 60 * 60 * 1_000,
});

const DEFAULT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1_000;

function normalized(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

export function semanticKeyForSpec(spec = {}) {
  const changeFacts = spec.changeFacts && typeof spec.changeFacts === 'object'
    ? JSON.stringify({
        from: Number.isFinite(spec.changeFacts.from) ? spec.changeFacts.from : null,
        to: Number.isFinite(spec.changeFacts.to) ? spec.changeFacts.to : null,
        mentioned: Array.isArray(spec.changeFacts.mentioned) ? spec.changeFacts.mentioned.slice(0, 6) : [],
      })
    : '';
  const taskIdentity = normalized(
    spec.taskPhrase
      || spec.groupLabel
      || spec.projectLabel
      || spec.title,
  );
  const scopeIdentity = normalized([
    spec.projectKey || spec.projectLabel || 'general',
    spec.groupKey || spec.chatKey || '',
  ].join('|'));
  const signalIdentity = normalized(spec.signalType || spec.recipeId || 'recommendation');
  return `semantic-${shortHash([signalIdentity, scopeIdentity, taskIdentity, changeFacts].join('|'))}`;
}

function maxAgeForSpec(spec) {
  if (Number.isFinite(spec.maxAgeMs) && spec.maxAgeMs > 0) return Number(spec.maxAgeMs);
  return MAX_AGE_BY_RECIPE[spec.recipeId] || DEFAULT_MAX_AGE_MS;
}

function isStale(spec, decision, nowMs) {
  const timestamp = Date.parse(spec.occurredAt || decision?.updatedAt || '');
  if (!Number.isFinite(timestamp)) return false;
  if (timestamp - nowMs > 5 * 60 * 1_000) return true;
  return nowMs - timestamp > maxAgeForSpec(spec);
}

function hasValueIncrement(spec, decision) {
  if (spec.valueIncrement === false || VALUELESS_RECIPES.has(spec.recipeId)) return false;
  if (spec.signalType === 'conversation' || spec.signalType === 'raw_signal') return false;
  if (Number(spec.confidence || 0) < 0.72) return false;
  if (/暂时没有需要你|没有识别到明确由你负责/u.test(String(spec.title || ''))) return false;
  if (decision?.jobId || spec.valueIncrement || spec.triggerStrength === 'explicit') return true;
  if (['direct_request', 'task_change', 'meeting_action'].includes(spec.signalType)) return true;
  // Evidence and explanatory copy alone do not create user value. A candidate
  // must carry an explicit delta such as a deadline window, scope change,
  // verified risk, ranked open work, or an already prepared local result.
  return false;
}

export function evaluateSilenceCandidate(spec, context = {}) {
  const nowMs = context.now instanceof Date ? context.now.getTime() : Number(context.now || Date.now());
  const decision = context.decision || null;
  const semanticKey = semanticKeyForSpec(spec);
  if (!spec || typeof spec !== 'object') return { allowed: false, reason: 'invalid', semanticKey };
  if (TERMINAL_DECISION_STATES.has(decision?.status)) {
    return { allowed: false, reason: 'terminal_decision', semanticKey };
  }
  if (NON_OWNER_RESPONSIBILITIES.has(spec.responsibility)) {
    return { allowed: false, reason: 'not_owner', semanticKey };
  }
  if (spec.completed === true || spec.cancelled === true || COMPLETION_TEXT_PATTERN.test(String(spec.taskState || ''))) {
    return { allowed: false, reason: 'completed_or_cancelled', semanticKey };
  }
  if (context.completedSemanticKeys?.has(semanticKey)) {
    return { allowed: false, reason: 'already_handled', semanticKey };
  }
  if (isStale(spec, decision, nowMs)) return { allowed: false, reason: 'stale', semanticKey };
  if (!hasValueIncrement(spec, decision)) return { allowed: false, reason: 'no_value_increment', semanticKey };
  if (context.seenSemanticKeys?.has(semanticKey)) return { allowed: false, reason: 'duplicate', semanticKey };
  return { allowed: true, reason: 'valuable', semanticKey };
}

export function applySilenceGate(specs, options = {}) {
  const state = options.state || { decisions: {} };
  const opportunityIdForSpec = options.opportunityIdForSpec || (() => '');
  const completedSemanticKeys = new Set();
  for (const decision of Object.values(state.decisions || {})) {
    if (!TERMINAL_DECISION_STATES.has(decision?.status)) continue;
    const semanticKey = decision.semanticKey
      || (decision.pendingSpec ? semanticKeyForSpec(decision.pendingSpec) : '');
    if (semanticKey) completedSemanticKeys.add(semanticKey);
  }

  const allowed = [];
  const rejected = [];
  const seenSemanticKeys = new Set();
  for (const spec of specs || []) {
    const opportunityId = opportunityIdForSpec(spec);
    const decision = opportunityId ? state.decisions?.[opportunityId] : null;
    const result = evaluateSilenceCandidate(spec, {
      now: options.now,
      decision,
      completedSemanticKeys,
      seenSemanticKeys,
    });
    if (!result.allowed) {
      rejected.push({ recipeId: spec?.recipeId || '', reason: result.reason, semanticKey: result.semanticKey });
      continue;
    }
    seenSemanticKeys.add(result.semanticKey);
    allowed.push({ ...spec, semanticKey: result.semanticKey });
  }

  const reasons = rejected.reduce((counts, item) => {
    counts[item.reason] = (counts[item.reason] || 0) + 1;
    return counts;
  }, {});
  return {
    allowed,
    rejected,
    summary: {
      considered: (specs || []).length,
      surfaced: allowed.length,
      silenced: rejected.length,
      reasons,
    },
  };
}

export const silenceGateInternals = {
  hasValueIncrement,
  isStale,
  maxAgeForSpec,
};

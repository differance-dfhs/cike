import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySilenceGate,
  evaluateSilenceCandidate,
  semanticKeyForSpec,
} from './silence-gate.mjs';

const now = new Date('2026-07-21T09:00:00.000Z');

function spec(overrides = {}) {
  return {
    recipeId: 'meeting-action',
    anchor: 'meeting-action-1',
    occurredAt: '2026-07-21T08:30:00.000Z',
    title: '老大，我正在整理主动 Agent 论文。',
    reason: '会议明确由你负责这项研究。',
    taskPhrase: '观测主动 Agent 业界前沿并阅读论文',
    projectKey: 'project-proactive-agent',
    signalType: 'meeting_action',
    responsibility: 'owner',
    triggerStrength: 'explicit',
    valueIncrement: 'local_research_result',
    confidence: 0.99,
    ...overrides,
  };
}

test('silence gate keeps a fresh owned task with concrete value', () => {
  const result = evaluateSilenceCandidate(spec(), { now });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'valuable');
});

test('silence gate rejects conversation, non-owner, completed and stale signals', () => {
  assert.equal(evaluateSilenceCandidate(spec({ signalType: 'conversation' }), { now }).reason, 'no_value_increment');
  assert.equal(evaluateSilenceCandidate(spec({ responsibility: 'other' }), { now }).reason, 'not_owner');
  assert.equal(evaluateSilenceCandidate(spec({ completed: true }), { now }).reason, 'completed_or_cancelled');
  assert.equal(evaluateSilenceCandidate(spec({ occurredAt: '2026-07-01T08:30:00.000Z' }), { now }).reason, 'stale');
});

test('silence gate deduplicates equivalent tasks and does not revive completed semantics', () => {
  const first = spec();
  const duplicate = spec({ anchor: 'meeting-action-2' });
  const semanticKey = semanticKeyForSpec(first);
  const result = applySilenceGate([first, duplicate], {
    now,
    state: {
      decisions: {
        unrelated: {
          status: 'archived',
          semanticKey: 'semantic-unrelated',
        },
      },
    },
    opportunityIdForSpec: (item) => item.anchor,
  });
  assert.equal(result.allowed.length, 1);
  assert.equal(result.rejected[0].reason, 'duplicate');

  const completed = applySilenceGate([first], {
    now,
    state: {
      decisions: {
        completed: {
          status: 'archived',
          semanticKey,
          pendingSpec: first,
        },
      },
    },
    opportunityIdForSpec: (item) => item.anchor,
  });
  assert.equal(completed.allowed.length, 0);
  assert.equal(completed.rejected[0].reason, 'already_handled');
});

test('meeting digest without owned Todo never passes foreground gate', () => {
  const result = evaluateSilenceCandidate(spec({
    recipeId: 'meeting-digest',
    signalType: 'meeting_digest',
    taskPhrase: '',
    valueIncrement: false,
  }), { now });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'no_value_increment');
});

test('polished copy and evidence do not make a generic reminder valuable', () => {
  const result = evaluateSilenceCandidate(spec({
    recipeId: 'frontier-research-brief',
    signalType: 'proactive_suggestion',
    triggerStrength: undefined,
    valueIncrement: undefined,
    title: '老大，建议今天看看前沿。',
    reason: '近期工作摘要中出现了研究关键词。',
    recommendationEvidence: [{ label: '记录', detail: '出现了一次研究关键词。' }],
  }), { now });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'no_value_increment');
});

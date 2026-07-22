import assert from 'node:assert/strict';
import test from 'node:test';
import { notificationKeysForSnapshot, selectNotificationCandidate } from './notification-policy.mjs';

function snapshot(interventions, state = 'available') {
  return { now: { state }, interventions };
}

test('generic high-priority reminders stay ambient', () => {
  const candidate = selectNotificationCandidate(snapshot([{
    id: 'generic', kind: 'recommendation', state: 'active', priority: 'high', interruption: 'ambient',
  }]));
  assert.equal(candidate, null);
});

test('a newly completed Codex result is eligible once per result version', () => {
  const result = {
    id: 'research', kind: 'work_result', state: 'ready', priority: 'high', updatedAt: '2026-07-21T10:00:00.000Z',
  };
  const candidate = selectNotificationCandidate(snapshot([result]));
  assert.equal(candidate.item.id, 'research');
  const seen = new Set([candidate.key]);
  assert.equal(selectNotificationCandidate(snapshot([result]), seen), null);
  const newer = { ...result, updatedAt: '2026-07-21T10:30:00.000Z' };
  assert.equal(selectNotificationCandidate(snapshot([newer]), seen).item.updatedAt, newer.updatedAt);
});

test('startup can seed old results and focus state defers new ones', () => {
  const result = {
    id: 'research', kind: 'work_result', state: 'ready', priority: 'high', updatedAt: '2026-07-20T10:00:00.000Z',
  };
  const keys = notificationKeysForSnapshot(snapshot([result]));
  assert.equal(keys.length, 1);
  assert.equal(selectNotificationCandidate(snapshot([result]), new Set(keys)), null);
  assert.equal(selectNotificationCandidate(snapshot([result], 'focus')), null);
});

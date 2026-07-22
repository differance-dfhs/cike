import assert from 'node:assert/strict';
import test from 'node:test';
import { fallbackSnapshot } from './data/fallback.ts';

test('fresh renderer fallback contains no inherited navigation, task, or result content', () => {
  assert.equal(fallbackSnapshot.setup.state, 'needs_setup');
  assert.deepEqual(fallbackSnapshot.projects, []);
  assert.deepEqual(fallbackSnapshot.plan.items, []);
  assert.deepEqual(fallbackSnapshot.opportunities, []);
  assert.deepEqual(fallbackSnapshot.prepared.items, []);
  assert.deepEqual(fallbackSnapshot.prepared.deliverables, []);
});

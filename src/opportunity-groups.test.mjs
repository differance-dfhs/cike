import assert from 'node:assert/strict';
import test from 'node:test';
import { groupOpportunities } from './opportunity-groups.ts';

function opportunity(id, overrides = {}) {
  return {
    id,
    title: `task ${id}`,
    reason: `reason ${id}`,
    priority: 'medium',
    confidence: 90,
    due: '今天',
    status: 'active',
    steps: [],
    origin: '本地',
    ...overrides,
  };
}

test('groups only opportunities that share an explicit group key', () => {
  const groups = groupOpportunities([
    opportunity('a', { groupKey: 'release', groupLabel: '发布任务' }),
    opportunity('b', { groupKey: 'release', groupLabel: '发布任务', status: 'preparing' }),
    opportunity('c', { groupKey: 'research', groupLabel: '研究任务' }),
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].items.map((item) => item.id), ['a', 'b']);
  assert.equal(groups[0].label, '发布任务');
  assert.equal(groups[0].status.tone, 'running');
});

test('keeps ungrouped opportunities separate to avoid false aggregation', () => {
  const groups = groupOpportunities([opportunity('a'), opportunity('b')]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.key), ['item:a', 'item:b']);
  assert.deepEqual(groups.map((group) => group.label), ['task a', 'task b']);
});

test('uses the first engine-ranked item as the latest summary and surfaces ready state', () => {
  const groups = groupOpportunities([
    opportunity('latest', { groupKey: 'one', groupLabel: '任务组', reason: '最新结论' }),
    opportunity('ready', { groupKey: 'one', groupLabel: '任务组', status: 'ready' }),
  ]);

  assert.equal(groups[0].latest.id, 'latest');
  assert.equal(groups[0].latest.reason, '最新结论');
  assert.deepEqual(groups[0].status, { label: '产物已就绪', tone: 'ready' });
});

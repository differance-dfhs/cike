import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UserLearningStore } from './user-learning.mjs';

test('deferred profile loading waits for the first refresh and caches that baseline', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-learning-lazy-'));
  const profileDir = path.join(root, 'Documents', 'Codex');
  const profilePath = path.join(profileDir, 'ditto_you.md');
  try {
    await mkdir(profileDir, { recursive: true });
    await writeFile(profilePath, '- Baseline before init.');
    const store = await new UserLearningStore(path.join(root, 'data'), {
      homeDir: root,
      deferProfileLoad: true,
    }).init();

    assert.equal(store.getContext().publicSummary.baselineLoaded, false);
    assert.equal(store.getContext().baselineExcerpt, '');

    await writeFile(profilePath, '- Baseline loaded by first refresh.');
    await store.refreshProfile();
    assert.equal(store.getContext().publicSummary.baselineLoaded, true);
    assert.match(store.getContext().baselineExcerpt, /loaded by first refresh/u);

    await writeFile(profilePath, '- Later disk change must not reload implicitly.');
    await store.refreshProfile();
    assert.match(store.getContext().baselineExcerpt, /loaded by first refresh/u);
    assert.doesNotMatch(store.getContext().baselineExcerpt, /Later disk change/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('records semantic actions and explicit feedback into a local profile overlay', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-learning-'));
  const profileDir = path.join(root, 'Documents', 'Codex');
  await mkdir(profileDir, { recursive: true });
  await writeFile(path.join(profileDir, 'ditto_you.md'), [
    '# Ditto Profile',
    '## Their Laws',
    '1. **Use current evidence.** (19/19)',
    '## Their Taste',
    '- Prefer concise Chinese recommendations.',
  ].join('\n'));
  let clock = new Date('2026-07-16T09:00:00.000Z');
  const store = await new UserLearningStore(path.join(root, 'data'), {
    homeDir: root,
    now: () => new Date(clock),
  }).init();

  await store.record({
    kind: 'artifact_opened',
    opportunityId: 'opp-safe',
    projectLabel: '录音',
    recipeId: 'meeting-minute-todo',
    title: '更新录音方案',
  });
  await store.record({
    kind: 'suggestion_expanded',
    opportunityId: 'opp-safe',
    projectLabel: '录音',
    recipeId: 'meeting-minute-todo',
    title: '更新录音方案',
  });
  clock = new Date(clock.getTime() + 1_000);
  await store.record({
    kind: 'feedback',
    opportunityId: 'opp-safe',
    projectLabel: '录音',
    recipeId: 'meeting-minute-todo',
    title: '更新录音方案',
    rating: 'good',
    note: '这个建议时机很准，继续提前准备。 token=should-hide',
  });

  const context = store.getContext();
  assert.equal(context.publicSummary.baselineLoaded, true);
  assert.equal(context.publicSummary.totalActions, 3);
  assert.deepEqual(context.publicSummary.ratings, { good: 1, bad: 0 });
  assert.match(context.baselineExcerpt, /Use current evidence/u);
  assert.match(context.source.detail, /ditto_you\.md/u);
  assert.deepEqual(store.feedbackForOpportunity('opp-safe'), {
    rating: 'good',
    note: '这个建议时机很准，继续提前准备。 token=[凭证已隐藏]',
    recordedAt: '2026-07-16T09:00:01.000Z',
  });
  assert.deepEqual(store.consumedInteractions(), [{
    opportunityId: 'opp-safe',
    kind: 'artifact_opened',
    at: '2026-07-16T09:00:00.000Z',
  }]);
  const jsonl = await readFile(path.join(root, 'data', 'interaction-events.jsonl'), 'utf8');
  const overlay = await readFile(path.join(root, 'data', 'user-profile-feedback.md'), 'utf8');
  assert.equal(jsonl.trim().split('\n').length, 3);
  assert.match(overlay, /语义动作：3/u);
  assert.match(overlay, /好 1 \/ 差 0/u);
  assert.equal(jsonl.includes('should-hide'), false);

  const restarted = await new UserLearningStore(path.join(root, 'data'), {
    homeDir: root,
    now: () => new Date(clock),
  }).init();
  assert.deepEqual(restarted.consumedInteractions(), store.consumedInteractions());
});

test('requires repeated explicit feedback before changing recommendation direction', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-learning-threshold-'));
  const store = await new UserLearningStore(path.join(root, 'data'), { homeDir: root }).init();
  const spec = { projectLabel: '主动 agent', recipeId: 'work-command-brief' };
  await store.record({ kind: 'feedback', opportunityId: 'opp-1', ...spec, rating: 'bad', note: '太泛了' });
  assert.equal(store.calibrationFor(spec).priorityDirection, 'keep');
  await store.record({ kind: 'feedback', opportunityId: 'opp-2', ...spec, rating: 'bad', note: '还是太泛' });
  assert.equal(store.calibrationFor(spec).priorityDirection, 'down');
  assert.equal(store.calibrationFor(spec).suppressAuto, false);
  await store.record({ kind: 'feedback', opportunityId: 'opp-3', ...spec, rating: 'bad', note: '不要再自动跑' });
  assert.equal(store.calibrationFor(spec).suppressAuto, true);
  assert.match((await readFile(path.join(root, 'data', 'user-profile-feedback.md'), 'utf8')), /收紧「主动 agent」/u);
});

test('expired and unimportant clicks are persisted and repeatedly suppress similar suggestions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-learning-semantic-feedback-'));
  try {
    const store = await new UserLearningStore(path.join(root, 'data'), { homeDir: root }).init();
    const spec = { projectLabel: '周报规划', recipeId: 'weekly-plan-review' };

    await store.record({ kind: 'opportunity_action', opportunityId: 'opp-old-1', ...spec, action: 'expired' });
    await store.record({ kind: 'feedback', opportunityId: 'opp-old-1', ...spec, rating: 'bad', note: '这条已经过期' });
    const first = store.calibrationFor(spec);
    assert.equal(first.stats.expired, 1);
    assert.ok(first.confidenceDelta < 0);
    assert.equal(first.suppressAuto, false);
    assert.equal(first.suppressSuggestion, false);

    await store.record({ kind: 'opportunity_action', opportunityId: 'opp-old-2', ...spec, action: 'unimportant' });
    await store.record({ kind: 'feedback', opportunityId: 'opp-old-2', ...spec, rating: 'bad', note: '同类内容不重要' });
    const repeated = store.calibrationFor(spec);
    assert.equal(repeated.stats.unimportant, 1);
    assert.equal(repeated.priorityDirection, 'down');
    assert.equal(repeated.suppressAuto, true);
    assert.equal(repeated.suppressSuggestion, true);
    assert.ok(repeated.confidenceDelta <= first.confidenceDelta);

    const events = (await readFile(path.join(root, 'data', 'interaction-events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.filter((event) => event.kind === 'opportunity_action').map((event) => event.action), [
      'expired',
      'unimportant',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

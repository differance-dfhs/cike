import assert from 'node:assert/strict';
import test from 'node:test';
import { codexRuntimeInternals } from './codex-runtime.mjs';

const {
  parseProcessResources,
  parseSession,
} = codexRuntimeInternals;

test('Codex runtime aggregates only Codex process resources', () => {
  const result = parseProcessResources([
    '100 12.4 204800 /Applications/Codex.app/Contents/MacOS/Codex',
    '101 3.1 102400 codex-cli app-server',
    '102 91.0 999999 /Applications/Safari.app/Contents/MacOS/Safari',
    '103 4.0 2048 cike-proactive-agent codex',
  ].join('\n'));

  assert.deepEqual(result, {
    cpuPercent: 15.5,
    memoryBytes: 307200 * 1024,
    processCount: 2,
  });
});

test('Codex runtime parses running state, token usage and remaining quota', () => {
  const session = parseSession({
    filePath: '/tmp/018f0000-0000-7000-8000-000000000001.jsonl',
    info: { mtimeMs: Date.parse('2026-07-20T10:00:00.000Z') },
    indexTitle: 'Fallback session title',
    head: `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id: '018f0000-0000-7000-8000-000000000001',
        cwd: '/Users/demo/Project Aurora',
      },
    })}\n`,
    tail: [
      {
        timestamp: '2026-07-20T10:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Review the current evaluation plan' },
      },
      {
        timestamp: '2026-07-20T10:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', started_at: 1_753_005_602 },
      },
      {
        timestamp: '2026-07-20T10:00:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 100_000,
            last_token_usage: {
              input_tokens: 16_000,
              cached_input_tokens: 4_000,
              output_tokens: 3_000,
              reasoning_output_tokens: 2_000,
              total_tokens: 25_000,
            },
            total_token_usage: { total_tokens: 76_000 },
          },
          rate_limits: {
            primary: {
              used_percent: 26.4,
              window_minutes: 300,
              resets_at: 1_753_010_000,
            },
            plan_type: 'pro',
            credits: { has_credits: true, unlimited: false, balance: '12.5' },
          },
        },
      },
    ].map((event) => JSON.stringify(event)).join('\n'),
  });

  assert.equal(session.state, 'running');
  assert.equal(session.title, 'Review the current evaluation plan');
  assert.equal(session.project, 'Project Aurora');
  assert.equal(session.usage.turnTokens, 25_000);
  assert.equal(session.usage.contextPercent, 25);
  assert.equal(session.quota.available, true);
  assert.equal(session.quota.remainingPercent, 74);
  assert.equal(session.quota.planType, 'pro');
});

test('Codex runtime marks quota unavailable when the event has no rate limit', () => {
  const session = parseSession({
    filePath: '/tmp/018f0000-0000-7000-8000-000000000002.jsonl',
    info: { mtimeMs: Date.parse('2026-07-20T10:00:00.000Z') },
    indexTitle: 'A local task',
    head: '',
    tail: JSON.stringify({
      timestamp: '2026-07-20T10:00:05.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model_context_window: 120_000,
          last_token_usage: { total_tokens: 10_000 },
          total_token_usage: { total_tokens: 10_000 },
        },
      },
    }),
  });

  assert.equal(session.quota.available, false);
  assert.equal(session.quota.usedPercent, null);
  assert.equal(session.quota.remainingPercent, null);
});

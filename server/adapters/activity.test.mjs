import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ActivityAdapter, activityInternals } from './activity.mjs';

const NOW = new Date('2026-07-15T10:00:00.000Z');

async function temporaryHome(prefix = 'proactive-activity-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test('Codex activity preserves authorized title context while omitting internal thread ids', async () => {
  const homeDir = await temporaryHome();
  try {
    await mkdir(path.join(homeDir, '.codex'), { recursive: true });
    await writeFile(
      path.join(homeDir, '.codex', 'session_index.jsonl'),
      [
        JSON.stringify({
          id: 'thread_raw_sensitive_id',
          thread_name: `Review ${homeDir}/client-secret.md for alice@example.com or 13800138000 at https://secret.example/private?q=token`,
          updated_at: '2026-07-15T09:30:00.000Z',
        }),
        JSON.stringify({
          id: 'thread_old_id',
          thread_name: 'Old task should not become a signal',
          updated_at: '2026-07-13T09:30:00.000Z',
        }),
        '{malformed tail',
      ].join('\n'),
    );

    const result = await new ActivityAdapter({
      homeDir,
      now: () => NOW,
      browserHistoryPaths: [],
      projectRoots: [],
    }).collect();

    const source = result.sources.find((item) => item.id === 'codex-activity');
    const signal = result.signals.find((item) => item.type === 'codex-thread');
    assert.equal(source.state, 'available');
    assert.equal(source.lastSeen, '2026-07-15T09:30:00.000Z');
    assert.ok(signal);
    assert.match(signal.id, /^activity-codex-[a-f0-9]{18}$/u);
    assert.match(signal.title, /client-secret/u);
    assert.match(signal.title, new RegExp(homeDir.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    const serialized = JSON.stringify(result);
    for (const internalOnly of [
      'thread_raw_sensitive_id',
      'thread_old_id',
    ]) {
      assert.equal(serialized.includes(internalOnly), false, internalOnly);
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('browser activity copies History and preserves full authorized title and URL context', async () => {
  const homeDir = await temporaryHome();
  const historyPath = path.join(homeDir, 'History');
  await writeFile(historyPath, 'locked database placeholder');
  let querySawCopiedDatabase = false;
  try {
    const result = await new ActivityAdapter({
      homeDir,
      now: () => NOW,
      browserHistoryPaths: [{ name: 'Chrome', path: historyPath }],
      projectRoots: [],
      execQuery: async ({ databasePath, sinceChromeMicros, limit, timeoutMs }) => {
        querySawCopiedDatabase = databasePath !== historyPath && path.basename(databasePath).endsWith('.sqlite');
        assert.match(sinceChromeMicros, /^\d+$/u);
        assert.equal(limit, 8);
        assert.equal(timeoutMs, 3_000);
        return [
          {
            title: `Customer note alice@example.com ${homeDir}/private.txt`,
            url: 'https://www.example.com/private/customer?id=42&token=very-secret#section',
            last_visit_time: activityInternals.chromeMicrosFromUnixMs(new Date('2026-07-15T09:45:00.000Z').getTime()),
          },
        ];
      },
    }).collect();

    assert.equal(querySawCopiedDatabase, true);
    const source = result.sources.find((item) => item.id === 'browser-activity');
    const signal = result.signals.find((item) => item.type === 'browser-activity');
    assert.equal(source.state, 'available');
    assert.equal(signal.domain, 'example.com');
    assert.equal(signal.occurredAt, '2026-07-15T09:45:00.000Z');
    assert.match(signal.title, /alice@example\.com/u);
    assert.match(signal.detail, /https:\/\/www\.example\.com\/private\/customer\?id=42/u);
    assert.match(signal.detail, /token=\[凭证已隐藏\]/u);
    assert.equal(signal.detail.includes('very-secret'), false);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(historyPath), false);
    assert.equal(serialized.includes('very-secret'), false);
    assert.equal(serialized.includes('alice@example.com'), true);
    assert.equal(serialized.includes('/private/customer'), true);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('unavailable local sources degrade honestly without inventing GPT history', async () => {
  const homeDir = await temporaryHome();
  try {
    const result = await new ActivityAdapter({
      homeDir,
      now: () => NOW,
      browserHistoryPaths: [path.join(homeDir, 'missing-history')],
      projectRoots: [],
    }).collect();

    assert.equal(result.signals.length, 0);
    assert.deepEqual(
      result.sources.map(({ id, state, lastSeen }) => ({ id, state, lastSeen })),
      [
        { id: 'codex-activity', state: 'unavailable', lastSeen: null },
        { id: 'codex-loops', state: 'unavailable', lastSeen: null },
        { id: 'browser-activity', state: 'unavailable', lastSeen: null },
        { id: 'gpt-activity', state: 'unavailable', lastSeen: null },
        { id: 'local-changes', state: 'unavailable', lastSeen: null },
      ],
    );
    assert.match(
      result.sources.find((source) => source.id === 'gpt-activity').detail,
      /未发现可靠的本地结构化历史/u,
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('Codex loops include recent run memory but not the automation prompt', async () => {
  const homeDir = await temporaryHome();
  const loopDir = path.join(homeDir, '.codex', 'automations', 'daily-ai');
  try {
    await mkdir(loopDir, { recursive: true });
    await writeFile(
      path.join(loopDir, 'automation.toml'),
      [
        'version = 1',
        'id = "daily-ai"',
        'kind = "cron"',
        'name = "每日 AI 学习 Loop"',
        `prompt = "secret ${homeDir}/private.md status = \\\"PAUSED\\\""`,
        'status = "ACTIVE"',
        'rrule = "RRULE:FREQ=WEEKLY;BYHOUR=11;BYMINUTE=0;BYDAY=MO,TU,WE,TH,FR"',
        `target = { type = "project", project_id = "${homeDir}/论文" }`,
      ].join('\n'),
    );
    await writeFile(path.join(loopDir, 'memory.md'), '# private run memory\nsecret result');

    const result = await new ActivityAdapter({
      homeDir,
      now: () => NOW,
      browserHistoryPaths: [],
      projectRoots: [],
    }).collect();

    const source = result.sources.find((item) => item.id === 'codex-loops');
    assert.equal(source.state, 'available');
    assert.equal(result.loops.length, 1);
    assert.deepEqual(
      Object.keys(result.loops[0]).sort(),
      ['id', 'kind', 'memoryExcerpt', 'memoryUpdatedAt', 'name', 'projectLabel', 'recordState', 'scheduleLabel', 'status'].sort(),
    );
    assert.equal(result.loops[0].name, '每日 AI 学习 Loop');
    assert.equal(result.loops[0].scheduleLabel, '工作日 11:00');
    assert.equal(result.loops[0].projectLabel, '论文与前沿');
    assert.equal(result.loops[0].recordState, 'recorded');
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('secret result'), true);
    assert.equal(serialized.includes('private.md'), false);
    assert.equal(serialized.includes(homeDir), false);
    assert.equal(serialized.includes('daily-ai\"'), false);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('activity project roots are resolved only by the first collect and then cached', async () => {
  const homeDir = await temporaryHome();
  const projectPath = path.join(homeDir, 'lazy-project');
  let resolverCalls = 0;
  const gitRoots = [];
  try {
    const adapter = new ActivityAdapter({
      homeDir,
      now: () => NOW,
      browserHistoryPaths: [],
      projectRootsResolver: async () => {
        resolverCalls += 1;
        return [{ path: projectPath, label: '录音' }];
      },
      execCommand: async (_file, args) => {
        gitRoots.push(args[1]);
        return { stdout: '', stderr: '' };
      },
    });

    assert.equal(resolverCalls, 0);
    await adapter.collect();
    assert.equal(resolverCalls, 1);
    assert.deepEqual(gitRoots, [projectPath]);

    await adapter.collect();
    assert.equal(resolverCalls, 1);
    assert.deepEqual(gitRoots, [projectPath, projectPath]);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('Git activity checks only injected roots and preserves changed paths for planning', async () => {
  const homeDir = await temporaryHome();
  const projectPath = path.join(homeDir, 'private-project-folder');
  const calls = [];
  try {
    const result = await new ActivityAdapter({
      homeDir,
      now: () => NOW,
      browserHistoryPaths: [],
      projectRoots: [{ path: projectPath, label: '客户支持' }],
      execCommand: async (file, args, options) => {
        calls.push({ file, args, options });
        return { stdout: ' M secret/customer-list.csv\n?? credentials/token.txt\n', stderr: '' };
      },
    }).collect();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'git');
    assert.deepEqual(calls[0].args, [
      '-C',
      projectPath,
      'status',
      '--porcelain=v1',
      '--untracked-files=normal',
    ]);
    assert.equal(calls[0].options.timeout, 2_500);
    const source = result.sources.find((item) => item.id === 'local-changes');
    const signal = result.signals.find((item) => item.type === 'local-changes');
    assert.equal(source.state, 'available');
    assert.equal(signal.projectLabel, '客户支持');
    assert.equal(signal.title, '客户支持 有 2 项本地改动');
    assert.equal(signal.occurredAt, NOW.toISOString());
    assert.match(signal.id, /^activity-local-[a-f0-9]{18}$/u);
    const serialized = JSON.stringify(result);
    for (const authorizedContext of [projectPath, 'private-project-folder', 'secret/customer-list.csv', 'credentials/token.txt']) {
      assert.equal(serialized.includes(authorizedContext), true, authorizedContext);
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('GPT source reports Chronicle proxy coverage without claiming local conversation access', async () => {
  const homeDir = await temporaryHome();
  try {
    const result = await new ActivityAdapter({
      homeDir,
      now: () => NOW,
      browserHistoryPaths: [],
      projectRoots: [],
      chronicleProxy: true,
      chronicleLastSeen: '2026-07-15T09:58:00.000Z',
    }).collect();
    const source = result.sources.find((item) => item.id === 'gpt-activity');
    assert.deepEqual(source, {
      id: 'gpt-activity',
      name: 'GPT / ChatGPT',
      state: 'available',
      detail: '仅由 Chronicle 屏幕记忆代理覆盖；未读取本地对话正文。',
      lastSeen: '2026-07-15T09:58:00.000Z',
    });
    assert.equal(result.signals.some((item) => /gpt|chatgpt/iu.test(item.type)), false);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('browser copy or query failure returns a generic error without leaking local paths', async () => {
  const homeDir = await temporaryHome();
  const historyPath = path.join(homeDir, 'History');
  await writeFile(historyPath, 'placeholder');
  try {
    const result = await new ActivityAdapter({
      homeDir,
      now: () => NOW,
      browserHistoryPaths: [{ name: 'Chrome', path: historyPath }],
      projectRoots: [],
      execQuery: async () => {
        throw new Error(`database locked: ${historyPath}`);
      },
    }).collect();
    const source = result.sources.find((item) => item.id === 'browser-activity');
    assert.equal(source.state, 'error');
    assert.equal(JSON.stringify(result).includes(historyPath), false);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

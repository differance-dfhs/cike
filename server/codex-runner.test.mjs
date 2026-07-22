import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CodexRunner, codexRunnerInternals } from './codex-runner.mjs';
import { DeliveryCoordinator } from './delivery-coordinator.mjs';
import { DeliveryRegistry } from './delivery-registry.mjs';

function createSuccessfulSpawn({ calls, finalText = '任务完成', onRun } = {}) {
  return (_binary, args, options) => {
    const call = { args, options, input: '' };
    calls?.push(call);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };
    child.stdin = {
      end: (input) => {
        call.input = String(input || '');
        queueMicrotask(() => {
          Promise.resolve(onRun?.({ args, options, input: call.input }))
            .then(() => {
              child.stdout.write(`${JSON.stringify({
                type: 'item.completed',
                item: { type: 'agent_message', text: finalText },
              })}\n`);
              child.stdout.write(`${JSON.stringify({
                type: 'turn.completed',
                usage: { input_tokens: 12, output_tokens: 6 },
              })}\n`);
              child.emit('close', 0, null);
            })
            .catch((error) => child.emit('error', error));
        });
      },
    };
    return child;
  };
}

test('Codex JSONL parser extracts only the final agent message and usage', () => {
  const output = [
    JSON.stringify({ type: 'thread.started', thread_id: 'hidden' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final result' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 12, reasoning_output_tokens: 2 } }),
  ].join('\n');
  const parsed = codexRunnerInternals.parseCodexJsonl(output);

  assert.equal(parsed.finalText, 'final result');
  assert.deepEqual(parsed.usage, { inputTokens: 100, cachedInputTokens: 40, outputTokens: 12, reasoningOutputTokens: 2 });
});

test('model UI presentation is strictly parsed, allowlisted, deduplicated, and compact', () => {
  const finalText = `分析正文
<PROACTIVE_UI_PRESENTATION>
${JSON.stringify({
    headline: '老大，题库初筛已经做完',
    summary: '韩森在代接评测群提出题库优化，Codex 已完成问题分层。',
    actions: [
      { intent: 'view_artifact', label: '看题库分层' },
      { intent: 'send_message', label: '发送给韩森' },
      { intent: 'continue_codex', label: '继续筛低价值题' },
      { intent: 'continue_codex', label: '继续筛低价值题' },
      { intent: 'ask', label: '追问边界原因' },
      { intent: 'ask', label: '追问替换标准' },
      { intent: 'complete', label: '收下这版结论' },
      { intent: 'snooze', label: '稍后继续' },
      { intent: 'dismiss', label: '不再关注' },
    ],
    receipt: {
      timeline: [
        { label: '定位题库结构', state: 'done' },
        { label: '核对评测标准', state: 'done' },
        { label: '/Users/example/private', state: 'done' },
        { label: '识别低价值模式', state: 'done' },
        { label: '补齐筛选标签', state: 'done' },
        { label: '整理待核验项', state: 'done' },
        { label: '生成本地结论', state: 'done' },
      ],
      result: {
        title: '题库初筛完成',
        summary: '结论已按问题类型和优先级整理。',
        deliverableLabel: '题库筛选结论',
        metrics: [
          { label: '问题类型', value: '5 类' },
          { label: '私密路径', value: '/Users/example/private' },
        ],
        sections: [
          { kind: 'conclusion', title: '核心判断', items: ['应先在副本中完成初筛。'] },
          { kind: 'evidence', title: '判断依据', items: ['已识别 5 类问题。', '/Users/example/private'] },
          { kind: 'next', title: '建议动作', items: ['继续核验边界题。'] },
          { kind: 'thought', title: '思考过程', items: ['不应进入界面。'] },
        ],
      },
    },
  })}
</PROACTIVE_UI_PRESENTATION>`;
  const job = { kind: 'analysis', state: 'ready', prompt: '请只读分析 客户支持题库，原件保持不动。' };
  const presentation = codexRunnerInternals.parsePresentation(finalText, job);
  const receipt = codexRunnerInternals.parseReceipt(finalText, job, presentation);

  assert.equal(presentation.headline, '老大，题库初筛已经做完');
  assert.deepEqual(presentation.actions, [
    { intent: 'view_artifact', label: '看题库分层' },
    { intent: 'continue_codex', label: '继续筛低价值题' },
    { intent: 'ask', label: '追问边界原因' },
    { intent: 'ask', label: '追问替换标准' },
    { intent: 'complete', label: '收下这版结论' },
    { intent: 'snooze', label: '稍后继续' },
    { intent: 'dismiss', label: '不再关注' },
  ]);
  assert.equal(receipt.timeline.length, 6);
  assert.equal(JSON.stringify(receipt).includes('/Users/example'), true);
  assert.deepEqual(receipt.result.metrics, [
    { label: '问题类型', value: '5 类' },
    { label: '私密路径', value: '/Users/example/pr…' },
  ]);
  assert.deepEqual(receipt.result.sections, [
    { kind: 'conclusion', title: '核心判断', items: ['应先在副本中完成初筛。'] },
    { kind: 'evidence', title: '判断依据', items: ['已识别 5 类问题。', '/Users/example/private'] },
    { kind: 'next', title: '建议动作', items: ['继续核验边界题。'] },
  ]);
  assert.equal(codexRunnerInternals.stripPresentation(finalText), '分析正文');
});

test('document candidates accept only bounded workspace-relative document paths', () => {
  const finalText = `完成了 \`reports/评测方案.md\` 和 \`result.html\`。
<PROACTIVE_UI_PRESENTATION>${JSON.stringify({
    receipt: {
      result: {
        documents: [
          { path: 'reports/评测方案.md' },
          { path: '../outside.pdf' },
          { path: '/Users/example/private.docx' },
          { path: 'scripts/run.sh' },
          { path: 'result.html' },
          { path: 'tables/结果.xlsx' },
        ],
      },
    },
  })}</PROACTIVE_UI_PRESENTATION>`;

  assert.deepEqual(codexRunnerInternals.extractDocumentCandidates(finalText), [
    { relativePath: 'reports/评测方案.md', label: '评测方案.md', kind: 'MD' },
    { relativePath: 'tables/结果.xlsx', label: '结果.xlsx', kind: 'XLSX' },
  ]);
});

test('malformed or copied model UI falls back by job kind and completed state', () => {
  const copied = '我晚上打个标，看看这批题有哪些问题，然后交给同事继续优化这批题';
  const finalText = `<PROACTIVE_UI_PRESENTATION>${JSON.stringify({
    headline: '题库处理好了',
    summary: copied,
    actions: [
      { intent: 'view_artifact', label: '看结果' },
      { intent: 'complete', label: '收下' },
    ],
  })}</PROACTIVE_UI_PRESENTATION>`;
  const analysis = codexRunnerInternals.parsePresentation(finalText, {
    kind: 'analysis', state: 'ready', prompt: `用户本人承诺：${copied}`,
  });
  const research = codexRunnerInternals.parsePresentation('not-json', { kind: 'research', state: 'ready' });
  const workCommand = codexRunnerInternals.parsePresentation('not-json', {
    kind: 'analysis', state: 'ready', title: '老大，我正在梳理你现在最该推进的事。',
  });

  assert.equal(analysis.headline, '老大，分析已经整理好');
  assert.equal(analysis.actions[0].label, '看判断依据');
  assert.equal(research.headline, '老大，研究已经整理好');
  assert.equal(research.actions[0].label, '看研究脉络');
  assert.equal(workCommand.headline, '老大，工作排序已经整理好');
  assert.equal(workCommand.summary, '优先级、Codex 可先做事项和需要你拍板的节点已经排好。');
  assert.deepEqual(workCommand.actions.map((item) => item.label), ['看今日排序', '让 Codex 先做', '这版可用']);

  const migrated = codexRunnerInternals.publicJob({
    id: 'job-work-command-migration',
    title: '老大，我正在梳理你现在最该推进的事。',
    kind: 'analysis',
    state: 'ready',
    createdAt: '2026-07-16T06:15:00.000Z',
    updatedAt: '2026-07-16T06:16:00.000Z',
    presentation: analysis,
    receipt: { timeline: [{ label: '完成分析', state: 'done' }], result: { title: '分析已经整理好' } },
  });
  assert.equal(migrated.presentation.headline, '老大，工作排序已经整理好');
  assert.equal(migrated.receipt.result.deliverableLabel, '工作排序成果');
});

test('presentation preserves authorized account mentions but rejects credentials', () => {
  const base = {
    summary: '周宁在评测群提出了题库核对任务，Codex 已完成初筛。',
    actions: [
      { intent: 'view_artifact', label: '看初筛结论' },
      { intent: 'complete', label: '收下这版' },
    ],
  };
  assert.equal(codexRunnerInternals.sanitizePresentation({
    ...base,
    headline: '老大，周宁在「评测群」@你核对题库',
  })?.headline, '老大，周宁在「评测群」@你核对题库');
  assert.equal(codexRunnerInternals.sanitizePresentation({
    ...base,
    headline: '老大，周宁在群里 @zhangsan 核对题库',
  })?.headline, '老大，周宁在群里 @zhangsan 核对题库');
  assert.equal(codexRunnerInternals.sanitizePresentation({
    ...base,
    summary: 'access_token=top-secret',
    headline: '老大，题库需要核对',
  }), null);
});

test('queued, running, and ready fallback receipts reflect true host state', () => {
  const queued = codexRunnerInternals.fallbackReceipt({ kind: 'brief', state: 'queued' });
  const running = codexRunnerInternals.fallbackReceipt({ kind: 'brief', state: 'running' });
  const ready = codexRunnerInternals.parseReceipt('manifest omitted', { kind: 'brief', state: 'ready' });

  assert.equal(queued.timeline.at(-1).state, 'pending');
  assert.equal(running.timeline.at(-2).state, 'running');
  assert.equal(ready.timeline.every((step) => step.state === 'done'), true);
  assert.equal(ready.result.title, '简报已经整理好');
});

test('Codex discovery checks the ChatGPT bundled binary before user fallbacks', () => {
  assert.deepEqual(codexRunnerInternals.knownCodexBinaryCandidates('/Users/example'), [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Users/example/.local/bin/codex',
    '/Users/example/.codex/bin/codex',
  ]);
});

test('public job contract never exposes a private workspace path', () => {
  const job = codexRunnerInternals.publicJob({
    id: 'job-1',
    title: '任务',
    kind: 'analysis',
    state: 'ready',
    createdAt: '2026-07-15T08:30:00.000Z',
    updatedAt: '2026-07-15T08:31:00.000Z',
    artifactName: 'result.html',
    executionMode: 'workspace-change',
    auto: true,
    prompt: 'private normalized task',
    workspacePath: '/Users/example/private-project',
    documents: [{
      id: 'doc-1234567890abcdef1234',
      label: '评测方案.md',
      kind: 'MD',
      absolutePath: '/Users/example/private-project/评测方案.md',
    }],
  });
  assert.equal(JSON.stringify(job).includes('/Users/example'), false);
  assert.equal(JSON.stringify(job).includes('private normalized task'), false);
  assert.equal('workspacePath' in job, false);
  assert.equal('prompt' in job, false);
  assert.equal(job.executionMode, 'workspace-change');
  assert.equal(job.auto, true);
  assert.equal(job.autonomyLabel, 'Codex 自动修改本地工作区');
  assert.equal(job.presentation.headline, '老大，分析已经整理好');
  assert.equal(job.receipt.timeline.length, 3);
  assert.deepEqual(job.receipt.result.documents, [{
    id: 'doc-1234567890abcdef1234', label: '评测方案.md', kind: 'MD',
  }]);
});

test('execution plan makes third-party workspace context strictly read-only', () => {
  const plan = codexRunnerInternals.buildExecutionPlan(
    {
      executionMode: 'untrusted-readonly',
      workspacePath: '/allowed/project',
      artifactName: 'result.html',
      prompt: '请整理项目结论',
    },
    '/private/data',
  );
  assert.equal(plan.cwd, '/allowed/project');
  assert.deepEqual(plan.args.slice(0, 5), ['exec', '--sandbox', 'read-only', '--cd', '/allowed/project']);
  assert.match(plan.guardedPrompt, /第三方飞书消息/u);
  assert.match(plan.guardedPrompt, /不得修改、创建、删除或重命名/u);
  assert.match(plan.guardedPrompt, /最终回复安全包装/u);
  assert.match(plan.guardedPrompt, /<PROACTIVE_UI_PRESENTATION>/u);
  assert.ok(plan.guardedPrompt.lastIndexOf('<PROACTIVE_UI_PRESENTATION>') > plan.guardedPrompt.indexOf('请整理项目结论'));
  assert.match(plan.guardedPrompt, /headline 必须以“老大，”开头/u);
  assert.equal(plan.guardedPrompt.includes('artifacts/result.html'), false);
});

test('meeting digest execution plan requires native meeting sections instead of generic judgment sections', () => {
  const plan = codexRunnerInternals.buildExecutionPlan(
    {
      title: '读取会后妙记',
      recipeId: 'meeting-digest',
      kind: 'brief',
      prompt: '已读取的会议正文。',
      executionMode: 'untrusted-readonly',
      artifactName: 'meeting-digest.html',
    },
    '/tmp/cike-data',
  );
  assert.match(plan.guardedPrompt, /title 必须是“会议摘要”/u);
  assert.match(plan.guardedPrompt, /title 必须是“关键决策”/u);
  assert.match(plan.guardedPrompt, /title 必须是“你的 Todo”/u);
  assert.match(plan.guardedPrompt, /不要使用“核心判断”“判断依据”“建议动作”/u);
});

test('meeting action execution plan requires finished deliverable sections instead of another summary', () => {
  const plan = codexRunnerInternals.buildExecutionPlan(
    {
      title: '完成会后识别出的评测方案',
      recipeId: 'meeting-action',
      kind: 'analysis',
      prompt: '根据会议正文直接完成 AI 电话代打评测方案。',
      executionMode: 'untrusted-readonly',
      artifactName: 'meeting-action.html',
    },
    '/tmp/cike-data',
  );
  assert.match(plan.guardedPrompt, /不是会议摘要任务/u);
  assert.match(plan.guardedPrompt, /title 必须是“完成结果”/u);
  assert.match(plan.guardedPrompt, /title 必须是“会议约束”/u);
  assert.match(plan.guardedPrompt, /title 必须是“待确认项”/u);
  assert.match(plan.guardedPrompt, /不要输出“会议摘要”“你的 Todo”/u);
});

test('manual local draft plan keeps the existing data-dir workspace-write behavior', () => {
  const plan = codexRunnerInternals.buildExecutionPlan(
    { executionMode: 'local-draft', artifactName: 'result.html', prompt: '生成草稿' },
    '/private/data',
  );
  assert.equal(plan.cwd, '/private/data');
  assert.deepEqual(plan.args.slice(0, 5), ['exec', '--sandbox', 'workspace-write', '--cd', '/private/data']);
  assert.match(plan.guardedPrompt, /artifacts\/result.html/u);
});

test('workspace-change plan edits only the verified workspace and delegates artifact wrapping to the host', () => {
  const plan = codexRunnerInternals.buildExecutionPlan(
    {
      executionMode: 'workspace-change',
      workspacePath: '/allowed/project',
      artifactName: 'result.html',
      prompt: '把评测方案的技能基数更新为 36，并同步相关计算。',
    },
    '/private/data',
  );
  assert.equal(plan.cwd, '/allowed/project');
  assert.equal(plan.workspaceChangeContext, true);
  assert.equal(plan.hostWrappedArtifact, true);
  assert.deepEqual(plan.args.slice(0, 5), ['exec', '--sandbox', 'workspace-write', '--cd', '/allowed/project']);
  assert.match(plan.guardedPrompt, /宿主从可信上下文中归一化出的任务语义/u);
  assert.match(plan.guardedPrompt, /只允许在当前工作区内修改文件/u);
  assert.match(plan.guardedPrompt, /保护已有的无关改动/u);
  assert.match(plan.guardedPrompt, /不得发送或回复消息/u);
  assert.match(plan.guardedPrompt, /不得上传、发布、删除业务数据、安装依赖/u);
  assert.match(plan.guardedPrompt, /项目内已有的测试、lint、typecheck、build/u);
  assert.match(plan.guardedPrompt, /宿主会把它安全包装到 \.data/u);
  assert.match(plan.guardedPrompt, /实际修改的文件与摘要、验证动作及结果/u);
  assert.equal(plan.guardedPrompt.includes('artifacts/result.html'), false);
});

test('workspace-change plan fails closed when no verified workspace is present', () => {
  assert.throws(
    () => codexRunnerInternals.buildExecutionPlan(
      { executionMode: 'workspace-change', artifactName: 'result.html', prompt: '修改本地方案' },
      '/private/data',
    ),
    (error) => error?.code === 'WORKSPACE_REQUIRED',
  );
});

test('restored third-party work without a workspace safely degrades to read-only data context', () => {
  const plan = codexRunnerInternals.buildExecutionPlan(
    { executionMode: 'untrusted-readonly', artifactName: 'result.html', prompt: '恢复的飞书任务' },
    '/private/data',
  );
  assert.equal(plan.cwd, '/private/data');
  assert.deepEqual(plan.args.slice(0, 5), ['exec', '--sandbox', 'read-only', '--cd', '/private/data']);
});

test('workspace-change requires a workspace that passes the configured-root validator', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-runner-policy-'));
  const allowedRoot = path.join(root, 'allowed');
  const outsideWorkspace = path.join(root, 'outside');
  await mkdir(allowedRoot, { recursive: true });
  await mkdir(outsideWorkspace, { recursive: true });
  try {
    const runner = new CodexRunner({
      binary: '/usr/bin/true',
      dataDir: path.join(root, 'data'),
      allowedWorkspaceRoots: [allowedRoot],
    });
    await runner.init();
    await assert.rejects(
      runner.startJob({ executionMode: 'workspace-change', prompt: '修改本地方案' }),
      (error) => error?.code === 'WORKSPACE_REQUIRED',
    );
    await assert.rejects(
      runner.startJob({
        executionMode: 'workspace-change',
        workspacePath: outsideWorkspace,
        prompt: '修改本地方案',
      }),
      (error) => error?.code === 'WORKSPACE_OUTSIDE_ALLOWED_ROOTS',
    );
    assert.equal(runner.listJobs().length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('untrusted input can never enter workspace-change and is forced through read-only Codex', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-runner-downgrade-'));
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'projects', 'agent-project');
  const calls = [];
  await mkdir(workspace, { recursive: true });
  try {
    const runner = new CodexRunner({
      binary: '/usr/bin/true',
      dataDir,
      allowedWorkspaceRoots: [path.join(root, 'projects')],
      spawnProcess: createSuccessfulSpawn({ calls, finalText: '只读核验已经完成。' }),
      now: () => new Date('2026-07-15T08:30:00.000Z'),
    });
    await runner.init();
    const finished = new Promise((resolve) => {
      runner.on('job:update', (job) => {
        if (job.state === 'ready' || job.state === 'error') resolve(job);
      });
    });
    const accepted = await runner.startJob({
      title: '第三方原文任务',
      kind: 'analysis',
      prompt: '原始飞书消息',
      executionMode: 'workspace-change',
      workspacePath: workspace,
      untrustedInput: true,
      auto: true,
    });
    const job = await finished;
    assert.equal(accepted.executionMode, 'untrusted-readonly');
    assert.equal(accepted.autonomyLabel, 'Codex 只读核验');
    assert.equal(job.state, 'ready');
    assert.equal(job.executionMode, 'untrusted-readonly');
    assert.deepEqual(calls[0].args.slice(0, 5), [
      'exec', '--sandbox', 'read-only', '--cd', await realpath(workspace),
    ]);
    assert.match(calls[0].input, /第三方飞书消息/u);
    assert.doesNotMatch(calls[0].input, /宿主从可信上下文中归一化出的任务语义/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trusted workspace-change keeps project edits, wraps the final response, and restores safely', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-runner-write-'));
  const dataDir = path.join(root, 'data');
  const projectsRoot = path.join(root, 'projects');
  const workspace = path.join(projectsRoot, 'evaluation-project');
  const calls = [];
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'existing-notes.txt'), 'keep this unrelated change\n');
  try {
    const runner = new CodexRunner({
      binary: '/usr/bin/true',
      dataDir,
      allowedWorkspaceRoots: [projectsRoot],
      spawnProcess: createSuccessfulSpawn({
        calls,
        finalText: '已把技能基数调整为 36，并完成项目内校验。',
        onRun: async ({ options }) => {
          await writeFile(path.join(options.cwd, 'evaluation-plan.txt'), 'skill_count=36\n');
        },
      }),
      now: () => new Date('2026-07-15T08:30:00.000Z'),
    });
    await runner.init();
    const finished = new Promise((resolve) => {
      runner.on('job:update', (job) => {
        if (job.state === 'ready' || job.state === 'error') resolve(job);
      });
    });
    const accepted = await runner.startJob({
      title: '更新评测方案',
      kind: 'analysis',
      prompt: '把评测方案的技能基数更新为 36，并同步项目内相关计算。',
      artifactName: 'workspace-change-result.html',
      executionMode: 'workspace-change',
      workspacePath: workspace,
      auto: true,
    });
    const job = await finished;
    const canonicalWorkspace = await realpath(workspace);
    assert.equal(accepted.executionMode, 'workspace-change');
    assert.equal(accepted.autonomyLabel, 'Codex 自动修改本地工作区');
    assert.equal(job.state, 'ready');
    assert.equal(job.executionMode, 'workspace-change');
    assert.deepEqual(calls[0].args.slice(0, 5), [
      'exec', '--sandbox', 'workspace-write', '--cd', canonicalWorkspace,
    ]);
    assert.match(calls[0].input, /宿主归一化后的本地任务/u);
    assert.match(calls[0].input, /保护已有的无关改动/u);
    assert.equal(await readFile(path.join(workspace, 'evaluation-plan.txt'), 'utf8'), 'skill_count=36\n');
    assert.equal(await readFile(path.join(workspace, 'existing-notes.txt'), 'utf8'), 'keep this unrelated change\n');

    const artifact = await readFile(path.join(dataDir, 'artifacts', 'workspace-change-result.html'), 'utf8');
    assert.match(artifact, /技能基数调整为 36/u);
    const persisted = await readFile(path.join(dataDir, 'jobs.json'), 'utf8');
    assert.equal(persisted.includes(canonicalWorkspace), false);
    assert.equal(persisted.includes('把评测方案的技能基数更新为 36'), false);
    assert.match(persisted, /"executionMode": "workspace-change"/u);

    const restoredRunner = new CodexRunner({
      binary: '/usr/bin/true',
      dataDir,
      allowedWorkspaceRoots: [projectsRoot],
      now: () => new Date('2026-07-15T08:35:00.000Z'),
    });
    await restoredRunner.init();
    const restored = restoredRunner.getLatestJob();
    assert.equal(restored.state, 'ready');
    assert.equal(restored.executionMode, 'workspace-change');
    assert.equal(restored.autonomyLabel, 'Codex 自动修改本地工作区');
    assert.equal(JSON.stringify(restored).includes(canonicalWorkspace), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace-change exposes only verified clickable documents and restores their private registry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-runner-documents-'));
  const dataDir = path.join(root, 'data');
  const projectsRoot = path.join(root, 'projects');
  const workspace = path.join(projectsRoot, 'weekly-review');
  const oldDocument = path.join(workspace, 'old-notes.md');
  const linkedDocument = path.join(workspace, 'linked-notes.md');
  const outsideDocument = path.join(root, 'outside.md');
  await mkdir(workspace, { recursive: true });
  await writeFile(oldDocument, 'unchanged\n');
  await utimes(oldDocument, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  await writeFile(outsideDocument, 'outside\n');
  await symlink(outsideDocument, linkedDocument);

  const finalText = `已更新 \`周会方案.md\`。
<PROACTIVE_UI_PRESENTATION>${JSON.stringify({
    headline: '老大，周会方案已经更新',
    summary: 'Codex 已完成本地文档修改并复核状态。',
    actions: [
      { intent: 'view_artifact', label: '查看方案' },
      { intent: 'continue_codex', label: '继续完善' },
      { intent: 'complete', label: '确认完成' },
    ],
    receipt: {
      timeline: [{ label: '更新周会方案', state: 'done' }],
      result: {
        title: '周会方案已更新',
        documents: [
          { path: '周会方案.md' },
          { path: 'old-notes.md' },
          { path: 'linked-notes.md' },
          { path: '../outside.md' },
          { path: 'unsafe.html' },
        ],
      },
    },
  })}</PROACTIVE_UI_PRESENTATION>`;

  try {
    const runner = new CodexRunner({
      binary: '/usr/bin/true',
      dataDir,
      allowedWorkspaceRoots: [projectsRoot],
      spawnProcess: createSuccessfulSpawn({
        finalText,
        onRun: async ({ options }) => {
          await writeFile(path.join(options.cwd, '周会方案.md'), '# 新方案\n');
          await writeFile(path.join(options.cwd, 'unsafe.html'), '<p>not a document link</p>');
        },
      }),
    });
    await runner.init();
    const finished = new Promise((resolve) => {
      runner.on('job:update', (job) => {
        if (job.state === 'ready' || job.state === 'error') resolve(job);
      });
    });
    await runner.startJob({
      title: '更新周会方案',
      kind: 'draft',
      prompt: '更新周会方案文档。',
      executionMode: 'workspace-change',
      workspacePath: workspace,
    });
    const job = await finished;
    assert.equal(job.state, 'ready');
    assert.equal(job.receipt.result.documents.length, 1);
    assert.equal(job.receipt.result.documents[0].label, '周会方案.md');
    assert.equal(JSON.stringify(job).includes(await realpath(workspace)), false);

    const reference = job.receipt.result.documents[0];
    const resolved = await runner.resolveDocumentReference(reference.id);
    assert.equal(resolved.path, await realpath(path.join(workspace, '周会方案.md')));
    assert.equal(await runner.resolveDocumentReference('../周会方案.md'), null);

    const jobsFile = await readFile(path.join(dataDir, 'jobs.json'), 'utf8');
    const registryFile = await readFile(path.join(dataDir, 'document-refs.json'), 'utf8');
    assert.equal(jobsFile.includes(await realpath(workspace)), false);
    assert.equal(jobsFile.includes('absolutePath'), false);
    assert.equal(registryFile.includes(await realpath(workspace)), true);

    const restoredRunner = new CodexRunner({
      binary: '/usr/bin/true',
      dataDir,
      allowedWorkspaceRoots: [projectsRoot],
    });
    await restoredRunner.init();
    assert.equal((await restoredRunner.resolveDocumentReference(reference.id)).label, '周会方案.md');

    await unlink(path.join(workspace, '周会方案.md'));
    assert.equal(await restoredRunner.resolveDocumentReference(reference.id), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('restart never resumes an interrupted workspace-change or retains its private task context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-runner-restart-'));
  const dataDir = path.join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'jobs.json'), `${JSON.stringify([{
    id: 'job-interrupted',
    title: '中断的本地修改',
    kind: 'analysis',
    state: 'running',
    createdAt: '2026-07-15T08:30:00.000Z',
    updatedAt: '2026-07-15T08:30:10.000Z',
    artifactName: 'interrupted.html',
    executionMode: 'workspace-change',
    prompt: 'private normalized task',
    workspacePath: '/Users/example/private-project',
  }], null, 2)}\n`);
  let spawnCount = 0;
  try {
    const runner = new CodexRunner({
      binary: '/usr/bin/true',
      dataDir,
      spawnProcess: (...args) => {
        spawnCount += 1;
        return createSuccessfulSpawn({})(...args);
      },
      now: () => new Date('2026-07-15T08:35:00.000Z'),
    });
    await runner.init();
    const restored = runner.getLatestJob();
    assert.equal(spawnCount, 0);
    assert.equal(restored.state, 'error');
    assert.equal(restored.executionMode, 'workspace-change');
    assert.match(restored.error, /应用重启后中断/u);
    assert.equal(JSON.stringify(restored).includes('/Users/example'), false);
    assert.equal(JSON.stringify(restored).includes('private normalized task'), false);
    const persisted = await readFile(path.join(dataDir, 'jobs.json'), 'utf8');
    assert.equal(persisted.includes('/Users/example'), false);
    assert.equal(persisted.includes('private normalized task'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner wraps a fake read-only Codex final response into the private artifact directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-runner-'));
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'projects', 'agent-project');
  const calls = [];
  await mkdir(workspace, { recursive: true });

  const spawnProcess = (_binary, args, options) => {
    calls.push({ args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };
    child.stdin = {
      end: () => {
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: `核验完成 <script>unsafe()</script>\n<PROACTIVE_UI_PRESENTATION>${JSON.stringify({
                headline: '老大，项目核验完成',
                summary: '关键判断和待确认项已经整理为本地成果。',
                actions: [
                  { intent: 'view_artifact', label: '看核验结论' },
                  { intent: 'continue_codex', label: '继续核对细节' },
                  { intent: 'complete', label: '收下核验结果' },
                ],
                receipt: {
                  timeline: [
                    { label: '读取项目线索', state: 'done' },
                    { label: '核对关键事实', state: 'done' },
                  ],
                  result: { title: '项目核验完成', deliverableLabel: '核验结论' },
                },
              })}</PROACTIVE_UI_PRESENTATION>`,
            },
          })}\n`);
          child.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 8, output_tokens: 4 } })}\n`);
          child.emit('close', 0, null);
        });
      },
    };
    return child;
  };

  try {
    const runner = new CodexRunner({
      binary: '/usr/bin/true',
      dataDir,
      allowedWorkspaceRoots: [path.join(root, 'projects')],
      spawnProcess,
      now: () => new Date('2026-07-15T08:30:00.000Z'),
    });
    await runner.init();
    const ready = new Promise((resolve) => {
      runner.on('job:update', (job) => {
        if (job.state === 'ready' || job.state === 'error') resolve(job);
      });
    });
    await runner.startJob({
      title: '飞书工作请求',
      kind: 'analysis',
      prompt: '请核对当前项目',
      artifactName: 'mention-result.html',
      untrustedInput: true,
      workspacePath: workspace,
      auto: true,
    });
    const job = await ready;
    assert.equal(job.state, 'ready');
    assert.equal(job.presentation.headline, '老大，项目核验完成');
    assert.equal(job.presentation.actions[1].label, '继续核对细节');
    assert.equal(job.receipt.result.deliverableLabel, '核验结论');
    assert.equal(calls.length, 1);
    const canonicalWorkspace = await realpath(workspace);
    assert.equal(calls[0].options.cwd, canonicalWorkspace);
    assert.deepEqual(calls[0].args.slice(0, 5), ['exec', '--sandbox', 'read-only', '--cd', canonicalWorkspace]);
    const artifact = await readFile(path.join(dataDir, 'artifacts', 'mention-result.html'), 'utf8');
    assert.match(artifact, /核验完成/u);
    assert.match(artifact, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/u);
    assert.equal(artifact.includes('<script>unsafe()</script>'), false);
    assert.equal(artifact.includes('PROACTIVE_UI_PRESENTATION'), false);
    const jobsFile = await readFile(path.join(dataDir, 'jobs.json'), 'utf8');
    assert.equal(jobsFile.includes(canonicalWorkspace), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a real-service coordinator gives every ordinary Codex task a verified generic delivery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-runner-generic-delivery-'));
  try {
    const registryDir = path.join(root, 'deliveries');
    const registry = await new DeliveryRegistry({ dataDir: registryDir }).init();
    const coordinator = new DeliveryCoordinator({ registry });
    const runner = new CodexRunner({
      binary: '/usr/bin/true',
      dataDir: path.join(root, 'runner'),
      spawnProcess: createSuccessfulSpawn({
        finalText: `任务结果正文\n<PROACTIVE_UI_PRESENTATION>${JSON.stringify({
          headline: '老大，范围核对已经完成',
          summary: '差异和下一步已经整理好。',
          actions: [
            { intent: 'view_artifact', label: '看范围差异' },
            { intent: 'complete', label: '收下结论' },
          ],
        })}</PROACTIVE_UI_PRESENTATION>`,
      }),
      deliveryCoordinator: coordinator,
    });
    await runner.init();
    const finished = new Promise((resolve) => runner.on('job:update', (job) => {
      if (['ready', 'error'].includes(job.state)) resolve(job);
    }));
    const started = await runner.startJob({ title: '核对范围', kind: 'analysis', prompt: '核对范围。' });
    assert.equal(started.deliveryState, undefined);
    const job = await finished;
    assert.equal(job.state, 'ready');
    assert.deepEqual(job.presentation.actions[0], {
      intent: 'open_delivery',
      label: '看范围差异',
      targetId: job.deliveries[0].id,
    });
    assert.equal(job.deliveries[0].kind, 'GENERIC_RESULT');
    assert.equal(job.deliveries[0].actionLabel, '看范围差异');

    const resolved = await registry.resolve(job.deliveries[0].id);
    assert.equal(resolved.ok, true);
    assert.equal(resolved.presentation, 'in_app');
    assert.equal(resolved.launch.policy, 'registered_local_result');
    assert.equal(JSON.stringify(resolved).includes(path.join(root, 'runner')), false);

    const restoredRegistry = await new DeliveryRegistry({ dataDir: registryDir }).init();
    const restored = await restoredRegistry.resolve(job.deliveries[0].id);
    assert.equal(restored.ok, true);
    assert.equal(restored.presentation, 'in_app');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed specialized adapter cannot turn a completed Codex job into an error or hide its generic result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-runner-delivery-fallback-'));
  try {
    const registry = await new DeliveryRegistry({ dataDir: path.join(root, 'deliveries') }).init();
    const coordinator = new DeliveryCoordinator({
      registry,
      handlers: {
        design_preview: async () => {
          throw new Error('preview service unavailable');
        },
      },
    });
    const runner = new CodexRunner({
      binary: '/usr/bin/true',
      dataDir: path.join(root, 'runner'),
      spawnProcess: createSuccessfulSpawn({
        finalText: `完成的交互方案\n<PROACTIVE_UI_PRESENTATION>${JSON.stringify({
          headline: '老大，交互方案已经整理好',
          summary: '完整结果已在本地生成，可以直接查看。',
          actions: [
            { intent: 'view_artifact', label: '看交互方案' },
            { intent: 'complete', label: '收下这版' },
          ],
        })}</PROACTIVE_UI_PRESENTATION>`,
      }),
      deliveryCoordinator: coordinator,
    });
    await runner.init();
    const finished = new Promise((resolve) => runner.on('job:update', (job) => {
      if (['ready', 'error'].includes(job.state)) resolve(job);
    }));
    await runner.startJob({
      title: '生成交互方案',
      kind: 'draft',
      prompt: '整理一份完整交互方案。',
      deliveryTarget: 'design_preview',
    });

    const job = await finished;
    assert.equal(job.state, 'ready');
    assert.equal(job.deliveryState, 'ready');
    assert.deepEqual(job.deliveries.map((delivery) => delivery.kind), ['GENERIC_RESULT']);
    assert.deepEqual(job.presentation.actions[0], {
      intent: 'open_delivery',
      label: '看交互方案',
      targetId: job.deliveries[0].id,
    });

    const resolved = await registry.resolve(job.deliveries[0].id);
    assert.equal(resolved.ok, true);
    assert.equal(resolved.presentation, 'in_app');
    assert.equal(resolved.loadedTarget, 'GENERIC_RESULT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

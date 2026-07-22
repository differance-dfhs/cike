import assert from 'node:assert/strict';
import test from 'node:test';
import { LarkAdapter, larkInternals } from './lark.mjs';

const NOW = new Date('2026-07-15T09:30:00.000Z');

function authEnvelope() {
  return {
    verified: true,
    identities: {
      user: {
        status: 'ready',
        tokenStatus: 'valid',
        openId: 'ou_selfSensitive123',
        userName: '林晓',
      },
    },
  };
}

function agendaEnvelope(items = []) {
  return { ok: true, identity: 'user', data: items };
}

function taskEnvelope(items = []) {
  return { ok: true, identity: 'user', data: { items, has_more: false, page_token: '' } };
}

function mentionEnvelope(messages = []) {
  return { ok: true, identity: 'user', data: { messages, has_more: false, page_token: '' } };
}

function meetingEnvelope(items = []) {
  return { ok: true, identity: 'user', data: { items, has_more: false, page_token: '' } };
}

function recordingEnvelope(recordings = []) {
  return { ok: true, identity: 'user', data: { recordings } };
}

function meetingDetailEnvelope(meetings = []) {
  return { ok: true, identity: 'user', data: { meetings } };
}

function noteDetailEnvelope(note = null) {
  return { ok: true, identity: 'user', data: { note } };
}

function documentEnvelope(content = '') {
  return { ok: true, identity: 'user', data: { document: { content } } };
}

function minuteEnvelope(minutes = []) {
  return { ok: true, identity: 'user', data: { minutes } };
}

function event(overrides = {}) {
  return {
    summary: '日程',
    start_time: { datetime: '2026-07-15T17:00:00+08:00' },
    end_time: { datetime: '2026-07-15T18:00:00+08:00' },
    free_busy_status: 'busy',
    self_rsvp_status: 'accept',
    ...overrides,
  };
}

function createExecStub(options = {}) {
  const calls = [];
  const execJson = async (file, args, execOptions) => {
    calls.push({ file, args, options: execOptions });
    if (args[0] === 'auth') return authEnvelope();
    if (args[0] === 'calendar') {
      if (options.agendaError) throw options.agendaError;
      return options.agenda ?? agendaEnvelope();
    }
    if (args[0] === 'task') {
      if (options.taskError) throw options.taskError;
      if (args.includes('--complete=true')) {
        if (options.completedTaskError) throw options.completedTaskError;
        return options.completedTasks ?? taskEnvelope();
      }
      return options.tasks ?? taskEnvelope();
    }
    if (args[0] === 'im') {
      if (args.includes('--sender')) {
        if (options.selfMessageError) throw options.selfMessageError;
        return options.selfMessages ?? mentionEnvelope();
      }
      if (options.mentionError) throw options.mentionError;
      return options.mentions ?? mentionEnvelope();
    }
    if (args[0] === 'vc' && args[1] === '+search') {
      if (options.meetingError) throw options.meetingError;
      return options.meetings ?? meetingEnvelope();
    }
    if (args[0] === 'vc' && args[1] === '+recording') {
      if (options.recordingError) throw options.recordingError;
      return options.recordings ?? recordingEnvelope();
    }
    if (args[0] === 'vc' && args[1] === '+detail') {
      if (options.meetingDetailError) throw options.meetingDetailError;
      return options.meetingDetails ?? meetingDetailEnvelope();
    }
    if (args[0] === 'minutes' && args[1] === '+detail') {
      if (options.minuteError) throw options.minuteError;
      return options.minutes ?? minuteEnvelope();
    }
    if (args[0] === 'note' && args[1] === '+detail') {
      if (options.noteError) throw options.noteError;
      return options.noteDetail ?? noteDetailEnvelope();
    }
    if (args[0] === 'docs' && args[1] === '+fetch') {
      const token = args[args.indexOf('--doc') + 1];
      return options.documents?.[token] ?? documentEnvelope();
    }
    throw new Error(`unexpected command: ${args.join(' ')}`);
  };
  return { calls, execJson };
}

test('uses only fixed read-only lark-cli argv for agenda, tasks, @me, and self messages', async () => {
  const stub = createExecStub();
  const adapter = new LarkAdapter({ execJson: stub.execJson, now: () => NOW });

  await adapter.collect();

  assert.deepEqual(stub.calls[0].args, ['auth', 'status', '--json', '--verify']);
  assert.deepEqual(stub.calls.find((call) => call.args[0] === 'calendar').args, [
    'calendar',
    '+agenda',
    '--as',
    'user',
    '--start',
    '2026-07-15',
    '--end',
    '2026-07-16',
    '--format',
    'json',
  ]);
  const taskCalls = stub.calls.filter((call) => call.args[0] === 'task');
  assert.deepEqual(taskCalls[0].args, [
    'task',
    '+get-my-tasks',
    '--complete=false',
    '--page-limit',
    '1',
    '--as',
    'user',
    '--format',
    'json',
  ]);
  assert.deepEqual(taskCalls[1].args, [
    'task',
    '+get-my-tasks',
    '--complete=true',
    '--page-limit',
    '3',
    '--as',
    'user',
    '--format',
    'json',
  ]);
  assert.deepEqual(stub.calls.find((call) => call.args.includes('--is-at-me')).args, [
    'im',
    '+messages-search',
    '--as',
    'user',
    '--query',
    '',
    '--is-at-me',
    '--start',
    '2026-07-14T17:30:00+08:00',
    '--end',
    '2026-07-15T17:30:00+08:00',
    '--page-size',
    '20',
    '--page-limit',
    '1',
    '--no-reactions',
    '--format',
    'json',
  ]);
  assert.deepEqual(stub.calls.find((call) => call.args.includes('--sender')).args, [
    'im',
    '+messages-search',
    '--as',
    'user',
    '--query',
    '',
    '--sender',
    'ou_selfSensitive123',
    '--start',
    '2026-07-14T17:30:00+08:00',
    '--end',
    '2026-07-15T17:30:00+08:00',
    '--page-size',
    '20',
    '--page-limit',
    '1',
    '--no-reactions',
    '--format',
    'json',
  ]);
  for (const call of stub.calls) {
    assert.equal(call.file, 'lark-cli');
    assert.equal(call.args.some((arg) => /^\+(?:create|update|delete|send|reply)$/u.test(arg)), false);
  }
});

test('preserves private titles and message context while omitting deleted, bot, and raw transport ids', async () => {
  const stub = createExecStub({
    agenda: agendaEnvelope([
      event({
        summary: '不应暴露的私密主题',
        visibility: 'private',
        event_id: 'evt_sensitive123',
        app_link: 'https://example.invalid/calendar',
      }),
    ]),
    tasks: taskEnvelope([
      {
        summary: '阅读 https://example.invalid/paper 并联系 alice@example.com',
        due_at: '2026-07-16T12:00:00+08:00',
        completed: false,
        guid: 'guid-should-never-leave',
        url: 'https://example.invalid/task',
      },
      {
        summary: '不应暴露的私密任务',
        visibility: 'private',
        due_at: '',
        completed: false,
      },
    ]),
    mentions: mentionEnvelope([
      {
        message_id: 'om_sensitiveMessage123',
        chat_id: 'oc_sensitiveChat123',
        chat_name: '主动 Agent 讨论',
        content: '请查看 [方案](https://example.invalid/spec) 并跟进 om_hiddenReference123',
        create_time: '1784106000000',
        deleted: false,
        updated: true,
        thread_id: 'omt_sensitiveThread123',
        sender: { id: 'ou_sensitiveUser123', name: '同事甲', sender_type: 'user' },
      },
      {
        message_id: 'om_deleted123',
        chat_id: 'oc_deleted123',
        chat_name: '已撤回',
        content: '不应出现',
        create_time: '1784106000000',
        deleted: true,
        sender: { name: '同事乙', sender_type: 'user' },
      },
      {
        message_id: 'om_bot123',
        chat_id: 'oc_bot123',
        chat_name: '机器人群',
        content: '机器人消息不应出现',
        create_time: '1784106000000',
        deleted: false,
        sender: { name: '提醒机器人', sender_type: 'bot' },
      },
      {
        message_id: 'om_empty123',
        chat_id: 'oc_empty123',
        chat_name: '空消息群',
        content: '<div></div>',
        create_time: '1784106000000',
        deleted: false,
        sender: { name: '同事丙', sender_type: 'user' },
      },
    ]),
    selfMessages: mentionEnvelope([
      {
        message_id: 'om_selfSensitive123',
        chat_id: 'oc_sensitiveChat123',
        chat_name: '主动 Agent 讨论',
        content: '我晚上打个标哈，看看这批题有哪些问题',
        create_time: '1784106060000',
        deleted: false,
        sender: { id: 'ou_selfSensitive123', name: '林晓', sender_type: 'user' },
      },
    ]),
  });
  const adapter = new LarkAdapter({ execJson: stub.execJson, now: () => NOW });

  const result = await adapter.collect();

  assert.equal(result.selfName, '林晓');
  assert.equal(result.events[0].title, '不应暴露的私密主题');
  assert.deepEqual(Object.keys(result.tasks[0]).sort(), ['completed', 'due', 'title']);
  assert.match(result.tasks[0].title, /https:\/\/example\.invalid\/paper/u);
  assert.match(result.tasks[0].title, /alice@example\.com/u);
  assert.equal(result.tasks[1].title, '不应暴露的私密任务');
  assert.equal(result.tasks[1].due, null);
  assert.equal(result.mentions.length, 1);
  assert.deepEqual(Object.keys(result.mentions[0]).sort(), [
    'chat',
    'chatKey',
    'createdAt',
    'deleted',
    'id',
    'isMine',
    'mentionedMe',
    'sender',
    'text',
    'threadKey',
    'threadPresent',
    'updated',
  ]);
  assert.match(result.mentions[0].id, /^mention-[a-f0-9]{16}$/u);
  assert.equal(result.mentions[0].sender, '同事甲');
  assert.equal(result.mentions[0].chat, '主动 Agent 讨论');
  assert.equal(result.mentions[0].mentionedMe, true);
  assert.equal(result.mentions[0].isMine, false);
  assert.equal(result.mentions[0].threadPresent, true);
  assert.equal(result.mentions[0].updated, true);
  assert.equal(result.mentions[0].deleted, false);
  assert.match(result.mentions[0].text, /方案/u);
  assert.match(result.mentions[0].text, /om_hiddenReference123/u);
  assert.equal(result.selfMessages.length, 1);
  assert.equal(result.selfMessages[0].sender, '你');
  assert.equal(result.selfMessages[0].isMine, true);
  assert.equal(result.selfMessages[0].mentionedMe, false);
  assert.equal(result.selfMessages[0].chatKey, result.mentions[0].chatKey);

  const serialized = JSON.stringify(result);
  for (const sensitive of [
    'guid-should-never-leave',
    'om_sensitiveMessage123',
    'oc_sensitiveChat123',
    'ou_sensitiveUser123',
    'omt_sensitiveThread123',
    'ou_selfSensitive123',
    'om_selfSensitive123',
  ]) {
    assert.equal(serialized.includes(sensitive), false, sensitive);
  }
  assert.equal(serialized.includes('https://example.invalid/paper'), true);
  assert.equal(serialized.includes('不应暴露的私密主题'), true);
  assert.equal(serialized.includes('不应暴露的私密任务'), true);
});

test('task enrichment failure keeps calendar and @me messages available', async () => {
  const stub = createExecStub({
    agenda: agendaEnvelope([event({ summary: '仍可使用的日程' })]),
    taskError: new Error('task scope unavailable'),
    mentions: mentionEnvelope([
      {
        message_id: 'om_valid123',
        chat_id: 'oc_valid123',
        chat_name: '项目群',
        content: '请核对结论',
        create_time: '1784106000000',
        deleted: false,
        sender: { name: '同事甲', sender_type: 'user' },
      },
    ]),
  });
  const result = await new LarkAdapter({ execJson: stub.execJson, now: () => NOW }).collect();

  assert.equal(result.state, 'connected');
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.tasks, []);
  assert.equal(result.mentions.length, 1);
  assert.match(result.source.detail, /未完成任务、已完成任务读取已部分降级/u);
  assert.equal(result.issue.source, '飞书未完成任务、飞书已完成任务');
});

test('已完成飞书 Todo 作为静默反证与未完成任务一起返回', async () => {
  const stub = createExecStub({
    tasks: taskEnvelope([{ summary: '待推进的事', due_at: '', completed: false }]),
    completedTasks: taskEnvelope([{ summary: '已完成的会后论文检索', due_at: '', completed: true }]),
  });

  const result = await new LarkAdapter({ execJson: stub.execJson, now: () => NOW }).collect();

  assert.deepEqual(result.tasks, [
    { title: '待推进的事', due: null, completed: false },
    { title: '已完成的会后论文检索', due: null, completed: true },
  ]);
  assert.match(result.source.detail, /1 个已完成任务用于静默去重/u);
});

test('@me enrichment failure keeps calendar and tasks available', async () => {
  const stub = createExecStub({
    agenda: agendaEnvelope([event({ summary: '仍可使用的日程' })]),
    tasks: taskEnvelope([{ summary: '仍可使用的任务', due_at: '', completed: false }]),
    mentionError: new Error('search:message unavailable'),
  });
  const result = await new LarkAdapter({ execJson: stub.execJson, now: () => NOW }).collect();

  assert.equal(result.state, 'connected');
  assert.equal(result.events.length, 1);
  assert.equal(result.tasks.length, 1);
  assert.deepEqual(result.mentions, []);
  assert.match(result.source.detail, /@我 消息读取已部分降级/u);
  assert.equal(result.issue.source, '飞书@我 消息');
  assert.match(result.issue.recovery, /search:message/u);
});

test('first @me scan looks back 24 hours in explicit Shanghai time', () => {
  const range = larkInternals.mentionWindow(NOW, null);
  const start = larkInternals.formatShanghaiIso(range.start);
  const end = larkInternals.formatShanghaiIso(range.end);
  assert.deepEqual(larkInternals.mentionArgs(start, end), [
    'im',
    '+messages-search',
    '--as',
    'user',
    '--query',
    '',
    '--is-at-me',
    '--start',
    '2026-07-14T17:30:00+08:00',
    '--end',
    '2026-07-15T17:30:00+08:00',
    '--page-size',
    '20',
    '--page-limit',
    '1',
    '--no-reactions',
    '--format',
    'json',
  ]);
});

test('subsequent @me scan recovers the offline interval with a 35-minute overlap', async () => {
  let current = NOW;
  const stub = createExecStub();
  const adapter = new LarkAdapter({ execJson: stub.execJson, now: () => current });

  await adapter.collect();
  current = new Date(NOW.getTime() + 3 * 60 * 60 * 1_000);
  await adapter.collect();

  const mentionCalls = stub.calls.filter((call) => call.args.includes('--is-at-me'));
  assert.equal(mentionCalls.length, 2);
  assert.equal(mentionCalls[0].args[8], '2026-07-14T17:30:00+08:00');
  assert.equal(mentionCalls[0].args[10], '2026-07-15T17:30:00+08:00');
  assert.equal(mentionCalls[1].args[8], '2026-07-15T16:55:00+08:00');
  assert.equal(mentionCalls[1].args[10], '2026-07-15T20:30:00+08:00');

  const priorEnd = new Date('2026-07-15T17:30:00+08:00').getTime();
  const nextStart = new Date(mentionCalls[1].args[8]).getTime();
  assert.equal(priorEnd - nextStart, 35 * 60 * 1_000);
});

test('failed @me scans do not advance the recovery cursor', async () => {
  let current = NOW;
  let mentionAttempt = 0;
  const stub = createExecStub();
  const execJson = async (file, args, options) => {
    const value = await stub.execJson(file, args, options);
    if (args.includes('--is-at-me')) {
      mentionAttempt += 1;
      if (mentionAttempt === 2) throw new Error('temporary offline failure');
    }
    return value;
  };
  const adapter = new LarkAdapter({ execJson, now: () => current });

  await adapter.collect();
  current = new Date(NOW.getTime() + 60 * 60 * 1_000);
  await adapter.collect();
  current = new Date(NOW.getTime() + 3 * 60 * 60 * 1_000);
  await adapter.collect();

  const mentionCalls = stub.calls.filter((call) => call.args.includes('--is-at-me'));
  assert.equal(mentionCalls.length, 3);
  assert.equal(mentionCalls[2].args[8], '2026-07-15T16:55:00+08:00');
  assert.equal(mentionCalls[2].args[10], '2026-07-15T20:30:00+08:00');
});

test('meeting minutes independently extract only the authenticated user todos and hide transport tokens', async () => {
  const rawMeetingId = '7663016759552871690';
  const readableToken = 'obc-readable-sensitive-token';
  const deniedToken = 'obc-denied-sensitive-token';
  const stub = createExecStub({
    meetings: meetingEnvelope([
      { id: rawMeetingId, display_info: '语音质量评估周会\n录制：语音质量评估周会' },
      { id: '7663016759552871691', display_info: '无权限会议\n录制：无权限会议' },
    ]),
    recordings: recordingEnvelope([
      { meeting_id: rawMeetingId, minute_token: readableToken },
      { meeting_id: '7663016759552871691', minute_token: deniedToken },
    ]),
    minutes: minuteEnvelope([
      {
        minute_token: readableToken,
        title: '语音质量评估周会',
        artifacts: {
          todos: [
            { title: '更新语音质量评估方案', assignees: [{ name: '林晓' }], deadline: '明天' },
            { title: '发送会议结论', assignees: [{ name: '同事甲' }] },
          ],
          transcript_file: 'lark-minutes/mock/transcript.txt',
        },
      },
      { minute_token: deniedToken, error: 'No read permission' },
    ]),
  });
  const transcript = [
    '2026-07-15 17:00:00 CST|45min',
    '',
    '林晓 00:20:01.100',
    '我来更新语音质量评估方案，明天给大家看。',
    '',
    '同事甲 00:21:00.000',
    '我来发送会议结论。',
    '',
    '林晓 00:22:00.000',
    '这个不用我做。',
  ].join('\n');
  const adapter = new LarkAdapter({
    execJson: stub.execJson,
    now: () => NOW,
    dataDir: '/tmp/cike-lark-test',
    ensureDir: async () => {},
    readText: async () => transcript,
  });

  const result = await adapter.collect();

  assert.equal(result.meetingTodos.length, 1);
  assert.equal(result.meetingTodos[0].title, '更新语音质量评估方案');
  assert.equal(result.meetingTodos[0].meetingTitle, '语音质量评估周会');
  assert.equal(result.meetingTodos[0].due, '明天');
  assert.equal(result.meetingTodos[0].occurredAt, '2026-07-15T09:00:00.000Z');
  assert.equal(result.meetingTodos[0].responsibility, 'owner');
  assert.equal(result.meetingBriefs.length, 1);
  assert.equal(result.meetingBriefs[0].meetingTitle, '语音质量评估周会');
  assert.match(result.meetingBriefs[0].content, /林晓.*更新语音质量评估方案/u);
  assert.match(result.meetingTodos[0].id, /^meeting-todo-[a-f0-9]{16}$/u);
  assert.match(result.source.detail, /检查 2 场已结束会议（1 场可读、1 场无权限）/u);
  assert.equal(JSON.stringify(result).includes(rawMeetingId), false);
  assert.equal(JSON.stringify(result).includes(readableToken), false);
  assert.equal(JSON.stringify(result).includes(deniedToken), false);

  const meetingSearchCall = stub.calls.find((call) => call.args[0] === 'vc' && call.args[1] === '+search');
  assert.deepEqual(meetingSearchCall.args, [
    'vc', '+search', '--as', 'user', '--participant-ids', 'ou_selfSensitive123',
    '--start', '2026-07-12T17:30:00+08:00', '--end', '2026-07-15T17:30:00+08:00',
    '--page-size', '30', '--format', 'json',
  ]);
  const minuteCall = stub.calls.find((call) => call.args[0] === 'minutes');
  assert.deepEqual(minuteCall.args.slice(0, 8), [
    'minutes', '+detail', '--minute-tokens', `${readableToken},${deniedToken}`, '--todo', '--summary', '--transcript', '--output-dir',
  ]);
  assert.equal(minuteCall.options.cwd, '/tmp/cike-lark-test');
});

test('falls back to the same meeting intelligent note when Minute is unreadable', async () => {
  const rawMeetingId = '7663016759552871999';
  const deniedToken = 'obc-denied-minute-token';
  const noteId = '7663016759552871888';
  const summaryToken = 'doc-summary-token';
  const transcriptToken = 'doc-transcript-token';
  const sourceUrl = 'https://example.larksuite.com/docx/meeting-summary';
  const transcript = [
    '# 文字记录：Atlas产品相关事项沟通会',
    '<cite type="user" user-name="林晓"></cite> 00:01:06',
    '我来和唐澈核对五分制是否合适，明天给结论。',
    '<cite type="user" user-name="蒋峰"></cite> 00:02:10',
    '我来修复服务端持久化问题。',
  ].join('\n');
  const stub = createExecStub({
    meetings: meetingEnvelope([{
      id: rawMeetingId,
      display_info: '蒋峰\n云文档：智能纪要：Atlas产品相关事项沟通会',
      meta_data: { app_link: 'https://applink.larkoffice.com/client/vctab/open?meetingId=masked' },
    }]),
    recordings: recordingEnvelope([{ meeting_id: rawMeetingId, minute_token: deniedToken }]),
    meetingDetails: meetingDetailEnvelope([{
      meeting_id: rawMeetingId,
      topic: 'Atlas产品相关事项沟通会',
      start_time: '2026-07-15 17:00',
      end_time: '2026-07-15 17:30',
      note_id: noteId,
    }]),
    minuteError: new Error('No read permission'),
    noteDetail: noteDetailEnvelope({
      note_id: noteId,
      note_display_type: 'normal',
      note_doc_token: summaryToken,
      verbatim_doc_token: transcriptToken,
    }),
    documents: {
      [summaryToken]: documentEnvelope(`# 智能纪要\n\n核心结论：反馈入口独立。\n\n[打开妙记](${sourceUrl})`),
      [transcriptToken]: documentEnvelope(transcript),
    },
  });
  const result = await new LarkAdapter({
    execJson: stub.execJson,
    now: () => NOW,
    dataDir: '/tmp/cike-lark-note-test',
    ensureDir: async () => {},
  }).collect();

  assert.equal(result.meetingBriefs.length, 1);
  assert.equal(result.meetingBriefs[0].meetingTitle, 'Atlas产品相关事项沟通会');
  assert.equal(result.meetingBriefs[0].source, '飞书智能纪要');
  assert.equal(result.meetingBriefs[0].sourceUrl, `https://www.feishu.cn/docx/${summaryToken}`);
  assert.match(result.meetingBriefs[0].content, /反馈入口独立/u);
  assert.equal(result.meetingTodos.length, 1);
  assert.match(result.meetingTodos[0].title, /唐澈核对五分制/u);
  assert.match(result.source.detail, /1 场正文/u);
  assert.equal(stub.calls.some((call) => call.args[0] === 'docs' && call.args[1] === '+fetch'), true);
});

test('minutes transcript parser ignores other speakers, negations, and conversational comments', () => {
  const transcript = [
    '2026-07-15 17:00:00 CST|30min',
    '林晓 00:01:00.000',
    '我觉得这个方向不错。 我来补充评测标准。 这个不用我做。',
    '同事甲 00:02:00.000',
    '我来更新表格。',
  ].join('\n');
  const result = larkInternals.extractTranscriptCommitments(transcript, '林晓');
  assert.deepEqual(result.items.map((item) => item.title), ['补充评测标准']);
});

test('transcript parser recognizes natural next-week commitments to create a plan and cases', () => {
  const transcript = [
    '# 文字记录：客服自动化专项研讨会 2026年7月17日',
    '<cite type="user" user-name="林晓"></cite> 00:10:12',
    '哦，OK，那我下周看一下，我们出一个标准和方案，大概写一套题，我们对一下。',
    '<cite type="user" user-name="沈川"></cite> 00:10:22',
    '你可以先做个十几二十道，可能先试试看。',
  ].join('\n');
  const result = larkInternals.extractTranscriptCommitments(transcript, '林晓');
  assert.equal(result.items.length, 1);
  assert.match(result.items[0].title, /出一个标准和方案/u);
  assert.match(result.items[0].title, /写一套题/u);
  assert.equal(result.items[0].due, '下周');
});

test('intelligent note Todo section keeps only items assigned to the authenticated user', () => {
  const summary = [
    '# 总结',
    '会议确认两项工作。',
    '# 待办',
    '- [ ] 更新评测方案 <cite type="user" user-name="林晓"></cite>',
    '- [ ] 修复服务端问题 <cite type="user" user-name="蒋峰"></cite>',
    '# 相关链接',
    '- 文字记录',
  ].join('\n');
  const result = larkInternals.extractOwnedNoteTodos(summary, '林晓');
  assert.deepEqual(result.map((item) => item.title), ['更新评测方案']);
});

test('intelligent note title replaces generic call titles for meeting cards', () => {
  assert.equal(
    larkInternals.meetingDocumentTitle('<title>智能纪要：客服自动化专项研讨会 2026年7月17日</title>'),
    '客服自动化专项研讨会 2026年7月17日',
  );
});

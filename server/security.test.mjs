import assert from 'node:assert/strict';
import test from 'node:test';
import { redactText, sanitizeObject, validateLocalDraftCommand } from './security.mjs';

test('redactText preserves authorized context and removes only credentials', () => {
  const input = [
    'https://example.com/private?token=abc',
    'ou_1234567890abcdef',
    'owner@example.com',
    'access_token=abcDEF1234567890',
  ].join(' ');
  const output = redactText(input);

  assert.equal(output.includes('https://'), true);
  assert.equal(output.includes('ou_1234567890abcdef'), true);
  assert.equal(output.includes('owner@example.com'), true);
  assert.equal(output.includes('abcDEF1234567890'), false);
  assert.match(output, /凭证已隐藏/u);
});

test('sanitizeObject preserves identifiers and links but blocks credential fields recursively', () => {
  const output = sanitizeObject({
    title: '可见标题',
    event_id: 'event-secret',
    nested: { app_link: 'https://example.com', detail: '安全详情', access_token: 'top-secret' },
  });

  assert.equal(output.title, '可见标题');
  assert.equal(output.event_id, 'event-secret');
  assert.equal(output.nested.app_link, 'https://example.com');
  assert.equal(output.nested.detail, '安全详情');
  assert.equal(output.nested.access_token, '[敏感字段已隐藏]');
});

test('local draft gate allows research and blocks external writes', () => {
  assert.equal(validateLocalDraftCommand('检索最近论文并生成本地 HTML').allowed, true);
  assert.equal(validateLocalDraftCommand('帮我发给群里').allowed, false);
  assert.equal(validateLocalDraftCommand('更新飞书文档').allowed, false);
  assert.equal(validateLocalDraftCommand('写一份可供发送的邮件草稿').allowed, true);
});

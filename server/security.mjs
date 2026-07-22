const SECRET_ASSIGNMENT_PATTERN = /\b((?:(?:access|refresh|session)[_-]?)?token|app[_-]?secret|api[_-]?key|authorization|bearer)\b\s*[:=]\s*[^\s,;]+/giu;
const BEARER_SECRET_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu;
const KNOWN_SECRET_PATTERN = /\b(?:sk-(?:proj-)?|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9._-]{12,}\b/gu;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

const SENSITIVE_KEY_PATTERN = /(?:^|_)(?:token|secret|password|authorization|cookie)(?:$|_)/iu;

export function redactText(value, options = {}) {
  const maxLength = Number.isFinite(options.maxLength) ? Math.max(0, options.maxLength) : 500;
  const text = String(value ?? '')
    .replace(CONTROL_PATTERN, ' ')
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1=[凭证已隐藏]')
    .replace(BEARER_SECRET_PATTERN, 'Bearer [凭证已隐藏]')
    .replace(KNOWN_SECRET_PATTERN, '[凭证已隐藏]')
    .replace(/\s+/gu, ' ')
    .trim();

  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function sanitizeObject(value, options = {}) {
  const { maxDepth = 5, maxArrayLength = 30, maxTextLength = 500 } = options;

  function visit(input, depth) {
    if (depth > maxDepth) return '[已截断]';
    if (input == null || typeof input === 'boolean' || typeof input === 'number') return input;
    if (typeof input === 'string') return redactText(input, { maxLength: maxTextLength });
    if (Array.isArray(input)) return input.slice(0, maxArrayLength).map((item) => visit(item, depth + 1));
    if (typeof input !== 'object') return redactText(String(input), { maxLength: maxTextLength });

    const output = {};
    for (const [key, item] of Object.entries(input)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        output[key] = '[敏感字段已隐藏]';
      } else {
        output[key] = visit(item, depth + 1);
      }
    }
    return output;
  }

  return visit(value, 0);
}

export function safeLabel(value, fallback = '未命名', maxLength = 96) {
  const label = redactText(value, { maxLength }).replace(/[<>]/gu, '').trim();
  return label || fallback;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

const EXTERNAL_WRITE_PATTERNS = [
  /(?:直接|帮我|立即|马上)?(?:发送|发给|回复对方|转发|邀请)(?![^\n]{0,12}草稿)/iu,
  /(?:写入|更新|修改|覆盖|同步到)(?:飞书|lark|feishu|共享文档|日程)/iu,
  /(?:创建|取消|删除|改期|预定)(?:日程|会议|会议室)/iu,
  /(?:上传|发布|对外分享|提交|git\s+push|创建\s*pr)/iu,
  /(?:付款|购买|下单|转账|报销)/iu,
  /(?:删除|清空|移除)(?:文件|数据|记录|任务|文档)/iu,
];

export function validateLocalDraftCommand(value) {
  const command = String(value ?? '').replace(CONTROL_PATTERN, ' ').trim();
  if (!command) {
    return { allowed: false, message: '请输入要生成的本地研究、分析或草稿任务。' };
  }
  if (command.length > 2_000) {
    return { allowed: false, message: '任务描述过长，请缩短到 2000 字以内。' };
  }
  if (EXTERNAL_WRITE_PATTERNS.some((pattern) => pattern.test(command))) {
    return {
      allowed: false,
      message: '当前只允许研究、分析和本地草稿。发送、写入飞书、删除或对外发布需要单独授权。',
    };
  }
  return { allowed: true, command };
}

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileJson } from '../lib/exec-file.mjs';

const CLI_ENV = Object.freeze({
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
});

const DELIVERY_ID_PATTERN = /^lark-doc-[a-f0-9]{24}$/u;
const DOCUMENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const MAX_TITLE_LENGTH = 120;
const MAX_SOURCE_LENGTH = 96 * 1024;
const MAX_FETCHED_LENGTH = 2 * 1024 * 1024;
const STAGING_DIRECTORY = 'lark-publications';
const REGISTRY_FILE = 'lark-document-deliveries.json';
const TRUSTED_DOCX_HOSTS = Object.freeze([
  'feishu.cn',
  'larkoffice.com',
  'larksuite.com',
]);

const SENSITIVE_PATTERNS = Object.freeze([
  /\b(?:(?:(?:access|refresh|session)[_-]?)?token|app[_-]?secret|api[_-]?key|authorization|password|cookie)\b\s*[:=]\s*[^\s,;]+/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
  /\b(?:sk-(?:proj-)?|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9._-]{12,}\b/u,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/iu,
]);

export class LarkDocumentPublisherError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LarkDocumentPublisherError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new LarkDocumentPublisherError(code, message);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function decodeXmlEntities(value) {
  return String(value ?? '')
    .replace(/&#(\d+);/gu, (_match, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([a-f0-9]+);/giu, (_match, hexadecimal) => String.fromCodePoint(Number.parseInt(hexadecimal, 16)))
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function containsSensitiveMaterial(value) {
  const text = String(value ?? '');
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

function sanitizeTitle(value) {
  const title = String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/^#{1,6}\s+/u, '')
    .replace(/[<>]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!title) fail('INVALID_TITLE', '飞书文档标题不能为空。');
  if ([...title].length > MAX_TITLE_LENGTH) fail('INVALID_TITLE', '飞书文档标题过长。');
  if (containsSensitiveMaterial(title)) fail('SENSITIVE_CONTENT', '文档包含凭据类敏感信息，已停止发布。');
  return title;
}

function normalizeSource(value) {
  const source = String(value ?? '')
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .trim();
  if (!source) fail('EMPTY_CONTENT', '飞书文档正文不能为空。');
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_LENGTH) fail('CONTENT_TOO_LARGE', '飞书文档正文过长。');
  if (containsSensitiveMaterial(source)) fail('SENSITIVE_CONTENT', '文档包含凭据类敏感信息，已停止发布。');
  if (/<\/?PROACTIVE_UI_PRESENTATION>/iu.test(source)) {
    fail('UNSAFE_CONTENT', '文档正文混入了界面控制数据，已停止发布。');
  }
  return source;
}

function stripInlineMarkdown(value) {
  return String(value ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu, '$1（$2）')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/(`{1,3})(.*?)\1/gu, '$2')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/__([^_]+)__/gu, '$1')
    .replace(/~~([^~]+)~~/gu, '$1')
    .replace(/^>\s?/u, '')
    .replace(/\\([\\`*_{}\[\]()#+.!>-])/gu, '$1')
    .trim();
}

function comparableText(value) {
  return decodeXmlEntities(value)
    .replace(/<[^>]*>/gu, ' ')
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase();
}

function sourceBlocks(source) {
  const blocks = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    const text = stripInlineMarkdown(paragraph.join(' '));
    if (text) blocks.push({ kind: 'paragraph', text });
    paragraph = [];
  };
  const flushList = () => {
    if (list?.items.length) blocks.push(list);
    list = null;
  };

  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/u);
    if (heading) {
      flushParagraph();
      flushList();
      const text = stripInlineMarkdown(heading[2]);
      if (text) blocks.push({ kind: 'heading', level: Math.min(2, heading[1].length), text });
      continue;
    }

    const bullet = line.match(/^[-*+]\s+(.+)$/u);
    const numbered = line.match(/^\d+[.)]\s+(.+)$/u);
    if (bullet || numbered) {
      flushParagraph();
      const kind = bullet ? 'unordered' : 'ordered';
      if (list && list.kind !== kind) flushList();
      if (!list) list = { kind, items: [] };
      const text = stripInlineMarkdown((bullet || numbered)[1]);
      if (text) list.items.push(text);
      continue;
    }

    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

function anchorCandidates(blocks) {
  const anchors = [];
  const add = (value) => {
    const normalized = comparableText(value);
    if (normalized.length < 6) return;
    const anchor = [...normalized].slice(0, 28).join('');
    if (!anchors.includes(anchor)) anchors.push(anchor);
  };
  for (const block of blocks) {
    if (block.kind === 'unordered' || block.kind === 'ordered') {
      for (const item of block.items) add(item);
    } else {
      add(block.text);
    }
    if (anchors.length >= 4) break;
  }
  if (anchors.length < 2) fail('INSUFFICIENT_ANCHORS', '正文至少需要两个可回读核验的内容片段。');
  return anchors.slice(0, 2);
}

function renderLarkXml(blocks, marker) {
  const output = [];
  for (const block of blocks) {
    if (block.kind === 'heading') {
      output.push(`<h${block.level}>${escapeXml(block.text)}</h${block.level}>`);
    } else if (block.kind === 'unordered' || block.kind === 'ordered') {
      const tag = block.kind === 'ordered' ? 'ol' : 'ul';
      output.push(`<${tag}>${block.items.map((item) => `<li>${escapeXml(item)}</li>`).join('')}</${tag}>`);
    } else {
      output.push(`<p>${escapeXml(block.text)}</p>`);
    }
  }
  output.push(`<p>此刻交付标识：${escapeXml(marker)}</p>`);
  return `${output.join('\n')}\n`;
}

function trustedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/u, '');
  return TRUSTED_DOCX_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function normalizeTrustedDocxUrl(value) {
  const input = String(value ?? '').trim();
  if (!input || input.length > 2_048) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || !trustedHost(url.hostname)) return null;
    const match = url.pathname.match(/^\/docx\/([A-Za-z0-9_-]{8,128})\/?$/u);
    if (!match) return null;
    url.pathname = `/docx/${match[1]}`;
    url.search = '';
    url.hash = '';
    return { url: url.toString(), token: match[1] };
  } catch {
    return null;
  }
}

function createDocumentReference(envelope) {
  if (envelope?.ok !== true) fail('CREATE_FAILED', '飞书文档创建失败，本地稿已保留。');
  const document = envelope?.data?.document ?? envelope?.data;
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    fail('CREATE_INVALID_RESPONSE', '飞书文档创建结果无法核验，本地稿已保留。');
  }
  const rawToken = document.document_id
    ?? document.documentId
    ?? document.document_token
    ?? document.doc_token
    ?? document.token;
  const rawUrl = document.url ?? document.document_url ?? document.doc_url;
  const token = String(rawToken ?? '').trim();
  const trustedUrl = normalizeTrustedDocxUrl(rawUrl);
  if (!DOCUMENT_TOKEN_PATTERN.test(token) || !trustedUrl || trustedUrl.token !== token) {
    fail('UNTRUSTED_DOCUMENT_REFERENCE', '飞书返回了不可信的文档地址，已停止交付。');
  }
  return { token, url: trustedUrl.url };
}

function fetchedDocument(envelope) {
  if (envelope?.ok !== true) fail('READBACK_FAILED', '飞书文档回读失败，本地稿已保留。');
  const document = envelope?.data?.document ?? envelope?.data;
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    fail('READBACK_INVALID_RESPONSE', '飞书文档回读结果无法核验，本地稿已保留。');
  }
  const content = typeof document.content === 'string'
    ? document.content
    : typeof document.markdown === 'string'
      ? document.markdown
      : '';
  if (!content || Buffer.byteLength(content, 'utf8') > MAX_FETCHED_LENGTH) {
    fail('READBACK_EMPTY', '飞书文档正文为空或异常，本地稿已保留。');
  }
  const title = typeof document.title === 'string' ? document.title : '';
  return { title, content };
}

function countOccurrences(value, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function validateReadback({ expectedTitle, marker, anchors, envelope }) {
  const document = fetchedDocument(envelope);
  const comparableBody = comparableText(document.content);
  const comparableTitle = comparableText(document.title || document.content);
  if (!comparableTitle.includes(comparableText(expectedTitle))) {
    fail('READBACK_TITLE_MISMATCH', '飞书文档标题回读不一致，本地稿已保留。');
  }
  if (comparableBody.length < 20) fail('READBACK_EMPTY', '飞书文档正文为空，本地稿已保留。');
  if (countOccurrences(document.content, marker) !== 1) {
    fail('READBACK_MARKER_MISMATCH', '飞书文档交付标识回读不一致，本地稿已保留。');
  }
  if (!anchors.every((anchor) => comparableBody.includes(anchor))) {
    fail('READBACK_CONTENT_MISMATCH', '飞书文档正文回读不完整，本地稿已保留。');
  }
}

function publicRecord(record) {
  return Object.freeze({
    id: record.id,
    label: record.title,
    kind: 'LARK_DOC',
    state: 'verified',
  });
}

function validStoredRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!DELIVERY_ID_PATTERN.test(String(value.id || ''))) return false;
  if (!['pending', 'uncertain', 'verified'].includes(value.state)) return false;
  if (!/^[a-f0-9]{64}$/u.test(String(value.key || ''))) return false;
  if (!/^[a-f0-9]{64}$/u.test(String(value.contentHash || ''))) return false;
  if (typeof value.title !== 'string' || !value.title) return false;
  if (value.state !== 'verified') return true;
  const trustedUrl = normalizeTrustedDocxUrl(value.url);
  return DOCUMENT_TOKEN_PATTERN.test(String(value.token || ''))
    && trustedUrl?.token === value.token;
}

async function discoverLarkBinary(configured = 'lark-cli', homeDir = os.homedir()) {
  if (path.isAbsolute(configured)) {
    await access(configured);
    return configured;
  }
  if (configured !== 'lark-cli') return configured;
  const candidates = [
    path.join(homeDir, '.local', 'bin', 'lark-cli'),
    '/opt/homebrew/bin/lark-cli',
    '/usr/local/bin/lark-cli',
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the PATH fallback.
    }
  }
  return configured;
}

export class LarkDocumentPublisher {
  constructor(options = {}) {
    if (!options.dataDir) throw new TypeError('dataDir is required');
    this.dataDir = path.resolve(options.dataDir);
    this.stagingDir = path.join(this.dataDir, STAGING_DIRECTORY);
    this.registryPath = path.join(this.dataDir, REGISTRY_FILE);
    this.binary = options.binary || process.env.LARK_CLI_BIN || 'lark-cli';
    this.execJson = options.execJson || execFileJson;
    this.resolveBinary = options.resolveBinary || (options.execJson
      ? async () => this.binary
      : () => discoverLarkBinary(this.binary));
    this.now = options.now || (() => new Date());
    this.recordsByKey = new Map();
    this.recordsById = new Map();
    this.pending = new Map();
    this.initialized = false;
    this.registryReadable = true;
    this.persistChain = Promise.resolve();
    this.resolvedBinary = null;
  }

  async init() {
    if (this.initialized) return this;
    await mkdir(this.stagingDir, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.registryPath, 'utf8'));
      const records = Array.isArray(parsed?.records) ? parsed.records : [];
      for (const record of records) {
        if (!validStoredRecord(record) || this.recordsByKey.has(record.key)) continue;
        this.recordsByKey.set(record.key, record);
        this.recordsById.set(record.id, record);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // Corrupt local state fails closed. Overwriting it and creating a new
        // document could duplicate an earlier remote delivery.
        this.recordsByKey.clear();
        this.recordsById.clear();
        this.registryReadable = false;
      }
    }
    if (this.registryReadable) await this.#persist();
    this.initialized = true;
    return this;
  }

  async sourceStatus() {
    if (!this.registryReadable) {
      return {
        id: 'lark-publisher', name: '飞书文档交付', state: 'error',
        detail: '本地飞书交付记录无法核验，已停止发布以避免重复文档。',
      };
    }
    try {
      const binary = this.resolvedBinary || await this.resolveBinary();
      this.resolvedBinary = binary;
      const auth = await this.execJson(binary, ['auth', 'status', '--json', '--verify'], {
        timeout: 8_000,
        cwd: this.dataDir,
        env: CLI_ENV,
        publicMessage: '飞书认证状态不可用。',
      });
      const userIdentity = auth?.identities?.user;
      const ready = auth?.verified === true
        && userIdentity?.status === 'ready'
        && userIdentity?.tokenStatus === 'valid';
      return ready
        ? {
            id: 'lark-publisher', name: '飞书文档交付', state: 'connected',
            detail: '个人飞书文档发布与回读校验已就绪。',
          }
        : {
            id: 'lark-publisher', name: '飞书文档交付', state: 'unavailable',
            detail: '飞书用户身份尚未就绪；本地结果仍可正常交付。',
          };
    } catch {
      return {
        id: 'lark-publisher', name: '飞书文档交付', state: 'error',
        detail: '飞书文档发布授权未通过校验；本地结果仍可正常交付。',
      };
    }
  }

  async publish({ jobId, title, content }) {
    await this.init();
    if (!this.registryReadable) {
      fail('REGISTRY_UNAVAILABLE', '本地交付记录无法核验，已停止发布以避免重复文档。');
    }
    const normalizedJobId = String(jobId ?? '').normalize('NFC').trim();
    if (!normalizedJobId || normalizedJobId.length > 200 || /[\u0000-\u001f\u007f]/u.test(normalizedJobId)) {
      fail('INVALID_JOB_ID', '交付任务标识无效。');
    }
    const safeTitle = sanitizeTitle(title);
    const source = normalizeSource(content);
    const contentHash = sha256(`${safeTitle}\0${source}`);
    const key = sha256(`${normalizedJobId}\0${contentHash}`);
    if (this.pending.has(key)) return this.pending.get(key);
    const existing = this.recordsByKey.get(key);
    if (existing?.state === 'verified') return publicRecord(existing);
    if (existing) fail('DELIVERY_RECONCILIATION_REQUIRED', '这份交付已尝试发布，需先核对远端状态。');

    const task = this.#publishOnce({
      key,
      contentHash,
      title: safeTitle,
      source,
    }).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, task);
    return task;
  }

  resolvePrivateDelivery(rawId) {
    const id = String(rawId ?? '');
    if (!DELIVERY_ID_PATTERN.test(id)) return null;
    const record = this.recordsById.get(id);
    if (!record || record.state !== 'verified' || !validStoredRecord(record)) return null;
    return {
      id: record.id,
      title: record.title,
      token: record.token,
      url: record.url,
      createdAt: record.createdAt,
    };
  }

  async #publishOnce({ key, contentHash, title, source }) {
    const blocks = sourceBlocks(source);
    const anchors = anchorCandidates(blocks);
    const marker = `cike_delivery_${key.slice(0, 24)}`;
    const xml = renderLarkXml(blocks, marker);
    const id = `lark-doc-${key.slice(0, 24)}`;
    const stagingRelativePath = path.posix.join(STAGING_DIRECTORY, `draft-${key.slice(0, 24)}.xml`);
    const stagingPath = path.join(this.dataDir, ...stagingRelativePath.split('/'));
    await writeFile(stagingPath, xml, { encoding: 'utf8', mode: 0o600, flag: 'wx' }).catch(async (error) => {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readFile(stagingPath, 'utf8');
      if (sha256(existing) !== sha256(xml)) fail('STAGING_CONFLICT', '本地交付稿校验失败，已停止发布。');
    });
    const mode = (await stat(stagingPath)).mode & 0o777;
    if (mode !== 0o600) fail('STAGING_PERMISSION', '本地交付稿权限不安全，已停止发布。');

    const attemptedAt = this.now().toISOString();
    const pendingRecord = {
      id,
      key,
      contentHash,
      title,
      marker,
      anchors,
      stagingRelativePath,
      state: 'pending',
      attemptedAt,
    };
    this.recordsByKey.set(key, pendingRecord);
    this.recordsById.set(id, pendingRecord);
    await this.#persist();

    try {
      const binary = this.resolvedBinary || await this.resolveBinary();
      this.resolvedBinary = binary;
      const auth = await this.execJson(binary, ['auth', 'status', '--json', '--verify'], {
        timeout: 8_000,
        cwd: this.dataDir,
        env: CLI_ENV,
        publicMessage: '飞书认证状态不可用。',
      });
      const userIdentity = auth?.identities?.user;
      if (auth?.verified !== true || userIdentity?.status !== 'ready' || userIdentity?.tokenStatus !== 'valid') {
        fail('AUTH_NOT_READY', '飞书用户身份尚未就绪，本地稿已保留。');
      }

      const created = await this.execJson(binary, [
        'docs',
        '+create',
        '--as',
        'user',
        '--parent-position',
        'my_library',
        '--doc-format',
        'xml',
        '--title',
        title,
        '--content',
        `@${stagingRelativePath}`,
        '--format',
        'json',
      ], {
        timeout: 45_000,
        maxBuffer: 2 * 1024 * 1024,
        cwd: this.dataDir,
        env: CLI_ENV,
        publicMessage: '飞书文档创建失败，本地稿已保留。',
      });
      const reference = createDocumentReference(created);
      const fetched = await this.execJson(binary, [
        'docs',
        '+fetch',
        '--doc',
        reference.token,
        '--doc-format',
        'xml',
        '--detail',
        'simple',
        '--as',
        'user',
        '--format',
        'json',
      ], {
        timeout: 30_000,
        maxBuffer: MAX_FETCHED_LENGTH,
        cwd: this.dataDir,
        env: CLI_ENV,
        publicMessage: '飞书文档回读失败，本地稿已保留。',
      });
      validateReadback({ expectedTitle: title, marker, anchors, envelope: fetched });

      const verifiedRecord = {
        ...pendingRecord,
        state: 'verified',
        token: reference.token,
        url: reference.url,
        createdAt: this.now().toISOString(),
      };
      this.recordsByKey.set(key, verifiedRecord);
      this.recordsById.set(id, verifiedRecord);
      await this.#persist();
      return publicRecord(verifiedRecord);
    } catch (error) {
      const uncertainRecord = {
        ...pendingRecord,
        state: 'uncertain',
        failedAt: this.now().toISOString(),
      };
      this.recordsByKey.set(key, uncertainRecord);
      this.recordsById.set(id, uncertainRecord);
      await this.#persist();
      if (error instanceof LarkDocumentPublisherError) throw error;
      fail('PUBLISH_FAILED', '飞书文档发布未完成，本地稿已保留。');
    }
  }

  async #persist() {
    const write = async () => {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      const temporary = `${this.registryPath}.tmp`;
      const records = [...this.recordsByKey.values()];
      await writeFile(temporary, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporary, this.registryPath);
    };
    this.persistChain = this.persistChain.then(write, write);
    return this.persistChain;
  }
}

export const larkDocumentPublisherInternals = {
  comparableText,
  containsSensitiveMaterial,
  normalizeTrustedDocxUrl,
  renderLarkXml,
  sourceBlocks,
};

import { randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const REGISTRY_VERSION = 1;
const MAX_RECORDS = 200;
const DELIVERY_ID_PATTERN = /^delivery-[a-f0-9]{20}$/u;
const PAPER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/u;
const DELIVERY_KIND_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/u;
const DELIVERY_ROLE_PATTERN = /^[a-z][a-z0-9_]{1,31}$/u;
const READER_ORIGIN = 'http://127.0.0.1:4173';

function opaqueId(prefix) {
  return prefix === 'delivery'
    ? `${prefix}-${randomBytes(10).toString('hex')}`
    : `${prefix}-${randomBytes(16).toString('base64url')}`;
}

function cleanLabel(value, fallback = '已准备的交付') {
  const label = String(value || '')
    .replace(/[\u0000-\u001F\u007F]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 96);
  return label || fallback;
}

function cleanRole(value) {
  const role = String(value || 'primary').trim().toLowerCase();
  if (role === 'translation') return 'zh_version';
  return DELIVERY_ROLE_PATTERN.test(role) ? role : 'primary';
}

function cleanActionLabel(value) {
  return cleanLabel(value, '打开结果').slice(0, 24);
}

function isTrustedLarkHost(hostname) {
  return ['feishu.cn', 'larkoffice.com', 'larksuite.com'].some((domain) => (
    hostname === domain || hostname.endsWith(`.${domain}`)
  ));
}

export function normalizeLarkDocumentUrl(value) {
  const input = String(value || '').trim();
  if (!input || input.length > 2_048) return null;
  try {
    const url = new URL(input);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || !isTrustedLarkHost(url.hostname.toLowerCase())
      || !/^\/docx\/[A-Za-z0-9_-]{8,128}\/?$/u.test(url.pathname)
    ) return null;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizePaperReaderUrl(value) {
  const input = String(value || '').trim();
  if (!input || input.length > 256) return null;
  try {
    const url = new URL(input);
    if (
      url.origin !== READER_ORIGIN
      || url.pathname !== '/'
      || url.hash
      || [...url.searchParams.keys()].some((key) => key !== 'paper')
      || [...url.searchParams.keys()].length !== 1
      || !PAPER_ID_PATTERN.test(url.searchParams.get('paper') || '')
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function publicReference(record) {
  return {
    id: record.id,
    label: record.label,
    actionLabel: record.actionLabel,
    kind: record.kind,
    role: record.role,
    state: record.state === 'ready' ? 'ready' : 'error',
    ...(record.state === 'error' ? { error: record.error || '交付内容暂时不可用。' } : {}),
  };
}

async function defaultPaperStatusChecker(paperId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${READER_ORIGIN}/api/papers/${encodeURIComponent(paperId)}`, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function validatePaperBundle(record, paperStatusChecker) {
  try {
    if (!PAPER_ID_PATTERN.test(record.paperId)) throw new Error('paper');
    const status = await paperStatusChecker(record.paperId);
    if (
      status?.status !== 'ready'
      || status?.ready !== true
      || status?.validation?.integrity !== 'verified'
      || !Array.isArray(status?.passages)
      || status.passages.length < 1
      || status.passages.some((passage) => (
        passage?.translationState !== 'done'
        || typeof passage?.english !== 'string'
        || !passage.english.trim()
        || typeof passage?.chinese !== 'string'
        || !passage.chinese.trim()
      ))
      || typeof (status?.assets?.sourcePdf || status?.paper?.sourcePdfUrl) !== 'string'
    ) throw new Error('not-ready');

    const readerUrl = new URL('/', READER_ORIGIN);
    readerUrl.searchParams.set('paper', record.paperId);
    const url = normalizePaperReaderUrl(readerUrl.toString());
    if (!url) throw new Error('reader');
    return {
      ok: true,
      launch: { type: 'external_url', policy: 'local_paper_reader', url },
      loadedTarget: 'PAPER_READER',
    };
  } catch {
    return { ok: false, error: '论文原文或中文版未通过完整性校验。' };
  }
}

async function validateRegisteredFile(record, { inApp = false } = {}) {
  try {
    const configuredPath = path.resolve(String(record.filePath || ''));
    const info = await lstat(configuredPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('file');
    const canonicalPath = await realpath(configuredPath);
    if (canonicalPath !== configuredPath) throw new Error('file');
    return {
      ok: true,
      launch: inApp
        ? { type: 'in_app_result', policy: 'registered_local_result' }
        : { type: 'local_file', policy: 'registered_local_file', path: canonicalPath },
      loadedTarget: inApp ? 'GENERIC_RESULT' : record.kind,
    };
  } catch {
    return { ok: false, error: '本地交付文件暂时不可用。' };
  }
}

function createPaperBundleAdapter(paperStatusChecker = defaultPaperStatusChecker) {
  return Object.freeze({
    async prepare(input) {
      const paperId = String(input.paperId || '').trim();
      return PAPER_ID_PATTERN.test(paperId) ? { paperId } : {};
    },
    sanitize(value) {
      const paperId = String(value.paperId || '');
      return PAPER_ID_PATTERN.test(paperId) ? { paperId } : null;
    },
    resolve(record) {
      return validatePaperBundle(record, paperStatusChecker);
    },
  });
}

const larkDocumentAdapter = Object.freeze({
  async prepare(input) {
    const url = normalizeLarkDocumentUrl(input.url);
    return url ? { url } : {};
  },
  sanitize(value) {
    const url = normalizeLarkDocumentUrl(value.url);
    return url ? { url } : (value.state === 'error' ? {} : null);
  },
  async resolve(record) {
    const url = normalizeLarkDocumentUrl(record.url);
    return url
      ? {
        ok: true,
        launch: { type: 'external_url', policy: 'trusted_lark_document', url },
        loadedTarget: 'LARK_DOC',
      }
      : { ok: false, error: '飞书文档地址未通过安全校验。' };
  },
});

const registeredFileAdapter = Object.freeze({
  async prepare(input) {
    const requestedPath = path.resolve(String(input.filePath || ''));
    try {
      const info = await lstat(requestedPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('file');
      return { filePath: await realpath(requestedPath) };
    } catch {
      return { filePath: requestedPath };
    }
  },
  sanitize(value) {
    const filePath = String(value.filePath || '');
    return path.isAbsolute(filePath) ? { filePath } : null;
  },
  resolve: validateRegisteredFile,
});

const genericResultAdapter = Object.freeze({
  ...registeredFileAdapter,
  resolve(record) {
    return validateRegisteredFile(record, { inApp: true });
  },
});

function builtinAdapters(options = {}) {
  return new Map([
    ['PAPER_BUNDLE', createPaperBundleAdapter(options.paperStatusChecker)],
    ['LARK_DOC', larkDocumentAdapter],
    ['LOCAL_FILE', registeredFileAdapter],
    ['GENERIC_RESULT', genericResultAdapter],
  ]);
}

function validAdapter(adapter) {
  return Boolean(
    adapter
    && typeof adapter.prepare === 'function'
    && typeof adapter.sanitize === 'function'
    && typeof adapter.resolve === 'function',
  );
}

function sanitizeStoredRecord(value, adapters) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = String(value.id || '');
  const kind = String(value.kind || '');
  const adapter = adapters.get(kind);
  if (!DELIVERY_ID_PATTERN.test(id) || !DELIVERY_KIND_PATTERN.test(kind) || !adapter) return null;
  const base = {
    id,
    kind,
    label: cleanLabel(value.label),
    actionLabel: cleanActionLabel(value.actionLabel),
    role: cleanRole(value.role),
    state: value.state === 'ready' ? 'ready' : 'error',
    error: typeof value.error === 'string' ? cleanLabel(value.error, '交付内容暂时不可用。') : undefined,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
  };
  const privateFields = adapter.sanitize(value);
  return privateFields ? { ...base, ...privateFields } : null;
}

export class DeliveryRegistry {
  constructor(options = {}) {
    this.dataDir = options.dataDir;
    this.registryFile = path.join(this.dataDir, 'delivery-registry.json');
    this.records = new Map();
    this.adapters = builtinAdapters({ paperStatusChecker: options.paperStatusChecker });
    this.persistChain = Promise.resolve();
    this.now = options.now || (() => new Date());
    for (const [kind, adapter] of Object.entries(options.adapters || {})) {
      this.registerAdapter(kind, adapter);
    }
  }

  registerAdapter(rawKind, adapter) {
    const kind = String(rawKind || '').trim().toUpperCase();
    if (!DELIVERY_KIND_PATTERN.test(kind) || !validAdapter(adapter)) {
      throw new TypeError('Invalid delivery adapter');
    }
    this.adapters.set(kind, adapter);
    return this;
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.registryFile, 'utf8'));
      const stored = Array.isArray(parsed?.records) ? parsed.records : [];
      for (const candidate of stored.slice(0, MAX_RECORDS)) {
        const record = sanitizeStoredRecord(candidate, this.adapters);
        if (record) this.records.set(record.id, record);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.records.clear();
    }
    await this.#persist();
    return this;
  }

  listReferences() {
    return [...this.records.values()].map(publicReference);
  }

  getReference(rawId) {
    const id = String(rawId || '');
    const record = DELIVERY_ID_PATTERN.test(id) ? this.records.get(id) : null;
    return record ? publicReference(record) : null;
  }

  async registerPaperBundle(input = {}) {
    return this.registerDelivery({ ...input, kind: 'PAPER_BUNDLE' });
  }

  async registerLarkDocument(input = {}) {
    return this.registerDelivery({ ...input, kind: 'LARK_DOC' });
  }

  async registerLocalFile(input = {}) {
    return this.registerDelivery({ ...input, kind: 'LOCAL_FILE' });
  }

  async registerGenericResult(input = {}) {
    return this.registerDelivery({ ...input, kind: 'GENERIC_RESULT' });
  }

  async registerDelivery(input = {}) {
    const kind = String(input.kind || '').trim().toUpperCase();
    const adapter = this.adapters.get(kind);
    if (!DELIVERY_KIND_PATTERN.test(kind) || !adapter) {
      throw new TypeError(`Unsupported delivery kind: ${kind || 'unknown'}`);
    }
    const privateFields = await adapter.prepare(input);
    const record = {
      id: opaqueId('delivery'),
      kind,
      label: cleanLabel(input.label),
      actionLabel: cleanActionLabel(input.actionLabel),
      role: cleanRole(input.role),
      state: 'error',
      error: '交付内容尚未通过校验。',
      createdAt: this.now().toISOString(),
      ...privateFields,
    };
    const validation = await adapter.resolve(record);
    record.state = validation.ok ? 'ready' : 'error';
    record.error = validation.ok ? undefined : validation.error;
    this.#store(record);
    await this.#persist();
    return publicReference(record);
  }

  async resolve(rawId) {
    const id = String(rawId || '');
    const record = DELIVERY_ID_PATTERN.test(id) ? this.records.get(id) : null;
    if (!record) return { ok: false, error: 'DELIVERY_NOT_FOUND' };

    const adapter = this.adapters.get(record.kind);
    if (!adapter) return { ok: false, error: 'DELIVERY_UNAVAILABLE', reference: publicReference(record) };
    const validation = await adapter.resolve(record);
    const nextState = validation.ok ? 'ready' : 'error';
    const nextError = validation.ok ? undefined : validation.error;
    if (record.state !== nextState || record.error !== nextError) {
      record.state = nextState;
      record.error = nextError;
      await this.#persist();
    }
    return validation.ok
      ? {
        ok: true,
        launch: validation.launch,
        presentation: validation.launch?.type === 'in_app_result' ? 'in_app' : 'external',
        loadedTarget: String(validation.loadedTarget || record.kind).slice(0, 48),
        reference: publicReference(record),
      }
      : { ok: false, error: 'DELIVERY_UNAVAILABLE', reference: publicReference(record) };
  }

  #store(record) {
    this.records.delete(record.id);
    this.records.set(record.id, record);
    while (this.records.size > MAX_RECORDS) this.records.delete(this.records.keys().next().value);
  }

  async #persist() {
    const records = [...this.records.values()];
    const payload = `${JSON.stringify({ version: REGISTRY_VERSION, records }, null, 2)}\n`;
    this.persistChain = this.persistChain.then(async () => {
      const temporaryPath = `${this.registryFile}.tmp`;
      await writeFile(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.registryFile);
    });
    return this.persistChain;
  }
}

export const deliveryRegistryInternals = {
  DELIVERY_ID_PATTERN,
  PAPER_ID_PATTERN,
  READER_ORIGIN,
  defaultPaperStatusChecker,
};

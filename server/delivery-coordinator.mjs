const DEFAULT_DEEPREAD_ORIGIN = 'http://127.0.0.1:4173';
const TARGET_PATTERN = /^[a-z][a-z0-9_]{1,31}$/u;
const PAPER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/u;
const MAX_PAPER_WAIT_MS = 5 * 60 * 1_000;

function compactText(value, fallback, maxLength = 120) {
  const text = String(value || '')
    .replace(/[\u0000-\u001F\u007F]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
  return text || fallback;
}

function safeDeepReadOrigin(value) {
  try {
    const url = new URL(String(value || DEFAULT_DEEPREAD_ORIGIN));
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function paperRequest(payload) {
  const paper = payload?.paper;
  if (!paper || typeof paper !== 'object' || Array.isArray(paper)) return null;
  const title = compactText(paper.title, '', 600);
  const pdfUrl = String(paper.pdfUrl || '').trim();
  if (!title || !pdfUrl || pdfUrl.length > 2_048) return null;
  let parsed;
  try {
    parsed = new URL(pdfUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  const authors = Array.isArray(paper.authors)
    ? paper.authors.map((author) => compactText(author, '', 120)).filter(Boolean).slice(0, 30)
    : [];
  return {
    sourcePdfUrl: parsed.toString(),
    title,
    author: authors.join('、').slice(0, 1_200),
  };
}

function verifiedPaperStatus(value, expectedPaperId) {
  return Boolean(
    value
    && value.paperId === expectedPaperId
    && value.status === 'ready'
    && value.ready === true
    && value.validation?.integrity === 'verified'
    && Array.isArray(value.passages)
    && value.passages.length > 0
    && value.passages.every((passage) => (
      passage?.translationState === 'done'
      && typeof passage?.english === 'string'
      && passage.english.trim()
      && typeof passage?.chinese === 'string'
      && passage.chinese.trim()
    ))
  );
}

export class DeliveryCoordinator {
  constructor(options = {}) {
    if (!options.registry || typeof options.registry.getReference !== 'function') {
      throw new TypeError('delivery registry is required');
    }
    this.registry = options.registry;
    this.larkPublisher = options.larkPublisher || null;
    this.fetchImpl = options.fetchImpl || fetch;
    this.deepReadOrigin = safeDeepReadOrigin(options.deepReadOrigin);
    if (!this.deepReadOrigin) throw new TypeError('DeepRead must use a 127.0.0.1 loopback origin');
    this.pollIntervalMs = Math.max(50, Number(options.pollIntervalMs) || 500);
    this.paperTimeoutMs = Math.min(
      MAX_PAPER_WAIT_MS,
      Math.max(1_000, Number(options.paperTimeoutMs) || MAX_PAPER_WAIT_MS),
    );
    this.sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.handlers = new Map();
    this.registerTarget('generic_result', (context) => this.#prepareGenericResult(context));
    this.registerTarget('local_file', (context) => this.#prepareLocalFile(context));
    this.registerTarget('lark_doc', (context) => this.#prepareLarkDocument(context));
    this.registerTarget('paper_bundle', (context) => this.#preparePaperBundle(context));
    for (const [target, handler] of Object.entries(options.handlers || {})) this.registerTarget(target, handler);
  }

  registerTarget(rawTarget, handler) {
    const target = String(rawTarget || '').trim().toLowerCase();
    if (!TARGET_PATTERN.test(target) || typeof handler !== 'function') throw new TypeError('invalid delivery target');
    this.handlers.set(target, handler);
    return this;
  }

  async prepare(context = {}) {
    const target = String(context?.job?.deliveryTarget || 'generic_result').trim().toLowerCase();
    // A completed Codex response is already a useful deliverable. Register its
    // local, in-app result before attempting any optional integration so a
    // flaky reader, publisher or custom adapter can never discard the work.
    const genericResult = await this.#prepareGenericResult(context);
    const genericReferences = this.#verifiedReadyReferences(genericResult);
    if (target === 'generic_result') return { deliveries: genericReferences };

    const handler = this.handlers.get(target);
    if (!handler) {
      return {
        deliveries: genericReferences,
        enhancement: { target, state: 'error' },
      };
    }

    try {
      const enhancedResult = await handler(context);
      const enhancedReferences = this.#verifiedReadyReferences(enhancedResult);
      return {
        // Specialized primary deliveries stay the first-choice action, while
        // the generic result remains inside the public, persisted reference
        // set as the universal in-app fallback. Keep the total within the
        // runner's three-delivery UI contract.
        deliveries: [...enhancedReferences.slice(0, 2), ...genericReferences],
        enhancement: { target, state: 'ready' },
      };
    } catch {
      return {
        deliveries: genericReferences,
        enhancement: { target, state: 'error' },
      };
    }
  }

  #verifiedReadyReferences(result) {
    const requested = Array.isArray(result?.deliveries) ? result.deliveries : [];
    const references = requested.map((delivery) => this.registry.getReference(delivery?.id));
    if (!references.length || references.some((delivery) => !delivery)) {
      throw new Error('delivery was not registered');
    }
    const ready = references.filter((delivery) => delivery.state === 'ready');
    if (!ready.length) throw new Error('delivery not ready');
    return ready;
  }

  async #prepareGenericResult({ job = {}, artifactPath } = {}) {
    const reference = await this.registry.registerGenericResult({
      filePath: artifactPath,
      label: compactText(job.deliveryTitle || job.title, 'Codex 完成结果', 96),
      actionLabel: compactText(job.deliveryActionLabel, '查看结果', 24),
      role: 'primary',
    });
    return { deliveries: [reference] };
  }

  async #prepareLocalFile({ job = {}, artifactPath } = {}) {
    const reference = await this.registry.registerLocalFile({
      filePath: artifactPath,
      label: compactText(job.deliveryTitle || job.title, '本地交付文件', 96),
      actionLabel: '打开文件',
      role: 'primary',
    });
    return { deliveries: [reference] };
  }

  async #prepareLarkDocument({ job = {}, finalText } = {}) {
    if (!this.larkPublisher?.publish || !this.larkPublisher?.resolvePrivateDelivery) {
      throw new Error('Lark document publishing is unavailable');
    }
    const published = await this.larkPublisher.publish({
      jobId: compactText(job.id, '', 200),
      title: compactText(job.deliveryTitle || job.title, '此刻完成方案', 120),
      content: String(finalText || '').trim(),
    });
    if (published?.state !== 'verified') throw new Error('Lark document was not verified');
    const privateDelivery = this.larkPublisher.resolvePrivateDelivery(published.id);
    if (!privateDelivery?.url) throw new Error('Lark document URL is unavailable');
    const reference = await this.registry.registerLarkDocument({
      url: privateDelivery.url,
      label: compactText(privateDelivery.title || job.deliveryTitle || job.title, '飞书方案文档', 96),
      actionLabel: '打开方案',
      role: 'primary',
    });
    return { deliveries: [reference] };
  }

  async #preparePaperBundle({ deliveryPayload } = {}) {
    const requestBody = paperRequest(deliveryPayload);
    if (!requestBody) throw new Error('verified paper metadata is missing');
    const prepared = await this.#json('/api/papers/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(requestBody),
    }, new Set([202]));
    const paperId = String(prepared?.paperId || '');
    if (!PAPER_ID_PATTERN.test(paperId) || prepared?.status !== 'preparing') throw new Error('DeepRead rejected paper preparation');

    const deadline = Date.now() + this.paperTimeoutMs;
    let ready = null;
    while (Date.now() < deadline) {
      const status = await this.#json(`/api/papers/${encodeURIComponent(paperId)}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      }, new Set([200, 202, 422]));
      if (status?.status === 'failed') throw new Error('DeepRead paper preparation failed');
      if (verifiedPaperStatus(status, paperId)) {
        ready = status;
        break;
      }
      if (status?.status !== 'preparing') throw new Error('DeepRead returned an invalid paper state');
      await this.sleep(this.pollIntervalMs);
    }
    if (!ready) throw new Error('DeepRead paper preparation timed out');

    const reference = await this.registry.registerPaperBundle({
      paperId,
      label: compactText(ready.paper?.chineseTitle || ready.paper?.title || requestBody.title, '论文双语阅读包', 96),
      actionLabel: '阅读论文',
      role: 'primary',
    });
    return { deliveries: [reference] };
  }

  async #json(pathname, init, allowedStatuses) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.fetchImpl(`${this.deepReadOrigin}${pathname}`, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
      });
      if (!allowedStatuses.has(response.status)) throw new Error('DeepRead request failed');
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

export const deliveryCoordinatorInternals = {
  DEFAULT_DEEPREAD_ORIGIN,
  paperRequest,
  safeDeepReadOrigin,
  verifiedPaperStatus,
};

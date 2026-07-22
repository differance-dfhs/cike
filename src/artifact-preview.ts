const ARTIFACT_PATH_PREFIX = '/api/artifacts/';
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.(?:html|md|txt|json)$/u;

export interface ArtifactPayload {
  content: string;
  contentType: string;
}

export interface NativeArtifactSection {
  kind: 'conclusion' | 'evidence' | 'next';
  title: string;
  items: string[];
}

const UI_PRIVATE_TEXT_PATTERN = /(?:\b(?:(?:(?:access|refresh|session)[_-]?)?token|app[_-]?secret|api[_-]?key|authorization|password|cookie)\b\s*[:=]\s*\S+|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\b(?:sk-(?:proj-)?|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9._-]{12,}\b)/giu;

function nativeSectionKind(title: string): NativeArtifactSection['kind'] {
  if (/(?:核验|事实|证据|依据|发现|变化|来源|未知)/u.test(title)) return 'evidence';
  if (/(?:下一步|建议|行动|待办|需要确认|待确认|拍板|需要老大)/u.test(title)) return 'next';
  return 'conclusion';
}

function cleanNativeLine(value: string, maxLength = 140): string {
  return value
    .replace(/<PROACTIVE_UI_PRESENTATION>[\s\S]*?<\/PROACTIVE_UI_PRESENTATION>/gu, '')
    .replace(UI_PRIVATE_TEXT_PATTERN, '[凭证已隐藏]')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^\s*(?:#{1,6}|[-*+]|\d+[.)])\s*/u, '')
    .replace(/[*_`~]/gu, '')
    .replace(/[—–]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

function splitNativeItems(value: string): string[] {
  const clean = cleanNativeLine(value, 360);
  if (!clean) return [];
  const sentences = clean.split(/(?<=[。！？；])\s*/u).filter(Boolean);
  return (sentences.length > 1 ? sentences : [clean])
    .map((item) => cleanNativeLine(item))
    .filter(Boolean)
    .slice(0, 3);
}

/** Convert a legacy Codex document into bounded plain data for native UI. */
export function parseNativeArtifactText(value: string): NativeArtifactSection[] {
  const lines = String(value || '')
    .replace(/<PROACTIVE_UI_PRESENTATION>[\s\S]*?<\/PROACTIVE_UI_PRESENTATION>/gu, '')
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);
  const sections: NativeArtifactSection[] = [];
  let current: NativeArtifactSection | null = null;

  const startSection = (rawTitle: string): NativeArtifactSection | null => {
    const title = cleanNativeLine(rawTitle, 20);
    if (!title) return null;
    const section: NativeArtifactSection = { kind: nativeSectionKind(title), title, items: [] };
    sections.push(section);
    return section;
  };

  for (const rawLine of lines) {
    if (/^Codex 的本地执行结果/u.test(rawLine)) continue;
    const markdownHeading = rawLine.match(/^#{1,6}\s+(.+)$/u)?.[1]
      ?? rawLine.match(/^\*\*([^*]{2,32})\*\*$/u)?.[1];
    if (markdownHeading) {
      current = startSection(markdownHeading);
      continue;
    }

    const labeled = rawLine.match(/^([^：:]{2,20})[：:]\s*(.+)$/u);
    if (labeled && /(?:核验|事实|证据|依据|判断|推断|结论|摘要|发现|下一步|建议|行动|待办|待确认)/u.test(labeled[1])) {
      current = startSection(labeled[1]);
      if (current) current.items.push(...splitNativeItems(labeled[2]));
      continue;
    }

    if (!current) continue;
    current.items.push(...splitNativeItems(rawLine));
    current.items = current.items.slice(0, 4);
  }

  const useful = sections.filter((section) => section.items.length);
  const deduplicated: NativeArtifactSection[] = [];
  for (const section of useful) {
    const existing = deduplicated.find((item) => item.kind === section.kind);
    if (existing) {
      existing.items = [...existing.items, ...section.items]
        .filter((item, index, all) => all.indexOf(item) === index)
        .slice(0, 4);
    } else {
      deduplicated.push(section);
    }
  }
  return deduplicated.slice(0, 3);
}

export function extractNativeArtifactSections(content: string, contentType: string): NativeArtifactSection[] {
  if (!/text\/html/iu.test(contentType)) return parseNativeArtifactText(content);
  const document = new DOMParser().parseFromString(content, 'text/html');
  document.querySelectorAll('script, style, iframe, object, embed, form').forEach((node) => node.remove());
  const pre = document.body.querySelector('pre');
  if (pre?.textContent?.trim()) return parseNativeArtifactText(pre.textContent);
  const blocks = [...document.body.querySelectorAll('h1, h2, h3, h4, p, li')]
    .map((node) => node.textContent?.trim() ?? '')
    .filter(Boolean);
  return parseNativeArtifactText(blocks.join('\n'));
}

function isLoopback(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
}

function isArtifactServiceOrigin(url: URL): boolean {
  return isLoopback(url) && /^\d{1,5}$/u.test(url.port) && Number(url.port) > 0 && Number(url.port) <= 65_535;
}

/**
 * Artifact links are data from the local engine, not arbitrary navigation.
 * Resolve and validate them before either the Electron bridge or fetch sees
 * the value so a compromised snapshot cannot turn the viewer into a browser.
 */
export function trustedArtifactUrl(
  rawUrl: string,
  currentHref: string,
  apiBase?: string,
): string | null {
  let target: URL;
  try {
    target = new URL(rawUrl, currentHref);
  } catch {
    return null;
  }

  if (!isLoopback(target) || target.username || target.password || target.search || target.hash) return null;

  let name: string;
  try {
    name = decodeURIComponent(target.pathname.slice(ARTIFACT_PATH_PREFIX.length));
  } catch {
    return null;
  }
  if (!target.pathname.startsWith(ARTIFACT_PATH_PREFIX) || !SAFE_ARTIFACT_NAME.test(name)) return null;

  // Vite presents proxied relative artifact URLs on :5189. Canonicalize that
  // one development shape to the pinned service rather than trusting the dev
  // origin as an artifact host.
  try {
    const current = new URL(currentHref);
    if (target.origin === current.origin && isLoopback(current) && current.port === '5189') {
      target = new URL(`${target.pathname}`, 'http://127.0.0.1:4318');
    }
  } catch {
    return null;
  }

  const allowedOrigins = new Set<string>(['http://127.0.0.1:4318', 'http://localhost:4318']);
  if (apiBase) {
    try {
      const api = new URL(apiBase);
      if (isArtifactServiceOrigin(api)) allowedOrigins.add(api.origin);
    } catch {
      // A malformed bridge value cannot broaden the allowlist.
    }
  }

  return allowedOrigins.has(target.origin) ? target.toString() : null;
}

async function readBoundedResponse(response: Response): Promise<string> {
  const announcedSize = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(announcedSize) && announcedSize > MAX_ARTIFACT_BYTES) {
    throw new Error('artifact-too-large');
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_ARTIFACT_BYTES) throw new Error('artifact-too-large');
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let output = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ARTIFACT_BYTES) {
      await reader.cancel();
      throw new Error('artifact-too-large');
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

export async function fetchArtifactPayload(url: string, signal: AbortSignal): Promise<ArtifactPayload> {
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal,
  });
  if (!response.ok) throw new Error(`artifact-${response.status}`);
  return {
    content: await readBoundedResponse(response),
    contentType: response.headers.get('content-type') ?? 'text/html',
  };
}

function cleanCssUrls(value: string): string {
  return value
    .replace(/@import\s+[^;]+;?/giu, '')
    .replace(/url\(\s*(["']?)(?!data:)[^)]+\)/giu, 'none');
}

function installPreviewPolicy(document: Document): void {
  document.head.querySelectorAll('meta[http-equiv], base, link').forEach((node) => node.remove());

  const charset = document.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  const csp = document.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    "script-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "media-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
  document.head.prepend(csp);
  document.head.prepend(charset);

  const guardStyle = document.createElement('style');
  guardStyle.textContent = `
    *, *::before, *::after { animation: none !important; transition: none !important; }
    html, body {
      min-width: 0 !important;
      max-width: 100% !important;
      background: #fff !important;
      color: #182132 !important;
    }
    html { color-scheme: light; }
    body {
      margin: 0 !important;
      overflow-wrap: anywhere;
      font-family: "Source Han Serif SC", "Songti SC", serif !important;
    }
    main {
      width: auto !important;
      max-width: 100% !important;
      margin: 0 !important;
      padding: 20px 16px !important;
      border: 0 !important;
      box-shadow: none !important;
    }
    h1 { font-size: clamp(18px, 6vw, 22px) !important; line-height: 1.35 !important; }
    h2 { font-size: clamp(15px, 5vw, 18px) !important; line-height: 1.4 !important; }
    table { display: block !important; max-width: 100% !important; overflow-x: auto !important; }
    pre {
      max-width: 100% !important;
      white-space: pre-wrap !important;
      overflow-wrap: anywhere !important;
      font: 13px/1.78 "Source Han Serif SC", "Songti SC", serif !important;
    }
    img, video, canvas, svg { max-width: 100%; height: auto; }
  `;
  document.head.append(guardStyle);
}

/** Build an offline, inert document for iframe.srcDoc. */
export function sanitizeArtifactDocument(content: string, contentType: string): string {
  const parser = new DOMParser();
  const isHtml = /text\/html/iu.test(contentType);
  const document = parser.parseFromString(isHtml ? content : '<!doctype html><html><head></head><body></body></html>', 'text/html');

  if (!isHtml) {
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:0;padding:16px;white-space:pre-wrap;font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;color:#182132;background:#fff;';
    pre.textContent = content;
    document.body.replaceChildren(pre);
  }

  document.querySelectorAll('script, iframe, object, embed, form, base, link, meta[http-equiv]').forEach((node) => node.remove());

  // The drawer already owns task routing and status. Remove only the known
  // generated routing preamble so an artifact starts with its actual result;
  // ordinary report titles remain untouched.
  const firstHeading = document.body.querySelector('h1');
  const firstHeadingText = firstHeading?.textContent?.trim() ?? '';
  if (firstHeadingText.startsWith('老大，') && (firstHeadingText.includes('@你') || firstHeadingText.includes('需要你'))) {
    firstHeading?.remove();
  }
  document.querySelectorAll('p').forEach((paragraph) => {
    if (paragraph.textContent?.trim() === 'Codex 的本地执行结果，未发送或写入共享系统。') {
      paragraph.remove();
    }
  });

  for (const element of document.querySelectorAll<HTMLElement>('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith('on')
        || ['srcdoc', 'action', 'formaction', 'ping', 'target'].includes(name)
      ) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (['href', 'xlink:href'].includes(name)) {
        if (!attribute.value.startsWith('#')) element.removeAttribute(attribute.name);
        continue;
      }
      if (['src', 'poster', 'srcset'].includes(name) && !/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,/iu.test(attribute.value)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === 'style') element.setAttribute('style', cleanCssUrls(attribute.value));
    }
  }
  document.querySelectorAll('style').forEach((style) => {
    style.textContent = cleanCssUrls(style.textContent ?? '');
  });

  installPreviewPolicy(document);
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

export const artifactPreviewLimits = Object.freeze({ maxBytes: MAX_ARTIFACT_BYTES });

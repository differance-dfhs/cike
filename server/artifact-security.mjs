const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.(?:html|md|txt|json)$/u;
const ARTIFACT_PATH_PREFIX = '/api/artifacts/';
const LOCAL_ARTIFACT_ORIGINS = new Set([
  'http://127.0.0.1:4318',
  'http://localhost:4318',
]);
const PREVIEW_CONTENT_TYPES = new Set(['text/html', 'text/plain', 'application/json']);

export const ARTIFACT_PREVIEW_LIMIT_BYTES = 2 * 1024 * 1024;

export const DIRECT_ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "media-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox',
].join('; ');

export const ARTIFACT_PERMISSIONS_POLICY = [
  'accelerometer=()',
  'autoplay=()',
  'camera=()',
  'display-capture=()',
  'encrypted-media=()',
  'fullscreen=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'picture-in-picture=()',
  'publickey-credentials-get=()',
  'screen-wake-lock=()',
  'usb=()',
  'web-share=()',
].join(', ');

export function artifactNameFromPathname(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(ARTIFACT_PATH_PREFIX)) return null;
  const encodedName = pathname.slice(ARTIFACT_PATH_PREFIX.length);
  let name;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    return null;
  }
  if (!ARTIFACT_NAME_PATTERN.test(name)) return null;
  if (name.includes('/') || name.includes('\\')) return null;
  return name;
}

function trustedRuntimeOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function parseLocalArtifactUrl(value, options = {}) {
  if (typeof value !== 'string' || !value || value.length > 1_000) return null;
  const origin = trustedRuntimeOrigin(options.origin) || 'http://127.0.0.1:4318';
  const allowedOrigins = new Set([...LOCAL_ARTIFACT_ORIGINS, origin]);
  let url;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || !allowedOrigins.has(url.origin)) return null;
  if (url.username || url.password || !artifactNameFromPathname(url.pathname)) return null;
  return url;
}

export function normalizeLocalArtifactUrl(value, options = {}) {
  const origin = trustedRuntimeOrigin(options.origin) || 'http://127.0.0.1:4318';
  const url = parseLocalArtifactUrl(value, { origin });
  if (!url) return null;
  const name = artifactNameFromPathname(url.pathname);
  if (options.htmlOnly && !name?.endsWith('.html')) return null;
  const normalized = new URL(url.pathname, origin);
  return normalized.href;
}

export async function readArtifactResponse(response, options = {}) {
  const limit = Number.isFinite(options.limit)
    ? Math.max(0, options.limit)
    : ARTIFACT_PREVIEW_LIMIT_BYTES;
  const contentType = String(response?.headers?.get?.('content-type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (!response?.ok || !PREVIEW_CONTENT_TYPES.has(contentType)) throw new Error('artifact unavailable');
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > limit) throw new Error('artifact too large');
  if (!response.body) return { content: '', contentType };

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('artifact too large');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return { content: Buffer.concat(chunks, size).toString('utf8'), contentType };
}

export function isSafeEmbeddedFrameNavigation(value) {
  return value === 'about:blank' || value === 'about:srcdoc';
}

export function isSafeAppNavigation(value, options = {}) {
  if (typeof value !== 'string' || !value) return false;
  let target;
  try {
    target = new URL(value);
  } catch {
    return false;
  }

  if (options.devServerUrl) {
    try {
      const dev = new URL(options.devServerUrl);
      return ['http:', 'https:'].includes(dev.protocol)
        && target.origin === dev.origin
        && !target.username
        && !target.password;
    } catch {
      return false;
    }
  }

  try {
    const primary = new URL(options.primaryUrl);
    target.hash = '';
    primary.hash = '';
    return target.href === primary.href;
  } catch {
    return false;
  }
}

export function artifactResponseHeaders() {
  return {
    'Content-Security-Policy': DIRECT_ARTIFACT_CSP,
    'Permissions-Policy': ARTIFACT_PERMISSIONS_POLICY,
    'X-Frame-Options': 'DENY',
    'X-Permitted-Cross-Domain-Policies': 'none',
  };
}

export const artifactSecurityInternals = {
  ARTIFACT_NAME_PATTERN,
  ARTIFACT_PATH_PREFIX,
  LOCAL_ARTIFACT_ORIGINS,
  PREVIEW_CONTENT_TYPES,
  parseLocalArtifactUrl,
  trustedRuntimeOrigin,
};

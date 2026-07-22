const MAX_EXTERNAL_URL_LENGTH = 2_048;

export function normalizeExternalUrl(value) {
  const input = String(value || '').trim();
  if (!input || input.length > MAX_EXTERNAL_URL_LENGTH) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (!url.hostname || url.hostname === 'localhost' || url.hostname === '127.0.0.1') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

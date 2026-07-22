import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeExternalUrl } from './external-links.mjs';

test('external source links allow only credential-free public HTTPS URLs', () => {
  assert.equal(
    normalizeExternalUrl('https://arxiv.org/abs/2607.12345#section'),
    'https://arxiv.org/abs/2607.12345',
  );
  assert.equal(normalizeExternalUrl('http://arxiv.org/abs/1'), null);
  assert.equal(normalizeExternalUrl('file:///tmp/result.html'), null);
  assert.equal(normalizeExternalUrl('https://user:secret@example.com/path'), null);
  assert.equal(normalizeExternalUrl('https://127.0.0.1:4318/api/artifacts/a.html'), null);
});

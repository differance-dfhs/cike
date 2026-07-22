import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mainSource = await readFile(new URL('./main.mjs', import.meta.url), 'utf8');

function matchIndex(source, pattern, label) {
  const index = source.search(pattern);
  assert.notEqual(index, -1, `missing startup step: ${label}`);
  return index;
}

test('optional DeepRead startup cannot gate the local service or first window', () => {
  const readyStart = mainSource.indexOf('app.whenReady().then(async () => {');
  const readyEnd = mainSource.indexOf('}).catch((error) => {', readyStart);
  assert.notEqual(readyStart, -1, 'missing app ready startup callback');
  assert.notEqual(readyEnd, -1, 'missing app ready startup error boundary');

  const startup = mainSource.slice(readyStart, readyEnd);
  const helperStart = matchIndex(
    startup,
    /deepReadRuntimePromise\s*=\s*startDeliveryHelpers\(\)/u,
    'start optional DeepRead helper without awaiting it',
  );
  const localServiceStart = matchIndex(
    startup,
    /service\s*=\s*await\s+startLocalService\(\)/u,
    'start local service',
  );
  const firstWindowStart = matchIndex(
    startup,
    /await\s+createWindows\(\)/u,
    'create first window',
  );
  const helperAttach = matchIndex(
    startup,
    /deepReadRuntimePromise\.then\(attachDeliveryHelper\)/u,
    'attach optional DeepRead helper asynchronously',
  );

  assert.ok(helperStart < localServiceStart, 'DeepRead should begin in parallel before the local service');
  assert.ok(localServiceStart < firstWindowStart, 'the local service should start before window creation');
  assert.ok(firstWindowStart < helperAttach, 'DeepRead must settle only after core startup reaches the window');

  const coreStartup = startup.slice(helperStart, helperAttach);
  assert.doesNotMatch(coreStartup, /await\s+startDeliveryHelpers\(\)/u);
  assert.doesNotMatch(coreStartup, /await\s+deepReadRuntimePromise\b/u);
});

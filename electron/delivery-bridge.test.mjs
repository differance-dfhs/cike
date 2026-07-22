import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mainSource = await readFile(new URL('./main.mjs', import.meta.url), 'utf8');
const preloadSource = await readFile(new URL('./preload.cjs', import.meta.url), 'utf8');

test('delivery bridge passes only an opaque id and never returns its private URL', () => {
  assert.match(preloadSource, /openDelivery: \(id\) => ipcRenderer\.invoke\('delivery:open', id\)/u);
  assert.match(mainSource, /service\?\.deliveryRegistry\?\.resolve/u);
  assert.match(mainSource, /launch\.policy === 'local_paper_reader'/u);
  assert.match(mainSource, /launch\.policy === 'trusted_lark_document'/u);
  assert.match(mainSource, /launch\.policy === 'registered_local_file'/u);
  assert.match(mainSource, /launch\.policy === 'registered_local_result'/u);
  assert.match(mainSource, /return \{ opened: true, presentation, loadedTarget \}/u);
  assert.match(mainSource, /resolution\.presentation === 'in_app'/u);
  assert.equal(mainSource.includes('return { opened: true, url: safeUrl'), false);
});

import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const productName = manifest.build?.productName || '此刻';
const releaseDir = path.join(root, 'release');
const deliverableDir = path.join(root, 'deliverables', `${productName}-${manifest.version}-mac`);

if (path.dirname(releaseDir) !== root || !releaseDir.endsWith(`${path.sep}release`)) {
  throw new Error(`Refusing to clean unexpected path: ${releaseDir}`);
}

await rm(releaseDir, { recursive: true, force: true });
await rm(deliverableDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true, mode: 0o700 });
console.log(`CLEAN_RELEASE_OK ${releaseDir}`);

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { extractAll, listPackage } from '@electron/asar';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const productName = manifest.build?.productName || '此刻';
const version = manifest.version;
const releaseDir = path.join(root, manifest.build?.directories?.output || 'release');
const appPath = path.join(releaseDir, 'mac-universal', `${productName}.app`);
const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
const artifactBase = `${productName}-${version}-universal`;
const dmgPath = path.join(releaseDir, `${artifactBase}.dmg`);
const zipPath = path.join(releaseDir, `${artifactBase}.zip`);
const guidePath = path.join(root, 'INSTALL.md');
const deliverableDir = path.join(root, 'deliverables', `${productName}-${version}-mac`);
const execFileAsync = promisify(execFile);

for (const filePath of [asarPath, dmgPath, guidePath]) {
  const info = await lstat(filePath);
  if (!info.isFile()) throw new Error(`Missing distribution file: ${filePath}`);
}

await rm(zipPath, { force: true });
await execFileAsync('/usr/bin/ditto', [
  '-c', '-k', '--keepParent', '--norsrc', '--noextattr', appPath, zipPath,
], { timeout: 10 * 60 * 1_000, maxBuffer: 1024 * 1024 });

const entries = listPackage(asarPath).map((entry) => entry.replace(/^\/+/, ''));
const forbiddenEntries = entries.filter((entry) => (
  /(?:^|\/)(?:\.data|output|qa|src|scripts|deliverables|\.playwright-cli)(?:\/|$)/u.test(entry)
  || /\.test\.[cm]?[jt]sx?$/iu.test(entry)
));
if (forbiddenEntries.length) {
  throw new Error(`Forbidden files in app.asar:\n${forbiddenEntries.slice(0, 40).join('\n')}`);
}

const temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'cike-public-check-'));
const extractedDir = path.join(temporaryDir, 'app');
extractAll(asarPath, extractedDir);

const forbiddenMarkers = String(process.env.CIKE_PUBLIC_FORBIDDEN_MARKERS || '')
  .split('|')
  .map((item) => item.trim())
  .filter(Boolean);
const textExtensions = new Set(['.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.txt']);
const privacyHits = [];

async function scanDirectory(directory, baseDirectory = directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(filePath, baseDirectory);
      continue;
    }
    if (!entry.isFile() || !textExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    const info = await lstat(filePath);
    if (info.size > 6 * 1024 * 1024) continue;
    const content = await readFile(filePath, 'utf8');
    if (/\/Users\/(?!demo\/|example\/|teammate\/|Shared\/)[A-Za-z0-9._-]+\//u.test(content)) {
      privacyHits.push(`${path.relative(baseDirectory, filePath)}: absolute home path`);
    }
    for (const marker of forbiddenMarkers) {
      if (content.includes(marker)) privacyHits.push(`${path.relative(baseDirectory, filePath)}: ${marker}`);
    }
  }
}

try {
  await scanDirectory(extractedDir);
} finally {
  await rm(temporaryDir, { recursive: true, force: true });
}
if (privacyHits.length) throw new Error(`Private markers in app bundle:\n${privacyHits.join('\n')}`);

await rm(deliverableDir, { recursive: true, force: true });
await mkdir(deliverableDir, { recursive: true, mode: 0o700 });
const deliverables = [
  [dmgPath, path.join(deliverableDir, path.basename(dmgPath))],
  [zipPath, path.join(deliverableDir, path.basename(zipPath))],
  [guidePath, path.join(deliverableDir, 'INSTALL.md')],
];
for (const [source, target] of deliverables) await copyFile(source, target);

const checksumLines = [];
for (const [, target] of deliverables.slice(0, 2)) {
  const digest = createHash('sha256').update(await readFile(target)).digest('hex');
  checksumLines.push(`${digest}  ${path.basename(target)}`);
}
await writeFile(path.join(deliverableDir, 'SHA256SUMS.txt'), `${checksumLines.join('\n')}\n`, { mode: 0o600 });

console.log(`PUBLIC_BUNDLE_OK entries=${entries.length} privacy_hits=0`);
console.log(`CLEAN_DISTRIBUTION_DIR ${deliverableDir}`);

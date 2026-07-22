import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['.git', '.data', '.playwright-cli', 'node_modules', 'vendor', 'dist', 'release', 'deliverables', 'output']);
const textExtensions = new Set(['.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.plist', '.ts', '.tsx', '.txt', '.yml', '.yaml']);
const forbidden = String(process.env.CIKE_PUBLIC_FORBIDDEN_MARKERS || '')
  .split('|')
  .map((item) => item.trim())
  .filter(Boolean);
const hits = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.name === '.DS_Store') continue;
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(filePath);
      continue;
    }
    if (!entry.isFile() || !textExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    const info = await lstat(filePath);
    if (info.size > 6 * 1024 * 1024) continue;
    const content = await readFile(filePath, 'utf8');
    if (/\/Users\/(?!demo\/|example\/|teammate\/|Shared\/)[A-Za-z0-9._-]+\//u.test(content)) {
      hits.push(`${path.relative(root, filePath)}: absolute home path`);
    }
    if (/(?:gh[op]|sk|xox)[-_][A-Za-z0-9_-]{20,}/u.test(content)) {
      hits.push(`${path.relative(root, filePath)}: credential-shaped string`);
    }
    for (const marker of forbidden) {
      if (content.includes(marker)) hits.push(`${path.relative(root, filePath)}: ${marker}`);
    }
  }
}

await walk(root);
if (hits.length) {
  console.error(hits.join('\n'));
  process.exitCode = 1;
} else {
  console.log('PUBLIC_SOURCE_AUDIT_OK privacy_hits=0');
}

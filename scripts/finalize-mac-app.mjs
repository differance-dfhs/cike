import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const productName = manifest.build?.productName || '此刻';
const releaseDir = path.join(root, manifest.build?.directories?.output || 'release');
const appPath = path.join(releaseDir, 'mac-universal', `${productName}.app`);

if (!(await lstat(appPath)).isDirectory()) throw new Error(`Missing universal app: ${appPath}`);

// A Developer ID build can keep Hardened Runtime because every nested binary
// shares a real Team ID. The internal unsigned build has no Team ID, so it must
// use one consistent ad-hoc signature without library validation; otherwise
// dyld refuses to load Electron Framework on current macOS releases.
await execFileAsync('/usr/bin/xattr', ['-cr', appPath], { timeout: 5 * 60 * 1_000, maxBuffer: 1024 * 1024 });
await execFileAsync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], {
  timeout: 10 * 60 * 1_000,
  maxBuffer: 4 * 1024 * 1024,
});
await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
  timeout: 5 * 60 * 1_000,
  maxBuffer: 4 * 1024 * 1024,
});

console.log(`ADHOC_SIGNED_APP_OK ${appPath}`);

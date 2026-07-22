import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  codexDesktopAppCandidates,
  configuredAutoExecuteOverride,
  configuredContextSourcesOverride,
  configuredPublishLarkDocumentsOverride,
  configuredProjectRootsOverride,
  loadDesktopSettings,
  resolveServiceDataDir,
  saveDesktopSettings,
} from './runtime-config.mjs';

test('fresh installs enable only the low-risk background execution layer without implicit roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-settings-'));
  const settings = await loadDesktopSettings(path.join(root, 'missing.json'));
  assert.deepEqual(settings.projectRoots, []);
  assert.equal(settings.contextSourcesEnabled, false);
  assert.equal(settings.autoExecute, true);
  assert.equal(settings.publishLarkDocuments, false);
  assert.equal(settings.setupComplete, false);
});

test('settings persist only canonical existing roots with private file permissions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cike-settings-'));
  const project = path.join(root, 'project');
  const filePath = path.join(root, 'config', 'settings.json');
  await mkdir(project);
  const canonicalProject = await realpath(project);
  const saved = await saveDesktopSettings(filePath, {
    projectRoots: [project, '/path/that/does/not/exist'],
    setupComplete: true,
    contextSourcesEnabled: true,
    autoExecute: true,
    publishLarkDocuments: true,
  });
  assert.deepEqual(saved.projectRoots, [canonicalProject]);
  assert.equal(saved.autoExecute, true);
  assert.equal(saved.publishLarkDocuments, true);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).projectRoots[0], canonicalProject);
});

test('packaged data lives below userData and explicit absolute overrides are honored', () => {
  assert.equal(resolveServiceDataDir({
    isPackaged: true,
    userDataDir: '/Users/example/Library/Application Support/此刻',
    projectRoot: '/Applications/此刻.app/Contents/Resources/app.asar',
    env: {},
  }), '/Users/example/Library/Application Support/此刻/data');
  assert.equal(resolveServiceDataDir({
    isPackaged: true,
    userDataDir: '/ignored',
    projectRoot: '/ignored',
    env: { PROACTIVE_AGENT_DATA_DIR: '/tmp/cike-data' },
  }), '/tmp/cike-data');
});

test('environment overrides are explicit and desktop app candidates are portable', () => {
  assert.equal(configuredProjectRootsOverride({}), null);
  assert.deepEqual(configuredProjectRootsOverride({ PROACTIVE_AGENT_PROJECT_ROOTS: '/a:/b' }), ['/a', '/b']);
  assert.equal(configuredAutoExecuteOverride({}), null);
  assert.equal(configuredAutoExecuteOverride({ PROACTIVE_AGENT_AUTO_EXECUTE: '1' }), true);
  assert.equal(configuredContextSourcesOverride({}), null);
  assert.equal(configuredContextSourcesOverride({ PROACTIVE_AGENT_CONTEXT_SOURCES: '0' }), false);
  assert.equal(configuredPublishLarkDocumentsOverride({}), null);
  assert.equal(configuredPublishLarkDocumentsOverride({ PROACTIVE_AGENT_PUBLISH_LARK_DOCUMENTS: '1' }), true);
  assert.deepEqual(
    codexDesktopAppCandidates({ PROACTIVE_AGENT_CODEX_APP_PATH: '/Custom/Codex.app' }, '/Users/teammate'),
    [
      '/Custom/Codex.app',
      '/Applications/Codex.app',
      '/Applications/ChatGPT.app',
      '/Users/teammate/Applications/Codex.app',
      '/Users/teammate/Applications/ChatGPT.app',
    ],
  );
});

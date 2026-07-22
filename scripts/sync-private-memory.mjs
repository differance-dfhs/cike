#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { FiveLayerMemoryStore } from '../server/five-layer-memory.mjs';

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

const configured = argumentValue('--data-dir') || process.env.PROACTIVE_AGENT_DATA_DIR || '';
const dataDir = configured && path.isAbsolute(configured)
  ? path.normalize(configured)
  : path.join(os.homedir(), 'Library', 'Application Support', '此刻', 'data');

const store = new FiveLayerMemoryStore(dataDir);
await store.init();
const { summary } = await store.syncPrivateSources();

process.stdout.write([
  `此刻五层记忆：${summary.state === 'ready' ? '已就绪' : '暂无可用来源'}`,
  `本机来源：${summary.sourceCount}`,
  `记忆总数：${summary.totalEntries}`,
  ...summary.layers.map((layer) => `${layer.label}：${layer.count}`),
  `私有数据目录：${dataDir}`,
].join('\n') + '\n');

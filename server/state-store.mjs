import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_STATE = Object.freeze({
  version: 2,
  decisions: {},
  activities: [],
  lastArtifact: null,
});

function migrateDecisions(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).map(([id, decision]) => {
    if (!decision || typeof decision !== 'object' || decision.status !== 'snoozed') {
      return [id, decision];
    }
    const archivedAt = decision.archivedAt || decision.updatedAt || null;
    return [id, {
      ...decision,
      status: 'archived',
      archiveReason: 'saved_for_later',
      ...(archivedAt ? { archivedAt } : {}),
      snoozedUntil: null,
    }];
  }));
}

function clone(value) {
  return structuredClone(value);
}

export class JsonStateStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'state.json');
    this.state = clone(DEFAULT_STATE);
    this.writeChain = Promise.resolve();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      this.state = clone(DEFAULT_STATE);
      return this;
    }
    const needsMigration = parsed?.version !== 2
      || Object.values(parsed?.decisions || {}).some((decision) => decision?.status === 'snoozed');
    const migrated = {
      ...clone(DEFAULT_STATE),
      ...parsed,
      version: 2,
      decisions: migrateDecisions(parsed?.decisions),
      activities: Array.isArray(parsed?.activities) ? parsed.activities.slice(0, 80) : [],
    };
    this.state = migrated;
    if (needsMigration) {
      try {
        await this.#persist(migrated);
      } catch {
        // Keep the successfully read and migrated state in memory. A later
        // writable launch can retry migration without reviving old snoozes.
      }
    }
    return this;
  }

  get() {
    return clone(this.state);
  }

  async update(mutator) {
    const run = async () => {
      const draft = clone(this.state);
      const maybeNext = await mutator(draft);
      const next = maybeNext && typeof maybeNext === 'object' ? maybeNext : draft;
      await this.#persist(next);
      this.state = next;
      return this.get();
    };
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }

  async #persist(state = this.state) {
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}

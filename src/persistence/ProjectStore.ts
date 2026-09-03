/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HorizonProject } from '../core/types';
import {
  deserializeProject,
  loadProjectLocal,
  saveProjectLocal,
  serializeProject,
  type MigrationReport,
} from '../core/serialization';

const DEFAULT_DB_NAME = 'horizon-studio-projects';
const DB_VERSION = 1;
const PROJECTS_STORE = 'projects';
const SNAPSHOTS_STORE = 'recoverySnapshots';
const SNAPSHOT_PROJECT_INDEX = 'projectId';

interface StoredProject {
  projectId: string;
  name: string;
  schemaVersion: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  json: string;
}

interface StoredSnapshot {
  snapshotId: string;
  projectId: string;
  name: string;
  schemaVersion: string;
  savedAt: string;
  revision: number;
  json: string;
}

export interface ProjectSummary {
  projectId: string;
  name: string;
  schemaVersion: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface RecoverySnapshotSummary {
  snapshotId: string;
  projectId: string;
  name: string;
  schemaVersion: string;
  savedAt: string;
  revision: number;
}

export interface LoadedProject {
  project: HorizonProject;
  report: MigrationReport;
  recoveredFromSnapshot?: RecoverySnapshotSummary;
}

export interface SaveProjectOptions {
  /** Save the prior revision before replacing it. Defaults to true. */
  createRecoverySnapshot?: boolean;
}

export interface ProjectStoreOptions {
  indexedDB?: IDBFactory;
  dbName?: string;
  maxRecoverySnapshots?: number;
  now?: () => Date;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction was aborted'));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

function projectSummary(record: StoredProject): ProjectSummary {
  const { json: _json, ...summary } = record;
  return summary;
}

function snapshotSummary(record: StoredSnapshot): RecoverySnapshotSummary {
  const { json: _json, ...summary } = record;
  return summary;
}

function snapshotId(projectId: string, revision: number, savedAt: string): string {
  return `${projectId}:${savedAt}:${revision}`;
}

/**
 * Durable browser project persistence. Saves are serialized per instance, making
 * this safe to call from a debounce or while an earlier save is still pending.
 */
export class ProjectStore {
  private readonly idb: IDBFactory;
  private readonly dbName: string;
  private readonly maxRecoverySnapshots: number;
  private readonly now: () => Date;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: ProjectStoreOptions = {}) {
    const idb = options.indexedDB ?? globalThis.indexedDB;
    if (!idb) throw new Error('IndexedDB is unavailable');
    this.idb = idb;
    this.dbName = options.dbName ?? DEFAULT_DB_NAME;
    this.maxRecoverySnapshots = Math.max(0, options.maxRecoverySnapshots ?? 10);
    this.now = options.now ?? (() => new Date());
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.idb.open(this.dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
          db.createObjectStore(PROJECTS_STORE, { keyPath: 'projectId' });
        }
        if (!db.objectStoreNames.contains(SNAPSHOTS_STORE)) {
          const snapshots = db.createObjectStore(SNAPSHOTS_STORE, {
            keyPath: 'snapshotId',
          });
          snapshots.createIndex(SNAPSHOT_PROJECT_INDEX, 'projectId', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('Could not open the project database'));
      request.onblocked = () => reject(new Error('Project database upgrade is blocked'));
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.writeQueue.then(operation, operation);
    this.writeQueue = queued.catch(() => undefined);
    return queued;
  }

  save(project: HorizonProject, options: SaveProjectOptions = {}): Promise<ProjectSummary> {
    // Capture at call time: a caller may continue mutating its live project while
    // this save waits behind another IndexedDB transaction.
    const json = serializeProject(project);
    const validated = deserializeProject(json).project;
    const createRecoverySnapshot = options.createRecoverySnapshot ?? true;

    return this.enqueue(async () => {
      const db = await this.open();
      try {
        const tx = db.transaction([PROJECTS_STORE, SNAPSHOTS_STORE], 'readwrite');
        const projects = tx.objectStore(PROJECTS_STORE);
        const snapshots = tx.objectStore(SNAPSHOTS_STORE);
        let record: StoredProject | undefined;
        await new Promise<void>((resolve, reject) => {
          const request = projects.get(validated.projectId);
          request.onsuccess = () => {
            const previous = request.result as StoredProject | undefined;
            const updatedAt = this.now().toISOString();
            record = {
              projectId: validated.projectId,
              name: validated.name,
              schemaVersion: validated.schemaVersion,
              createdAt: previous?.createdAt ?? updatedAt,
              updatedAt,
              revision: (previous?.revision ?? 0) + 1,
              json,
            };

            if (
              previous &&
              createRecoverySnapshot &&
              this.maxRecoverySnapshots > 0 &&
              previous.json !== json
            ) {
              snapshots.put({
                snapshotId: snapshotId(
                  previous.projectId,
                  previous.revision,
                  previous.updatedAt,
                ),
                projectId: previous.projectId,
                name: previous.name,
                schemaVersion: previous.schemaVersion,
                savedAt: previous.updatedAt,
                revision: previous.revision,
                json: previous.json,
              } satisfies StoredSnapshot);
            }
            projects.put(record);
          };
          request.onerror = () =>
            reject(request.error ?? new Error('Could not read prior project revision'));
          tx.oncomplete = () => resolve();
          tx.onabort = () =>
            reject(tx.error ?? new Error('Project save transaction was aborted'));
          tx.onerror = () =>
            reject(tx.error ?? new Error('Project save transaction failed'));
        });
        if (!record) throw new Error('Project save did not produce a record');
        await this.pruneSnapshots(validated.projectId);
        return projectSummary(record);
      } finally {
        db.close();
      }
    });
  }

  async load(projectId: string): Promise<LoadedProject | null> {
    await this.writeQueue;
    const db = await this.open();
    let record: StoredProject | undefined;
    try {
      const tx = db.transaction(PROJECTS_STORE, 'readonly');
      record = (await requestResult(
        tx.objectStore(PROJECTS_STORE).get(projectId),
      )) as StoredProject | undefined;
      await transactionDone(tx);
    } finally {
      db.close();
    }
    if (!record) return null;

    try {
      return deserializeProject(record.json);
    } catch (error) {
      const snapshots = await this.listRecoverySnapshots(projectId);
      for (const snapshot of snapshots) {
        try {
          const recovered = await this.loadRecoverySnapshot(snapshot.snapshotId);
          if (recovered) {
            return { ...recovered, recoveredFromSnapshot: snapshot };
          }
        } catch {
          // Continue toward an older valid snapshot.
        }
      }
      throw error;
    }
  }

  async list(): Promise<ProjectSummary[]> {
    await this.writeQueue;
    const db = await this.open();
    try {
      const tx = db.transaction(PROJECTS_STORE, 'readonly');
      const records = (await requestResult(
        tx.objectStore(PROJECTS_STORE).getAll(),
      )) as StoredProject[];
      await transactionDone(tx);
      return records
        .map(projectSummary)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } finally {
      db.close();
    }
  }

  delete(projectId: string): Promise<void> {
    return this.enqueue(async () => {
      const db = await this.open();
      try {
        const tx = db.transaction([PROJECTS_STORE, SNAPSHOTS_STORE], 'readwrite');
        tx.objectStore(PROJECTS_STORE).delete(projectId);
        const index = tx
          .objectStore(SNAPSHOTS_STORE)
          .index(SNAPSHOT_PROJECT_INDEX);
        await new Promise<void>((resolve, reject) => {
          const request = index.getAllKeys(IDBKeyRange.only(projectId));
          request.onsuccess = () => {
            for (const key of request.result) {
              tx.objectStore(SNAPSHOTS_STORE).delete(key);
            }
          };
          request.onerror = () =>
            reject(request.error ?? new Error('Could not list recovery snapshots'));
          tx.oncomplete = () => resolve();
          tx.onabort = () =>
            reject(tx.error ?? new Error('Project delete transaction was aborted'));
          tx.onerror = () =>
            reject(tx.error ?? new Error('Project delete transaction failed'));
        });
      } finally {
        db.close();
      }
    });
  }

  async listRecoverySnapshots(projectId: string): Promise<RecoverySnapshotSummary[]> {
    await this.writeQueue;
    const db = await this.open();
    try {
      const tx = db.transaction(SNAPSHOTS_STORE, 'readonly');
      const records = (await requestResult(
        tx
          .objectStore(SNAPSHOTS_STORE)
          .index(SNAPSHOT_PROJECT_INDEX)
          .getAll(IDBKeyRange.only(projectId)),
      )) as StoredSnapshot[];
      await transactionDone(tx);
      return records
        .map(snapshotSummary)
        .sort(
          (a, b) =>
            b.revision - a.revision || b.savedAt.localeCompare(a.savedAt),
        );
    } finally {
      db.close();
    }
  }

  async loadRecoverySnapshot(snapshotId: string): Promise<LoadedProject | null> {
    await this.writeQueue;
    const db = await this.open();
    try {
      const tx = db.transaction(SNAPSHOTS_STORE, 'readonly');
      const record = (await requestResult(
        tx.objectStore(SNAPSHOTS_STORE).get(snapshotId),
      )) as StoredSnapshot | undefined;
      await transactionDone(tx);
      return record ? deserializeProject(record.json) : null;
    } finally {
      db.close();
    }
  }

  private async pruneSnapshots(projectId: string): Promise<void> {
    if (this.maxRecoverySnapshots < 0) return;
    const db = await this.open();
    try {
      const tx = db.transaction(SNAPSHOTS_STORE, 'readwrite');
      const store = tx.objectStore(SNAPSHOTS_STORE);
      await new Promise<void>((resolve, reject) => {
        const request = store
          .index(SNAPSHOT_PROJECT_INDEX)
          .getAll(IDBKeyRange.only(projectId));
        request.onsuccess = () => {
          const records = request.result as StoredSnapshot[];
          records.sort(
            (a, b) =>
              b.revision - a.revision || b.savedAt.localeCompare(a.savedAt),
          );
          for (const record of records.slice(this.maxRecoverySnapshots)) {
            store.delete(record.snapshotId);
          }
        };
        request.onerror = () =>
          reject(request.error ?? new Error('Could not list recovery snapshots'));
        tx.oncomplete = () => resolve();
        tx.onabort = () =>
          reject(tx.error ?? new Error('Snapshot prune transaction was aborted'));
        tx.onerror = () =>
          reject(tx.error ?? new Error('Snapshot prune transaction failed'));
      });
    } finally {
      db.close();
    }
  }
}

export interface DebouncedProjectSaver {
  schedule(project: HorizonProject): Promise<ProjectSummary>;
  flush(): Promise<ProjectSummary | null>;
  cancel(reason?: unknown): void;
}

/** Coalesces rapid edits while preserving a promise for every scheduled save. */
export function createDebouncedProjectSaver(
  store: ProjectStore,
  delayMs = 500,
): DebouncedProjectSaver {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: HorizonProject | undefined;
  let waiters: Array<{
    resolve: (summary: ProjectSummary) => void;
    reject: (reason?: unknown) => void;
  }> = [];

  const run = async (): Promise<ProjectSummary | null> => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const project = pending;
    pending = undefined;
    if (!project) return null;
    const currentWaiters = waiters;
    waiters = [];
    try {
      const summary = await store.save(project);
      currentWaiters.forEach(({ resolve }) => resolve(summary));
      return summary;
    } catch (error) {
      currentWaiters.forEach(({ reject }) => reject(error));
      throw error;
    }
  };

  return {
    schedule(project) {
      pending = deserializeProject(serializeProject(project)).project;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        void run().catch(() => {
          // Errors are delivered through the schedule promises.
        });
      }, Math.max(0, delayMs));
      return new Promise<ProjectSummary>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    flush: run,
    cancel(reason = new Error('Scheduled project save cancelled')) {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
      const currentWaiters = waiters;
      waiters = [];
      currentWaiters.forEach(({ reject }) => reject(reason));
    },
  };
}

export interface StartupProjectResult {
  project: HorizonProject;
  source: 'indexeddb' | 'recovery' | 'localStorage' | 'default';
  report?: MigrationReport;
  warnings: string[];
}

/**
 * Loads the most recently saved IndexedDB project, then the legacy localStorage
 * project, then a caller-provided default. Valid legacy data is copied into IDB.
 */
export async function loadStartupProject(
  store: ProjectStore | null,
  createDefault: () => HorizonProject,
): Promise<StartupProjectResult> {
  const warnings: string[] = [];
  if (store) {
    try {
      for (const summary of await store.list()) {
        try {
          const loaded = await store.load(summary.projectId);
          if (loaded) {
            return {
              project: loaded.project,
              source: loaded.recoveredFromSnapshot ? 'recovery' : 'indexeddb',
              report: loaded.report,
              warnings,
            };
          }
        } catch (error) {
          warnings.push(
            `Could not load ${summary.name}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } catch (error) {
      warnings.push(
        `IndexedDB unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const legacy = loadProjectLocal();
  if (legacy) {
    if (store) {
      try {
        await store.save(legacy.project, { createRecoverySnapshot: false });
      } catch (error) {
        warnings.push(
          `Could not migrate local project to IndexedDB: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return {
      project: legacy.project,
      source: 'localStorage',
      report: legacy.report,
      warnings,
    };
  }

  return { project: createDefault(), source: 'default', warnings };
}

/**
 * Compatibility save for integration points that still expect localStorage.
 * IndexedDB is authoritative; localStorage remains a best-effort fallback.
 */
export async function saveProjectDurably(
  store: ProjectStore | null,
  project: HorizonProject,
): Promise<ProjectSummary | null> {
  let localError: unknown;
  try {
    saveProjectLocal(project);
  } catch (error) {
    localError = error;
  }
  if (store) return store.save(project);
  if (localError) throw localError;
  return null;
}

/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject } from '../../core/project';
import { saveProjectLocal } from '../../core/serialization';
import {
  createDebouncedProjectSaver,
  loadStartupProject,
  ProjectStore,
} from '../ProjectStore';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function makeStore(maxRecoverySnapshots = 10): ProjectStore {
  let tick = 0;
  return new ProjectStore({
    indexedDB: new IDBFactory(),
    dbName: `projects-${Math.random()}`,
    maxRecoverySnapshots,
    now: () => new Date(Date.UTC(2026, 8, 2, 0, 0, tick++)),
  });
}

describe('ProjectStore', () => {
  beforeEach(() => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    vi.stubGlobal('localStorage', new MemoryStorage());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('saves, loads, and lists validated projects newest first', async () => {
    const store = makeStore();
    const first = createEmptyProject('First');
    const second = createEmptyProject('Second');

    const firstSummary = await store.save(first);
    await store.save(second);
    first.name = 'Mutated after save';

    expect((await store.load(first.projectId))?.project.name).toBe('First');
    expect(firstSummary.revision).toBe(1);
    expect((await store.list()).map(({ name }) => name)).toEqual(['Second', 'First']);
  });

  it('captures call-time state while queued saves are pending', async () => {
    const store = makeStore();
    const project = createEmptyProject('Revision one');

    const first = store.save(project);
    project.name = 'Revision two';
    const second = store.save(project);
    project.name = 'Unsaved mutation';
    await Promise.all([first, second]);

    expect((await store.load(project.projectId))?.project.name).toBe('Revision two');
    const snapshots = await store.listRecoverySnapshots(project.projectId);
    expect(snapshots).toHaveLength(1);
    expect(
      (await store.loadRecoverySnapshot(snapshots[0].snapshotId))?.project.name,
    ).toBe('Revision one');
  });

  it('retains only the configured number of prior revisions', async () => {
    const store = makeStore(2);
    const project = createEmptyProject('v1');
    await store.save(project);
    for (const name of ['v2', 'v3', 'v4']) {
      project.name = name;
      await store.save(project);
    }

    const snapshots = await store.listRecoverySnapshots(project.projectId);
    expect(snapshots.map(({ revision }) => revision)).toEqual([3, 2]);
    await expect(
      Promise.all(
        snapshots.map(async ({ snapshotId }) =>
          (await store.loadRecoverySnapshot(snapshotId))?.project.name,
        ),
      ),
    ).resolves.toEqual(['v3', 'v2']);
  });

  it('falls back to the newest valid recovery snapshot when the primary is corrupt', async () => {
    const factory = new IDBFactory();
    const dbName = 'corrupt-primary';
    const store = new ProjectStore({ indexedDB: factory, dbName });
    const project = createEmptyProject('recoverable');
    await store.save(project);
    project.name = 'current';
    await store.save(project);

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(dbName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put({
        projectId: project.projectId,
        name: project.name,
        schemaVersion: project.schemaVersion,
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:01.000Z',
        revision: 2,
        json: '{broken',
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    const recovered = await store.load(project.projectId);
    expect(recovered?.project.name).toBe('recoverable');
    expect(recovered?.recoveredFromSnapshot?.revision).toBe(1);
  });

  it('deletes the project and all recovery snapshots', async () => {
    const store = makeStore();
    const project = createEmptyProject('Delete me');
    await store.save(project);
    project.name = 'Delete me too';
    await store.save(project);

    await store.delete(project.projectId);

    expect(await store.load(project.projectId)).toBeNull();
    expect(await store.listRecoverySnapshots(project.projectId)).toEqual([]);
  });

  it('coalesces scheduled saves and resolves every caller', async () => {
    const store = makeStore();
    const saver = createDebouncedProjectSaver(store, 250);
    const project = createEmptyProject('draft');
    const first = saver.schedule(project);
    project.name = 'final';
    const second = saver.schedule(project);

    await saver.flush();
    const [a, b] = await Promise.all([first, second]);

    expect(a.revision).toBe(1);
    expect(b).toEqual(a);
    expect((await store.load(project.projectId))?.project.name).toBe('final');
    expect(await store.listRecoverySnapshots(project.projectId)).toEqual([]);
  });

  it('migrates the legacy localStorage project on first startup', async () => {
    const store = makeStore();
    const legacyProject = createEmptyProject('Legacy local project');
    saveProjectLocal(legacyProject);

    const startup = await loadStartupProject(store, () =>
      createEmptyProject('Default'),
    );

    expect(startup.source).toBe('localStorage');
    expect(startup.project.name).toBe('Legacy local project');
    expect((await store.load(legacyProject.projectId))?.project.name).toBe(
      'Legacy local project',
    );
  });
});

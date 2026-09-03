/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const DB_NAME = 'horizon-studio-assets';
const STORE = 'blobs';
const DB_VERSION = 1;
const OPFS_PREFIX = 'opfs_';
const OPFS_THRESHOLD = 8 * 1024 * 1024;

async function opfsMediaDirectory(create = false): Promise<FileSystemDirectoryHandle | null> {
  try {
    const getDirectory = navigator.storage?.getDirectory?.bind(navigator.storage);
    if (!getDirectory) return null;
    const root = await getDirectory();
    return await root.getDirectoryHandle('horizon-media', { create });
  } catch {
    return null;
  }
}

async function putOpfsBlob(key: string, blob: Blob): Promise<boolean> {
  const directory = await opfsMediaDirectory(true);
  if (!directory) return false;
  try {
    const file = await directory.getFileHandle(key, { create: true });
    const writable = await file.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

async function getOpfsBlob(key: string): Promise<Blob | null> {
  const directory = await opfsMediaDirectory(false);
  if (!directory) return null;
  try {
    return await (await directory.getFileHandle(key)).getFile();
  } catch {
    return null;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putBlob(key: string, blob: Blob): Promise<void> {
  await putBlobs([{ key, blob }]);
}

/** Writes a package's assets atomically: a failed transaction stores none of them. */
export async function putBlobs(entries: ReadonlyArray<{ key: string; blob: Blob }>): Promise<void> {
  if (entries.length === 0) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const { key, blob } of entries) store.put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('Asset transaction was aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('Asset transaction failed'));
    });
  } finally {
    db.close();
  }
}

export async function getBlob(key: string): Promise<Blob | null> {
  if (key.startsWith(OPFS_PREFIX)) return getOpfsBlob(key);
  const db = await openDb();
  const blob = await new Promise<Blob | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as Blob) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return blob;
}

export async function deleteBlob(key: string): Promise<void> {
  if (key.startsWith(OPFS_PREFIX)) {
    const directory = await opfsMediaDirectory(false);
    if (directory) {
      try { await directory.removeEntry(key); } catch { /* already absent */ }
    }
    return;
  }
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function hashBlob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function blobKeyForHash(hash: string): string {
  return `blob_${hash.slice(0, 24)}`;
}

export async function storeBlobWithHash(blob: Blob): Promise<{ key: string; hash: string; size: number; storage: 'indexeddb' | 'opfs' }> {
  const hash = await hashBlob(blob);
  const indexedDbKey = blobKeyForHash(hash);
  if (blob.size >= OPFS_THRESHOLD) {
    const opfsKey = `${OPFS_PREFIX}${hash.slice(0, 24)}`;
    if (await putOpfsBlob(opfsKey, blob)) {
      return { key: opfsKey, hash, size: blob.size, storage: 'opfs' };
    }
  }
  const key = indexedDbKey;
  await putBlob(key, blob);
  return { key, hash, size: blob.size, storage: 'indexeddb' };
}

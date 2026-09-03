/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { hashBlob } from '../../assets/BlobStore';
import { createEmptyProject } from '../../core/project';
import type { AssetRecord } from '../../core/types';
import {
  exportHznProject,
  HZN_FORMAT,
  HZN_MIME_TYPE,
  importHznProject,
  type HznManifest,
} from '../HorizonPackage';

function addIndexedDbAsset(
  project: ReturnType<typeof createEmptyProject>,
  blobKey = 'legacy_blob_key',
): AssetRecord {
  const asset: AssetRecord = {
    id: 'asset_image',
    name: 'texture.png',
    kind: 'image',
    mimeType: 'image/png',
    size: 5,
    hash: 'outdated',
    storage: 'indexeddb',
    blobKey,
    importedAt: '2026-09-01T00:00:00.000Z',
  };
  project.assets[asset.id] = asset;
  return asset;
}

async function packageBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe('.hzn packages', () => {
  it('exports a portable ZIP with project, manifest, and content-hashed assets', async () => {
    const project = createEmptyProject('Portable');
    const asset = addIndexedDbAsset(project);
    const content = new Blob([strToU8('hello')], { type: 'image/png' });
    const expectedHash = await hashBlob(content);

    const output = await exportHznProject(project, {
      getAssetBlob: async (key) => (key === asset.blobKey ? content : null),
      now: () => new Date('2026-09-02T00:00:00.000Z'),
    });
    const files = unzipSync(await packageBytes(output));
    const manifest = JSON.parse(
      strFromU8(files['manifest.json']),
    ) as HznManifest;
    const archivedProject = JSON.parse(strFromU8(files['project.json'])) as {
      assets: Record<string, AssetRecord>;
    };

    expect(output.type).toBe(HZN_MIME_TYPE);
    expect(manifest.format).toBe(HZN_FORMAT);
    expect(manifest).not.toHaveProperty('author');
    expect(manifest).not.toHaveProperty('license');
    expect(manifest.assets[asset.id]).toMatchObject({
      path: `assets/${expectedHash}`,
      hash: expectedHash,
      size: 5,
    });
    expect(strFromU8(files[`assets/${expectedHash}`])).toBe('hello');
    expect(archivedProject.assets[asset.id].hash).toBe(expectedHash);
    expect(archivedProject).not.toHaveProperty('author');
    expect(asset.hash).toBe('outdated');
  });

  it('round-trips assets and rewrites blob keys to their verified hashes', async () => {
    const project = createEmptyProject('Round trip');
    addIndexedDbAsset(project);
    const content = new Blob([strToU8('hello')], { type: 'image/png' });
    const archive = await exportHznProject(project, {
      getAssetBlob: async () => content,
    });
    const stored = new Map<string, Blob>();

    const imported = await importHznProject(archive, {
      storeAssets: async (entries) => {
        for (const entry of entries) stored.set(entry.key, entry.blob);
      },
    });
    const asset = imported.project.assets.asset_image as AssetRecord;

    expect(asset.blobKey).toBe(`blob_${asset.hash?.slice(0, 24)}`);
    expect(stored.get(asset.blobKey!)?.type).toBe('image/png');
    expect(
      strFromU8(
        new Uint8Array(await stored.get(asset.blobKey!)!.arrayBuffer()),
      ),
    ).toBe('hello');
  });

  it('validates all hashes before making any writes', async () => {
    const project = createEmptyProject('Tampered');
    addIndexedDbAsset(project);
    const archive = await exportHznProject(project, {
      getAssetBlob: async () => new Blob([strToU8('hello')], { type: 'image/png' }),
    });
    const files = unzipSync(await packageBytes(archive));
    const assetPath = Object.keys(files).find((path) => path.startsWith('assets/'))!;
    files[assetPath] = strToU8('jello');
    const tampered = zipSync(files);
    const storeAssets = vi.fn();

    await expect(importHznProject(tampered, { storeAssets })).rejects.toThrow(
      'failed SHA-256 verification',
    );
    expect(storeAssets).not.toHaveBeenCalled();
  });

  it('rejects incompatible package schemas before writing assets', async () => {
    const project = createEmptyProject('Future');
    addIndexedDbAsset(project);
    const archive = await exportHznProject(project, {
      getAssetBlob: async () => new Blob([strToU8('hello')], { type: 'image/png' }),
    });
    const files = unzipSync(await packageBytes(archive));
    const manifest = JSON.parse(strFromU8(files['manifest.json'])) as HznManifest;
    manifest.schemaVersion = '99.0';
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    const storeAssets = vi.fn();

    await expect(
      importHznProject(zipSync(files), { storeAssets }),
    ).rejects.toThrow('Unsupported project schema 99.0');
    expect(storeAssets).not.toHaveBeenCalled();
  });

  it('rejects manifest/project mismatches and unavailable export assets', async () => {
    const project = createEmptyProject('Mismatch');
    addIndexedDbAsset(project);
    await expect(
      exportHznProject(project, { getAssetBlob: async () => null }),
    ).rejects.toThrow('is unavailable');

    const archive = await exportHznProject(project, {
      getAssetBlob: async () => new Blob([strToU8('hello')], { type: 'image/png' }),
    });
    const files = unzipSync(await packageBytes(archive));
    const manifest = JSON.parse(strFromU8(files['manifest.json'])) as HznManifest;
    manifest.projectId = 'different-project';
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    const storeAssets = vi.fn();

    await expect(
      importHznProject(zipSync(files), { storeAssets }),
    ).rejects.toThrow('projectId does not match');
    expect(storeAssets).not.toHaveBeenCalled();
  });
});

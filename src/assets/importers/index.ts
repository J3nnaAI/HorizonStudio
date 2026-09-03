/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AssetRecord } from '../../core/types';
import { createId } from '../../core/ids';
import { storeBlobWithHash } from '../BlobStore';

export interface ImportResult {
  asset: AssetRecord;
  warnings: string[];
}

async function waitForVideoFrame(video: HTMLVideoElement): Promise<boolean> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return true;
  return new Promise<boolean>((resolve) => {
    const finish = (ready: boolean) => {
      window.clearTimeout(timer);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('error', onError);
      resolve(ready);
    };
    const onReady = () => finish(true);
    const onError = () => finish(false);
    const timer = window.setTimeout(() => finish(false), 3_000);
    video.addEventListener('loadeddata', onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

async function detectDecodedVideoAlpha(video: HTMLVideoElement): Promise<boolean | undefined> {
  if (!(await waitForVideoFrame(video)) || !video.videoWidth || !video.videoHeight) return undefined;
  const width = Math.min(video.videoWidth, 128);
  const height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return undefined;
  try {
    context.clearRect(0, 0, width, height);
    context.drawImage(video, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] < 250) return true;
    }
    return false;
  } catch {
    return undefined;
  }
}

export async function importImageAsset(
  blob: Blob,
  name: string,
  source = 'import',
): Promise<ImportResult> {
  const warnings: string[] = [];
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close();

  const { key, hash, size, storage } = await storeBlobWithHash(blob);
  const asset: AssetRecord = {
    id: createId('asset'),
    name,
    kind: 'image',
    mimeType: blob.type || 'image/png',
    width,
    height,
    size,
    hash,
    storage,
    blobKey: key,
    colorSpace: 'sRGB',
    importedAt: new Date().toISOString(),
    source,
  };
  if (size > 8 * 1024 * 1024) {
    warnings.push('Large image stored in IndexedDB; consider external URL for very large assets');
  }
  return { asset, warnings };
}

export async function importHdriAsset(
  blob: Blob,
  name: string,
  source = 'import',
): Promise<ImportResult> {
  const { key, hash, size, storage } = await storeBlobWithHash(blob);
  const mimeType = blob.type || (name.endsWith('.exr') ? 'image/exr' : 'image/vnd.radiance');
  const asset: AssetRecord = {
    id: createId('asset'),
    name,
    kind: 'hdri',
    mimeType,
    size,
    hash,
    storage,
    blobKey: key,
    colorSpace: 'linear',
    importedAt: new Date().toISOString(),
    source,
  };
  return { asset, warnings: [] };
}

export async function importModelAsset(
  blob: Blob,
  name: string,
  source = 'import',
): Promise<ImportResult> {
  const { key, hash, size, storage } = await storeBlobWithHash(blob);
  const asset: AssetRecord = {
    id: createId('asset'),
    name,
    kind: 'model',
    mimeType: blob.type || 'model/gltf-binary',
    size,
    hash,
    storage,
    blobKey: key,
    importedAt: new Date().toISOString(),
    source,
  };
  return { asset, warnings: [] };
}

export async function importBinaryAsset(
  blob: Blob,
  name: string,
  kind: 'font' | 'video' | 'audio' | 'lut' | 'ies' | 'custom',
  source = 'import',
): Promise<ImportResult> {
  const warnings: string[] = [];
  const { key, hash, size, storage } = await storeBlobWithHash(blob);
  const asset: AssetRecord = {
    id: createId('asset'),
    name,
    kind,
    mimeType: blob.type || 'application/octet-stream',
    size,
    hash,
    storage,
    blobKey: key,
    importedAt: new Date().toISOString(),
    source,
  };

  if (kind === 'video' || kind === 'audio') {
    const url = URL.createObjectURL(blob);
    try {
      const media = document.createElement(kind);
      media.preload = kind === 'video' ? 'auto' : 'metadata';
      asset.duration = await new Promise<number | undefined>((resolve) => {
        media.onloadedmetadata = () =>
          resolve(Number.isFinite(media.duration) ? media.duration : undefined);
        media.onerror = () => resolve(undefined);
        media.src = url;
      });
      if (kind === 'video') {
        const video = media as HTMLVideoElement;
        asset.width = video.videoWidth || undefined;
        asset.height = video.videoHeight || undefined;
        const alphaPresent = await detectDecodedVideoAlpha(video);
        asset.metadata = {
          ...asset.metadata,
          alphaPresent: alphaPresent ?? null,
          alphaMode: alphaPresent ? 'straight' : alphaPresent === false ? 'opaque' : 'auto',
        };
        if (alphaPresent) warnings.push('Transparent video detected and ready for compositing');
        else if (alphaPresent === undefined) warnings.push('Video alpha could not be inspected in this browser');
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return { asset, warnings };
}

export async function resolveAssetUrl(asset: AssetRecord): Promise<string | null> {
  if (asset.storage === 'inline' && asset.dataUrl) return asset.dataUrl;
  if (asset.storage === 'url' && asset.url) return asset.url;
  if ((asset.storage === 'indexeddb' || asset.storage === 'opfs') && asset.blobKey) {
    const { getBlob } = await import('../BlobStore');
    const blob = await getBlob(asset.blobKey);
    if (!blob) return null;
    return URL.createObjectURL(blob);
  }
  return null;
}

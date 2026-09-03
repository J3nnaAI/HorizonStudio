/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  blobKeyForHash,
  getBlob,
  hashBlob,
  putBlobs,
} from '../assets/BlobStore';
import {
  CURRENT_SCHEMA_VERSION,
  deserializeProject,
  serializeProject,
  type MigrationReport,
} from '../core/serialization';
import type { AssetRecord, HorizonProject } from '../core/types';

export const HZN_MIME_TYPE = 'application/vnd.horizon.project+zip';
export const HZN_PACKAGE_VERSION = 1;
export const HZN_FORMAT = 'horizon-studio-project';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;
const SUPPORTED_REQUIRED_FEATURES = new Set(['custom-shaders', 'volumetrics']);

export interface HznAssetManifestEntry {
  assetId: string;
  storage: AssetRecord['storage'];
  mimeType: string;
  path?: string;
  hash?: string;
  size?: number;
}

export interface HznManifest {
  format: typeof HZN_FORMAT;
  packageVersion: typeof HZN_PACKAGE_VERSION;
  horizonVersion: string;
  schemaVersion: string;
  projectId: string;
  name: string;
  projectPath: 'project.json';
  entryComposition: string;
  createdAt: string;
  assets: Record<string, HznAssetManifestEntry>;
  requiredFeatures: string[];
  trustedCode: boolean;
  provenance?: Record<string, unknown>;
}

export interface ExportHznOptions {
  getAssetBlob?: (key: string) => Promise<Blob | null>;
  now?: () => Date;
  horizonVersion?: string;
  provenance?: Record<string, unknown>;
}

export interface ImportHznOptions {
  storeAssets?: (
    entries: ReadonlyArray<{ key: string; blob: Blob }>,
  ) => Promise<void>;
}

export interface ImportedHznProject {
  project: HorizonProject;
  manifest: HznManifest;
  report: MigrationReport;
  warnings: string[];
}

export class HznPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HznPackageError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assetRecord(value: unknown, assetId: string): AssetRecord {
  if (!isRecord(value)) throw new HznPackageError(`Asset ${assetId} is not an object`);
  if (value.id !== assetId) {
    throw new HznPackageError(`Asset ${assetId} has a mismatched id`);
  }
  if (
    value.storage !== 'inline' &&
    value.storage !== 'indexeddb' &&
    value.storage !== 'opfs' &&
    value.storage !== 'url'
  ) {
    throw new HznPackageError(`Asset ${assetId} has an invalid storage type`);
  }
  if (typeof value.mimeType !== 'string' || value.mimeType === '') {
    throw new HznPackageError(`Asset ${assetId} is missing mimeType`);
  }
  return value as unknown as AssetRecord;
}

function contentPath(hash: string): string {
  return `assets/${hash}`;
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  return hashBlob(
    new Blob([bytes.slice().buffer], { type: 'application/octet-stream' }),
  );
}

function packageFeatures(project: HorizonProject): string[] {
  const features = new Set<string>();
  if (Object.values(project.shaders).some((shader) => shader.kind === 'custom-js')) {
    features.add('custom-shaders');
  }
  if (Object.values(project.nodes).some((node) => node.type === 'volume')) {
    features.add('volumetrics');
  }
  return [...features].sort();
}

function hasTrustedCode(project: HorizonProject): boolean {
  return Object.values(project.shaders).some(
    (shader) => shader.kind === 'custom-js' && Boolean(shader.moduleSource),
  );
}

/**
 * Builds a portable ZIP. The project copy in the archive is normalized to the
 * actual asset hashes without mutating the caller's live project.
 */
export async function exportHznProject(
  project: HorizonProject,
  options: ExportHznOptions = {},
): Promise<Blob> {
  const portableProject = deserializeProject(serializeProject(project)).project;
  const getAssetBlob = options.getAssetBlob ?? getBlob;
  const files: Record<string, Uint8Array> = {};
  const manifestAssets: Record<string, HznAssetManifestEntry> = {};

  for (const [assetId, rawAsset] of Object.entries(portableProject.assets)) {
    const asset = assetRecord(rawAsset, assetId);
    const manifestAsset: HznAssetManifestEntry = {
      assetId,
      storage: asset.storage,
      mimeType: asset.mimeType,
    };

    if (asset.storage === 'indexeddb' || asset.storage === 'opfs') {
      if (!asset.blobKey) {
        throw new HznPackageError(`IndexedDB asset ${assetId} is missing blobKey`);
      }
      const blob = await getAssetBlob(asset.blobKey);
      if (!blob) {
        throw new HznPackageError(
          `IndexedDB asset ${assetId} (${asset.blobKey}) is unavailable`,
        );
      }
      const hash = await hashBlob(blob);
      const path = contentPath(hash);
      if (!files[path]) files[path] = new Uint8Array(await blob.arrayBuffer());
      manifestAsset.path = path;
      manifestAsset.hash = hash;
      manifestAsset.size = blob.size;
      asset.hash = hash;
      asset.size = blob.size;
    } else {
      if (asset.hash) manifestAsset.hash = asset.hash;
      if (asset.size !== undefined) manifestAsset.size = asset.size;
    }
    manifestAssets[assetId] = manifestAsset;
  }

  const manifest: HznManifest = {
    format: HZN_FORMAT,
    packageVersion: HZN_PACKAGE_VERSION,
    horizonVersion: options.horizonVersion ?? '1.0.0',
    schemaVersion: portableProject.schemaVersion,
    projectId: portableProject.projectId,
    name: portableProject.name,
    projectPath: 'project.json',
    entryComposition: portableProject.activeCompositionId,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    assets: manifestAssets,
    requiredFeatures: packageFeatures(portableProject),
    trustedCode: hasTrustedCode(portableProject),
    ...(options.provenance ? { provenance: options.provenance } : {}),
  };

  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  files['project.json'] = strToU8(serializeProject(portableProject));
  const zip = zipSync(files, { level: 6 });
  return new Blob([zip.slice().buffer], { type: HZN_MIME_TYPE });
}

function parseJsonFile(files: Record<string, Uint8Array>, path: string): unknown {
  const bytes = files[path];
  if (!bytes) throw new HznPackageError(`Package is missing ${path}`);
  try {
    return JSON.parse(strFromU8(bytes));
  } catch {
    throw new HznPackageError(`${path} is not valid UTF-8 JSON`);
  }
}

function validateArchiveEntries(files: Record<string, Uint8Array>): void {
  const names = Object.keys(files);
  if (names.length > MAX_ARCHIVE_ENTRIES) {
    throw new HznPackageError('Package contains too many files');
  }
  let totalSize = 0;
  for (const name of names) {
    if (
      name.startsWith('/') ||
      name.includes('\\') ||
      name.split('/').some((part) => part === '..' || part === '.')
    ) {
      throw new HznPackageError(`Unsafe package path: ${name}`);
    }
    totalSize += files[name].byteLength;
    if (totalSize > MAX_UNCOMPRESSED_BYTES) {
      throw new HznPackageError('Package expands beyond the supported size');
    }
  }
}

function validateManifest(value: unknown): HznManifest {
  if (!isRecord(value)) throw new HznPackageError('manifest.json must contain an object');
  if (value.format !== HZN_FORMAT) {
    throw new HznPackageError(`Unsupported package format: ${String(value.format)}`);
  }
  if (value.packageVersion !== HZN_PACKAGE_VERSION) {
    throw new HznPackageError(
      `Unsupported package version: ${String(value.packageVersion)}`,
    );
  }
  if (value.projectPath !== 'project.json') {
    throw new HznPackageError('Manifest projectPath must be project.json');
  }
  for (const field of [
    'horizonVersion',
    'schemaVersion',
    'projectId',
    'name',
    'entryComposition',
    'createdAt',
  ]) {
    if (typeof value[field] !== 'string' || value[field] === '') {
      throw new HznPackageError(`Manifest ${field} must be a non-empty string`);
    }
  }
  if (!isRecord(value.assets)) {
    throw new HznPackageError('Manifest assets must be an object');
  }
  if (
    !Array.isArray(value.requiredFeatures) ||
    !value.requiredFeatures.every((feature) => typeof feature === 'string')
  ) {
    throw new HznPackageError('Manifest requiredFeatures must be a string array');
  }
  if (typeof value.trustedCode !== 'boolean') {
    throw new HznPackageError('Manifest trustedCode must be a boolean');
  }
  const unsupportedFeature = value.requiredFeatures.find(
    (feature) => !SUPPORTED_REQUIRED_FEATURES.has(feature as string),
  );
  if (unsupportedFeature) {
    throw new HznPackageError(
      `Package requires unsupported feature: ${String(unsupportedFeature)}`,
    );
  }
  return value as unknown as HznManifest;
}

function asBytes(input: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return Promise.resolve(input);
  if (input instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(input));
  return input.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

/**
 * Validates package metadata, project schema, file paths, sizes, and all asset
 * hashes before atomically writing assets. It never saves the imported project.
 */
export async function importHznProject(
  input: Blob | ArrayBuffer | Uint8Array,
  options: ImportHznOptions = {},
): Promise<ImportedHznProject> {
  const packageBytes = await asBytes(input);
  if (packageBytes.byteLength > MAX_PACKAGE_BYTES) {
    throw new HznPackageError('Package exceeds the supported size');
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(packageBytes);
  } catch {
    throw new HznPackageError('File is not a valid ZIP package');
  }
  validateArchiveEntries(files);

  const manifest = validateManifest(parseJsonFile(files, 'manifest.json'));
  if (
    manifest.schemaVersion !== CURRENT_SCHEMA_VERSION &&
    manifest.schemaVersion !== '1.0'
  ) {
    throw new HznPackageError(
      `Unsupported project schema ${manifest.schemaVersion}`,
    );
  }

  const projectJson = files[manifest.projectPath];
  if (!projectJson) throw new HznPackageError('Package is missing project.json');
  let deserialized: ReturnType<typeof deserializeProject>;
  try {
    deserialized = deserializeProject(strFromU8(projectJson));
  } catch (error) {
    throw new HznPackageError(
      `Invalid project.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const project = deserialized.project;
  if (manifest.projectId !== project.projectId) {
    throw new HznPackageError('Manifest projectId does not match project.json');
  }
  if (manifest.schemaVersion !== deserialized.report.fromVersion) {
    throw new HznPackageError('Manifest schemaVersion does not match project.json');
  }
  if (manifest.name !== project.name) {
    throw new HznPackageError('Manifest name does not match project.json');
  }
  if (manifest.entryComposition !== project.activeCompositionId) {
    throw new HznPackageError(
      'Manifest entryComposition does not match project.json',
    );
  }
  if (manifest.trustedCode !== hasTrustedCode(project)) {
    throw new HznPackageError(
      'Manifest trustedCode declaration does not match project.json',
    );
  }

  const staged = new Map<string, { key: string; blob: Blob }>();
  const verifiedPaths = new Map<string, string>();
  for (const [assetId, rawAsset] of Object.entries(project.assets)) {
    const asset = assetRecord(rawAsset, assetId);
    const entry = manifest.assets[assetId];
    if (!isRecord(entry) || entry.assetId !== assetId) {
      throw new HznPackageError(`Manifest is missing asset ${assetId}`);
    }
    if (entry.storage !== asset.storage || entry.mimeType !== asset.mimeType) {
      throw new HznPackageError(`Manifest metadata does not match asset ${assetId}`);
    }
    if (asset.storage !== 'indexeddb' && asset.storage !== 'opfs') continue;
    if (
      typeof entry.path !== 'string' ||
      typeof entry.hash !== 'string' ||
      !SHA256_PATTERN.test(entry.hash) ||
      typeof entry.size !== 'number' ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    ) {
      throw new HznPackageError(`Manifest has invalid IndexedDB asset ${assetId}`);
    }
    if (entry.path !== contentPath(entry.hash)) {
      throw new HznPackageError(`Asset ${assetId} does not use a content-hashed path`);
    }
    const bytes = files[entry.path];
    if (!bytes) throw new HznPackageError(`Package is missing ${entry.path}`);
    if (bytes.byteLength !== entry.size) {
      throw new HznPackageError(`Asset ${assetId} size does not match manifest`);
    }
    let actualHash = verifiedPaths.get(entry.path);
    if (!actualHash) {
      actualHash = await hashBytes(bytes);
      verifiedPaths.set(entry.path, actualHash);
    }
    if (actualHash !== entry.hash) {
      throw new HznPackageError(`Asset ${assetId} failed SHA-256 verification`);
    }
    const key = blobKeyForHash(actualHash);
    asset.blobKey = key;
    // Portable packages are rehydrated into the universally available local
    // store; large assets can migrate back to OPFS on a later import/render.
    asset.storage = 'indexeddb';
    asset.hash = actualHash;
    asset.size = bytes.byteLength;
    if (!staged.has(key)) {
      staged.set(key, {
        key,
        blob: new Blob([bytes.slice().buffer], { type: asset.mimeType }),
      });
    }
  }

  for (const assetId of Object.keys(manifest.assets)) {
    if (!(assetId in project.assets)) {
      throw new HznPackageError(`Manifest references unknown asset ${assetId}`);
    }
  }

  // This is intentionally the first mutation.
  await (options.storeAssets ?? putBlobs)([...staged.values()]);
  return {
    project,
    manifest,
    report: deserialized.report,
    warnings: manifest.trustedCode
      ? ['Package contains trusted custom code; review it before execution']
      : [],
  };
}

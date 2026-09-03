import { strToU8, zipSync } from 'fflate';
import { getBlob, hashBlob } from '../assets/BlobStore';
import { getProperty } from '../core/project';
import { resolveCompositionRootNodes } from '../core/project';
import { CURRENT_SCHEMA_VERSION, validateProject } from '../core/serialization';
import type {
  AssetRecord,
  HorizonNode,
  HorizonProject,
  PublicProperty,
  Sequence,
} from '../core/types';
import runtimeSource from './runtime/horizon-runtime.js?raw';
import runtimeCss from './runtime/horizon-runtime.css?raw';
import threeModuleSource from '../../node_modules/three/build/three.module.min.js?raw';
import gltfLoaderSource from '../../node_modules/three/examples/jsm/loaders/GLTFLoader.js?raw';
import bufferGeometryUtilsSource from '../../node_modules/three/examples/jsm/utils/BufferGeometryUtils.js?raw';
import fontLoaderSource from '../../node_modules/three/examples/jsm/loaders/FontLoader.js?raw';
import textGeometrySource from '../../node_modules/three/examples/jsm/geometries/TextGeometry.js?raw';
import skySource from '../../node_modules/three/examples/jsm/objects/Sky.js?raw';
import helvetikerBoldFont from '../../node_modules/three/examples/fonts/helvetiker_bold.typeface.json?raw';
import apacheLicenseText from '../../LICENSE?raw';

export const STATIC_PACKAGE_FORMAT = 'horizon-static-runtime';
export const STATIC_PACKAGE_VERSION = 1;
export const STATIC_PACKAGE_MIME_TYPE = 'application/zip';

export type PublishDiagnosticSeverity = 'warning' | 'error';

export interface PublishDiagnostic {
  severity: PublishDiagnosticSeverity;
  code: string;
  message: string;
  path?: string;
}

export interface PublishedPropertyContract {
  type: PublicProperty['type'];
  read: boolean;
  write: boolean;
  min?: number;
  max?: number;
}

export interface PublishedSceneContract {
  version: 1;
  properties: Record<string, PublishedPropertyContract>;
  timelines: string[];
  events: string[];
  compositions: Array<{ id: string; name: string }>;
}

export interface PublishedAssetEntry {
  assetId: string;
  path: string;
  hash: string;
  size: number;
  mimeType: string;
  kind: AssetRecord['kind'];
}

export interface StaticPublishManifest {
  format: typeof STATIC_PACKAGE_FORMAT;
  packageVersion: typeof STATIC_PACKAGE_VERSION;
  horizonVersion: string;
  runtimeCompatibility: string;
  schemaVersion: string;
  projectId: string;
  name: string;
  runtimeCopyrightHolder: 'J3nna Technologies, LLC';
  runtimeLicense: 'Apache-2.0';
  runtimeLicensePath: 'HORIZON-RUNTIME-LICENSE.txt';
  runtimeNoticePath: 'HORIZON-RUNTIME-NOTICE.txt';
  entryComposition: string;
  compositionPath: 'composition.json';
  runtimePath: 'horizon-runtime.js';
  stylesheetPath: 'horizon-runtime.css';
  contractPath: 'scene-contract.json';
  declarationsPath: 'horizon-runtime.d.ts';
  createdAt: string;
  assets: Record<string, PublishedAssetEntry>;
  requiredFeatures: string[];
  trustedCode: boolean;
  contract: PublishedSceneContract;
  provenance?: Record<string, unknown>;
}

export interface PrepareStaticPublishOptions {
  /** Defaults to every composition so hosts can switch compositions at runtime. */
  compositionIds?: string[];
  /** Trusted modules are retained only after an explicit opt-in. They are never auto-executed. */
  allowTrustedCode?: boolean;
  horizonVersion?: string;
  provenance?: Record<string, unknown>;
  now?: () => Date;
}

export interface PublishStaticPackageOptions extends PrepareStaticPublishOptions {
  getAssetBlob?: (key: string) => Promise<Blob | null>;
  fetchAsset?: (url: string) => Promise<Response>;
  compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

export interface StaticPublishPlan {
  project: HorizonProject;
  contract: PublishedSceneContract;
  diagnostics: PublishDiagnostic[];
  requiredAssetIds: string[];
  trustedCode: boolean;
  requiredFeatures: string[];
}

export interface StaticPackageResult {
  blob: Blob;
  filename: string;
  manifest: StaticPublishManifest;
  diagnostics: PublishDiagnostic[];
  files: ReadonlyMap<string, Uint8Array>;
}

export class StaticPublishError extends Error {
  constructor(
    message: string,
    readonly diagnostics: PublishDiagnostic[],
  ) {
    super(message);
    this.name = 'StaticPublishError';
  }
}

function sortedEntries<T>(record: Record<string, T>): Array<[string, T]> {
  return Object.entries(record).sort(([left], [right]) => left.localeCompare(right));
}

function sortedRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  return Object.fromEntries(
    [...entries].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return sortedRecord(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      canonicalize(item),
    ]),
  );
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function addDiagnostic(
  diagnostics: PublishDiagnostic[],
  severity: PublishDiagnosticSeverity,
  code: string,
  message: string,
  path?: string,
): void {
  diagnostics.push({ severity, code, message, ...(path ? { path } : {}) });
}

function cloneRecordSubset<T>(
  source: Record<string, T>,
  ids: Iterable<string>,
): Record<string, T> {
  const entries: Array<[string, T]> = [];
  for (const id of [...new Set(ids)].sort()) {
    if (source[id] !== undefined) entries.push([id, structuredClone(source[id])]);
  }
  return Object.fromEntries(entries);
}

function expandPublishedChildren(
  project: HorizonProject,
  nodeId: string,
  diagnostics: PublishDiagnostic[],
  stack = new Set<string>(),
): string[] {
  if (stack.has(nodeId)) {
    addDiagnostic(diagnostics, 'error', 'node-cycle', `Node hierarchy contains a cycle at ${nodeId}`);
    return [];
  }
  const node = project.nodes[nodeId];
  if (!node) {
    addDiagnostic(diagnostics, 'error', 'missing-node', `Composition references missing node ${nodeId}`);
    return [];
  }
  if (node.type !== 'helper') return [nodeId];
  const nextStack = new Set(stack).add(nodeId);
  return node.children.flatMap((childId) =>
    expandPublishedChildren(project, childId, diagnostics, nextStack),
  );
}

function collectNodes(
  project: HorizonProject,
  rootIds: string[],
  diagnostics: PublishDiagnostic[],
): Set<string> {
  const collected = new Set<string>();
  const visiting = new Set<string>();
  const visit = (nodeId: string) => {
    if (collected.has(nodeId)) return;
    if (visiting.has(nodeId)) {
      addDiagnostic(diagnostics, 'error', 'node-cycle', `Node hierarchy contains a cycle at ${nodeId}`);
      return;
    }
    const node = project.nodes[nodeId];
    if (!node) {
      addDiagnostic(diagnostics, 'error', 'missing-node', `Composition references missing node ${nodeId}`);
      return;
    }
    visiting.add(nodeId);
    if (node.type !== 'helper') collected.add(nodeId);
    node.children.forEach(visit);
    visiting.delete(nodeId);
  };
  rootIds.forEach(visit);
  return collected;
}

function nearestPublishedParent(
  project: HorizonProject,
  node: HorizonNode,
  included: Set<string>,
): string | null {
  let parentId = node.parentId;
  const seen = new Set<string>();
  while (parentId) {
    if (seen.has(parentId)) return null;
    seen.add(parentId);
    if (included.has(parentId)) return parentId;
    parentId = project.nodes[parentId]?.parentId ?? null;
  }
  return null;
}

function publishedChildren(
  project: HorizonProject,
  node: HorizonNode,
  included: Set<string>,
  diagnostics: PublishDiagnostic[],
): string[] {
  return node.children
    .flatMap((childId) => expandPublishedChildren(project, childId, diagnostics))
    .filter((childId) => included.has(childId));
}

function timelineLookup(project: HorizonProject, name: string): Sequence | undefined {
  return Object.values(project.sequences).find(
    (sequence) => sequence.name === name || sequence.id === name,
  );
}

function collectSequences(
  project: HorizonProject,
  initialIds: Iterable<string>,
  diagnostics: PublishDiagnostic[],
): { sequenceIds: Set<string>; trackIds: Set<string> } {
  const sequenceIds = new Set<string>();
  const trackIds = new Set<string>();
  const visit = (sequenceId: string) => {
    if (sequenceIds.has(sequenceId)) return;
    const sequence = project.sequences[sequenceId];
    if (!sequence) {
      addDiagnostic(diagnostics, 'error', 'missing-sequence', `Missing sequence ${sequenceId}`);
      return;
    }
    sequenceIds.add(sequenceId);
    for (const trackId of sequence.tracks) {
      const track = project.tracks[trackId];
      if (!track) {
        addDiagnostic(
          diagnostics,
          'error',
          'missing-track',
          `Sequence ${sequence.name} references missing track ${trackId}`,
        );
        continue;
      }
      trackIds.add(trackId);
      for (const clip of track.clips ?? []) {
        if (clip.kind === 'sequence') visit(clip.sequenceId);
      }
    }
  };
  [...initialIds].sort().forEach(visit);
  return { sequenceIds, trackIds };
}

function collectMatchingIds(value: unknown, candidates: Set<string>, output: Set<string>): void {
  if (typeof value === 'string') {
    if (candidates.has(value)) output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectMatchingIds(item, candidates, output));
    return;
  }
  if (!value || typeof value !== 'object') return;
  Object.values(value as Record<string, unknown>).forEach((item) =>
    collectMatchingIds(item, candidates, output),
  );
}

function propertyValueMatchesType(type: PublicProperty['type'], value: unknown): boolean {
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (
    type === 'string' ||
    type === 'color' ||
    type === 'enum' ||
    type === 'reference' ||
    type === 'texture' ||
    type === 'asset'
  ) {
    return typeof value === 'string';
  }
  const lengths: Partial<Record<PublicProperty['type'], number>> = {
    vec2: 2,
    vec3: 3,
    vec4: 4,
    quaternion: 4,
  };
  const length = lengths[type];
  return (
    length !== undefined &&
    Array.isArray(value) &&
    value.length === length &&
    value.every((part) => typeof part === 'number' && Number.isFinite(part))
  );
}

function publicContract(
  project: HorizonProject,
  compositions: Array<{ id: string; name: string }>,
): PublishedSceneContract {
  const properties = sortedRecord(
    sortedEntries(project.publicContract.properties).map(([name, property]) => [
      name,
      {
        type: property.type,
        read: property.read,
        write: property.write,
        ...(property.min !== undefined ? { min: property.min } : {}),
        ...(property.max !== undefined ? { max: property.max } : {}),
      },
    ]),
  );
  return {
    version: 1,
    properties,
    timelines: [...new Set(project.publicContract.timelines)].sort(),
    events: [...new Set(project.publicContract.events)].sort(),
    compositions: [...compositions].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function validatePublicContract(
  project: HorizonProject,
  includedNodes: Set<string>,
  materialIds: Set<string>,
  fieldIds: Set<string>,
  diagnostics: PublishDiagnostic[],
): void {
  for (const [name, property] of sortedEntries(project.publicContract.properties)) {
    const ownerExists =
      includedNodes.has(property.target.ownerId) ||
      materialIds.has(property.target.ownerId) ||
      fieldIds.has(property.target.ownerId);
    if (!ownerExists) {
      addDiagnostic(
        diagnostics,
        'error',
        'private-property-target',
        `Public property "${name}" targets an unpublished owner`,
        `publicContract.properties.${name}`,
      );
      continue;
    }
    const value = getProperty(project, property.target.ownerId, property.target.path);
    if (value === undefined) {
      addDiagnostic(
        diagnostics,
        'error',
        'missing-property-target',
        `Public property "${name}" targets a missing property`,
        `publicContract.properties.${name}`,
      );
    } else if (!propertyValueMatchesType(property.type, value)) {
      addDiagnostic(
        diagnostics,
        'error',
        'property-type-mismatch',
        `Public property "${name}" declares ${property.type}, but its current value does not match`,
        `publicContract.properties.${name}`,
      );
    }
    if (
      property.min !== undefined &&
      property.max !== undefined &&
      property.min > property.max
    ) {
      addDiagnostic(
        diagnostics,
        'error',
        'invalid-property-range',
        `Public property "${name}" has min greater than max`,
      );
    }
  }
}

function sanitizeBehaviors(
  project: HorizonProject,
  includedNodes: Set<string>,
  diagnostics: PublishDiagnostic[],
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const publicProperties = new Set(Object.keys(project.publicContract.properties));
  const publicEvents = new Set(project.publicContract.events);
  const publicTimelines = new Set(project.publicContract.timelines);
  for (const [id, raw] of sortedEntries(project.behaviors)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      addDiagnostic(diagnostics, 'warning', 'invalid-behavior', `Behavior ${id} is not publishable`);
      continue;
    }
    const behavior = structuredClone(raw) as Record<string, unknown>;
    if (typeof behavior.nodeId === 'string' && !includedNodes.has(behavior.nodeId)) {
      addDiagnostic(
        diagnostics,
        'warning',
        'excluded-behavior',
        `Behavior ${id} targets an unpublished node and was excluded`,
      );
      continue;
    }
    const actions = Array.isArray(behavior.actions)
      ? (behavior.actions as Array<Record<string, unknown>>)
      : [];
    const safeActions = actions.filter((action) => {
      if (action.type === 'setProperty') return publicProperties.has(String(action.publicName));
      if (action.type === 'emit') return publicEvents.has(String(action.event));
      if (action.type === 'timeline') return publicTimelines.has(String(action.timeline));
      return false;
    });
    if (safeActions.length !== actions.length) {
      addDiagnostic(
        diagnostics,
        'warning',
        'private-behavior-action',
        `Behavior ${id} contained private or unsupported actions; those actions were excluded`,
      );
    }
    behavior.actions = safeActions;
    output[id] = behavior;
  }
  return output;
}

function inspectMarkup(nodes: Record<string, HorizonNode>, diagnostics: PublishDiagnostic[]): void {
  const unsafe = /<\s*(script|iframe|object|embed|link|meta)\b|\son[a-z]+\s*=|javascript\s*:/i;
  for (const [id, node] of sortedEntries(nodes)) {
    if (node.type !== 'html' && node.type !== 'svg') continue;
    const markup = String(node.properties[`${node.type}.content`] ?? '');
    if (unsafe.test(markup)) {
      addDiagnostic(
        diagnostics,
        'warning',
        'sanitized-markup',
        `${node.name || id} contains executable markup; the runtime will remove it`,
        `nodes.${id}`,
      );
    }
  }
}

/**
 * Produces a validated, editor-free runtime project and package plan. This does
 * not read assets or trigger a browser download.
 */
export function prepareStaticPublish(
  project: HorizonProject,
  options: PrepareStaticPublishOptions = {},
): StaticPublishPlan {
  const diagnostics: PublishDiagnostic[] = [];
  try {
    validateProject(project);
  } catch (error) {
    addDiagnostic(
      diagnostics,
      'error',
      'invalid-project',
      error instanceof Error ? error.message : String(error),
    );
    throw new StaticPublishError('Project is not publishable', diagnostics);
  }

  const selectedIds = options.compositionIds?.length
    ? [...new Set(options.compositionIds)].sort()
    : Object.keys(project.compositions).sort();
  if (!selectedIds.includes(project.activeCompositionId)) {
    addDiagnostic(
      diagnostics,
      'error',
      'missing-entry-composition',
      'The active composition must be included in a static package',
    );
  }
  for (const id of selectedIds) {
    if (!project.compositions[id]) {
      addDiagnostic(diagnostics, 'error', 'missing-composition', `Composition ${id} does not exist`);
    }
  }

  const selectedCompositions = selectedIds
    .map((id) => project.compositions[id])
    .filter((composition): composition is NonNullable<typeof composition> => Boolean(composition));
  const roots = selectedCompositions.flatMap((composition) => resolveCompositionRootNodes(project, composition.id));
  const includedNodes = collectNodes(project, roots, diagnostics);
  for (const composition of selectedCompositions) {
    const camera = project.nodes[composition.activeCamera];
    if (!camera || camera.type !== 'camera' || !includedNodes.has(camera.id)) {
      addDiagnostic(
        diagnostics,
        'error',
        'missing-active-camera',
        `Composition ${composition.name} does not have a publishable active camera`,
        `compositions.${composition.id}.activeCamera`,
      );
    }
  }

  const initialSequenceIds = new Set<string>();
  for (const composition of selectedCompositions) {
    if (composition.sequence) initialSequenceIds.add(composition.sequence);
  }
  for (const timeline of project.publicContract.timelines) {
    const sequence = timelineLookup(project, timeline);
    if (!sequence) {
      addDiagnostic(
        diagnostics,
        'error',
        'missing-public-timeline',
        `Public timeline "${timeline}" does not resolve to a sequence`,
      );
    } else {
      initialSequenceIds.add(sequence.id);
    }
  }
  const experienceSequenceId = (project.metadata.videoEdit as { sequenceId?: string } | undefined)?.sequenceId;
  if (experienceSequenceId && project.sequences[experienceSequenceId]) {
    initialSequenceIds.add(experienceSequenceId);
  }
  const { sequenceIds, trackIds } = collectSequences(project, initialSequenceIds, diagnostics);

  const nodes: Record<string, HorizonNode> = {};
  for (const id of [...includedNodes].sort()) {
    const source = project.nodes[id];
    const node = structuredClone(source);
    node.parentId = nearestPublishedParent(project, source, includedNodes);
    node.children = publishedChildren(project, source, includedNodes, diagnostics);
    node.locked = false;
    nodes[id] = node;
  }

  const materialIds = new Set<string>();
  const allMaterialIds = new Set(Object.keys(project.materials));
  collectMatchingIds(nodes, allMaterialIds, materialIds);
  const tracks = cloneRecordSubset(project.tracks, trackIds);
  collectMatchingIds(tracks, allMaterialIds, materialIds);
  for (const property of Object.values(project.publicContract.properties)) {
    if (allMaterialIds.has(property.target.ownerId)) materialIds.add(property.target.ownerId);
  }
  const materials = cloneRecordSubset(project.materials, materialIds);

  const shaderIds = new Set<string>();
  for (const material of Object.values(materials)) {
    if (project.shaders[material.shaderId]) shaderIds.add(material.shaderId);
    else {
      addDiagnostic(
        diagnostics,
        'warning',
        'missing-shader',
        `Material ${material.name} references missing shader ${material.shaderId}; runtime fallback will be used`,
      );
    }
  }
  const shaders = cloneRecordSubset(project.shaders, shaderIds);

  const fieldIds = new Set<string>();
  const allFieldIds = new Set(Object.keys(project.fields));
  collectMatchingIds(tracks, allFieldIds, fieldIds);
  for (const property of Object.values(project.publicContract.properties)) {
    if (allFieldIds.has(property.target.ownerId)) fieldIds.add(property.target.ownerId);
  }
  for (const node of Object.values(nodes)) {
    if (node.type === 'field' && project.fields[node.id]) fieldIds.add(node.id);
  }
  const fields = cloneRecordSubset(project.fields, fieldIds);

  for (const [trackId, track] of sortedEntries(tracks)) {
    if (
      ['event', 'audio', 'video', 'media', 'sequence'].includes(track.kind ?? '')
    ) {
      continue;
    }
    const targetOwnerExists =
      includedNodes.has(track.target.ownerId) ||
      materialIds.has(track.target.ownerId) ||
      fieldIds.has(track.target.ownerId);
    if (!targetOwnerExists) {
      addDiagnostic(
        diagnostics,
        'error',
        'unpublished-track-target',
        `Track ${track.name || trackId} targets an unpublished owner`,
        `tracks.${trackId}.target`,
      );
    } else if (
      getProperty(project, track.target.ownerId, track.target.path) === undefined
    ) {
      addDiagnostic(
        diagnostics,
        'error',
        'missing-track-target',
        `Track ${track.name || trackId} targets a missing property`,
        `tracks.${trackId}.target`,
      );
    }
  }

  validatePublicContract(project, includedNodes, materialIds, fieldIds, diagnostics);
  inspectMarkup(nodes, diagnostics);

  const trustedShaders = Object.values(shaders).filter(
    (shader) => shader.kind === 'custom-js' && Boolean(shader.moduleSource),
  );
  const trustedCode = trustedShaders.length > 0;
  if (trustedCode && !options.allowTrustedCode) {
    addDiagnostic(
      diagnostics,
      'error',
      'trusted-code-approval-required',
      'Referenced custom JavaScript shaders require explicit allowTrustedCode approval',
    );
  } else if (trustedCode) {
    addDiagnostic(
      diagnostics,
      'warning',
      'trusted-code-retained',
      'Trusted custom shader source is retained as data but is not auto-executed by the static runtime',
    );
  }

  const unsupportedNodes = Object.values(nodes).filter((node) =>
    ['effect', 'volume', 'reflectionProbe'].includes(node.type),
  );
  for (const node of unsupportedNodes) {
    addDiagnostic(
      diagnostics,
      'warning',
      'runtime-fallback',
      `${node.name} (${node.type}) uses a reduced static-runtime representation`,
      `nodes.${node.id}`,
    );
  }

  const compositions = cloneRecordSubset(project.compositions, selectedIds);
  for (const composition of Object.values(compositions)) {
    composition.rootNodes = resolveCompositionRootNodes(project, composition.id).flatMap((rootId) =>
      expandPublishedChildren(project, rootId, diagnostics),
    );
    composition.inherits = [];
  }

  const retainedPublicContract = {
    properties: sortedRecord(
      sortedEntries(project.publicContract.properties).map(([name, property]) => [
        name,
        structuredClone(property),
      ]),
    ),
    timelines: [...new Set([
      ...project.publicContract.timelines,
      ...(experienceSequenceId && project.sequences[experienceSequenceId]?.experience?.scriptable
        ? [project.sequences[experienceSequenceId].name]
        : []),
    ])].sort(),
    events: [...new Set(project.publicContract.events)].sort(),
  };

  const runtimeProject: HorizonProject = {
    schemaVersion: project.schemaVersion,
    projectId: project.projectId,
    name: project.name,
    activeCompositionId: project.activeCompositionId,
    assets: {},
    compositions,
    nodes,
    materials,
    shaders,
    fields,
    sequences: cloneRecordSubset(project.sequences, sequenceIds),
    tracks,
    behaviors: sanitizeBehaviors(project, includedNodes, diagnostics),
    publicContract: retainedPublicContract,
    renderPresets: {},
    renderJobs: {},
    renderSettings: structuredClone(project.renderSettings),
    variants: structuredClone(project.variants),
    metadata: sortedRecord(
      ['presentation', 'presentationCaptions', 'runtime', 'videoEdit']
        .filter((key) => project.metadata[key] !== undefined)
        .map((key) => [key, structuredClone(project.metadata[key])] as const),
    ),
  };
  if (
    experienceSequenceId &&
    runtimeProject.sequences[experienceSequenceId]?.experience?.outputs.includes('interactive-web')
  ) {
    runtimeProject.metadata.runtimeExperienceSequenceId = experienceSequenceId;
  }

  const allAssetIds = new Set(Object.keys(project.assets));
  const requiredAssets = new Set<string>();
  collectMatchingIds(runtimeProject, allAssetIds, requiredAssets);
  for (const assetId of [...requiredAssets]) {
    runtimeProject.assets[assetId] = structuredClone(project.assets[assetId]);
  }
  if (Object.keys(retainedPublicContract.properties).length === 0) {
    addDiagnostic(
      diagnostics,
      'warning',
      'empty-public-contract',
      'No public properties are exposed',
    );
  }

  const requiredFeatures = [
    ...(trustedCode ? ['custom-shaders'] : []),
    ...(Object.values(nodes).some((node) => node.type === 'volume') ? ['volumetrics'] : []),
    ...(Object.values(nodes).some((node) => node.type === 'html' || node.type === 'svg')
      ? ['dom-layers']
      : []),
    ...(experienceSequenceId ? ['experience-timeline'] : []),
  ].sort();

  return {
    project: runtimeProject,
    contract: publicContract(
      runtimeProject,
      selectedCompositions.map(({ id, name }) => ({ id, name })),
    ),
    diagnostics: diagnostics.sort((left, right) =>
      `${left.severity}:${left.code}:${left.path ?? ''}:${left.message}`.localeCompare(
        `${right.severity}:${right.code}:${right.path ?? ''}:${right.message}`,
      ),
    ),
    requiredAssetIds: [...requiredAssets].sort(),
    trustedCode,
    requiredFeatures,
  };
}

function assertAssetRecord(value: unknown, assetId: string): AssetRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Asset ${assetId} is not a valid asset record`);
  }
  const asset = value as AssetRecord;
  if (asset.id !== assetId || !asset.mimeType || !asset.kind || !asset.storage) {
    throw new Error(`Asset ${assetId} has invalid metadata`);
  }
  return asset;
}

function blobFromDataUrl(dataUrl: string): Blob {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('Inline asset has an invalid data URL');
  const mimeType = match[1] || 'application/octet-stream';
  const encoded = match[3];
  if (match[2]) {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new Blob([bytes], { type: mimeType });
  }
  return new Blob([decodeURIComponent(encoded)], { type: mimeType });
}

async function readAsset(
  asset: AssetRecord,
  options: PublishStaticPackageOptions,
): Promise<Blob> {
  if (asset.storage === 'indexeddb' || asset.storage === 'opfs') {
    if (!asset.blobKey) throw new Error('IndexedDB asset is missing blobKey');
    const blob = await (options.getAssetBlob ?? getBlob)(asset.blobKey);
    if (!blob) throw new Error(`Stored blob ${asset.blobKey} is unavailable`);
    return blob;
  }
  if (asset.storage === 'inline') {
    if (!asset.dataUrl) throw new Error('Inline asset is missing dataUrl');
    return blobFromDataUrl(asset.dataUrl);
  }
  if (asset.storage === 'url') {
    if (!asset.url) throw new Error('Remote asset is missing url');
    const response = await (options.fetchAsset ?? fetch)(asset.url);
    if (!response.ok) throw new Error(`Remote asset request failed (${response.status})`);
    return response.blob();
  }
  throw new Error(`Unsupported asset storage ${String(asset.storage)}`);
}

function extensionFor(asset: AssetRecord): string {
  const mimeExtensions: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/ogg': '.ogg',
    'font/woff2': '.woff2',
    'font/woff': '.woff',
    'model/gltf-binary': '.glb',
    'model/gltf+json': '.gltf',
  };
  return mimeExtensions[asset.mimeType.toLowerCase()] ?? '';
}

function runtimeDeclarations(contract: PublishedSceneContract): string {
  const propertyNames = Object.keys(contract.properties);
  const timelineNames = contract.timelines;
  const eventNames = contract.events;
  const compositionNames = contract.compositions.flatMap(({ id, name }) => [id, name]);
  const union = (values: string[]) =>
    values.length ? values.map((value) => JSON.stringify(value)).join(' | ') : 'never';
  return `/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type HorizonPropertyName = ${union(propertyNames)};
export type HorizonTimelineName = ${union(timelineNames)};
export type HorizonEventName = ${union(eventNames)};
export type HorizonCompositionName = ${union([...new Set(compositionNames)])};
export type HorizonDriver = 'time' | 'manual' | 'scroll' | 'pointer' | 'external' | 'presentation' | 'event';

export interface HorizonRuntimeEvent<T = unknown> {
  readonly type: string;
  readonly detail: T;
  readonly runtime: HorizonRuntime;
}

export interface HorizonTimeline {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  progress(value: number): void;
  rate(value: number): void;
  stop(): void;
  setDriver(driver: HorizonDriver, input?: Record<string, unknown>): void;
}

export interface HorizonRuntime {
  ready(): Promise<this>;
  contract(): Readonly<PublishedSceneContract>;
  loadComposition(name: HorizonCompositionName): Promise<void>;
  get(name: HorizonPropertyName): unknown;
  set(name: HorizonPropertyName, value: unknown): void;
  update(values: Partial<Record<HorizonPropertyName, unknown>>): void;
  play(timeline?: HorizonTimelineName): void;
  pause(): void;
  seek(seconds: number, timeline?: HorizonTimelineName): void;
  setDriver(driver: HorizonDriver, input?: Record<string, unknown>): void;
  trigger(name: HorizonEventName, detail?: unknown): void;
  subscribe(name: HorizonEventName | 'ready' | 'error' | 'compositionchange' | 'timeline:start' | 'timeline:pause' | 'timeline:complete', handler: (event: HorizonRuntimeEvent) => void): () => void;
  on(name: HorizonEventName, handler: (event: HorizonRuntimeEvent) => void): () => void;
  timeline(name: HorizonTimelineName): HorizonTimeline;
  presentationState(): Readonly<{ active: boolean; slideIndex: number; compositionId?: string; revealIndex: number; revealCount: number }>;
  enterPresentation(): Readonly<{ active: boolean; slideIndex: number; compositionId?: string; revealIndex: number; revealCount: number }>;
  exitPresentation(): Readonly<{ active: boolean; slideIndex: number; compositionId?: string; revealIndex: number; revealCount: number }>;
  next(): Promise<Readonly<{ active: boolean; slideIndex: number; compositionId?: string; revealIndex: number; revealCount: number }>>;
  previous(): Promise<Readonly<{ active: boolean; slideIndex: number; compositionId?: string; revealIndex: number; revealCount: number }>>;
  goTo(slide: number | HorizonCompositionName): Promise<Readonly<{ active: boolean; slideIndex: number; compositionId?: string; revealIndex: number; revealCount: number }>>;
  resize(): void;
  dispose(): void;
}

export interface PublishedSceneContract {
  readonly version: 1;
  readonly properties: Readonly<Record<HorizonPropertyName, {
    readonly type: string;
    readonly read: boolean;
    readonly write: boolean;
    readonly min?: number;
    readonly max?: number;
  }>>;
  readonly timelines: readonly HorizonTimelineName[];
  readonly events: readonly HorizonEventName[];
  readonly compositions: readonly { readonly id: string; readonly name: string }[];
}

export const Horizon: {
  mount(target: string | HTMLElement, manifestUrl?: string | URL, options?: {
    quality?: 'auto' | 'interactive' | 'high';
    reducedMotion?: 'system' | boolean;
  }): Promise<HorizonRuntime>;
};
`;
}

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function indexHtml(name: string): string {
  return `<!doctype html>
<!--
  Copyright 2026 J3nna Technologies, LLC
  SPDX-License-Identifier: Apache-2.0
-->
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <title>${htmlEscape(name)}</title>
  <link rel="stylesheet" href="./horizon-runtime.css">
  <style>
    html,body,#horizon-root{width:100%;height:100%;margin:0}body{background:#050505;overflow:hidden}
    #horizon-transport{position:fixed;z-index:2147483646;left:24px;right:24px;bottom:20px;display:grid;grid-template-columns:auto minmax(180px,1fr) auto;gap:14px;align-items:center;padding:9px 11px;border:1px solid #ffffff20;border-radius:14px;background:#090909c7;box-shadow:0 18px 55px #0008;backdrop-filter:blur(20px);transition:opacity .35s,transform .35s}
    #horizon-transport[hidden],#horizon-captions[hidden]{display:none}#horizon-transport.quiet{opacity:0;transform:translateY(12px);pointer-events:none}#horizon-transport.recording-hidden{opacity:0;transform:translateY(12px);pointer-events:none;transition:none}.horizon-transport-group{display:flex;gap:7px;align-items:center}#horizon-transport button{height:34px;min-width:38px;border:1px solid #ffffff1f;border-radius:8px;background:#ffffff0b;color:#eee;font:650 13px system-ui;cursor:pointer}#horizon-transport button:hover,#horizon-transport button[aria-pressed="true"]{border-color:#ff642e88;background:#ff642e22}#horizon-chapter{padding:0 5px;color:#aaa;font:650 10px ui-monospace,monospace;letter-spacing:.08em;white-space:nowrap}.horizon-scrub-group{display:grid;grid-template-columns:auto minmax(100px,1fr) auto;gap:10px;align-items:center}#horizon-progress{width:100%;accent-color:#ff642e;cursor:pointer}#horizon-elapsed,#horizon-duration{color:#bbb;font:650 10px ui-monospace,monospace;font-variant-numeric:tabular-nums}#horizon-captions{position:fixed;z-index:2147483645;left:50%;top:24px;max-width:min(820px,80vw);transform:translateX(-50%);padding:10px 16px;border:1px solid #ffffff1f;border-radius:10px;background:#080808c9;color:#fff;text-align:center;font:600 16px/1.4 system-ui;backdrop-filter:blur(16px);box-shadow:0 12px 40px #0008}@media(max-width:760px){#horizon-transport{left:8px;right:8px;grid-template-columns:auto 1fr}.horizon-transport-actions{display:none}.horizon-scrub-group{grid-column:1/-1;grid-row:2}}
  </style>
</head>
<body>
  <main id="horizon-root" aria-label="${htmlEscape(name)}"></main>
  <div id="horizon-captions" role="status" aria-live="polite" hidden></div>
  <nav id="horizon-transport" aria-label="Presentation controls" hidden>
    <div class="horizon-transport-group"><button id="horizon-previous" aria-label="Previous chapter">‹</button><button id="horizon-play" aria-label="Play">▶</button><button id="horizon-next" aria-label="Next chapter">›</button><span id="horizon-chapter"></span></div>
    <div class="horizon-scrub-group"><span id="horizon-elapsed">0:00</span><input id="horizon-progress" type="range" min="0" step="0.01" value="0" aria-label="Presentation position"><span id="horizon-duration">0:00</span></div>
    <div class="horizon-transport-group horizon-transport-actions"><button id="horizon-cc" aria-label="Toggle closed captions" aria-pressed="false">CC</button><button id="horizon-restart">Restart</button><button id="horizon-fullscreen">Full screen</button></div>
  </nav>
  <script type="module" src="./bootstrap.js"></script>
</body>
</html>
`;
}

const bootstrapSource = `/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Horizon } from './horizon-runtime.js';

const project = await fetch('./composition.json').then((response) => response.json());
const runtime = await Horizon.mount('#horizon-root', './manifest.json');
globalThis.horizon = runtime;
const sequenceId = project.metadata.runtimeExperienceSequenceId;
const sequence = sequenceId ? project.sequences[sequenceId] : null;
if (sequence?.experience?.controls) {
  const markers = sequence.markers ?? [];
  const captions = Array.isArray(project.metadata.presentationCaptions) ? project.metadata.presentationCaptions : [];
  const timeline = runtime.timeline(sequence.name);
  const transport = document.querySelector('#horizon-transport');
  const play = document.querySelector('#horizon-play');
  const previous = document.querySelector('#horizon-previous');
  const next = document.querySelector('#horizon-next');
  const chapter = document.querySelector('#horizon-chapter');
  const progress = document.querySelector('#horizon-progress');
  const elapsed = document.querySelector('#horizon-elapsed');
  const duration = document.querySelector('#horizon-duration');
  const cc = document.querySelector('#horizon-cc');
  const captionBox = document.querySelector('#horizon-captions');
  let playing = Boolean(sequence.experience.autoplay);
  let markerIndex = 0;
  let scrubbing = false;
  let resumeAfterScrub = false;
  let captionsOn = false;
  let quietTimer = 0;
  let delayedPlayTimer = 0;
  let controlsLockedHidden = false;
  const formatTime = (value) => { const safe=Math.max(0,Number(value)||0); return Math.floor(safe/60)+':'+String(Math.floor(safe%60)).padStart(2,'0'); };
  const updatePlayButton = () => { play.textContent=playing?'Ⅱ':'▶';play.setAttribute('aria-label',playing?'Pause':'Play'); };
  const cancelDelayedPlay = () => { if(delayedPlayTimer){clearTimeout(delayedPlayTimer);delayedPlayTimer=0;} };
  const showControls = () => { if(controlsLockedHidden)return;transport.classList.remove('quiet','recording-hidden');clearTimeout(quietTimer);if(playing&&!scrubbing)quietTimer=setTimeout(()=>transport.classList.add('quiet'),4000); };
  const beginRecordingPlayback = () => { cancelDelayedPlay();clearTimeout(quietTimer);if(playing){playing=false;timeline.pause();}updatePlayButton();controlsLockedHidden=true;transport.classList.add('quiet','recording-hidden');delayedPlayTimer=setTimeout(()=>{delayedPlayTimer=0;if(!controlsLockedHidden)return;playing=true;timeline.play();updatePlayButton();},2000); };
  const revealControls = (pausePlayback=false) => { const wasWaiting=Boolean(delayedPlayTimer);cancelDelayedPlay();controlsLockedHidden=false;transport.classList.remove('quiet','recording-hidden');if(pausePlayback||wasWaiting){playing=false;timeline.pause();updatePlayButton();}showControls(); };
  const captionAt = (time) => captions.findLast((item)=>{const start=Number(item.start??item.time??0);const end=item.end===undefined?Infinity:Number(item.end);return start<=time&&time<end;})??null;
  const updateCaption = (time=Number(runtime.time)||0) => { const item=captionAt(time); captionBox.textContent=item?.text??item?.title??''; captionBox.hidden=!captionsOn||!captionBox.textContent; };
  const updateChapter = () => { chapter.textContent=markers.length?String(markerIndex+1).padStart(2,'0')+' / '+String(markers.length).padStart(2,'0'):''; updateCaption(); };
  const setPlaying = (nextState) => { cancelDelayedPlay();playing=nextState;if(playing)timeline.play();else timeline.pause();updatePlayButton();showControls(); };
  const goTo = (index) => { if(!markers.length){timeline.seek(0);return} markerIndex=Math.max(0,Math.min(markers.length-1,index));timeline.seek(markers[markerIndex]?.time??0);updateChapter();if(playing)timeline.play();showControls(); };
  transport.hidden=false; progress.max=String(sequence.duration); duration.textContent=formatTime(sequence.duration); updateChapter(); setPlaying(playing);
  play.addEventListener('click',()=>setPlaying(!playing)); previous.addEventListener('click',()=>goTo(markerIndex-1)); next.addEventListener('click',()=>goTo(markerIndex+1));
  document.querySelector('#horizon-restart').addEventListener('click',()=>goTo(0)); document.querySelector('#horizon-fullscreen').addEventListener('click',()=>document.documentElement.requestFullscreen?.());
  cc.addEventListener('click',()=>{captionsOn=!captionsOn;cc.setAttribute('aria-pressed',String(captionsOn));updateCaption();showControls()});
  progress.addEventListener('pointerdown',()=>{scrubbing=true;resumeAfterScrub=playing;if(playing)setPlaying(false)});
  const seekFromProgress=()=>{const time=Number(progress.value);timeline.seek(time);markerIndex=Math.max(0,markers.findLastIndex((marker)=>marker.time<=time));elapsed.textContent=formatTime(time);updateChapter();showControls()};
  progress.addEventListener('input',seekFromProgress);const finishScrub=()=>{if(!scrubbing)return;scrubbing=false;if(resumeAfterScrub)setPlaying(true);resumeAfterScrub=false;showControls()};progress.addEventListener('pointerup',finishScrub);progress.addEventListener('change',()=>{seekFromProgress();finishScrub()});
  addEventListener('mousemove',showControls,{passive:true});addEventListener('keydown',(event)=>{if(event.key===' '){event.preventDefault();if(controlsLockedHidden)revealControls(true);else beginRecordingPlayback();return}if(event.key==='Escape'&&controlsLockedHidden){revealControls(false);return}if(event.key==='ArrowLeft')goTo(markerIndex-1);if(event.key==='ArrowRight')goTo(markerIndex+1);if(event.key.toLowerCase()==='r')goTo(0);if(event.key.toLowerCase()==='f')document.documentElement.requestFullscreen?.();if(event.key.toLowerCase()==='c')cc.click()});
  runtime.subscribe('timeline:complete',()=>setPlaying(false));markers.forEach((marker,index)=>runtime.subscribe(marker.name,()=>{markerIndex=index;updateChapter()}));
  const sync=()=>{if(!scrubbing){const time=Number(runtime.time)||0;progress.value=String(time);elapsed.textContent=formatTime(time);const nextIndex=Math.max(0,markers.findLastIndex((marker)=>marker.time<=time));if(nextIndex!==markerIndex){markerIndex=nextIndex;updateChapter()}else if(captionsOn)updateCaption(time)}requestAnimationFrame(sync)};sync();
}
`;

function normalizeVendorImports(source: string): string {
  return source.replaceAll("from 'three'", "from '../three.module.min.js'");
}

function packageFilename(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug || 'horizon-scene'}.zip`;
}

function throwForErrors(diagnostics: PublishDiagnostic[]): void {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length) {
    throw new StaticPublishError(
      errors.length === 1
        ? errors[0].message
        : `Static publish failed with ${errors.length} errors`,
      diagnostics,
    );
  }
}

/**
 * Builds a complete, content-addressed static ZIP. The caller remains
 * responsible for the user-visible download gesture.
 */
export async function publishStaticPackage(
  project: HorizonProject,
  options: PublishStaticPackageOptions = {},
): Promise<StaticPackageResult> {
  const plan = prepareStaticPublish(project, options);
  const diagnostics = [...plan.diagnostics];
  throwForErrors(diagnostics);

  const files = new Map<string, Uint8Array>();
  const manifestAssets: Record<string, PublishedAssetEntry> = {};
  const runtimeProject = structuredClone(plan.project);
  const contentFiles = new Map<string, Uint8Array>();

  for (const assetId of plan.requiredAssetIds) {
    try {
      const asset = assertAssetRecord(project.assets[assetId], assetId);
      if (asset.kind === 'custom' && (asset.metadata?.nleTitle || asset.metadata?.horizonComposition)) {
        runtimeProject.assets[assetId] = structuredClone(asset);
        continue;
      }
      const blob = await readAsset(asset, options);
      const hash = await hashBlob(blob);
      if (asset.hash && asset.hash.toLowerCase() !== hash) {
        throw new Error(`declared hash ${asset.hash} does not match ${hash}`);
      }
      const path = `assets/${hash}${extensionFor(asset)}`;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!contentFiles.has(path)) contentFiles.set(path, bytes);
      manifestAssets[assetId] = {
        assetId,
        path,
        hash,
        size: bytes.byteLength,
        mimeType: asset.mimeType,
        kind: asset.kind,
      };
      runtimeProject.assets[assetId] = {
        ...structuredClone(asset),
        storage: 'url',
        url: path,
        hash,
        size: bytes.byteLength,
        dataUrl: undefined,
        blobKey: undefined,
      };
      if (asset.storage === 'url') {
        addDiagnostic(
          diagnostics,
          'warning',
          'remote-asset-vendored',
          `Remote asset ${asset.name} was fetched and embedded in the package`,
          `assets.${assetId}`,
        );
      }
    } catch (error) {
      addDiagnostic(
        diagnostics,
        'error',
        'asset-unavailable',
        `Asset ${assetId} cannot be published: ${error instanceof Error ? error.message : String(error)}`,
        `assets.${assetId}`,
      );
    }
  }
  throwForErrors(diagnostics);

  const manifest: StaticPublishManifest = {
    format: STATIC_PACKAGE_FORMAT,
    packageVersion: STATIC_PACKAGE_VERSION,
    horizonVersion: options.horizonVersion ?? '1.0.0',
    runtimeCompatibility: '^1.0.0',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projectId: project.projectId,
    name: project.name,
    runtimeCopyrightHolder: 'J3nna Technologies, LLC',
    runtimeLicense: 'Apache-2.0',
    runtimeLicensePath: 'HORIZON-RUNTIME-LICENSE.txt',
    runtimeNoticePath: 'HORIZON-RUNTIME-NOTICE.txt',
    entryComposition: project.activeCompositionId,
    compositionPath: 'composition.json',
    runtimePath: 'horizon-runtime.js',
    stylesheetPath: 'horizon-runtime.css',
    contractPath: 'scene-contract.json',
    declarationsPath: 'horizon-runtime.d.ts',
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    assets: sortedRecord(Object.entries(manifestAssets)),
    requiredFeatures: plan.requiredFeatures,
    trustedCode: plan.trustedCode,
    contract: plan.contract,
    ...(options.provenance ? { provenance: structuredClone(options.provenance) } : {}),
  };

  const textFiles: Record<string, string> = {
    'HORIZON-RUNTIME-LICENSE.txt': apacheLicenseText.endsWith('\n') ? apacheLicenseText : `${apacheLicenseText}\n`,
    'HORIZON-RUNTIME-NOTICE.txt': `Horizon Runtime\nCopyright 2026 J3nna Technologies, LLC\n\nThe Apache License applies only to the Horizon runtime software included in this package.\nIt does not apply to, claim copyright in, or grant rights to the user's project, assets, or authored output.\n`,
    'bootstrap.js': bootstrapSource,
    'composition.json': stableJson(runtimeProject),
    'horizon-runtime.css': runtimeCss.endsWith('\n') ? runtimeCss : `${runtimeCss}\n`,
    'horizon-runtime.d.ts': runtimeDeclarations(plan.contract),
    'horizon-runtime.js': runtimeSource.endsWith('\n') ? runtimeSource : `${runtimeSource}\n`,
    'index.html': indexHtml(project.name),
    'manifest.json': stableJson(manifest),
    'scene-contract.json': stableJson(plan.contract),
    'vendor/loaders/GLTFLoader.js': normalizeVendorImports(gltfLoaderSource),
    'vendor/loaders/FontLoader.js': normalizeVendorImports(fontLoaderSource),
    'vendor/geometries/TextGeometry.js': normalizeVendorImports(textGeometrySource),
    'vendor/objects/Sky.js': normalizeVendorImports(skySource),
    'vendor/fonts/helvetiker_bold.typeface.json': helvetikerBoldFont,
    'vendor/three.module.min.js': threeModuleSource,
    'vendor/utils/BufferGeometryUtils.js': normalizeVendorImports(bufferGeometryUtilsSource),
  };
  for (const [path, content] of sortedEntries(textFiles)) files.set(path, strToU8(content));
  for (const [path, bytes] of [...contentFiles].sort(([left], [right]) => left.localeCompare(right))) {
    files.set(path, bytes);
  }

  const zipInput: Record<string, Uint8Array> = {};
  for (const [path, bytes] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    zipInput[path] = bytes;
  }
  const archive = zipSync(zipInput, {
    level: options.compressionLevel ?? 6,
    // DOS ZIP timestamps have a 1980 floor and are encoded in local time.
    mtime: new Date('1980-01-02T00:00:00.000Z'),
  });
  return {
    blob: new Blob([archive.slice().buffer], { type: STATIC_PACKAGE_MIME_TYPE }),
    filename: packageFilename(project.name),
    manifest,
    diagnostics: diagnostics.sort((left, right) =>
      `${left.severity}:${left.code}:${left.path ?? ''}:${left.message}`.localeCompare(
        `${right.severity}:${right.code}:${right.path ?? ''}:${right.message}`,
      ),
    ),
    files,
  };
}

/** Must be called from an explicit user action in browsers. */
export function downloadStaticPackage(result: StaticPackageResult): void {
  const url = URL.createObjectURL(result.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = result.filename;
  anchor.rel = 'noopener';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

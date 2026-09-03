/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { makeCommand } from '../../core/commands';
import { createId } from '../../core/ids';
import { createNode, environmentDefaults } from '../../core/project';
import { deserializeProject, serializeProject } from '../../core/serialization';
import type { HorizonProject, ToolResult } from '../../core/types';
import type { WebMcpContext } from './tools';

type EditOperation = Record<string, unknown> & { op: string; ref?: string; id?: string };

const ID_PREFIX: Record<string, string> = {
  createAsset: 'asset',
  createNode: 'node',
  createShader: 'shader',
  createMaterial: 'material',
  createComposition: 'composition',
  createSequence: 'sequence',
  createTrack: 'track',
  addClip: 'clip',
  addMarker: 'marker',
  addBehavior: 'behavior',
};

function failure(ctx: WebMcpContext, code: string, error: string): ToolResult {
  return { ok: false, code, error, summary: error, revision: ctx.bus.getRevision() };
}

function resolveRefs(value: unknown, refs: Map<string, string>): unknown {
  if (typeof value === 'string' && value.startsWith('@')) {
    const resolved = refs.get(value.slice(1));
    if (!resolved) throw new Error(`Unknown client reference: ${value}`);
    return resolved;
  }
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, refs));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, resolveRefs(child, refs)]));
  }
  return value;
}

function setNested(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) throw new Error('A non-empty path is required');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = structuredClone(value);
}

function uniqueId(operation: EditOperation, refs: Map<string, string>, reserved: Set<string>): string {
  const prefix = ID_PREFIX[operation.op];
  if (!prefix) throw new Error(`Operation ${operation.op} does not create an entity`);
  const id = operation.id?.trim() || createId(prefix);
  if (reserved.has(id)) throw new Error(`ID already exists: ${id}`);
  reserved.add(id);
  if (operation.ref) {
    if (refs.has(operation.ref)) throw new Error(`Duplicate client reference: ${operation.ref}`);
    refs.set(operation.ref, id);
  }
  return id;
}

function applyOperation(draft: HorizonProject, raw: EditOperation, refs: Map<string, string>, ids: Map<EditOperation, string>): void {
  const operation = resolveRefs(raw, refs) as EditOperation;
  const id = ids.get(raw);
  switch (operation.op) {
    case 'setProject': {
      if (operation.name !== undefined) draft.name = String(operation.name);
      if (operation.activeCompositionId !== undefined) draft.activeCompositionId = String(operation.activeCompositionId);
      return;
    }
    case 'setMetadata': {
      const path = String(operation.path ?? '');
      if (!path || path === 'webmcpPermissions' || path.startsWith('webmcpPermissions.')) {
        throw new Error('Metadata path is missing or protected');
      }
      setNested(draft.metadata as Record<string, unknown>, path, operation.value);
      return;
    }
    case 'setPresentation':
      draft.metadata.presentation = structuredClone(operation.value ?? operation.presentation ?? {});
      return;
    case 'setPublicContract':
      draft.publicContract = structuredClone((operation.value ?? operation.publicContract) as HorizonProject['publicContract']);
      return;
    case 'patchEntity': {
      const collection = String(operation.collection ?? '') as keyof HorizonProject;
      const allowed = new Set(['assets', 'nodes', 'shaders', 'materials', 'compositions', 'sequences', 'tracks', 'behaviors', 'variants']);
      if (!allowed.has(collection)) throw new Error(`Unsupported entity collection: ${collection}`);
      const entityId = String(operation.entityId ?? operation.id ?? '');
      const record = draft[collection] as unknown as Record<string, Record<string, unknown>>;
      const entity = record[entityId];
      if (!entity) throw new Error(`Entity not found: ${collection}.${entityId}`);
      const patch = structuredClone((operation.patch ?? operation.value ?? {}) as Record<string, unknown>);
      if (patch.id !== undefined && patch.id !== entityId) throw new Error('patchEntity cannot change an entity ID');
      Object.assign(entity, patch, { id: entityId });
      return;
    }
    case 'moveNode': {
      const nodeId = String(operation.nodeId ?? operation.entityId ?? '');
      const node = draft.nodes[nodeId];
      if (!node) throw new Error(`Node not found: ${nodeId}`);
      if (node.parentId) {
        const previousParent = draft.nodes[node.parentId];
        if (previousParent) previousParent.children = previousParent.children.filter((childId) => childId !== nodeId);
      }
      for (const composition of Object.values(draft.compositions)) {
        composition.rootNodes = composition.rootNodes.filter((rootId) => rootId !== nodeId);
      }
      const parentId = operation.parentId ? String(operation.parentId) : '';
      if (parentId) {
        const parent = draft.nodes[parentId];
        if (!parent) throw new Error(`Parent node not found: ${parentId}`);
        let cursor: typeof parent | undefined = parent;
        while (cursor) {
          if (cursor.id === nodeId) throw new Error('A node cannot be moved beneath itself');
          cursor = cursor.parentId ? draft.nodes[cursor.parentId] : undefined;
        }
        node.parentId = parentId;
        const index = Math.max(0, Math.min(parent.children.length, Number(operation.index ?? parent.children.length)));
        parent.children.splice(index, 0, nodeId);
      } else {
        const compositionId = String(operation.compositionId ?? draft.activeCompositionId);
        const composition = draft.compositions[compositionId];
        if (!composition) throw new Error(`Composition not found: ${compositionId}`);
        node.parentId = null;
        const index = Math.max(0, Math.min(composition.rootNodes.length, Number(operation.index ?? composition.rootNodes.length)));
        composition.rootNodes.splice(index, 0, nodeId);
      }
      return;
    }
    case 'createAsset': {
      const value = (operation.value ?? operation.asset ?? {}) as Record<string, unknown>;
      if (!value.name || !value.kind || !value.mimeType) throw new Error('createAsset requires name, kind, and mimeType');
      draft.assets[id!] = {
        name: String(value.name), kind: value.kind as never, mimeType: String(value.mimeType),
        storage: (value.storage as never) ?? (value.dataUrl ? 'inline' : 'url'),
        importedAt: String(value.importedAt ?? new Date().toISOString()),
        ...structuredClone(value), id: id!,
      } as never;
      return;
    }
    case 'createNode': {
      const value = (operation.value ?? operation.node ?? operation) as Record<string, unknown>;
      const node = createNode(value.type as never, String(value.name ?? 'Object'));
      node.id = id!;
      node.properties = { ...node.properties, ...structuredClone((value.properties ?? {}) as Record<string, unknown>) };
      node.components = structuredClone((value.components ?? {}) as Record<string, unknown>);
      node.tags = Array.isArray(value.tags) ? value.tags.map(String) : [];
      node.enabled = value.enabled !== false;
      node.locked = value.locked === true;
      const parentId = value.parentId ? String(value.parentId) : '';
      const compositionId = String(value.compositionId ?? draft.activeCompositionId);
      if (parentId) {
        const parent = draft.nodes[parentId];
        if (!parent) throw new Error(`Parent node not found: ${parentId}`);
        node.parentId = parentId;
        parent.children.push(node.id);
      } else {
        const composition = draft.compositions[compositionId];
        if (!composition) throw new Error(`Composition not found: ${compositionId}`);
        composition.rootNodes.push(node.id);
      }
      draft.nodes[node.id] = node;
      return;
    }
    case 'createShader': {
      const value = structuredClone((operation.value ?? operation.shader ?? {}) as Record<string, unknown>);
      draft.shaders[id!] = { name: String(value.name ?? 'Shader'), kind: 'builtin', domain: 'surface', parameters: [], ...value, id: id! } as never;
      return;
    }
    case 'createMaterial': {
      const value = structuredClone((operation.value ?? operation.material ?? {}) as Record<string, unknown>);
      const shaderId = String(value.shaderId ?? '');
      if (!draft.shaders[shaderId]) throw new Error(`Shader not found: ${shaderId}`);
      draft.materials[id!] = { name: String(value.name ?? 'Material'), shaderId, parameters: {}, ...value, id: id! } as never;
      return;
    }
    case 'createComposition': {
      const value = structuredClone((operation.value ?? operation.composition ?? {}) as Record<string, unknown>);
      draft.compositions[id!] = {
        name: String(value.name ?? 'Stage'), rootNodes: [], activeCamera: '', sequence: null,
        environment: environmentDefaults(), ...value, id: id!,
      } as never;
      return;
    }
    case 'createSequence': {
      const value = structuredClone((operation.value ?? operation.sequence ?? {}) as Record<string, unknown>);
      draft.sequences[id!] = {
        name: String(value.name ?? 'Sequence'), duration: Number(value.duration ?? 8),
        nominalFps: Number(value.nominalFps ?? value.fps ?? 60), tracks: [], markers: [], defaultDriver: 'time',
        ...value, id: id!,
      } as never;
      return;
    }
    case 'createTrack': {
      const value = structuredClone((operation.value ?? operation.track ?? {}) as Record<string, unknown>);
      const sequenceId = String(value.sequenceId ?? operation.sequenceId ?? '');
      const sequence = draft.sequences[sequenceId];
      if (!sequence) throw new Error(`Sequence not found: ${sequenceId}`);
      const { sequenceId: _sequenceId, ...trackValue } = value;
      draft.tracks[id!] = {
        name: String(value.name ?? 'Track'), target: value.target ?? { ownerId: '', path: '' },
        keyframes: [], enabled: true, ...trackValue, id: id!,
      } as never;
      sequence.tracks.push(id!);
      return;
    }
    case 'addClip': {
      const value = structuredClone((operation.value ?? operation.clip ?? {}) as Record<string, unknown>);
      const trackId = String(operation.trackId ?? value.trackId ?? '');
      const track = draft.tracks[trackId];
      if (!track) throw new Error(`Track not found: ${trackId}`);
      delete value.trackId;
      track.clips = [...(track.clips ?? []), { ...value, id: id! } as never];
      return;
    }
    case 'addMarker': {
      const value = structuredClone((operation.value ?? operation.marker ?? {}) as Record<string, unknown>);
      const sequenceId = String(operation.sequenceId ?? value.sequenceId ?? '');
      const sequence = draft.sequences[sequenceId];
      if (!sequence) throw new Error(`Sequence not found: ${sequenceId}`);
      delete value.sequenceId;
      sequence.markers.push({ ...value, id: id! } as never);
      return;
    }
    case 'addBehavior': {
      const value = structuredClone((operation.value ?? operation.behavior ?? {}) as Record<string, unknown>);
      draft.behaviors[id!] = { ...value, id: id! } as never;
      return;
    }
    case 'setProperty': {
      const ownerId = String(operation.ownerId ?? '');
      const path = String(operation.path ?? '');
      const owner = draft.nodes[ownerId]?.properties ?? draft.materials[ownerId]?.parameters ?? draft.fields[ownerId]?.properties;
      if (!owner) throw new Error(`Property owner not found: ${ownerId}`);
      owner[path] = structuredClone(operation.value);
      return;
    }
    default:
      throw new Error(`Unsupported edit operation: ${operation.op}`);
  }
}

function validateReferences(project: HorizonProject): void {
  for (const composition of Object.values(project.compositions)) {
    for (const nodeId of composition.rootNodes) {
      if (!project.nodes[nodeId]) throw new Error(`Composition ${composition.name} references missing node ${nodeId}`);
    }
    if (composition.activeCamera && project.nodes[composition.activeCamera]?.type !== 'camera') {
      throw new Error(`Composition ${composition.name} activeCamera must reference a camera node`);
    }
    if (composition.sequence && !project.sequences[composition.sequence]) {
      throw new Error(`Composition ${composition.name} references missing sequence ${composition.sequence}`);
    }
    for (const inheritedId of composition.inherits ?? []) {
      if (!project.compositions[inheritedId]) throw new Error(`Composition ${composition.name} inherits missing composition ${inheritedId}`);
    }
  }
  for (const node of Object.values(project.nodes)) {
    if (node.parentId && !project.nodes[node.parentId]) throw new Error(`Node ${node.name} references missing parent ${node.parentId}`);
    for (const childId of node.children) if (!project.nodes[childId]) throw new Error(`Node ${node.name} references missing child ${childId}`);
    const materialId = node.components.materialId;
    if (typeof materialId === 'string' && !project.materials[materialId]) throw new Error(`Node ${node.name} references missing material ${materialId}`);
  }
  for (const material of Object.values(project.materials)) {
    if (!project.shaders[material.shaderId]) throw new Error(`Material ${material.name} references missing shader ${material.shaderId}`);
  }
  for (const sequence of Object.values(project.sequences)) {
    for (const trackId of sequence.tracks) if (!project.tracks[trackId]) throw new Error(`Sequence ${sequence.name} references missing track ${trackId}`);
    for (const cut of sequence.cameraCuts ?? []) {
      if (!(sequence.videoCameras ?? []).some((camera) => camera.id === cut.cameraId)) throw new Error(`Camera cut ${cut.id} references missing camera ${cut.cameraId}`);
      if (cut.time < 0 || cut.time > sequence.duration) throw new Error(`Camera cut ${cut.id} lies outside sequence duration`);
    }
  }
}

export function editProject(
  ctx: WebMcpContext,
  input: { expectedRevision?: number; intent?: string; operations?: EditOperation[] },
): ToolResult {
  if (input.expectedRevision === undefined) return failure(ctx, 'REVISION_REQUIRED', 'expectedRevision is required');
  if (input.expectedRevision !== ctx.bus.getRevision()) {
    return failure(ctx, 'STALE_REVISION', `Expected revision ${input.expectedRevision}, current revision is ${ctx.bus.getRevision()}`);
  }
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    return failure(ctx, 'INVALID_INPUT', 'operations must contain at least one edit');
  }
  if (input.operations.length > 2000) return failure(ctx, 'VALIDATION_FAILED', 'A project edit may contain at most 2000 operations');
  const permissions = {
    import: false,
    remoteImport: false,
    trustedShaderSource: false,
    ...ctx.permissions,
  };
  if (input.operations.some((operation) => operation.op === 'createAsset') && !permissions.import) {
    return failure(ctx, 'PERMISSION_DENIED', 'Asset import is disabled');
  }
  if (!permissions.trustedShaderSource && input.operations.some((operation) => {
    if (operation.op !== 'createShader' && !(operation.op === 'patchEntity' && operation.collection === 'shaders')) return false;
    const value = (operation.value ?? operation.shader ?? operation.patch ?? {}) as Record<string, unknown>;
    return value.moduleSource !== undefined || value.source !== undefined;
  })) {
    return failure(ctx, 'PERMISSION_DENIED', 'Trusted shader source editing is disabled');
  }

  for (const operation of input.operations) {
    if (operation.op !== 'createAsset') continue;
    const value = (operation.value ?? operation.asset ?? {}) as Record<string, unknown>;
    const dataUrl = typeof value.dataUrl === 'string' ? value.dataUrl : '';
    const url = typeof value.url === 'string' ? value.url : '';
    if (dataUrl && (!dataUrl.startsWith('data:') || dataUrl.length > 70_000_000)) {
      return failure(ctx, 'VALIDATION_FAILED', 'Inline asset data must be a data URL no larger than 50 MB');
    }
    if (url) {
      let parsed: URL;
      try {
        parsed = new URL(url, document.baseURI);
      } catch {
        return failure(ctx, 'VALIDATION_FAILED', 'Asset URL is invalid');
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) return failure(ctx, 'VALIDATION_FAILED', 'Asset URL must use HTTP or HTTPS');
      if (parsed.origin !== location.origin && !permissions.remoteImport) {
        return failure(ctx, 'PERMISSION_DENIED', 'Cross-origin asset import is disabled');
      }
    }
  }

  const draft = structuredClone(ctx.bus.project);
  const refs = new Map<string, string>();
  const ids = new Map<EditOperation, string>();
  const reserved = new Set([
    ...Object.keys(draft.assets), ...Object.keys(draft.nodes), ...Object.keys(draft.shaders),
    ...Object.keys(draft.materials), ...Object.keys(draft.compositions), ...Object.keys(draft.sequences),
    ...Object.keys(draft.tracks), ...Object.keys(draft.behaviors), ...Object.keys(draft.variants),
  ]);
  try {
    for (const operation of input.operations) {
      if (!operation || typeof operation !== 'object' || !operation.op) throw new Error('Every edit requires an op');
      if (ID_PREFIX[operation.op]) ids.set(operation, uniqueId(operation, refs, reserved));
    }
    for (const operation of input.operations) applyOperation(draft, operation, refs, ids);
    if (!draft.compositions[draft.activeCompositionId]) throw new Error('activeCompositionId must reference an existing composition');
    validateReferences(draft);
    const validated = deserializeProject(serializeProject(draft)).project;
    const author = { kind: 'webmcp-agent' as const, name: 'WebMCP Agent' };
    const transactionId = createId('transaction');
    const outcome = ctx.bus.executeTransaction([
      makeCommand('ReplaceProjectContents', {
        project: validated,
        previousProject: structuredClone(ctx.bus.project),
        changedIds: [...new Set([...refs.values(), '__project__'])],
      }, transactionId, author, input.intent ?? 'Edit project', 'webmcp'),
    ], author, input.intent ?? 'Edit project', 'webmcp');
    if (!outcome.ok) return failure(ctx, 'COMMAND_FAILED', outcome.error);
    return {
      ok: true,
      summary: `Applied ${input.operations.length} project edits as one undoable transaction`,
      transactionId: outcome.transactionId,
      changed: outcome.changed,
      revision: ctx.bus.getRevision(),
      data: { refs: Object.fromEntries(refs), operationCount: input.operations.length },
    };
  } catch (error) {
    return failure(ctx, 'VALIDATION_FAILED', error instanceof Error ? error.message : String(error));
  }
}

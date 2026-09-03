/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildSetPropertyCommand, makeCommand } from '../../core/commands';
import { createId } from '../../core/ids';
import { getActiveComposition, getProperty, resolveCompositionRootNodes } from '../../core/project';
import { SequenceEvaluator } from '../../core/evaluator';
import { propertyRegistry } from '../../core/propertyRegistry';
import type {
  AssetRecord,
  Author,
  DriverType,
  HorizonNode,
  Keyframe,
  MaterialDef,
  NodeType,
  PropertyDef,
  RenderJob,
  ShaderDef,
  TimelineClip,
  TimelineMarker,
  ToolResult,
  Track,
  TrackKind,
} from '../../core/types';
import type { InteractionBehavior } from '../../core/interactions';
import type { WebMcpContext, WebMcpPermissions } from './tools';
import { registryDiscoveryMetadata } from './schemaGenerator';
import { prepareStaticPublish } from '../../publish/StaticPublisher';

export const WEBMCP_TOOL_VERSION = '1.0.0';

const AGENT: Author = { kind: 'webmcp-agent', name: 'WebMCP Agent' };
const NODE_TYPES = new Set<NodeType>([
  'group', 'mesh', 'text3d', 'dynamicText', 'camera', 'light', 'html', 'svg',
  'image', 'video', 'audio', 'effect', 'helper', 'field', 'volume',
  'reflectionProbe', 'imported',
]);
const DRIVERS = new Set<DriverType>([
  'time', 'manual', 'scroll', 'pointer', 'external', 'presentation', 'event',
]);
const TRACK_KINDS = new Set<TrackKind>([
  'property', 'clip', 'sequence', 'event', 'expression', 'binding',
  'constraint', 'audio', 'video', 'media',
]);
const ASSET_KINDS = new Set<AssetRecord['kind']>([
  'image', 'hdri', 'font', 'model', 'video', 'audio', 'lut', 'ies', 'custom',
]);

type MutatingInput = { expectedRevision?: number; intent?: string };

function permissions(ctx: WebMcpContext): Required<WebMcpPermissions> {
  return {
    delete: false,
    import: false,
    remoteImport: false,
    save: false,
    export: false,
    publish: false,
    trustedShaderSource: false,
    ...ctx.permissions,
  };
}

function success(
  ctx: WebMcpContext,
  summary: string,
  options: {
    transactionId?: string;
    changed?: string[];
    warnings?: string[];
    degradedFeatures?: string[];
    data?: unknown;
  } = {},
): ToolResult {
  return {
    ok: true,
    toolVersion: WEBMCP_TOOL_VERSION,
    schemaVersion: ctx.bus.project.schemaVersion,
    revision: ctx.bus.getRevision(),
    summary,
    ...options,
    warnings: options.warnings ?? [],
  };
}

function failure(
  ctx: WebMcpContext,
  code: string,
  error: string,
  warnings: string[] = [],
): ToolResult {
  return {
    ok: false,
    toolVersion: WEBMCP_TOOL_VERSION,
    schemaVersion: ctx.bus.project.schemaVersion,
    revision: ctx.bus.getRevision(),
    code,
    error,
    summary: error,
    warnings,
  };
}

function stale(ctx: WebMcpContext, input: MutatingInput, required = false): ToolResult | null {
  if (required && input.expectedRevision === undefined) {
    return failure(
      ctx,
      'REVISION_REQUIRED',
      'expectedRevision is required for this state-sensitive operation',
    );
  }
  if (
    input.expectedRevision !== undefined &&
    input.expectedRevision !== ctx.bus.getRevision()
  ) {
    return failure(
      ctx,
      'STALE_REVISION',
      `Expected revision ${input.expectedRevision}, current revision is ${ctx.bus.getRevision()}`,
    );
  }
  return null;
}

function execute(
  ctx: WebMcpContext,
  input: MutatingInput,
  commands: ReturnType<typeof makeCommand>[],
  summary: string,
  changed?: string[],
): ToolResult {
  const revisionFailure = stale(ctx, input);
  if (revisionFailure) return revisionFailure;
  if (commands.length === 0) return failure(ctx, 'NO_CHANGES', 'No changes were supplied');
  const intent = input.intent?.trim() || summary;
  const result = ctx.bus.executeTransaction(commands, AGENT, intent, 'webmcp');
  if (!result.ok) return failure(ctx, 'COMMAND_FAILED', result.error, result.warnings);
  return success(ctx, summary, {
    transactionId: result.transactionId,
    changed: changed ?? result.changed,
    warnings: result.warnings,
  });
}

function txCommand(
  type: string,
  payload: Record<string, unknown>,
  intent: string,
): ReturnType<typeof makeCommand> {
  return makeCommand(type, payload, createId('transaction'), AGENT, intent, 'webmcp');
}

function entityExists(ctx: WebMcpContext, id: string): boolean {
  const p = ctx.bus.project;
  return Boolean(
    p.nodes[id] || p.materials[id] || p.fields[id] || p.shaders[id] ||
    p.sequences[id] || p.tracks[id] || p.compositions[id] || p.assets[id] ||
    p.variants[id],
  );
}

function scopeForNode(node: HorizonNode): string | undefined {
  if (node.type === 'dynamicText') return 'dynamicText';
  if (node.type === 'text3d') return 'text3d';
  return propertyRegistry.getScope(node.type)?.id;
}

function validateProperty(
  ctx: WebMcpContext,
  ownerId: string,
  path: string,
  value: unknown,
): string | null {
  const p = ctx.bus.project;
  const node = p.nodes[ownerId];
  const material = p.materials[ownerId];
  const field = p.fields[ownerId];
  if (!node && !material && !field) return `Property owner not found: ${ownerId}`;
  if (node) {
    const scope = scopeForNode(node);
    if (scope) {
      const validation = propertyRegistry.validate(scope, path, value);
      if (!validation.ok) return validation.error;
    }
  }
  if (material) {
    const shader = p.shaders[material.shaderId];
    const def = shader?.parameters.find((candidate) => candidate.path === path);
    const error = validatePropertyDef(def, value);
    if (error) return error;
  }
  return null;
}

function validatePropertyDef(def: PropertyDef | undefined, value: unknown): string | null {
  if (!def) return null;
  if ((def.type === 'number' || def.type === 'integer') && !Number.isFinite(Number(value))) {
    return `Invalid number for ${def.path}`;
  }
  if (typeof value === 'number' && def.min !== undefined && value < def.min) {
    return `${def.path} below min ${def.min}`;
  }
  if (typeof value === 'number' && def.max !== undefined && value > def.max) {
    return `${def.path} above max ${def.max}`;
  }
  if (def.type === 'enum' && def.choices && !def.choices.some((choice) => choice.value === value)) {
    return `${def.path} not in enum`;
  }
  return null;
}

function nodeSummary(ctx: WebMcpContext, id: string): unknown {
  const node = ctx.bus.project.nodes[id];
  if (!node) return null;
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    parentId: node.parentId,
    enabled: node.enabled,
    locked: node.locked,
    tags: node.tags,
    materialId: node.components.materialId,
    properties: node.properties,
    children: node.children.map((child) => nodeSummary(ctx, child)).filter(Boolean),
  };
}

export function capabilitiesGet(ctx: WebMcpContext): ToolResult {
  const policy = permissions(ctx);
  const render = ctx.scene.getCapabilities?.() ?? null;
  const queue = ctx.renderQueue?.getCapabilities?.() ?? null;
  const degradedFeatures = [
    ...(!ctx.renderQueue ? ['render queue is not connected'] : []),
    ...(!policy.delete ? ['agent deletion is disabled'] : []),
    ...(!policy.import ? ['agent import is disabled'] : []),
    ...(!policy.remoteImport ? ['remote asset import is disabled'] : []),
    ...(!policy.publish || !ctx.publishProject ? ['direct publish is unavailable'] : []),
    'trusted shader source editing is unavailable through WebMCP',
  ];
  return success(ctx, 'Horizon semantic capabilities', {
    degradedFeatures,
    data: {
      mutationPath: 'CommandBus',
      optimisticConcurrency: true,
      dangerousOperationsRequireRevision: true,
      permissions: policy,
      operations: {
        inspect: true,
        properties: true,
        nodes: { create: true, update: true, delete: policy.delete },
        import: { inline: policy.import, remoteReference: policy.import && policy.remoteImport },
        materials: true,
        shaders: { declarative: true, source: false },
        fields: true,
        timeline: true,
        publicContract: true,
        interactions: true,
        presentation: true,
        variants: true,
        preview: true,
        projectLifecycle: {
          create: Boolean(ctx.newProject),
          list: Boolean(ctx.listProjects),
          open: Boolean(ctx.openProject),
          atomicEdit: true,
          import: policy.import && Boolean(ctx.importProject),
          previewRuntime: Boolean(ctx.previewProject),
        },
        renderQueue: Boolean(ctx.renderQueue),
        save: policy.save && Boolean(ctx.saveProject),
        export: policy.export && Boolean(ctx.exportProject),
        publishPrepare: true,
        publish: policy.publish && Boolean(ctx.publishProject),
      },
      renderer: render,
      encoder: queue,
    },
  });
}

export function projectInspect(ctx: WebMcpContext): ToolResult {
  const p = ctx.bus.project;
  const active = getActiveComposition(p);
  return success(ctx, 'Project inspected', {
    data: {
      projectId: p.projectId,
      name: p.name,
      activeCompositionId: p.activeCompositionId,
      activeComposition: active?.name,
      counts: {
        assets: Object.keys(p.assets).length,
        compositions: Object.keys(p.compositions).length,
        nodes: Object.keys(p.nodes).length,
        materials: Object.keys(p.materials).length,
        shaders: Object.keys(p.shaders).length,
        fields: Object.keys(p.fields).length +
          Object.values(p.nodes).filter((node) => node.type === 'field').length,
        sequences: Object.keys(p.sequences).length,
        tracks: Object.keys(p.tracks).length,
        behaviors: Object.keys(p.behaviors).length,
        variants: Object.keys(p.variants).length,
      },
      compositions: Object.values(p.compositions).map((composition) => ({
        id: composition.id,
        name: composition.name,
        activeCamera: composition.activeCamera,
        sequence: composition.sequence,
      })),
      sequences: Object.values(p.sequences).map((sequence) => ({
        id: sequence.id,
        name: sequence.name,
        duration: sequence.duration,
        nominalFps: sequence.nominalFps,
        defaultDriver: sequence.defaultDriver,
        trackCount: sequence.tracks.length,
        markerCount: sequence.markers.length,
      })),
      publicContract: p.publicContract,
      presentation: p.metadata.presentation ?? null,
      selection: ctx.getSelection(),
    },
  });
}

export function sceneInspect(
  ctx: WebMcpContext,
  input: { compositionId?: string } = {},
): ToolResult {
  const compositionId = input.compositionId ?? ctx.bus.project.activeCompositionId;
  const composition = ctx.bus.project.compositions[compositionId];
  if (!composition) return failure(ctx, 'NOT_FOUND', `Composition not found: ${compositionId}`);
  const nodes = resolveCompositionRootNodes(ctx.bus.project, composition.id).map((id) => nodeSummary(ctx, id)).filter(Boolean);
  return success(ctx, 'Scene inspected', {
    data: {
      composition: {
        id: composition.id,
        name: composition.name,
        activeCamera: composition.activeCamera,
        activeSequence: composition.sequence,
        inherits: composition.inherits ?? [],
        nodeOverrides: composition.nodeOverrides ?? {},
      },
      hierarchy: nodes,
      cameras: Object.values(ctx.bus.project.nodes)
        .filter((node) => node.type === 'camera')
        .map((node) => nodeSummary(ctx, node.id)),
      lights: Object.values(ctx.bus.project.nodes)
        .filter((node) => node.type === 'light')
        .map((node) => nodeSummary(ctx, node.id)),
      fields: [
        ...Object.values(ctx.bus.project.nodes)
          .filter((node) => node.type === 'field')
          .map((node) => nodeSummary(ctx, node.id)),
        ...Object.values(ctx.bus.project.fields),
      ],
      materials: Object.values(ctx.bus.project.materials),
      environment: composition.environment,
    },
  });
}

export function selectionInspect(ctx: WebMcpContext): ToolResult {
  return success(ctx, 'Selection inspected', {
    data: {
      ids: ctx.getSelection(),
      entities: ctx.getSelection().map((id) => nodeSummary(ctx, id) ?? { id, found: false }),
    },
  });
}

export function timelineInspect(
  ctx: WebMcpContext,
  input: { sequenceId?: string } = {},
): ToolResult {
  const sequenceId = input.sequenceId ?? getActiveComposition(ctx.bus.project).sequence ?? '';
  const sequence = ctx.bus.project.sequences[sequenceId];
  if (!sequence) return failure(ctx, 'NOT_FOUND', `Sequence not found: ${sequenceId}`);
  return success(ctx, 'Timeline inspected', {
    data: {
      sequence,
      tracks: sequence.tracks
        .map((id) => ctx.bus.project.tracks[id])
        .filter(Boolean),
    },
  });
}

export function propertyFind(
  ctx: WebMcpContext,
  input: { query?: string; ownerId?: string; scope?: string; animatable?: boolean } = {},
): ToolResult {
  const query = input.query?.trim().toLowerCase() ?? '';
  const matches: unknown[] = [];
  const accepts = (path: string, label: string | undefined, value: unknown) =>
    !query || `${path} ${label ?? ''} ${String(value ?? '')}`.toLowerCase().includes(query);

  if (!input.ownerId) {
    for (const scope of propertyRegistry.listScopes()) {
      if (input.scope && scope.id !== input.scope) continue;
      for (const entry of scope.entries) {
        if (input.animatable !== undefined && Boolean(entry.animatable) !== input.animatable) continue;
        if (accepts(entry.path, entry.label, entry.default)) {
          matches.push({ ...entry, registryScope: scope.id });
        }
      }
    }
  } else {
    const p = ctx.bus.project;
    const node = p.nodes[input.ownerId];
    const material = p.materials[input.ownerId];
    const field = p.fields[input.ownerId];
    if (!node && !material && !field) {
      return failure(ctx, 'NOT_FOUND', `Property owner not found: ${input.ownerId}`);
    }
    const values = node?.properties ?? material?.parameters ?? field?.properties ?? {};
    const shader = material ? p.shaders[material.shaderId] : undefined;
    for (const [path, value] of Object.entries(values)) {
      const metadata =
        (node && scopeForNode(node) ? propertyRegistry.find(scopeForNode(node)!, path) : undefined) ??
        shader?.parameters.find((entry) => entry.path === path);
      if (input.animatable !== undefined && Boolean(metadata?.animatable) !== input.animatable) continue;
      if (accepts(path, metadata?.label, value)) {
        matches.push({ ownerId: input.ownerId, path, value, metadata });
      }
    }
  }
  return success(ctx, `Found ${matches.length} properties`, { data: { matches } });
}

export function propertiesSet(
  ctx: WebMcpContext,
  input: MutatingInput & {
    ownerId: string;
    properties: Record<string, unknown>;
  },
): ToolResult {
  if (!input.ownerId || !input.properties || Object.keys(input.properties).length === 0) {
    return failure(ctx, 'INVALID_INPUT', 'ownerId and at least one property are required');
  }
  const commands = [];
  const txId = createId('transaction');
  for (const [path, value] of Object.entries(input.properties)) {
    const error = validateProperty(ctx, input.ownerId, path, value);
    if (error) return failure(ctx, 'VALIDATION_FAILED', error);
    commands.push(
      buildSetPropertyCommand(
        input.ownerId,
        path,
        structuredClone(value),
        structuredClone(getProperty(ctx.bus.project, input.ownerId, path)),
        txId,
        AGENT,
        input.intent ?? `Set ${path}`,
        'webmcp',
      ),
    );
  }
  return execute(ctx, input, commands, `Updated ${input.ownerId}`, [input.ownerId]);
}

export function fieldParametersSet(
  ctx: WebMcpContext,
  input: MutatingInput & {
    fieldId: string;
    parameters: Record<string, unknown>;
  },
): ToolResult {
  const fieldNode = ctx.bus.project.nodes[input.fieldId];
  if (!ctx.bus.project.fields[input.fieldId] && fieldNode?.type !== 'field') {
    return failure(ctx, 'NOT_FOUND', `Field not found: ${input.fieldId}`);
  }
  return propertiesSet(ctx, {
    ownerId: input.fieldId,
    properties: input.parameters,
    expectedRevision: input.expectedRevision,
    intent: input.intent ?? `Update field ${input.fieldId}`,
  });
}

export function nodeUpdate(
  ctx: WebMcpContext,
  input: MutatingInput & {
    nodeId: string;
    name?: string;
    enabled?: boolean;
    locked?: boolean;
    tags?: string[];
    properties?: Record<string, unknown>;
  },
): ToolResult {
  const node = ctx.bus.project.nodes[input.nodeId];
  if (!node) return failure(ctx, 'NOT_FOUND', `Node not found: ${input.nodeId}`);
  const txId = createId('transaction');
  const commands = [];
  for (const key of ['name', 'enabled', 'locked', 'tags'] as const) {
    if (input[key] !== undefined) {
      commands.push(makeCommand(
        'SetProjectProperty',
        {
          path: `nodes.${node.id}.${key}`,
          value: structuredClone(input[key]),
          previousValue: structuredClone(node[key]),
        },
        txId,
        AGENT,
        input.intent ?? `Update node ${node.name}`,
        'webmcp',
      ));
    }
  }
  for (const [path, value] of Object.entries(input.properties ?? {})) {
    const error = validateProperty(ctx, node.id, path, value);
    if (error) return failure(ctx, 'VALIDATION_FAILED', error);
    commands.push(buildSetPropertyCommand(
      node.id,
      path,
      structuredClone(value),
      structuredClone(node.properties[path]),
      txId,
      AGENT,
      input.intent ?? `Update node ${node.name}`,
      'webmcp',
    ));
  }
  return execute(ctx, input, commands, `Updated node ${node.name}`, [node.id]);
}

function collectSubtree(ctx: WebMcpContext, nodeId: string, out: HorizonNode[]): void {
  const node = ctx.bus.project.nodes[nodeId];
  if (!node) return;
  for (const childId of node.children) collectSubtree(ctx, childId, out);
  out.push(node);
}

export function nodeDelete(
  ctx: WebMcpContext,
  input: MutatingInput & { nodeIds: string[] },
): ToolResult {
  if (!permissions(ctx).delete) return failure(ctx, 'PERMISSION_DENIED', 'Agent deletion is disabled');
  const revisionFailure = stale(ctx, input, true);
  if (revisionFailure) return revisionFailure;
  if (!Array.isArray(input.nodeIds) || input.nodeIds.length === 0) {
    return failure(ctx, 'INVALID_INPUT', 'nodeIds is required');
  }
  const activeCamera = getActiveComposition(ctx.bus.project).activeCamera;
  const nodes: HorizonNode[] = [];
  for (const id of [...new Set(input.nodeIds)]) {
    if (!ctx.bus.project.nodes[id]) return failure(ctx, 'NOT_FOUND', `Node not found: ${id}`);
    collectSubtree(ctx, id, nodes);
  }
  const unique = [...new Map(nodes.map((node) => [node.id, node])).values()];
  if (unique.some((node) => node.id === activeCamera)) {
    return failure(ctx, 'VALIDATION_FAILED', 'Cannot delete the active camera');
  }
  const txId = createId('transaction');
  const commands = unique.map((node) => makeCommand(
    'RemoveEntity',
    {
      entityId: node.id,
      savedEntity: structuredClone(node),
      parentId: node.parentId,
      materialId: node.components.materialId,
      compositionId: ctx.bus.project.activeCompositionId,
    },
    txId,
    AGENT,
    input.intent ?? 'Delete nodes',
    'webmcp',
  ));
  const result = execute(ctx, input, commands, `Deleted ${unique.length} nodes`, unique.map((node) => node.id));
  if (result.ok) ctx.setSelection(ctx.getSelection().filter((id) => !unique.some((node) => node.id === id)));
  return result;
}

export function assetImport(
  ctx: WebMcpContext,
  input: MutatingInput & {
    name: string;
    kind: AssetRecord['kind'];
    mimeType: string;
    dataUrl?: string;
    url?: string;
    colorSpace?: AssetRecord['colorSpace'];
  },
): ToolResult {
  const policy = permissions(ctx);
  if (!policy.import) return failure(ctx, 'PERMISSION_DENIED', 'Agent import is disabled');
  if (!input.name || !ASSET_KINDS.has(input.kind) || !input.mimeType) {
    return failure(ctx, 'INVALID_INPUT', 'Valid name, kind, and mimeType are required');
  }
  if (Boolean(input.dataUrl) === Boolean(input.url)) {
    return failure(ctx, 'INVALID_INPUT', 'Supply exactly one of dataUrl or url');
  }
  if (input.dataUrl) {
    if (!input.dataUrl.startsWith('data:') || input.dataUrl.length > 14_000_000) {
      return failure(ctx, 'VALIDATION_FAILED', 'Inline data must be a data URL no larger than 10 MB');
    }
  }
  if (input.url) {
    let parsed: URL;
    try {
      parsed = new URL(input.url, document.baseURI);
      if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error();
    } catch {
      return failure(ctx, 'VALIDATION_FAILED', 'Remote asset URL must use HTTP or HTTPS');
    }
    if (parsed.origin !== location.origin && !policy.remoteImport) {
      return failure(ctx, 'PERMISSION_DENIED', 'Cross-origin asset references are disabled');
    }
  }
  const asset: AssetRecord = {
    id: createId('asset'),
    name: input.name,
    kind: input.kind,
    mimeType: input.mimeType,
    storage: input.dataUrl ? 'inline' : 'url',
    dataUrl: input.dataUrl,
    url: input.url,
    colorSpace: input.colorSpace,
    importedAt: new Date().toISOString(),
    source: 'webmcp',
  };
  return execute(
    ctx,
    input,
    [txCommand('AddAsset', { asset }, input.intent ?? `Import ${asset.name}`)],
    `Imported asset ${asset.name}`,
    [asset.id],
  );
}

export function materialCreate(
  ctx: WebMcpContext,
  input: MutatingInput & {
    name: string;
    shaderId: string;
    parameters?: Record<string, unknown>;
  },
): ToolResult {
  const shader = ctx.bus.project.shaders[input.shaderId];
  if (!shader) return failure(ctx, 'NOT_FOUND', `Shader not found: ${input.shaderId}`);
  const parameters: Record<string, unknown> = {};
  for (const def of shader.parameters) parameters[def.path] = structuredClone(def.default);
  for (const [path, value] of Object.entries(input.parameters ?? {})) {
    const error = validatePropertyDef(shader.parameters.find((def) => def.path === path), value);
    if (error) return failure(ctx, 'VALIDATION_FAILED', error);
    parameters[path] = structuredClone(value);
  }
  const material: MaterialDef = {
    id: createId('material'),
    name: input.name,
    shaderId: input.shaderId,
    parameters,
  };
  return execute(
    ctx,
    input,
    [txCommand('AddMaterial', { material }, input.intent ?? `Create material ${input.name}`)],
    `Created material ${input.name}`,
    [material.id],
  );
}

export function shaderCreate(
  ctx: WebMcpContext,
  input: MutatingInput & {
    name: string;
    domain: ShaderDef['domain'];
    parameters?: PropertyDef[];
    source?: string;
  },
): ToolResult {
  if (input.source) {
    return failure(
      ctx,
      'CAPABILITY_UNAVAILABLE',
      'Shader source editing is not exposed through WebMCP; create a declarative shader or use Studio trusted-code mode',
    );
  }
  if (!input.name || !['surface', 'post', 'field', 'volume'].includes(input.domain)) {
    return failure(ctx, 'INVALID_INPUT', 'Valid shader name and domain are required');
  }
  const seen = new Set<string>();
  for (const parameter of input.parameters ?? []) {
    if (!parameter.path || seen.has(parameter.path)) {
      return failure(ctx, 'VALIDATION_FAILED', 'Shader parameter paths must be unique and non-empty');
    }
    seen.add(parameter.path);
  }
  const shader: ShaderDef = {
    id: createId('shader'),
    name: input.name,
    domain: input.domain,
    parameters: structuredClone(input.parameters ?? []),
    kind: 'builtin',
  };
  return execute(
    ctx,
    input,
    [txCommand('AddShader', { shader }, input.intent ?? `Create shader ${input.name}`)],
    `Created shader ${input.name}`,
    [shader.id],
  );
}

export function trackCreate(
  ctx: WebMcpContext,
  input: MutatingInput & {
    sequenceId: string;
    name: string;
    kind?: TrackKind;
    ownerId?: string;
    path?: string;
  },
): ToolResult {
  const sequence = ctx.bus.project.sequences[input.sequenceId];
  if (!sequence) return failure(ctx, 'NOT_FOUND', `Sequence not found: ${input.sequenceId}`);
  const kind = input.kind ?? 'property';
  if (!TRACK_KINDS.has(kind)) return failure(ctx, 'INVALID_INPUT', `Unsupported track kind: ${kind}`);
  if (kind === 'property' && (!input.ownerId || !input.path)) {
    return failure(ctx, 'INVALID_INPUT', 'Property tracks require ownerId and path');
  }
  if (input.ownerId && !entityExists(ctx, input.ownerId)) {
    return failure(ctx, 'NOT_FOUND', `Track target not found: ${input.ownerId}`);
  }
  const track: Track = {
    id: createId('track'),
    name: input.name,
    kind,
    target: { ownerId: input.ownerId ?? '', path: input.path ?? '' },
    keyframes: [],
    enabled: true,
  };
  return execute(
    ctx,
    input,
    [txCommand('AddTrack', { track, sequenceId: sequence.id }, input.intent ?? `Create track ${input.name}`)],
    `Created track ${input.name}`,
    [track.id, sequence.id],
  );
}

export function sequenceUpdate(
  ctx: WebMcpContext,
  input: MutatingInput & {
    sequenceId: string;
    name?: string;
    duration?: number;
    nominalFps?: number;
    defaultDriver?: DriverType;
    driverConfig?: Record<string, unknown>;
    playbackMode?: 'clamp' | 'loop' | 'pingPong';
  },
): ToolResult {
  const sequence = ctx.bus.project.sequences[input.sequenceId];
  if (!sequence) return failure(ctx, 'NOT_FOUND', `Sequence not found: ${input.sequenceId}`);
  if (input.duration !== undefined && (!Number.isFinite(input.duration) || input.duration <= 0)) {
    return failure(ctx, 'VALIDATION_FAILED', 'Sequence duration must be positive');
  }
  if (input.nominalFps !== undefined && (!Number.isFinite(input.nominalFps) || input.nominalFps <= 0)) {
    return failure(ctx, 'VALIDATION_FAILED', 'Sequence nominalFps must be positive');
  }
  if (input.defaultDriver !== undefined && !DRIVERS.has(input.defaultDriver)) {
    return failure(ctx, 'VALIDATION_FAILED', `Unsupported sequence driver: ${input.defaultDriver}`);
  }
  const txId = createId('transaction');
  const commands = [];
  for (const key of [
    'name', 'duration', 'nominalFps', 'defaultDriver', 'driverConfig', 'playbackMode',
  ] as const) {
    if (input[key] !== undefined) {
      commands.push(makeCommand(
        'SetSequenceProperty',
        {
          sequenceId: sequence.id,
          path: key,
          value: structuredClone(input[key]),
          previousValue: structuredClone(sequence[key]),
        },
        txId,
        AGENT,
        input.intent ?? `Update sequence ${sequence.name}`,
        'webmcp',
      ));
    }
  }
  return execute(ctx, input, commands, `Updated sequence ${sequence.name}`, [sequence.id]);
}

export function trackUpdate(
  ctx: WebMcpContext,
  input: MutatingInput & {
    trackId: string;
    name?: string;
    enabled?: boolean;
    muted?: boolean;
    solo?: boolean;
    locked?: boolean;
  },
): ToolResult {
  const track = ctx.bus.project.tracks[input.trackId];
  if (!track) return failure(ctx, 'NOT_FOUND', `Track not found: ${input.trackId}`);
  const txId = createId('transaction');
  const commands = [];
  if (input.name !== undefined) {
    commands.push(makeCommand(
      'SetProjectProperty',
      {
        path: `tracks.${track.id}.name`,
        value: input.name,
        previousValue: track.name,
      },
      txId,
      AGENT,
      input.intent ?? `Update track ${track.name}`,
      'webmcp',
    ));
  }
  for (const flag of ['enabled', 'muted', 'solo', 'locked'] as const) {
    if (input[flag] !== undefined) {
      commands.push(makeCommand(
        'SetTrackFlag',
        { trackId: track.id, flag, value: input[flag], previousValue: track[flag] },
        txId,
        AGENT,
        input.intent ?? `Update track ${track.name}`,
        'webmcp',
      ));
    }
  }
  return execute(ctx, input, commands, `Updated track ${track.name}`, [track.id]);
}

export function clipUpsert(
  ctx: WebMcpContext,
  input: MutatingInput & { trackId: string; clip: TimelineClip },
): ToolResult {
  const track = ctx.bus.project.tracks[input.trackId];
  if (!track) return failure(ctx, 'NOT_FOUND', `Track not found: ${input.trackId}`);
  if (!input.clip?.id || input.clip.start < 0 || input.clip.duration <= 0) {
    return failure(ctx, 'VALIDATION_FAILED', 'Clip requires id, non-negative start, and positive duration');
  }
  if (input.clip.kind === 'sequence' && !ctx.bus.project.sequences[input.clip.sequenceId]) {
    return failure(ctx, 'NOT_FOUND', `Nested sequence not found: ${input.clip.sequenceId}`);
  }
  if (
    (input.clip.kind === 'audio' || input.clip.kind === 'video') &&
    !ctx.bus.project.assets[input.clip.assetId]
  ) {
    return failure(ctx, 'NOT_FOUND', `Media asset not found: ${input.clip.assetId}`);
  }
  const existing = track.clips?.find((clip) => clip.id === input.clip.id);
  const command = existing
    ? txCommand(
        'UpdateClip',
        {
          trackId: track.id,
          clipId: existing.id,
          patch: structuredClone(input.clip),
          previousPatch: structuredClone(existing),
        },
        input.intent ?? `Update clip ${existing.id}`,
      )
    : txCommand(
        'AddClip',
        { trackId: track.id, clip: structuredClone(input.clip) },
        input.intent ?? `Add clip ${input.clip.id}`,
      );
  return execute(
    ctx,
    input,
    [command],
    `${existing ? 'Updated' : 'Added'} clip ${input.clip.id}`,
    [track.id, input.clip.id],
  );
}

export function markerAdd(
  ctx: WebMcpContext,
  input: MutatingInput & {
    sequenceId: string;
    marker: Omit<TimelineMarker, 'id'> & { id?: string };
  },
): ToolResult {
  const sequence = ctx.bus.project.sequences[input.sequenceId];
  if (!sequence) return failure(ctx, 'NOT_FOUND', `Sequence not found: ${input.sequenceId}`);
  if (!input.marker?.name || !Number.isFinite(input.marker.time) || input.marker.time < 0) {
    return failure(ctx, 'VALIDATION_FAILED', 'Marker requires a name and non-negative time');
  }
  if (input.marker.time > sequence.duration) {
    return failure(ctx, 'VALIDATION_FAILED', 'Marker time exceeds sequence duration');
  }
  const marker = { ...structuredClone(input.marker), id: input.marker.id ?? createId('marker') };
  return execute(
    ctx,
    input,
    [txCommand('AddMarker', { sequenceId: sequence.id, marker }, input.intent ?? `Add marker ${marker.name}`)],
    `Added marker ${marker.name}`,
    [sequence.id, marker.id],
  );
}

export function timelineDelete(
  ctx: WebMcpContext,
  input: MutatingInput & {
    kind: 'sequence' | 'track' | 'clip' | 'marker';
    id: string;
    parentId?: string;
  },
): ToolResult {
  if (!permissions(ctx).delete) return failure(ctx, 'PERMISSION_DENIED', 'Agent deletion is disabled');
  const revisionFailure = stale(ctx, input, true);
  if (revisionFailure) return revisionFailure;
  let command: ReturnType<typeof makeCommand> | null = null;
  if (input.kind === 'sequence') {
    const sequence = ctx.bus.project.sequences[input.id];
    if (!sequence) return failure(ctx, 'NOT_FOUND', `Sequence not found: ${input.id}`);
    if (Object.values(ctx.bus.project.compositions).some((comp) => comp.sequence === input.id)) {
      return failure(ctx, 'VALIDATION_FAILED', 'Cannot delete a sequence assigned to a composition');
    }
    command = txCommand('RemoveSequence', { sequenceId: input.id, savedSequence: structuredClone(sequence) }, 'Delete sequence');
  } else if (input.kind === 'track') {
    const track = ctx.bus.project.tracks[input.id];
    if (!track) return failure(ctx, 'NOT_FOUND', `Track not found: ${input.id}`);
    const sequence = Object.values(ctx.bus.project.sequences).find((candidate) => candidate.tracks.includes(input.id));
    command = txCommand(
      'RemoveTrack',
      { trackId: input.id, savedTrack: structuredClone(track), sequenceId: sequence?.id },
      'Delete track',
    );
  } else if (input.kind === 'clip') {
    const track = ctx.bus.project.tracks[input.parentId ?? ''];
    const clip = track?.clips?.find((candidate) => candidate.id === input.id);
    if (!track || !clip) return failure(ctx, 'NOT_FOUND', `Clip not found: ${input.id}`);
    command = txCommand(
      'RemoveClip',
      { trackId: track.id, clipId: clip.id, savedClip: structuredClone(clip) },
      'Delete clip',
    );
  } else {
    const sequence = ctx.bus.project.sequences[input.parentId ?? ''];
    const marker = sequence?.markers.find((candidate) => candidate.id === input.id);
    if (!sequence || !marker) return failure(ctx, 'NOT_FOUND', `Marker not found: ${input.id}`);
    command = txCommand(
      'RemoveMarker',
      { sequenceId: sequence.id, markerId: input.id, savedMarker: structuredClone(marker) },
      'Delete marker',
    );
  }
  return execute(ctx, input, [command], `Deleted ${input.kind} ${input.id}`, [input.id]);
}

export function publicContractSet(
  ctx: WebMcpContext,
  input: MutatingInput & {
    kind: 'event' | 'timeline';
    name: string;
    exposed: boolean;
  },
): ToolResult {
  const key = input.kind === 'event' ? 'events' : 'timelines';
  const current = ctx.bus.project.publicContract[key];
  const next = input.exposed
    ? [...new Set([...current, input.name])]
    : current.filter((name) => name !== input.name);
  if (input.kind === 'timeline' && input.exposed) {
    const exists = Object.values(ctx.bus.project.sequences).some(
      (sequence) => sequence.id === input.name || sequence.name === input.name,
    );
    if (!exists) return failure(ctx, 'NOT_FOUND', `Timeline not found: ${input.name}`);
  }
  return execute(
    ctx,
    input,
    [txCommand(
      'SetProjectProperty',
      {
        path: `publicContract.${key}`,
        value: next,
        previousValue: structuredClone(current),
      },
      input.intent ?? `${input.exposed ? 'Expose' : 'Hide'} public ${input.kind}`,
    )],
    `${input.exposed ? 'Exposed' : 'Hid'} public ${input.kind} ${input.name}`,
    ['__public_contract__'],
  );
}

export function interactionUpsert(
  ctx: WebMcpContext,
  input: MutatingInput & { behavior: InteractionBehavior },
): ToolResult {
  const behavior = input.behavior;
  if (!behavior?.id || !behavior.name || !Array.isArray(behavior.actions)) {
    return failure(ctx, 'INVALID_INPUT', 'Behavior id, name, and actions are required');
  }
  if (behavior.nodeId && !ctx.bus.project.nodes[behavior.nodeId]) {
    return failure(ctx, 'NOT_FOUND', `Behavior node not found: ${behavior.nodeId}`);
  }
  for (const action of behavior.actions) {
    if (
      action.type === 'setProperty' &&
      !ctx.bus.project.publicContract.properties[action.publicName]
    ) {
      return failure(ctx, 'NOT_FOUND', `Public property not found: ${action.publicName}`);
    }
    if (
      action.type === 'timeline' &&
      !ctx.bus.project.publicContract.timelines.includes(action.timeline)
    ) {
      return failure(ctx, 'NOT_FOUND', `Public timeline not found: ${action.timeline}`);
    }
  }
  const previousValue = ctx.bus.project.behaviors[behavior.id];
  return execute(
    ctx,
    input,
    [txCommand(
      'SetProjectProperty',
      {
        path: `behaviors.${behavior.id}`,
        value: structuredClone(behavior),
        previousValue: structuredClone(previousValue),
      },
      input.intent ?? `${previousValue ? 'Update' : 'Create'} interaction ${behavior.name}`,
    )],
    `${previousValue ? 'Updated' : 'Created'} interaction ${behavior.name}`,
    [behavior.id],
  );
}

export function presentationSet(
  ctx: WebMcpContext,
  input: MutatingInput & {
    slides: Array<string | { composition: string; sequence?: string; variant?: string }>;
    autoplay?: boolean;
    intervalSeconds?: number;
    loop?: boolean;
    clickToAdvance?: boolean;
  },
): ToolResult {
  if (!Array.isArray(input.slides) || input.slides.length === 0) {
    return failure(ctx, 'INVALID_INPUT', 'Presentation requires at least one slide');
  }
  for (const slide of input.slides) {
    const id = typeof slide === 'string' ? slide : slide?.composition;
    if (!id || !ctx.bus.project.compositions[id]) return failure(ctx, 'NOT_FOUND', `Composition not found: ${String(id)}`);
    if (typeof slide !== 'string' && slide.sequence && !ctx.bus.project.sequences[slide.sequence]) {
      return failure(ctx, 'NOT_FOUND', `Sequence not found: ${slide.sequence}`);
    }
    if (typeof slide !== 'string' && slide.variant && !ctx.bus.project.variants[slide.variant]) {
      return failure(ctx, 'NOT_FOUND', `Variant not found: ${slide.variant}`);
    }
  }
  if (input.intervalSeconds !== undefined && input.intervalSeconds < 0.25) {
    return failure(ctx, 'VALIDATION_FAILED', 'intervalSeconds must be at least 0.25');
  }
  const previousValue = ctx.bus.project.metadata.presentation;
  const value = {
    slides: structuredClone(input.slides),
    autoplay: input.autoplay ?? false,
    intervalSeconds: input.intervalSeconds ?? 8,
    loop: input.loop ?? false,
    clickToAdvance: input.clickToAdvance ?? true,
  };
  return execute(
    ctx,
    input,
    [txCommand(
      'SetProjectProperty',
      { path: 'metadata.presentation', value, previousValue: structuredClone(previousValue) },
      input.intent ?? 'Set presentation',
    )],
    'Presentation updated',
    ['__presentation__'],
  );
}

export function variantUpdate(
  ctx: WebMcpContext,
  input: MutatingInput & {
    variantId: string;
    name?: string;
    overrides?: Record<string, unknown>;
  },
): ToolResult {
  const variant = ctx.bus.project.variants[input.variantId];
  if (!variant) return failure(ctx, 'NOT_FOUND', `Variant not found: ${input.variantId}`);
  const txId = createId('transaction');
  const commands = [];
  if (input.name !== undefined) commands.push(makeCommand(
    'SetProjectProperty',
    {
      path: `variants.${variant.id}.name`,
      value: input.name,
      previousValue: variant.name,
    },
    txId,
    AGENT,
    input.intent ?? `Update variant ${variant.name}`,
    'webmcp',
  ));
  if (input.overrides !== undefined) commands.push(makeCommand(
    'SetProjectProperty',
    {
      path: `variants.${variant.id}.overrides`,
      value: structuredClone(input.overrides),
      previousValue: structuredClone(variant.overrides),
    },
    txId,
    AGENT,
    input.intent ?? `Update variant ${variant.name}`,
    'webmcp',
  ));
  return execute(ctx, input, commands, `Updated variant ${variant.name}`, [variant.id]);
}

export function renderSnapshot(
  ctx: WebMcpContext,
  input: { time?: number } = {},
): ToolResult {
  try {
    if (input.time !== undefined) {
      if (!Number.isFinite(input.time) || input.time < 0) {
        return failure(ctx, 'VALIDATION_FAILED', 'Preview time must be a non-negative number');
      }
      const sequenceId = getActiveComposition(ctx.bus.project).sequence;
      if (!sequenceId) return failure(ctx, 'NOT_FOUND', 'Active composition has no sequence');
      const evaluator = new SequenceEvaluator(ctx.bus.project);
      const snapshot = evaluator.evaluateSequence(sequenceId, input.time);
      ctx.scene.syncProject(ctx.bus.project, snapshot, { driveCamera: true });
      ctx.scene.renderFrame(snapshot);
    }
    const dataUrl = ctx.scene.captureScreenshot();
    return success(ctx, 'Preview snapshot captured', {
      data: {
        format: 'image/png',
        dataUrl,
        time: input.time,
        viewportUpdated: true,
        capabilities: ctx.scene.getCapabilities(),
        stats: ctx.scene.getStats(),
      },
    });
  } catch (error) {
    return failure(ctx, 'RENDER_FAILED', error instanceof Error ? error.message : String(error));
  }
}

export function renderEnqueue(
  ctx: WebMcpContext,
  input: MutatingInput & { presetId: string; compositionId?: string },
): ToolResult {
  const revisionFailure = stale(ctx, input);
  if (revisionFailure) return revisionFailure;
  if (!ctx.renderQueue) return failure(ctx, 'CAPABILITY_UNAVAILABLE', 'Render queue is not connected');
  if (!ctx.bus.project.renderPresets[input.presetId]) {
    return failure(ctx, 'NOT_FOUND', `Render preset not found: ${input.presetId}`);
  }
  if (input.compositionId && !ctx.bus.project.compositions[input.compositionId]) {
    return failure(ctx, 'NOT_FOUND', `Composition not found: ${input.compositionId}`);
  }
  try {
    const job = ctx.renderQueue.enqueue(input.presetId, input.compositionId, {
      author: AGENT,
      intent: input.intent ?? `Enqueue render ${input.presetId}`,
      source: 'webmcp',
    });
    const history = ctx.bus.getRecentHistory(1)[0];
    return success(ctx, `Enqueued render ${job.id}`, {
      transactionId: history?.id,
      changed: [job.id],
      data: { job },
    });
  } catch (error) {
    return failure(ctx, 'RENDER_FAILED', error instanceof Error ? error.message : String(error));
  }
}

export function renderStatus(
  ctx: WebMcpContext,
  input: { jobId?: string } = {},
): ToolResult {
  const jobs = ctx.renderQueue?.list() ?? Object.values(ctx.bus.project.renderJobs);
  const selected = input.jobId ? jobs.filter((job) => job.id === input.jobId) : jobs;
  if (input.jobId && selected.length === 0) {
    return failure(ctx, 'NOT_FOUND', `Render job not found: ${input.jobId}`);
  }
  return success(ctx, 'Render status', {
    data: {
      jobs: selected,
      capabilities: ctx.renderQueue?.getCapabilities() ?? null,
    },
  });
}

export function renderCancel(
  ctx: WebMcpContext,
  input: MutatingInput & { jobId: string },
): ToolResult {
  const revisionFailure = stale(ctx, input, true);
  if (revisionFailure) return revisionFailure;
  const job = ctx.bus.project.renderJobs[input.jobId];
  if (!job) return failure(ctx, 'NOT_FOUND', `Render job not found: ${input.jobId}`);
  if (['complete', 'failed', 'cancelled'].includes(job.status)) {
    return failure(ctx, 'INVALID_STATE', `Render job is already ${job.status}`);
  }
  if (ctx.renderQueue) {
    ctx.renderQueue.cancel(job.id, {
      author: AGENT,
      intent: input.intent ?? `Cancel render ${job.id}`,
      source: 'webmcp',
    });
    const history = ctx.bus.getRecentHistory(1)[0];
    return success(ctx, `Cancelled render ${job.id}`, {
      transactionId: history?.id,
      changed: [job.id],
    });
  }
  const patch: Partial<RenderJob> = {
    cancelRequested: true,
    status: 'cancelled',
    message: 'Cancellation requested',
  };
  return execute(
    ctx,
    input,
    [txCommand(
      'UpdateRenderJob',
      {
        jobId: job.id,
        patch,
        previousPatch: {
          cancelRequested: job.cancelRequested,
          status: job.status,
          message: job.message,
        },
      },
      input.intent ?? `Cancel render ${job.id}`,
    )],
    `Cancelled render ${job.id}`,
    [job.id],
  );
}

async function explicitAction(
  ctx: WebMcpContext,
  input: MutatingInput & { confirm: boolean },
  kind: 'save' | 'export' | 'publish',
): Promise<ToolResult> {
  const revisionFailure = stale(ctx, input, true);
  if (revisionFailure) return revisionFailure;
  if (input.confirm !== true) {
    return failure(ctx, 'CONFIRMATION_REQUIRED', `${kind} requires confirm: true`);
  }
  const policy = permissions(ctx);
  const action =
    kind === 'save' ? ctx.saveProject :
    kind === 'export' ? ctx.exportProject :
    ctx.publishProject;
  if (!policy[kind] || !action) {
    return failure(ctx, 'PERMISSION_DENIED', `${kind} is not permitted in this context`);
  }
  try {
    const data = await action();
    return success(ctx, `${kind} completed`, { data });
  } catch (error) {
    return failure(ctx, 'ACTION_FAILED', error instanceof Error ? error.message : String(error));
  }
}

export function projectSave(
  ctx: WebMcpContext,
  input: MutatingInput & { confirm: boolean },
): Promise<ToolResult> {
  return explicitAction(ctx, input, 'save');
}

export function projectExport(
  ctx: WebMcpContext,
  input: MutatingInput & { confirm: boolean },
): Promise<ToolResult> {
  return explicitAction(ctx, input, 'export');
}

export function projectPublish(
  ctx: WebMcpContext,
  input: MutatingInput & { confirm: boolean },
): Promise<ToolResult> {
  return explicitAction(ctx, input, 'publish');
}

export function publishPlan(ctx: WebMcpContext): ToolResult {
  try {
    const plan = prepareStaticPublish(ctx.bus.project);
    return success(ctx, 'Publish plan prepared; no files were written', {
      warnings: plan.diagnostics
        .filter((diagnostic) => diagnostic.severity === 'warning')
        .map((diagnostic) => diagnostic.message),
      data: {
        contract: plan.contract,
        diagnostics: plan.diagnostics,
        requiredAssetIds: plan.requiredAssetIds,
        requiredFeatures: plan.requiredFeatures,
        trustedCode: plan.trustedCode,
        requiresExplicitPublish: true,
        permitted: permissions(ctx).publish && Boolean(ctx.publishProject),
      },
    });
  } catch (error) {
    const diagnostics =
      error && typeof error === 'object' && 'diagnostics' in error
        ? (error as { diagnostics?: unknown }).diagnostics
        : undefined;
    return failure(
      ctx,
      'PUBLISH_VALIDATION_FAILED',
      error instanceof Error ? error.message : String(error),
      Array.isArray(diagnostics)
        ? diagnostics.map((item) => String((item as { message?: unknown }).message ?? item))
        : [],
    );
  }
}

export function registryInspect(ctx: WebMcpContext): ToolResult {
  return success(ctx, 'Property registry inspected', {
    data: { scopes: registryDiscoveryMetadata() },
  });
}

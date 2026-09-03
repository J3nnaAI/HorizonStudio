/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandBus } from '../../core/commandBus';
import type { Author, HorizonProject, MaterialDef, ToolResult, Track, NodeType, PropertyType } from '../../core/types';
import { createId } from '../../core/ids';
import { getActiveComposition, getNode, getProperty } from '../../core/project';
import {
  buildAddEntityCommand,
  buildSetPropertyCommand,
  createNode,
  makeCommand,
} from '../../core/commands';
import { frameCameraForSubject } from '../../demo/persistenceHero';
import { preparePublish } from '../../core/serialization';
import type { RenderCoordinator } from '../../render/RenderCoordinator';
import type { RenderQueue } from '../../render/RenderQueue';
import { registryDiscoveryMetadata } from './schemaGenerator';

export interface WebMcpPermissions {
  delete?: boolean;
  import?: boolean;
  remoteImport?: boolean;
  save?: boolean;
  export?: boolean;
  publish?: boolean;
  trustedShaderSource?: boolean;
}

export interface WebMcpContext {
  bus: CommandBus;
  scene: RenderCoordinator;
  renderQueue?: RenderQueue;
  getSelection: () => string[];
  setSelection: (ids: string[]) => void;
  permissions?: WebMcpPermissions;
  saveProject?: () => Promise<unknown> | unknown;
  exportProject?: () => Promise<unknown> | unknown;
  publishProject?: () => Promise<unknown> | unknown;
  listProjects?: () => Promise<unknown> | unknown;
  newProject?: (input: { name?: string; templateId?: string }) => Promise<unknown> | unknown;
  openProject?: (projectId: string) => Promise<unknown> | unknown;
  importProject?: (input: { dataUrl?: string; url?: string }) => Promise<unknown> | unknown;
  previewProject?: (sequenceId?: string) => Promise<unknown> | unknown;
}

function agentAuthor(name = 'Agent'): Author {
  return { kind: 'webmcp-agent', name };
}

function ok(
  summary: string,
  txId?: string,
  changed?: string[],
  data?: unknown,
): ToolResult {
  return { ok: true, summary, transactionId: txId, changed, data };
}

function fail(error: string): ToolResult {
  return { ok: false, error, summary: error };
}

export function describeProject(ctx: WebMcpContext): ToolResult {
  const p = ctx.bus.project;
  const comp = getActiveComposition(p);
  return ok('Project description', undefined, undefined, {
    schemaVersion: p.schemaVersion,
    name: p.name,
    compositions: Object.values(p.compositions).map((c) => ({ id: c.id, name: c.name })),
    activeComposition: comp?.id,
    assetCount: Object.keys(p.assets).length,
    sequences: Object.values(p.sequences).map((s) => ({ id: s.id, name: s.name, duration: s.duration })),
    publicContract: p.publicContract,
    selection: ctx.getSelection(),
  });
}

export function describeScene(ctx: WebMcpContext, compositionId?: string): ToolResult {
  const p = ctx.bus.project;
  const compId = compositionId ?? p.activeCompositionId;
  const comp = p.compositions[compId];
  if (!comp) return fail(`Composition not found: ${compId}`);

  const nodes = comp.rootNodes.map((id) => {
    const n = p.nodes[id];
    if (!n) return null;
    return {
      id: n.id,
      type: n.type,
      name: n.name,
      tags: n.tags,
      properties: summarizeProperties(p, n.id),
    };
  }).filter(Boolean);

  const fields = Object.values(p.fields);
  const materials = Object.values(p.materials).map((m) => ({
    id: m.id,
    name: m.name,
    parameters: m.parameters,
  }));

  return ok('Scene description', undefined, undefined, {
    composition: comp.name,
    hierarchy: nodes,
    activeCamera: comp.activeCamera,
    activeSequence: comp.sequence,
    materials,
    fields,
    environment: comp.environment,
  });
}

function summarizeProperties(project: HorizonProject, ownerId: string) {
  const node = getNode(project, ownerId);
  if (!node) return {};
  const summary: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.properties)) {
    if (k.startsWith('transform.') || k.startsWith('text.') || k.startsWith('camera.') || k === 'energy') {
      summary[k] = v;
    }
  }
  return summary;
}

export function getSelection(ctx: WebMcpContext): ToolResult {
  const ids = ctx.getSelection();
  const items = ids.map((id) => {
    const n = getNode(ctx.bus.project, id);
    return n
      ? { id, type: n.type, name: n.name, properties: summarizeProperties(ctx.bus.project, id) }
      : { id, error: 'not found' };
  });
  return ok('Selection', undefined, undefined, { selection: items });
}

export function getHistoryRecent(ctx: WebMcpContext, limit = 10): ToolResult {
  return ok('Recent history', undefined, undefined, {
    entries: ctx.bus.getRecentHistory(limit),
  });
}

export function objectCreate(
  ctx: WebMcpContext,
  input: {
    type: string;
    name: string;
    parentId?: string;
    compositionId?: string;
    transform?: { position?: number[]; rotation?: number[]; scale?: number[] };
    options?: Record<string, unknown>;
  },
): ToolResult {
  const supported: NodeType[] = [
    'group', 'mesh', 'text3d', 'dynamicText', 'camera', 'light', 'html', 'svg',
    'image', 'video', 'audio', 'effect', 'helper', 'field', 'volume',
    'reflectionProbe', 'imported',
  ];
  if (!supported.includes(input.type as NodeType)) return fail(`Unsupported node type: ${input.type}`);
  if (!input.name?.trim()) return fail('Object name is required');
  if (input.parentId && !getNode(ctx.bus.project, input.parentId)) {
    return fail(`Parent node not found: ${input.parentId}`);
  }
  if (input.compositionId && !ctx.bus.project.compositions[input.compositionId]) {
    return fail(`Composition not found: ${input.compositionId}`);
  }
  const author = agentAuthor();
  const entity = createNode(input.type as NodeType, input.name);
  if (input.transform?.position) entity.properties['transform.position'] = input.transform.position;
  if (input.transform?.rotation) entity.properties['transform.rotation'] = input.transform.rotation;
  if (input.transform?.scale) entity.properties['transform.scale'] = input.transform.scale;
  if (input.options) {
    for (const [k, v] of Object.entries(input.options)) {
      entity.properties[k] = v;
    }
  }
  const txId = createId('transaction');
  const result = ctx.bus.executeTransaction(
    [buildAddEntityCommand(entity, input.parentId ?? null, undefined, txId, author, `Create ${input.type} ${input.name}`, 'webmcp', input.compositionId)],
    author,
    `Create ${input.type}: ${input.name}`,
    'webmcp',
  );
  if (!result.ok) return fail(result.error);
  return ok(`Created ${input.type} ${input.name}`, result.transactionId, [entity.id]);
}

export function objectTransform(
  ctx: WebMcpContext,
  input: {
    nodeIds: string[];
    position?: number[];
    rotation?: number[];
    scale?: number[];
    delta?: boolean;
    intent?: string;
  },
): ToolResult {
  if (!Array.isArray(input.nodeIds) || input.nodeIds.length === 0) {
    return fail('At least one nodeId is required');
  }
  const vectors: Array<[string, number[] | undefined]> = [
    ['position', input.position],
    ['rotation', input.rotation],
    ['scale', input.scale],
  ];
  for (const [name, value] of vectors) {
    if (value && (value.length !== 3 || value.some((item) => !Number.isFinite(item)))) {
      return fail(`${name} must contain three finite numbers`);
    }
  }
  const author = agentAuthor();
  const commands = [];
  const txId = createId('transaction');
  for (const nodeId of input.nodeIds) {
    const node = getNode(ctx.bus.project, nodeId);
    if (!node) return fail(`Node not found: ${nodeId}`);
    if (input.position) {
      const prev = node.properties['transform.position'];
      let val = input.position;
      if (input.delta && Array.isArray(prev)) {
        val = [prev[0] + input.position[0], prev[1] + input.position[1], prev[2] + input.position[2]];
      }
      commands.push(
        buildSetPropertyCommand(nodeId, 'transform.position', val, prev, txId, author, input.intent ?? 'Transform'),
      );
    }
    if (input.rotation) {
      const prev = node.properties['transform.rotation'];
      let val = input.rotation;
      if (input.delta && Array.isArray(prev)) {
        val = [prev[0] + input.rotation[0], prev[1] + input.rotation[1], prev[2] + input.rotation[2]];
      }
      commands.push(
        buildSetPropertyCommand(nodeId, 'transform.rotation', val, prev, txId, author, input.intent ?? 'Transform'),
      );
    }
    if (input.scale) {
      const prev = node.properties['transform.scale'];
      let val = input.scale;
      if (input.delta && Array.isArray(prev)) {
        val = [prev[0] + input.scale[0], prev[1] + input.scale[1], prev[2] + input.scale[2]];
      }
      commands.push(
        buildSetPropertyCommand(nodeId, 'transform.scale', val, prev, txId, author, input.intent ?? 'Transform'),
      );
    }
  }
  if (commands.length === 0) return fail('No transform values supplied');
  const result = ctx.bus.executeTransaction(commands, author, input.intent ?? 'Transform objects', 'webmcp');
  if (!result.ok) return fail(result.error);
  return ok('Transformed objects', result.transactionId, result.changed);
}

export function textSet(
  ctx: WebMcpContext,
  input: { nodeId: string; text: string },
): ToolResult {
  const author = agentAuthor();
  const node = getNode(ctx.bus.project, input.nodeId);
  if (!node) return fail(`Node not found: ${input.nodeId}`);
  if (node.type !== 'text3d' && node.type !== 'dynamicText') {
    return fail(`Node is not text: ${input.nodeId}`);
  }
  const prev = node.properties['text.value'];
  const txId = createId('transaction');
  const result = ctx.bus.executeTransaction(
    [buildSetPropertyCommand(input.nodeId, 'text.value', input.text, prev, txId, author, `Set text to ${input.text}`)],
    author,
    `Set text: ${input.text}`,
    'webmcp',
  );
  if (!result.ok) return fail(result.error);
  return ok(`Text set to ${input.text}`, result.transactionId, [input.nodeId], { geometryRebuild: true });
}

export function materialAssign(
  ctx: WebMcpContext,
  input: { nodeId: string; materialId: string },
): ToolResult {
  const author = agentAuthor();
  const node = getNode(ctx.bus.project, input.nodeId);
  if (!node) return fail(`Node not found: ${input.nodeId}`);
  if (!ctx.bus.project.materials[input.materialId]) {
    return fail(`Material not found: ${input.materialId}`);
  }
  const prev = node.components.materialId;
  const txId = createId('transaction');
  const result = ctx.bus.executeTransaction(
    [
      makeCommand(
        'AssignMaterial',
        { nodeId: input.nodeId, materialId: input.materialId, previousMaterialId: prev },
        txId,
        author,
        'Assign material',
        'webmcp',
      ),
    ],
    author,
    'Assign material',
    'webmcp',
  );
  if (!result.ok) return fail(result.error);
  return ok('Material assigned', result.transactionId, [input.nodeId]);
}

export function materialParametersSet(
  ctx: WebMcpContext,
  input: { materialId: string; parameters: Record<string, unknown> },
): ToolResult {
  const mat = ctx.bus.project.materials[input.materialId];
  if (!mat) return fail(`Material not found: ${input.materialId}`);
  if (!input.parameters || Object.keys(input.parameters).length === 0) {
    return fail('No material parameters supplied');
  }
  const shader = ctx.bus.project.shaders[mat.shaderId];
  for (const [path, value] of Object.entries(input.parameters)) {
    if (!(path in mat.parameters)) return fail(`Material parameter not found: ${path}`);
    const def = shader?.parameters.find((candidate) => candidate.path === path);
    if (def && (def.type === 'number' || def.type === 'integer')) {
      if (!Number.isFinite(Number(value))) return fail(`Invalid number for ${path}`);
      if (def.min !== undefined && Number(value) < def.min) return fail(`${path} below min ${def.min}`);
      if (def.max !== undefined && Number(value) > def.max) return fail(`${path} above max ${def.max}`);
    }
    if (def?.type === 'enum' && def.choices && !def.choices.some((choice) => choice.value === value)) {
      return fail(`${path} not in enum`);
    }
  }
  const author = agentAuthor();
  const txId = createId('transaction');
  const result = ctx.bus.executeTransaction(
    [
      makeCommand(
        'SetMaterialParameters',
        {
          materialId: input.materialId,
          parameters: input.parameters,
          previousParameters: { ...mat.parameters },
        },
        txId,
        author,
        'Set material parameters',
        'webmcp',
      ),
    ],
    author,
    'Set material parameters',
    'webmcp',
  );
  if (!result.ok) return fail(result.error);
  return ok('Material parameters updated', result.transactionId, [input.materialId], input.parameters);
}

export function shaderParametersSet(
  ctx: WebMcpContext,
  input: { ownerId: string; parameters: Record<string, unknown> },
): ToolResult {
  if (
    !ctx.bus.project.nodes[input.ownerId] &&
    !ctx.bus.project.fields[input.ownerId] &&
    !ctx.bus.project.materials[input.ownerId]
  ) {
    return fail(`Shader parameter owner not found: ${input.ownerId}`);
  }
  if (!input.parameters || Object.keys(input.parameters).length === 0) {
    return fail('No shader parameters supplied');
  }
  const author = agentAuthor();
  const commands = [];
  const txId = createId('transaction');
  for (const [path, value] of Object.entries(input.parameters)) {
    const prev = getProperty(ctx.bus.project, input.ownerId, path);
    if (prev === undefined) return fail(`Exposed shader parameter not found: ${input.ownerId}.${path}`);
    commands.push(
      buildSetPropertyCommand(input.ownerId, path, value, prev, txId, author, `Set shader param ${path}`),
    );
  }
  const result = ctx.bus.executeTransaction(commands, author, 'Set shader parameters', 'webmcp');
  if (!result.ok) return fail(result.error);
  return ok('Shader parameters updated', result.transactionId, [input.ownerId]);
}

export function cameraFrame(
  ctx: WebMcpContext,
  input: { subjectId?: string; hint?: string },
): ToolResult {
  const comp = getActiveComposition(ctx.bus.project);
  const subjectId =
    input.subjectId ??
    comp.rootNodes.map((id) => ctx.bus.project.nodes[id]).find((n) => n?.type === 'text3d')?.id;
  if (!subjectId) return fail('No subject found');
  const result = frameCameraForSubject(ctx.bus, subjectId, input.hint ?? 'grazing', agentAuthor());
  return result.ok
    ? { ...ok(result.summary, result.transactionId, result.changed), warnings: result.warnings ?? [] }
    : fail(result.summary);
}

export function cameraLensSet(
  ctx: WebMcpContext,
  input: {
    cameraId?: string;
    focalLength?: number;
    sensorHeight?: number;
    focus?: number;
    depthOfField?: boolean;
    aperture?: number;
    maxBlur?: number;
  },
): ToolResult {
  const comp = getActiveComposition(ctx.bus.project);
  const cameraId = input.cameraId ?? comp.activeCamera;
  const camera = getNode(ctx.bus.project, cameraId);
  if (!camera || camera.type !== 'camera') return fail(`Camera not found: ${cameraId}`);

  const values: Record<string, unknown> = {};
  if (input.focalLength !== undefined) values['camera.focalLength'] = input.focalLength;
  if (input.sensorHeight !== undefined) values['camera.sensorHeight'] = input.sensorHeight;
  if (input.focus !== undefined) values['camera.focus'] = input.focus;
  if (input.depthOfField !== undefined) values['camera.depthOfField'] = input.depthOfField;
  if (input.aperture !== undefined) values['camera.aperture'] = input.aperture;
  if (input.maxBlur !== undefined) values['camera.maxBlur'] = input.maxBlur;
  if (Object.keys(values).length === 0) return fail('No lens properties supplied');

  const author = agentAuthor();
  const txId = createId('transaction');
  const commands = Object.entries(values).map(([path, value]) =>
    buildSetPropertyCommand(
      cameraId,
      path,
      value,
      camera.properties[path],
      txId,
      author,
      `Set camera ${path.slice('camera.'.length)}`,
      'webmcp',
    ),
  );
  const result = ctx.bus.executeTransaction(commands, author, 'Set camera lens', 'webmcp');
  if (!result.ok) return fail(result.error);
  return ok('Camera lens updated', result.transactionId, [cameraId], values);
}

export function environmentSet(
  ctx: WebMcpContext,
  input: {
    compositionId?: string;
    settings: Record<string, unknown>;
  },
): ToolResult {
  const compositionId = input.compositionId ?? ctx.bus.project.activeCompositionId;
  const composition = ctx.bus.project.compositions[compositionId];
  if (!composition) return fail(`Composition not found: ${compositionId}`);
  if (!input.settings || Object.keys(input.settings).length === 0) {
    return fail('No environment settings supplied');
  }

  const read = (path: string): unknown => {
    let value: unknown = composition.environment;
    for (const part of path.split('.')) {
      if (!value || typeof value !== 'object') return undefined;
      value = (value as Record<string, unknown>)[part];
    }
    return value;
  };
  const author = agentAuthor();
  const txId = createId('transaction');
  const commands = Object.entries(input.settings).map(([path, value]) =>
    makeCommand(
      'SetEnvironmentProperty',
      {
        compositionId,
        path,
        value,
        previousValue: read(path),
      },
      txId,
      author,
      `Set environment ${path}`,
      'webmcp',
    ),
  );
  const result = ctx.bus.executeTransaction(
    commands,
    author,
    'Set environment',
    'webmcp',
  );
  if (!result.ok) return fail(result.error);
  return ok(
    'Environment updated',
    result.transactionId,
    [compositionId],
    input.settings,
  );
}

export function sequenceCreate(
  ctx: WebMcpContext,
  input: { name: string; duration?: number; fps?: number },
): ToolResult {
  if (!input.name?.trim()) return fail('Sequence name is required');
  if (input.duration !== undefined && (!Number.isFinite(input.duration) || input.duration <= 0)) {
    return fail('Sequence duration must be positive');
  }
  if (input.fps !== undefined && (!Number.isFinite(input.fps) || input.fps <= 0)) {
    return fail('Sequence fps must be positive');
  }
  const author = agentAuthor();
  const seqId = createId('sequence');
  const seq = {
    id: seqId,
    name: input.name,
    duration: input.duration ?? 8,
    nominalFps: input.fps ?? 60,
    tracks: [] as string[],
    markers: [],
    defaultDriver: 'time' as const,
  };
  const txId = createId('transaction');
  const result = ctx.bus.executeTransaction(
    [makeCommand('AddSequence', { sequence: seq }, txId, author, 'Create sequence', 'webmcp')],
    author,
    `Create sequence ${input.name}`,
    'webmcp',
  );
  if (!result.ok) return fail(result.error);
  return ok(`Created sequence ${input.name}`, result.transactionId, [seqId], { sequenceId: seqId });
}

export function keyframesSet(
  ctx: WebMcpContext,
  input: {
    ownerId: string;
    path: string;
    keyframes: Array<{ time: number; value: unknown; interpolation?: string; easing?: string }>;
    sequenceId?: string;
  },
): ToolResult {
  const author = agentAuthor();
  const comp = getActiveComposition(ctx.bus.project);
  const seqId = input.sequenceId ?? comp.sequence;
  if (!seqId) return fail('No active sequence');
  const sequence = ctx.bus.project.sequences[seqId];
  if (!sequence) return fail(`Sequence not found: ${seqId}`);
  if (
    !ctx.bus.project.nodes[input.ownerId] &&
    !ctx.bus.project.fields[input.ownerId] &&
    !ctx.bus.project.materials[input.ownerId]
  ) {
    return fail(`Keyframe target not found: ${input.ownerId}`);
  }
  if (!input.path?.trim()) return fail('Keyframe property path is required');
  if (
    !Array.isArray(input.keyframes) ||
    input.keyframes.some((keyframe) =>
      !Number.isFinite(keyframe.time) || keyframe.time < 0 || keyframe.time > sequence.duration
    )
  ) {
    return fail(`Keyframe times must be between 0 and ${sequence.duration}`);
  }

  let track = Object.values(ctx.bus.project.tracks).find(
    (t) =>
      sequence.tracks.includes(t.id) &&
      t.target.ownerId === input.ownerId &&
      t.target.path === input.path,
  );
  const prevKf = track?.keyframes;
  if (!track) {
    const trackId = createId('track');
    track = {
      id: trackId,
      name: `${input.path}`,
      target: { ownerId: input.ownerId, path: input.path },
      keyframes: [],
      enabled: true,
    };
    const txId = createId('transaction');
    const result = ctx.bus.executeTransaction(
      [
        makeCommand('AddTrack', { track, sequenceId: seqId }, txId, author, 'Add track', 'webmcp'),
        makeCommand(
          'SetKeyframes',
          {
            trackId,
            keyframes: input.keyframes.map((k) => ({
              ...k,
              interpolation: k.interpolation ?? 'cubic',
            })),
            previousKeyframes: [],
          },
          txId,
          author,
          'Set keyframes',
          'webmcp',
        ),
      ],
      author,
      'Set keyframes',
      'webmcp',
    );
    if (!result.ok) return fail(result.error);
    return ok('Keyframes set', result.transactionId, [input.ownerId, trackId]);
  }

  const txId = createId('transaction');
  const result = ctx.bus.executeTransaction(
    [
      makeCommand(
        'SetKeyframes',
        {
          trackId: track.id,
          keyframes: input.keyframes.map((k) => ({
            ...k,
            interpolation: k.interpolation ?? 'cubic',
          })),
          previousKeyframes: prevKf,
        },
        txId,
        author,
        'Set keyframes',
        'webmcp',
      ),
    ],
    author,
    'Set keyframes',
    'webmcp',
  );
  if (!result.ok) return fail(result.error);
  return ok('Keyframes set', result.transactionId, [input.ownerId, track.id]);
}

export function sequenceDriverSet(
  ctx: WebMcpContext,
  input: { sequenceId?: string; driver: string },
): ToolResult {
  const comp = getActiveComposition(ctx.bus.project);
  const seqId = input.sequenceId ?? comp.sequence;
  if (!seqId) return fail('No sequence');
  const seq = ctx.bus.project.sequences[seqId];
  if (!seq) return fail(`Sequence not found: ${seqId}`);
  if (!['time', 'manual', 'scroll', 'pointer', 'external', 'presentation', 'event'].includes(input.driver)) {
    return fail(`Unsupported sequence driver: ${input.driver}`);
  }
  const author = agentAuthor();
  const txId = createId('transaction');
  const result = ctx.bus.executeTransaction(
    [
      makeCommand(
        'SetSequenceProperty',
        {
          sequenceId: seqId,
          path: 'defaultDriver',
          value: input.driver,
          previousValue: seq.defaultDriver,
        },
        txId,
        author,
        'Set sequence driver',
        'webmcp',
      ),
    ],
    author,
    `Set driver to ${input.driver}`,
    'webmcp',
  );
  if (!result.ok) return fail(result.error);
  return ok(`Driver set to ${input.driver}`, result.transactionId, [seqId]);
}

export function publicPropertyExpose(
  ctx: WebMcpContext,
  input: {
    publicName: string;
    ownerId: string;
    path: string;
    type: string;
    read?: boolean;
    write?: boolean;
    min?: number;
    max?: number;
  },
): ToolResult {
  if (!input.publicName?.trim()) return fail('Public property name is required');
  if (
    !ctx.bus.project.nodes[input.ownerId] &&
    !ctx.bus.project.fields[input.ownerId] &&
    !ctx.bus.project.materials[input.ownerId]
  ) {
    return fail(`Public property owner not found: ${input.ownerId}`);
  }
  const currentValue = getProperty(ctx.bus.project, input.ownerId, input.path);
  if (currentValue === undefined) {
    return fail(`Property not found: ${input.ownerId}.${input.path}`);
  }
  const inferred = Array.isArray(currentValue) && currentValue.length === 4
    ? input.type === 'quaternion' ? 'quaternion' : 'vec4'
    : Array.isArray(currentValue) && currentValue.length === 3
      ? 'vec3'
      : Array.isArray(currentValue) && currentValue.length === 2
        ? 'vec2'
        : typeof currentValue === 'number'
          ? input.type === 'integer' && Number.isInteger(currentValue) ? 'integer' : 'number'
          : typeof currentValue;
  if (
    inferred !== input.type &&
    !(inferred === 'number' && input.type === 'integer') &&
    !(inferred === 'string' && ['color', 'enum', 'reference', 'asset'].includes(input.type))
  ) {
    return fail(`Public type ${input.type} does not match property type ${inferred}`);
  }
  if (ctx.bus.project.publicContract.properties[input.publicName]) {
    return fail(`Public property already exists: ${input.publicName}`);
  }
  const author = agentAuthor();
  const prop = {
    publicName: input.publicName,
    target: { ownerId: input.ownerId, path: input.path },
    type: input.type as PropertyType,
    read: input.read ?? true,
    write: input.write ?? true,
    min: input.min,
    max: input.max,
  };
  const txId = createId('transaction');
  const result = ctx.bus.executeTransaction(
    [makeCommand('ExposePublicProperty', { property: prop }, txId, author, 'Expose property', 'webmcp')],
    author,
    `Expose ${input.publicName}`,
    'webmcp',
  );
  if (!result.ok) return fail(result.error);
  return ok(`Exposed ${input.publicName}`, result.transactionId);
}

export function previewRender(
  ctx: WebMcpContext,
  input?: {
    time?: number;
    presetId?: string;
    qualityProfileId?: string;
    aov?: string;
  },
): ToolResult {
  if (input?.time !== undefined) {
    ctx.getSelection();
  }
  const dataUrl = ctx.scene.captureScreenshot();
  const capabilities = (ctx.scene as unknown as { getCapabilities?: () => unknown }).getCapabilities?.();
  return ok('Preview rendered', undefined, undefined, {
    format: 'image/png',
    dataUrl,
    viewportUpdated: true,
    time: input?.time,
    presetId: input?.presetId,
    qualityProfileId: input?.qualityProfileId,
    aov: input?.aov,
    capabilities,
  });
}

export function renderSettingsSet(
  ctx: WebMcpContext,
  input: { settings: Record<string, unknown> },
): ToolResult {
  if (!input.settings || Object.keys(input.settings).length === 0) {
    return fail('No render settings supplied');
  }
  const author = agentAuthor();
  const txId = createId('transaction');
  const read = (path: string): unknown => {
    let value: unknown = ctx.bus.project.renderSettings;
    for (const part of path.split('.')) {
      if (!value || typeof value !== 'object') return undefined;
      value = (value as Record<string, unknown>)[part];
    }
    return value;
  };
  const commands = Object.entries(input.settings).map(([path, value]) =>
    makeCommand(
      'SetRenderProperty',
      { path, value, previousValue: read(path) },
      txId,
      author,
      `Set render ${path}`,
      'webmcp',
    ),
  );
  const result = ctx.bus.executeTransaction(commands, author, 'Set render settings', 'webmcp');
  if (!result.ok) return fail(result.error);
  return ok('Render settings updated', result.transactionId, ['__render__'], input.settings);
}

export function rendererCapabilities(ctx: WebMcpContext): ToolResult {
  const capabilities = (ctx.scene as unknown as { getCapabilities?: () => unknown }).getCapabilities?.();
  const stats = (ctx.scene as unknown as { getStats?: () => unknown }).getStats?.();
  return ok('Renderer capabilities', undefined, undefined, { capabilities, stats });
}

export function registryDescribe(): ToolResult {
  return ok('Property registry', undefined, undefined, { scopes: registryDiscoveryMetadata() });
}

export function publishPrepare(ctx: WebMcpContext): ToolResult {
  const { manifest, warnings } = preparePublish(ctx.bus.project);
  return ok('Publish plan ready', undefined, undefined, { manifest, warnings });
}

export function variantCreate(
  ctx: WebMcpContext,
  input: { name: string; baseCompositionId?: string },
): ToolResult {
  const author = agentAuthor();
  const compId = input.baseCompositionId ?? ctx.bus.project.activeCompositionId;
  if (!ctx.bus.project.compositions[compId]) return fail(`Composition not found: ${compId}`);
  if (!input.name?.trim()) return fail('Variant name is required');
  const variant = {
    id: createId('variant'),
    base: compId,
    name: input.name,
    overrides: {},
  };
  const txId = createId('transaction');
  const result = ctx.bus.executeTransaction(
    [makeCommand('CreateVariant', { variant }, txId, author, 'Create variant', 'webmcp')],
    author,
    `Create variant ${input.name}`,
    'webmcp',
  );
  if (!result.ok) return fail(result.error);
  return ok(`Variant ${input.name} created`, result.transactionId, [variant.id]);
}

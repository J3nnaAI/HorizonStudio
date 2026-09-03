/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { makeCommand } from '../../core/commands';
import { createId } from '../../core/ids';
import {
  environmentDefaults,
  getProperty,
  outputDefaults,
  qualityProfileDefaults,
} from '../../core/project';
import type { AovDef, ToolResult } from '../../core/types';
import type { WebMcpContext, WebMcpPermissions } from './tools';
import {
  findComponentDescriptor,
  parseComponentId,
  type ComponentDescriptor,
  type FactoryCollection,
} from './componentCatalog';
import { invokeActionComponent, updateShaderPatch, type ActionId } from './componentActions';
import * as semantic from './semanticTools';
import * as tools from './tools';
import { WEBMCP_TOOL_VERSION } from './semanticTools';

type MutatingInput = {
  expectedRevision?: number;
  intent?: string;
  operation?: 'create' | 'append' | 'upsert' | 'update' | 'invoke';
};

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

function stale(ctx: WebMcpContext, input: MutatingInput, required = false): ToolResult | null {
  if (required && input.expectedRevision === undefined) {
    return failure(ctx, 'REVISION_REQUIRED', 'expectedRevision is required for this state-sensitive operation');
  }
  if (input.expectedRevision !== undefined && input.expectedRevision !== ctx.bus.getRevision()) {
    return failure(
      ctx,
      'STALE_REVISION',
      `Expected revision ${input.expectedRevision}, current revision is ${ctx.bus.getRevision()}`,
    );
  }
  return null;
}

function failure(ctx: WebMcpContext, code: string, error: string, warnings: string[] = []): ToolResult {
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

function success(
  ctx: WebMcpContext,
  summary: string,
  options: { transactionId?: string; changed?: string[]; warnings?: string[]; data?: unknown } = {},
): ToolResult {
  return {
    ok: true,
    toolVersion: WEBMCP_TOOL_VERSION,
    schemaVersion: ctx.bus.project.schemaVersion,
    revision: ctx.bus.getRevision(),
    summary,
    warnings: options.warnings ?? [],
    ...options,
  };
}

function readNested(source: unknown, path: string): unknown {
  let cursor = source;
  for (const part of path.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function tx(
  ctx: WebMcpContext,
  input: MutatingInput,
  commands: ReturnType<typeof makeCommand>[],
  summary: string,
  requiredRevision = false,
): ToolResult {
  const revisionFailure = stale(ctx, input, requiredRevision);
  if (revisionFailure) return revisionFailure;
  const author = { kind: 'webmcp-agent' as const, name: 'WebMCP Agent' };
  const result = ctx.bus.executeTransaction(commands, author, input.intent ?? summary, 'webmcp');
  if (!result.ok) return failure(ctx, 'COMMAND_FAILED', result.error, result.warnings);
  return success(ctx, summary, {
    transactionId: result.transactionId,
    changed: result.changed,
    warnings: result.warnings,
  });
}

export function executeFactoryCreate(
  ctx: WebMcpContext,
  input: MutatingInput & { collection: FactoryCollection; value?: unknown },
): ToolResult {
  const payload = (input.value ?? {}) as Record<string, unknown>;
  switch (input.collection) {
    case 'node':
      return tools.objectCreate(ctx, { ...payload, expectedRevision: input.expectedRevision, intent: input.intent } as never);
    case 'asset':
      return semantic.assetImport(ctx, { ...payload, expectedRevision: input.expectedRevision, intent: input.intent } as never);
    case 'material':
      return semantic.materialCreate(ctx, { ...payload, expectedRevision: input.expectedRevision, intent: input.intent } as never);
    case 'shader':
      return semantic.shaderCreate(ctx, { ...payload, expectedRevision: input.expectedRevision, intent: input.intent } as never);
    case 'sequence':
      return tools.sequenceCreate(ctx, { ...payload, expectedRevision: input.expectedRevision, intent: input.intent } as never);
    case 'track':
      return semantic.trackCreate(ctx, { ...payload, expectedRevision: input.expectedRevision, intent: input.intent } as never);
    case 'clip':
      return semantic.clipUpsert(ctx, {
        trackId: String(payload.trackId),
        clip: payload.clip as never,
        expectedRevision: input.expectedRevision,
        intent: input.intent,
      });
    case 'marker':
      return semantic.markerAdd(ctx, {
        sequenceId: String(payload.sequenceId),
        marker: payload.marker as never,
        expectedRevision: input.expectedRevision,
        intent: input.intent,
      });
    case 'behavior':
      return semantic.interactionUpsert(ctx, {
        behavior: payload.behavior as never,
        expectedRevision: input.expectedRevision,
        intent: input.intent,
      });
    case 'variant':
      return tools.variantCreate(ctx, { ...payload, expectedRevision: input.expectedRevision, intent: input.intent } as never);
    case 'public-property':
      return tools.publicPropertyExpose(ctx, { ...payload, expectedRevision: input.expectedRevision, intent: input.intent } as never);
    case 'keyframe':
      return tools.keyframesSet(ctx, { ...payload, expectedRevision: input.expectedRevision, intent: input.intent } as never);
    case 'render-job':
      return semantic.renderEnqueue(ctx, {
        presetId: String(payload.presetId),
        compositionId: payload.compositionId as string | undefined,
        expectedRevision: input.expectedRevision,
        intent: input.intent,
      });
    case 'composition': {
      const compId = createId('composition');
      const inheritedIds = Array.isArray(payload.inherits) ? payload.inherits.map(String) : [];
      if (inheritedIds.some((id) => !ctx.bus.project.compositions[id])) {
        return failure(ctx, 'VALIDATION_FAILED', 'Every inherited stage must exist');
      }
      const composition = {
        id: compId,
        name: String(payload.name ?? 'Stage'),
        rootNodes: Array.isArray(payload.rootNodes) ? payload.rootNodes.map(String) : [],
        activeCamera: Object.values(ctx.bus.project.nodes).find((n) => n.type === 'camera')?.id ?? '',
        sequence: null,
        environment: environmentDefaults(),
        inherits: inheritedIds,
        nodeOverrides: payload.nodeOverrides && typeof payload.nodeOverrides === 'object'
          ? payload.nodeOverrides as Record<string, { enabled?: boolean; properties?: Record<string, unknown> }>
          : {},
      };
      const txId = createId('transaction');
      return tx(ctx, input, [
        makeCommand('AddComposition', { composition }, txId, { kind: 'webmcp-agent', name: 'WebMCP Agent' }, input.intent ?? 'Create composition', 'webmcp'),
      ], `Created composition ${composition.name}`);
    }
    case 'render-preset': {
      const presetId = createId('preset');
      const preset = {
        id: presetId,
        name: String(payload.name ?? 'Preset'),
        qualityProfileId: String(payload.qualityProfileId ?? ctx.bus.project.renderSettings.qualityProfileId),
        output: outputDefaults(),
        aovs: [],
      };
      const txId = createId('transaction');
      return tx(ctx, input, [
        makeCommand('AddRenderPreset', { preset }, txId, { kind: 'webmcp-agent', name: 'WebMCP Agent' }, input.intent ?? 'Create render preset', 'webmcp'),
      ], `Created render preset ${preset.name}`, Boolean(input.expectedRevision));
    }
    case 'quality-profile': {
      const profileId = createId('profile');
      const profile = qualityProfileDefaults(profileId, (payload.base as 'interactive' | 'high' | 'master' | 'custom') ?? 'custom', {
        name: String(payload.name ?? profileId),
      });
      const txId = createId('transaction');
      return tx(ctx, input, [
        makeCommand('AddQualityProfile', { profile }, txId, { kind: 'webmcp-agent', name: 'WebMCP Agent' }, input.intent ?? 'Create quality profile', 'webmcp'),
      ], `Created quality profile ${profile.name}`, Boolean(input.expectedRevision));
    }
    case 'aov': {
      const aov = (payload.aov ?? payload) as AovDef;
      if (!aov.id) aov.id = createId('aov');
      const target = (payload.target as 'render' | 'preset') ?? 'render';
      const txId = createId('transaction');
      return tx(ctx, input, [
        makeCommand(
          'AddAov',
          { aov, target, presetId: payload.presetId },
          txId,
          { kind: 'webmcp-agent', name: 'WebMCP Agent' },
          input.intent ?? 'Add AOV',
          'webmcp',
        ),
      ], `Added AOV ${aov.name}`, Boolean(input.expectedRevision));
    }
    case 'breakpoint': {
      const breakpoint = payload.breakpoint as Record<string, unknown>;
      if (!breakpoint?.id) breakpoint.id = createId('breakpoint');
      const current = ctx.bus.project.responsive?.breakpoints ?? [];
      const txId = createId('transaction');
      return tx(ctx, input, [
        makeCommand(
          'SetProjectProperty',
          {
            path: 'responsive.breakpoints',
            value: [...current, breakpoint],
            previousValue: structuredClone(current),
          },
          txId,
          { kind: 'webmcp-agent', name: 'WebMCP Agent' },
          input.intent ?? 'Add breakpoint',
          'webmcp',
        ),
      ], 'Added responsive breakpoint');
    }
    case 'event': {
      const event = payload.event as Record<string, unknown>;
      const trackId = String(payload.trackId);
      const txId = createId('transaction');
      return tx(ctx, input, [
        makeCommand(
          'AddTrackEvent',
          { trackId, event },
          txId,
          { kind: 'webmcp-agent', name: 'WebMCP Agent' },
          input.intent ?? 'Add track event',
          'webmcp',
        ),
      ], 'Added track event', Boolean(input.expectedRevision));
    }
    default:
      return failure(ctx, 'INVALID_INPUT', `Unsupported factory collection: ${input.collection}`);
  }
}

function actionPolicyFailure(
  ctx: WebMcpContext,
  descriptor: ComponentDescriptor,
  input: MutatingInput & { value?: unknown; patch?: Record<string, unknown> },
): ToolResult | null {
  const rules = descriptor.validationRules;
  if (rules.requiresRevision) {
    const revisionFailure = stale(ctx, input, true);
    if (revisionFailure) return revisionFailure;
  }
  if (rules.requiresPermission && !permissions(ctx)[rules.requiresPermission]) {
    return failure(ctx, 'PERMISSION_DENIED', `${rules.requiresPermission} permission is required`);
  }
  if (rules.requiresConfirmation) {
    const payload = (input.value ?? input.patch ?? {}) as Record<string, unknown>;
    if (payload.confirm !== true) {
      return failure(ctx, 'CONFIRMATION_REQUIRED', `${rules.requiresConfirmation} requires confirm: true in value`);
    }
  }
  return null;
}

export async function executeComponentUpdate(
  ctx: WebMcpContext,
  input: MutatingInput & {
    componentId: string;
    value?: unknown;
    patch?: Record<string, unknown>;
    properties?: Record<string, unknown>;
  },
  descriptor: ComponentDescriptor,
): Promise<ToolResult> {
  const parsed = parseComponentId(input.componentId)!;
  const op = input.operation ?? (parsed.kind === 'action' ? 'invoke' : 'update');

  if (parsed.kind === 'action') {
    if (op !== 'invoke') {
      return failure(ctx, 'INVALID_INPUT', 'Action components require operation invoke');
    }
    const policyFailure = actionPolicyFailure(ctx, descriptor, input);
    if (policyFailure) return policyFailure;
    return invokeActionComponent(ctx, parsed.ownerId as ActionId, input);
  }

  if (parsed.kind === 'factory') {
    if (op !== 'create' && op !== 'upsert' && op !== 'append') {
      return failure(ctx, 'INVALID_INPUT', 'Factory components require operation create, upsert, or append');
    }
    return executeFactoryCreate(ctx, {
      collection: parsed.ownerId as FactoryCollection,
      value: input.value ?? input.patch,
      expectedRevision: input.expectedRevision,
      intent: input.intent,
      operation: op,
    });
  }

  if (parsed.kind === 'property') {
    const values = input.properties ?? (input.value !== undefined ? { [parsed.path]: input.value } : null);
    if (!values || Object.keys(values).length === 0) {
      return failure(ctx, 'INVALID_INPUT', 'value or properties is required');
    }
    return semantic.propertiesSet(ctx, {
      ownerId: parsed.ownerId,
      properties: values,
      expectedRevision: input.expectedRevision,
      intent: input.intent,
    });
  }

  if (parsed.kind === 'environment') {
    const composition = ctx.bus.project.compositions[parsed.ownerId];
    if (!composition) return failure(ctx, 'NOT_FOUND', `Composition not found: ${parsed.ownerId}`);
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand(
        'SetEnvironmentProperty',
        {
          compositionId: parsed.ownerId,
          path: parsed.path,
          value: input.value,
          previousValue: readNested(composition.environment, parsed.path),
        },
        txId,
        { kind: 'webmcp-agent', name: 'WebMCP Agent' },
        input.intent ?? `Set environment ${parsed.path}`,
        'webmcp',
      ),
    ], `Updated environment ${parsed.path}`);
  }

  if (parsed.kind === 'render') {
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand(
        'SetRenderProperty',
        { path: parsed.path, value: input.value, previousValue: readNested(ctx.bus.project.renderSettings, parsed.path) },
        txId,
        { kind: 'webmcp-agent', name: 'WebMCP Agent' },
        input.intent ?? `Set render ${parsed.path}`,
        'webmcp',
      ),
    ], `Updated render ${parsed.path}`);
  }

  if (parsed.kind === 'property-quality-profile') {
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand(
        'SetQualityProfileProperty',
        {
          profileId: parsed.ownerId,
          path: parsed.path,
          value: input.value,
          previousValue: readNested(ctx.bus.project.renderSettings.qualityProfiles[parsed.ownerId], parsed.path),
        },
        txId,
        { kind: 'webmcp-agent', name: 'WebMCP Agent' },
        input.intent ?? `Set quality profile ${parsed.path}`,
        'webmcp',
      ),
    ], `Updated quality profile ${parsed.path}`);
  }

  if (parsed.kind === 'property-render-preset' || parsed.kind === 'property-preset-output') {
    const txId = createId('transaction');
    const preset = ctx.bus.project.renderPresets[parsed.ownerId];
    if (!preset) return failure(ctx, 'NOT_FOUND', `Preset not found: ${parsed.ownerId}`);
    const path = parsed.kind === 'property-preset-output' ? `output.${parsed.path}` : parsed.path;
    return tx(ctx, input, [
      makeCommand(
        'SetRenderPresetProperty',
        { presetId: parsed.ownerId, path, value: input.value, previousValue: readNested(preset, path) },
        txId,
        { kind: 'webmcp-agent', name: 'WebMCP Agent' },
        input.intent ?? `Set preset ${path}`,
        'webmcp',
      ),
    ], `Updated preset ${path}`);
  }

  if (parsed.kind === 'property-aov' || parsed.kind === 'property-preset-aov') {
    const [entityId, aovId] = parsed.ownerId.split('__');
    const target = entityId === '__render__' ? 'render' : 'preset';
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand(
        'SetAovProperty',
        {
          aovId,
          target,
          presetId: target === 'preset' ? entityId : undefined,
          path: parsed.path,
          value: input.value,
          previousValue: undefined,
        },
        txId,
        { kind: 'webmcp-agent', name: 'WebMCP Agent' },
        input.intent ?? `Set AOV ${parsed.path}`,
        'webmcp',
      ),
    ], `Updated AOV ${parsed.path}`, true);
  }

  if (parsed.kind === 'property-responsive') {
    const txId = createId('transaction');
    const prev = readNested(ctx.bus.project.responsive ?? {}, parsed.path);
    return tx(ctx, input, [
      makeCommand(
        'SetProjectProperty',
        { path: `responsive.${parsed.path}`, value: input.value, previousValue: prev },
        txId,
        { kind: 'webmcp-agent', name: 'WebMCP Agent' },
        input.intent ?? `Set responsive ${parsed.path}`,
        'webmcp',
      ),
    ], `Updated responsive ${parsed.path}`);
  }

  if (parsed.kind === 'property-project') {
    const path = parsed.path === 'name' ? 'name' : 'activeCompositionId';
    if (path === 'activeCompositionId' && !ctx.bus.project.compositions[String(input.value)]) {
      return failure(ctx, 'NOT_FOUND', `Composition not found: ${String(input.value)}`);
    }
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand(
        'SetProjectProperty',
        { path, value: input.value, previousValue: path === 'name' ? ctx.bus.project.name : ctx.bus.project.activeCompositionId },
        txId,
        { kind: 'webmcp-agent', name: 'WebMCP Agent' },
        input.intent ?? `Set project ${path}`,
        'webmcp',
      ),
    ], `Updated project ${path}`);
  }

  if (parsed.kind === 'property-composition' && parsed.path) {
    const txId = createId('transaction');
    const comp = ctx.bus.project.compositions[parsed.ownerId];
    if (!comp) return failure(ctx, 'NOT_FOUND', `Composition not found: ${parsed.ownerId}`);
    if (parsed.path === 'name' && !String(input.value ?? '').trim()) return failure(ctx, 'VALIDATION_FAILED', 'Composition name is required');
    if (parsed.path === 'rootNodes') {
      if (!Array.isArray(input.value)) return failure(ctx, 'VALIDATION_FAILED', 'Composition rootNodes must be an array');
      const missing = input.value.map(String).find((id) => !ctx.bus.project.nodes[id]);
      if (missing) return failure(ctx, 'NOT_FOUND', `Node not found: ${missing}`);
    }
    if (parsed.path === 'activeCamera' && input.value && ctx.bus.project.nodes[String(input.value)]?.type !== 'camera') {
      return failure(ctx, 'VALIDATION_FAILED', 'activeCamera must reference a camera node');
    }
    if (parsed.path === 'sequence' && input.value && !ctx.bus.project.sequences[String(input.value)]) {
      return failure(ctx, 'NOT_FOUND', `Sequence not found: ${String(input.value)}`);
    }
    if (parsed.path === 'inherits') {
      if (!Array.isArray(input.value)) return failure(ctx, 'VALIDATION_FAILED', 'Stage inheritance must be an array of stage IDs');
      const inheritedIds = input.value.map(String);
      if (inheritedIds.some((id) => !ctx.bus.project.compositions[id])) return failure(ctx, 'VALIDATION_FAILED', 'Every inherited stage must exist');
      const reaches = (id: string, target: string, seen = new Set<string>()): boolean => {
        if (id === target) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        return (ctx.bus.project.compositions[id]?.inherits ?? []).some((next) => reaches(next, target, seen));
      };
      if (inheritedIds.some((id) => reaches(id, parsed.ownerId))) return failure(ctx, 'VALIDATION_FAILED', 'Stages cannot inherit from themselves, directly or indirectly');
    }
    return tx(ctx, input, [
      makeCommand(
        'SetProjectProperty',
        {
          path: `compositions.${parsed.ownerId}.${parsed.path}`,
          value: input.value,
          previousValue: comp?.[parsed.path as keyof typeof comp],
        },
        txId,
        { kind: 'webmcp-agent', name: 'WebMCP Agent' },
        input.intent ?? `Set composition ${parsed.path}`,
        'webmcp',
      ),
    ], `Updated composition ${parsed.path}`);
  }

  if (parsed.kind === 'entity-composition' && !parsed.path) {
    const patch = (input.value && typeof input.value === 'object' ? input.value : input.patch) as Record<string, unknown> | undefined;
    if (!patch || Object.keys(patch).length === 0) return failure(ctx, 'INVALID_INPUT', 'A composition patch is required');
    const allowed = new Set(['name', 'rootNodes', 'activeCamera', 'sequence', 'inherits', 'nodeOverrides']);
    const unknown = Object.keys(patch).find((key) => !allowed.has(key));
    if (unknown) return failure(ctx, 'VALIDATION_FAILED', `Unsupported composition field: ${unknown}`);
    const comp = ctx.bus.project.compositions[parsed.ownerId];
    if (!comp) return failure(ctx, 'NOT_FOUND', `Composition not found: ${parsed.ownerId}`);
    const commands = Object.entries(patch).map(([path, value]) => makeCommand(
      'SetProjectProperty',
      { path: `compositions.${parsed.ownerId}.${path}`, value, previousValue: structuredClone(comp[path as keyof typeof comp]) },
      createId('transaction'),
      { kind: 'webmcp-agent', name: 'WebMCP Agent' },
      input.intent ?? 'Update composition',
      'webmcp',
    ));
    return tx(ctx, input, commands, `Updated composition ${comp.name}`, true);
  }

  if (parsed.kind === 'entity-asset' && parsed.path === 'name') {
    const asset = ctx.bus.project.assets[parsed.ownerId];
    const name = String(input.value ?? '').trim();
    if (!asset) return failure(ctx, 'NOT_FOUND', `Asset not found: ${parsed.ownerId}`);
    if (!name) return failure(ctx, 'VALIDATION_FAILED', 'Asset name is required');
    return tx(ctx, input, [makeCommand(
      'SetProjectProperty',
      { path: `assets.${parsed.ownerId}.name`, value: name, previousValue: asset.name },
      createId('transaction'),
      { kind: 'webmcp-agent', name: 'WebMCP Agent' },
      input.intent ?? 'Rename asset',
      'webmcp',
    )], `Renamed asset ${name}`);
  }

  if (parsed.kind === 'entity-marker') {
    const sequence = ctx.bus.project.sequences[parsed.ownerId];
    if (!sequence) return failure(ctx, 'NOT_FOUND', `Sequence not found: ${parsed.ownerId}`);
    const index = sequence.markers.findIndex((marker) => (marker.id ?? marker.name) === parsed.path);
    if (index < 0) return failure(ctx, 'NOT_FOUND', `Marker not found: ${parsed.path}`);
    const next = [...sequence.markers];
    next[index] = { ...next[index], ...(input.value as object ?? input.patch ?? {}) };
    return tx(ctx, input, [makeCommand(
      'SetProjectProperty',
      { path: `sequences.${sequence.id}.markers`, value: next, previousValue: structuredClone(sequence.markers) },
      createId('transaction'),
      { kind: 'webmcp-agent', name: 'WebMCP Agent' },
      input.intent ?? 'Update marker',
      'webmcp',
    )], `Updated marker ${parsed.path}`, true);
  }

  if (parsed.kind === 'entity-event') {
    const track = ctx.bus.project.tracks[parsed.ownerId];
    if (!track) return failure(ctx, 'NOT_FOUND', `Track not found: ${parsed.ownerId}`);
    const events = track.events ?? [];
    const index = events.findIndex((event) => (event.id ?? `${event.time}-${event.name}`) === parsed.path);
    if (index < 0) return failure(ctx, 'NOT_FOUND', `Event not found: ${parsed.path}`);
    const next = [...events];
    next[index] = { ...next[index], ...(input.value as object ?? input.patch ?? {}) } as never;
    return tx(ctx, input, [makeCommand(
      'SetProjectProperty',
      { path: `tracks.${track.id}.events`, value: next, previousValue: structuredClone(events) },
      createId('transaction'),
      { kind: 'webmcp-agent', name: 'WebMCP Agent' },
      input.intent ?? 'Update event',
      'webmcp',
    )], `Updated event ${parsed.path}`, true);
  }

  if (parsed.kind === 'entity-breakpoint') {
    const current = ctx.bus.project.responsive?.breakpoints ?? [];
    const index = current.findIndex((breakpoint) => breakpoint.id === parsed.path);
    if (index < 0) return failure(ctx, 'NOT_FOUND', `Breakpoint not found: ${parsed.path}`);
    const next = [...current];
    next[index] = { ...next[index], ...(input.value as object ?? input.patch ?? {}) } as never;
    return tx(ctx, input, [makeCommand(
      'SetProjectProperty',
      { path: 'responsive.breakpoints', value: next, previousValue: structuredClone(current) },
      createId('transaction'),
      { kind: 'webmcp-agent', name: 'WebMCP Agent' },
      input.intent ?? 'Update breakpoint',
      'webmcp',
    )], `Updated breakpoint ${parsed.path}`, true);
  }

  if (parsed.kind === 'property-render-job') {
    if (parsed.path !== 'cancelRequested') {
      return failure(ctx, 'VALIDATION_FAILED', `Render job field ${parsed.path} is runtime-owned and read-only`);
    }
    return semantic.renderCancel(ctx, {
      jobId: parsed.ownerId,
      expectedRevision: input.expectedRevision,
      intent: input.intent,
    });
  }

  if (parsed.kind === 'entity-material' && parsed.path === 'name') {
    return invokeActionComponent(ctx, 'material-rename', {
      value: { materialId: parsed.ownerId, name: input.value },
      expectedRevision: input.expectedRevision,
      intent: input.intent,
    });
  }

  if (parsed.kind === 'entity-material' && parsed.path === 'shaderId') {
    const mat = ctx.bus.project.materials[parsed.ownerId];
    if (!mat) return failure(ctx, 'NOT_FOUND', `Material not found: ${parsed.ownerId}`);
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand(
        'SetMaterialShader',
        { materialId: parsed.ownerId, shaderId: String(input.value), previousShaderId: mat.shaderId },
        txId,
        { kind: 'webmcp-agent', name: 'WebMCP Agent' },
        input.intent ?? 'Set material shader',
        'webmcp',
      ),
    ], `Updated material shader`);
  }

  if (parsed.kind === 'entity-shader' && parsed.path) {
    const patch = { [parsed.path]: input.value ?? input.patch?.[parsed.path] } as Record<string, unknown>;
    return updateShaderPatch(
      ctx,
      parsed.ownerId,
      patch as never,
      input,
      permissions(ctx).trustedShaderSource,
    );
  }

  if (parsed.kind === 'entity-track' && parsed.path) {
    const track = ctx.bus.project.tracks[parsed.ownerId];
    if (!track) return failure(ctx, 'NOT_FOUND', `Track not found: ${parsed.ownerId}`);
    if (['name', 'enabled', 'muted', 'solo', 'locked'].includes(parsed.path)) {
      return semantic.trackUpdate(ctx, {
        trackId: parsed.ownerId,
        [parsed.path]: input.value,
        expectedRevision: input.expectedRevision,
        intent: input.intent,
      } as never);
    }
    const txId = createId('transaction');
    if (parsed.path === 'target') {
      return tx(ctx, input, [
        makeCommand(
          'SetProjectProperty',
          { path: `tracks.${track.id}.target`, value: input.value, previousValue: structuredClone(track.target) },
          txId,
          { kind: 'webmcp-agent', name: 'WebMCP Agent' },
          input.intent ?? 'Set track target',
          'webmcp',
        ),
      ], 'Updated track target', true);
    }
    if (parsed.path === 'target.ownerId' || parsed.path === 'target.path') {
      const key = parsed.path.split('.')[1] as 'ownerId' | 'path';
      const next = { ...track.target, [key]: input.value };
      return tx(ctx, input, [
        makeCommand(
          'SetProjectProperty',
          { path: `tracks.${track.id}.target`, value: next, previousValue: structuredClone(track.target) },
          txId,
          { kind: 'webmcp-agent', name: 'WebMCP Agent' },
          input.intent ?? `Set track target ${key}`,
          'webmcp',
        ),
      ], `Updated track target ${key}`, true);
    }
    if (parsed.path === 'expression') {
      return tx(ctx, input, [
        makeCommand(
          'SetTrackExpression',
          { trackId: track.id, expression: input.value, previousExpression: structuredClone(track.expression) },
          txId,
          { kind: 'webmcp-agent', name: 'WebMCP Agent' },
          input.intent ?? 'Set track expression',
          'webmcp',
        ),
      ], 'Updated track expression', true);
    }
    if (parsed.path === 'binding') {
      return tx(ctx, input, [
        makeCommand(
          'SetTrackBinding',
          { trackId: track.id, binding: input.value, previousBinding: structuredClone(track.binding) },
          txId,
          { kind: 'webmcp-agent', name: 'WebMCP Agent' },
          input.intent ?? 'Set track binding',
          'webmcp',
        ),
      ], 'Updated track binding', true);
    }
    if (parsed.path === 'constraints') {
      return tx(ctx, input, [
        makeCommand(
          'SetTrackConstraints',
          { trackId: track.id, constraints: input.value, previousConstraints: structuredClone(track.constraints) },
          txId,
          { kind: 'webmcp-agent', name: 'WebMCP Agent' },
          input.intent ?? 'Set track constraints',
          'webmcp',
        ),
      ], 'Updated track constraints', true);
    }
  }

  if (parsed.kind === 'entity-clip') {
    const track = ctx.bus.project.tracks[parsed.ownerId];
    if (!track) return failure(ctx, 'NOT_FOUND', `Track not found: ${parsed.ownerId}`);
    const dot = parsed.path.indexOf('.');
    const clipId = dot >= 0 ? parsed.path.slice(0, dot) : parsed.path;
    const subPath = dot >= 0 ? parsed.path.slice(dot + 1) : '';
    const existing = track.clips?.find((clip) => clip.id === clipId);
    if (!existing && !subPath && op !== 'upsert') {
      return failure(ctx, 'NOT_FOUND', `Clip not found: ${clipId}`);
    }
    const base = (input.value && typeof input.value === 'object' && !Array.isArray(input.value))
      ? (input.value as Record<string, unknown>)
      : { ...(existing ?? {}), ...(input.patch ?? {}) };
    if (subPath) {
      base[subPath] = input.value ?? input.patch?.[subPath];
    }
    if (!base.id) base.id = clipId;
    return semantic.clipUpsert(ctx, {
      trackId: parsed.ownerId,
      clip: base as never,
      expectedRevision: input.expectedRevision,
      intent: input.intent,
    });
  }

  if (parsed.kind === 'entity-node') {
    if (parsed.path && ['name', 'enabled', 'locked', 'tags'].includes(parsed.path)) {
      return semantic.nodeUpdate(ctx, {
        nodeId: parsed.ownerId,
        [parsed.path]: input.value,
        expectedRevision: input.expectedRevision,
        intent: input.intent,
      } as never);
    }
    if (!parsed.path) {
      const patch = { ...(input.patch ?? {}), ...(input.properties ?? {}) };
      if (input.value && typeof input.value === 'object' && !Array.isArray(input.value)) {
        Object.assign(patch, input.value as Record<string, unknown>);
      }
      return semantic.nodeUpdate(ctx, {
        nodeId: parsed.ownerId,
        ...patch,
        expectedRevision: input.expectedRevision,
        intent: input.intent,
      } as never);
    }
  }

  if (parsed.kind === 'entity-sequence' && parsed.path) {
    return semantic.sequenceUpdate(ctx, {
      sequenceId: parsed.ownerId,
      [parsed.path]: input.value ?? input.patch?.[parsed.path],
      expectedRevision: input.expectedRevision,
      intent: input.intent,
    } as never);
  }

  if (parsed.kind === 'entity-keyframe') {
    const track = ctx.bus.project.tracks[parsed.ownerId];
    if (!track) return failure(ctx, 'NOT_FOUND', `Track not found: ${parsed.ownerId}`);
    const index = Number(parsed.path);
    const keyframes = [...track.keyframes];
    if (op === 'append') {
      keyframes.push(input.value as never);
    } else {
      keyframes[index] = input.value as never;
    }
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand(
        'SetKeyframes',
        { trackId: track.id, keyframes, previousKeyframes: track.keyframes },
        txId,
        { kind: 'webmcp-agent', name: 'WebMCP Agent' },
        input.intent ?? 'Set keyframes',
        'webmcp',
      ),
    ], 'Updated keyframes', true);
  }

  if (parsed.kind === 'entity-variant' && parsed.path) {
    return semantic.variantUpdate(ctx, {
      variantId: parsed.ownerId,
      [parsed.path]: input.value ?? input.patch?.[parsed.path],
      expectedRevision: input.expectedRevision,
      intent: input.intent,
    } as never);
  }

  if (parsed.kind === 'entity-behavior') {
    const behavior = (input.value ?? { ...(descriptor.currentValue as object), ...(input.patch ?? {}) }) as never;
    return semantic.interactionUpsert(ctx, {
      behavior,
      expectedRevision: input.expectedRevision,
      intent: input.intent,
    });
  }

  if (parsed.kind === 'presentation' && parsed.path) {
    const current = ctx.bus.project.metadata.presentation ?? {
      slides: [ctx.bus.project.activeCompositionId],
      autoplay: false,
      intervalSeconds: 8,
      loop: false,
    };
    return semantic.presentationSet(ctx, {
      ...current,
      [parsed.path]: input.value ?? input.patch?.[parsed.path],
      expectedRevision: input.expectedRevision,
      intent: input.intent,
    } as never);
  }

  if (parsed.kind === 'node-component' && input.value !== undefined) {
    if (parsed.path === 'materialId') {
      return tools.materialAssign(ctx, {
        nodeId: parsed.ownerId,
        materialId: String(input.value),
      });
    }
    const node = ctx.bus.project.nodes[parsed.ownerId];
    if (!node) return failure(ctx, 'NOT_FOUND', `Node not found: ${parsed.ownerId}`);
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand(
        'SetNodeComponent',
        {
          nodeId: parsed.ownerId,
          key: parsed.path,
          value: structuredClone(input.value),
          previousValue: structuredClone(node.components[parsed.path]),
        },
        txId,
        { kind: 'webmcp-agent', name: 'WebMCP Agent' },
        input.intent ?? `Set ${parsed.path}`,
        'webmcp',
      ),
    ], `Updated node component ${parsed.path}`);
  }

  if (parsed.kind === 'material-texture') {
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand(
        'SetMaterialTexture',
        {
          materialId: parsed.ownerId,
          slot: parsed.path,
          binding: input.value,
          previousBinding: ctx.bus.project.materials[parsed.ownerId]?.textures?.[parsed.path],
        },
        txId,
        { kind: 'webmcp-agent', name: 'WebMCP Agent' },
        input.intent ?? `Set texture ${parsed.path}`,
        'webmcp',
      ),
    ], `Updated material texture ${parsed.path}`);
  }

  return failure(ctx, 'INVALID_INPUT', 'Supply value, properties, or patch for this component type');
}

export function executeComponentRemove(
  ctx: WebMcpContext,
  input: MutatingInput & { componentId: string },
): ToolResult {
  const parsed = parseComponentId(input.componentId);
  if (!parsed) return failure(ctx, 'INVALID_INPUT', `Invalid componentId: ${input.componentId}`);
  const requiredRevision = descriptorRequiresRevision(findComponentDescriptor(ctx.bus.project, permissions(ctx), input.componentId));

  if (parsed.kind === 'entity-asset' && !parsed.path) {
    if (!permissions(ctx).delete) return failure(ctx, 'PERMISSION_DENIED', 'Agent deletion is disabled');
    const asset = ctx.bus.project.assets[parsed.ownerId];
    if (!asset) return failure(ctx, 'NOT_FOUND', `Asset not found: ${parsed.ownerId}`);
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand('RemoveAsset', { assetId: parsed.ownerId, savedAsset: structuredClone(asset) }, txId, { kind: 'webmcp-agent', name: 'WebMCP Agent' }, input.intent ?? 'Remove asset', 'webmcp'),
    ], `Removed asset ${parsed.ownerId}`, requiredRevision);
  }
  if (parsed.kind === 'entity-node' && !parsed.path) {
    return semantic.nodeDelete(ctx, { nodeIds: [parsed.ownerId], expectedRevision: input.expectedRevision, intent: input.intent });
  }
  if (parsed.kind === 'entity-material' && !parsed.path) {
    const mat = ctx.bus.project.materials[parsed.ownerId];
    if (!mat) return failure(ctx, 'NOT_FOUND', `Material not found: ${parsed.ownerId}`);
    if (!permissions(ctx).delete) return failure(ctx, 'PERMISSION_DENIED', 'Agent deletion is disabled');
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand('RemoveMaterial', { materialId: parsed.ownerId, savedMaterial: structuredClone(mat) }, txId, { kind: 'webmcp-agent', name: 'WebMCP Agent' }, input.intent ?? 'Remove material', 'webmcp'),
    ], `Removed material ${parsed.ownerId}`, requiredRevision);
  }
  if (parsed.kind === 'entity-shader' && !parsed.path) {
    const shader = ctx.bus.project.shaders[parsed.ownerId];
    if (!shader) return failure(ctx, 'NOT_FOUND', `Shader not found: ${parsed.ownerId}`);
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand('RemoveShader', { shaderId: parsed.ownerId, savedShader: structuredClone(shader) }, txId, { kind: 'webmcp-agent', name: 'WebMCP Agent' }, input.intent ?? 'Remove shader', 'webmcp'),
    ], `Removed shader ${parsed.ownerId}`, requiredRevision);
  }
  if (parsed.kind === 'entity-variant' && !parsed.path) {
    const variant = ctx.bus.project.variants[parsed.ownerId];
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand('RemoveVariant', { variantId: parsed.ownerId, savedVariant: structuredClone(variant) }, txId, { kind: 'webmcp-agent', name: 'WebMCP Agent' }, input.intent ?? 'Remove variant', 'webmcp'),
    ], `Removed variant ${parsed.ownerId}`, requiredRevision);
  }
  if (parsed.kind === 'entity-behavior' && !parsed.path) {
    const prev = ctx.bus.project.behaviors[parsed.ownerId];
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand(
        'SetProjectProperty',
        { path: `behaviors.${parsed.ownerId}`, value: undefined, previousValue: structuredClone(prev) },
        txId,
        { kind: 'webmcp-agent', name: 'WebMCP Agent' },
        input.intent ?? 'Remove behavior',
        'webmcp',
      ),
    ], `Removed behavior ${parsed.ownerId}`, requiredRevision);
  }
  if (parsed.kind === 'entity-composition' && !parsed.path) {
    const comp = ctx.bus.project.compositions[parsed.ownerId];
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand('RemoveComposition', { compositionId: parsed.ownerId, savedComposition: structuredClone(comp) }, txId, { kind: 'webmcp-agent', name: 'WebMCP Agent' }, input.intent ?? 'Remove composition', 'webmcp'),
    ], `Removed composition ${parsed.ownerId}`, requiredRevision);
  }
  if (parsed.kind === 'entity-quality-profile' && !parsed.path) {
    const profile = ctx.bus.project.renderSettings.qualityProfiles[parsed.ownerId];
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand('RemoveQualityProfile', { profileId: parsed.ownerId, savedProfile: structuredClone(profile) }, txId, { kind: 'webmcp-agent', name: 'WebMCP Agent' }, input.intent ?? 'Remove quality profile', 'webmcp'),
    ], `Removed quality profile ${parsed.ownerId}`, requiredRevision);
  }
  if (parsed.kind === 'entity-render-preset' && !parsed.path) {
    const preset = ctx.bus.project.renderPresets[parsed.ownerId];
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand('RemoveRenderPreset', { presetId: parsed.ownerId, savedPreset: structuredClone(preset) }, txId, { kind: 'webmcp-agent', name: 'WebMCP Agent' }, input.intent ?? 'Remove render preset', 'webmcp'),
    ], `Removed render preset ${parsed.ownerId}`, requiredRevision);
  }
  if (parsed.kind === 'entity-aov') {
    const target = parsed.ownerId === '__render__' ? 'render' : 'preset';
    const txId = createId('transaction');
    const list = target === 'render'
      ? ctx.bus.project.renderSettings.aovs
      : ctx.bus.project.renderPresets[parsed.ownerId]?.aovs;
    const saved = list?.find((a) => a.id === parsed.path);
    return tx(ctx, input, [
      makeCommand(
        'RemoveAov',
        { aovId: parsed.path, target, presetId: target === 'preset' ? parsed.ownerId : undefined, savedAov: structuredClone(saved) },
        txId,
        { kind: 'webmcp-agent', name: 'WebMCP Agent' },
        input.intent ?? 'Remove AOV',
        'webmcp',
      ),
    ], `Removed AOV ${parsed.path}`, true);
  }
  if (parsed.kind === 'entity-render-job' && !parsed.path) {
    const job = ctx.bus.project.renderJobs[parsed.ownerId];
    if (ctx.renderQueue && job && !['complete', 'failed', 'cancelled'].includes(job.status)) {
      return semantic.renderCancel(ctx, { jobId: parsed.ownerId, expectedRevision: input.expectedRevision ?? ctx.bus.getRevision(), intent: input.intent });
    }
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand('RemoveRenderJob', { jobId: parsed.ownerId, savedJob: structuredClone(job) }, txId, { kind: 'webmcp-agent', name: 'WebMCP Agent' }, input.intent ?? 'Remove render job', 'webmcp'),
    ], `Removed render job ${parsed.ownerId}`, true);
  }
  if (parsed.kind === 'entity-breakpoint') {
    const current = ctx.bus.project.responsive?.breakpoints ?? [];
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand(
        'SetProjectProperty',
        {
          path: 'responsive.breakpoints',
          value: current.filter((bp) => bp.id !== parsed.path),
          previousValue: structuredClone(current),
        },
        txId,
        { kind: 'webmcp-agent', name: 'WebMCP Agent' },
        input.intent ?? 'Remove breakpoint',
        'webmcp',
      ),
    ], `Removed breakpoint ${parsed.path}`);
  }
  if (parsed.kind === 'entity-sequence' && !parsed.path) {
    return semantic.timelineDelete(ctx, { kind: 'sequence', id: parsed.ownerId, expectedRevision: input.expectedRevision, intent: input.intent });
  }
  if (parsed.kind === 'entity-track' && !parsed.path) {
    return semantic.timelineDelete(ctx, { kind: 'track', id: parsed.ownerId, expectedRevision: input.expectedRevision, intent: input.intent });
  }
  if (parsed.kind === 'entity-clip') {
    return semantic.timelineDelete(ctx, { kind: 'clip', id: parsed.path, parentId: parsed.ownerId, expectedRevision: input.expectedRevision, intent: input.intent });
  }
  if (parsed.kind === 'entity-marker') {
    return semantic.timelineDelete(ctx, { kind: 'marker', id: parsed.path, parentId: parsed.ownerId, expectedRevision: input.expectedRevision, intent: input.intent });
  }
  if (parsed.kind === 'entity-event') {
    const track = ctx.bus.project.tracks[parsed.ownerId];
    const event = track?.events?.find((e) => (e.id ?? `${e.time}-${e.name}`) === parsed.path);
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand('RemoveTrackEvent', { trackId: parsed.ownerId, eventId: parsed.path, savedEvent: structuredClone(event) }, txId, { kind: 'webmcp-agent', name: 'WebMCP Agent' }, input.intent ?? 'Remove event', 'webmcp'),
    ], `Removed event ${parsed.path}`, true);
  }
  if (parsed.kind === 'entity-keyframe') {
    const track = ctx.bus.project.tracks[parsed.ownerId];
    if (!track) return failure(ctx, 'NOT_FOUND', `Track not found: ${parsed.ownerId}`);
    const index = Number(parsed.path);
    const keyframes = track.keyframes.filter((_, i) => i !== index);
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand('SetKeyframes', { trackId: track.id, keyframes, previousKeyframes: track.keyframes }, txId, { kind: 'webmcp-agent', name: 'WebMCP Agent' }, input.intent ?? 'Remove keyframe', 'webmcp'),
    ], `Removed keyframe ${index}`, true);
  }
  if (parsed.kind === 'public-contract') {
    if (parsed.ownerId === 'properties') {
      const saved = ctx.bus.project.publicContract.properties[parsed.path];
      const txId = createId('transaction');
      return tx(ctx, input, [
        makeCommand('RemovePublicProperty', { publicName: parsed.path, savedProperty: structuredClone(saved) }, txId, { kind: 'webmcp-agent', name: 'WebMCP Agent' }, input.intent ?? 'Remove public property', 'webmcp'),
      ], `Removed public property ${parsed.path}`);
    }
    return semantic.publicContractSet(ctx, {
      kind: parsed.ownerId === 'events' ? 'event' : 'timeline',
      name: parsed.path,
      exposed: false,
      expectedRevision: input.expectedRevision,
      intent: input.intent,
    });
  }
  if (parsed.kind === 'material-texture') {
    const txId = createId('transaction');
    return tx(ctx, input, [
      makeCommand(
        'SetMaterialTexture',
        {
          materialId: parsed.ownerId,
          slot: parsed.path,
          binding: null,
          previousBinding: ctx.bus.project.materials[parsed.ownerId]?.textures?.[parsed.path],
        },
        txId,
        { kind: 'webmcp-agent', name: 'WebMCP Agent' },
        input.intent ?? 'Remove texture binding',
        'webmcp',
      ),
    ], `Removed texture ${parsed.path}`);
  }
  return failure(ctx, 'VALIDATION_FAILED', `Component kind cannot be removed: ${parsed.kind}`);
}

function descriptorRequiresRevision(descriptor: ComponentDescriptor | undefined): boolean {
  return Boolean(descriptor?.validationRules.requiresRevision);
}

export function resolveSelectionNodeIds(componentIds: string[]): string[] {
  return componentIds.map((componentId) => {
    const parsed = parseComponentId(componentId);
    if (!parsed) return componentId;
    if (parsed.kind === 'entity-node' && !parsed.path) return parsed.ownerId;
    if (parsed.kind === 'property' || parsed.kind === 'node-component') return parsed.ownerId;
    return parsed.ownerId;
  });
}

export { findComponentDescriptor };

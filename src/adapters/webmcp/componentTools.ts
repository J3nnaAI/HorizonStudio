/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolResult } from '../../core/types';
import type { WebMcpContext, WebMcpPermissions } from './tools';
import {
  buildCapabilitiesMetadata,
  findComponentDescriptor,
  queryComponentsPaginated,
  toPublicDescriptor,
  type ComponentQuery,
} from './componentCatalog';
import {
  executeComponentRemove,
  executeComponentUpdate,
  resolveSelectionNodeIds,
} from './componentOperations';
import { enrichActionInspect, type ActionId } from './componentActions';
import { buildApplicationGuide } from './applicationGuide';
import { WEBMCP_TOOL_VERSION } from './semanticTools';
import {
  executePublicProjectTool,
  PUBLIC_PROJECT_TOOL_NAMES,
  type PublicProjectToolName,
} from './projectTools';

export const PUBLIC_COMPONENT_TOOL_NAMES = [
  'listComponents',
  'findComponents',
  'inspectComponent',
  'selectedComponent',
  'selectComponent',
  'updateComponent',
  'removeComponent',
] as const;

export const PUBLIC_WEBMCP_TOOL_NAMES = [
  'about',
  ...PUBLIC_PROJECT_TOOL_NAMES,
  ...PUBLIC_COMPONENT_TOOL_NAMES,
] as const;

/** Internal debug aliases — not advertised to MCP hosts. */
export const INTERNAL_COMPONENT_TOOL_ALIASES: Record<string, typeof PUBLIC_COMPONENT_TOOL_NAMES[number]> = {
  horizon_list_components: 'listComponents',
  horizon_find_components: 'findComponents',
  horizon_inspect_component: 'inspectComponent',
  horizon_selected_component: 'selectedComponent',
  horizon_select_component: 'selectComponent',
  horizon_update_component: 'updateComponent',
  horizon_remove_component: 'removeComponent',
};

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

const MANDATORY_DESCRIPTOR_KEYS = [
  'id', 'kind', 'componentType', 'ownerId', 'path', 'label', 'help', 'dataType',
  'currentValue', 'rangeMin', 'rangeMax', 'unit', 'animatable', 'mutable',
  'registryScope', 'category', 'validationFunction', 'validationRules',
] as const;

export function assertPublicDescriptorShape(descriptor: Record<string, unknown>): void {
  for (const key of MANDATORY_DESCRIPTOR_KEYS) {
    if (!(key in descriptor)) throw new Error(`Missing descriptor key: ${key}`);
  }
}

export function about(ctx: WebMcpContext): ToolResult {
  return success(ctx, 'Horizon Studio application and WebMCP guide', {
    data: buildApplicationGuide(ctx),
  });
}

export function listComponents(
  ctx: WebMcpContext,
  input: ComponentQuery = {},
): ToolResult {
  const page = queryComponentsPaginated(ctx.bus.project, permissions(ctx), input);
  for (const component of page.components) assertPublicDescriptorShape(component as unknown as Record<string, unknown>);
  return success(ctx, `Listed ${page.components.length} components`, {
    data: {
      metadata: buildCapabilitiesMetadata(ctx),
      ...page,
    },
  });
}

export function findComponents(
  ctx: WebMcpContext,
  input: ComponentQuery = {},
): ToolResult {
  const page = queryComponentsPaginated(ctx.bus.project, permissions(ctx), input);
  for (const component of page.components) assertPublicDescriptorShape(component as unknown as Record<string, unknown>);
  return success(ctx, `Found ${page.components.length} components`, {
    data: page,
  });
}

export function inspectComponent(
  ctx: WebMcpContext,
  input: { componentId: string; value?: unknown },
): ToolResult {
  if (!input.componentId?.trim()) return failure(ctx, 'INVALID_INPUT', 'componentId is required');
  const descriptor = findComponentDescriptor(ctx.bus.project, permissions(ctx), input.componentId);
  if (!descriptor) return failure(ctx, 'NOT_FOUND', `Component not found: ${input.componentId}`);
  const payload = toPublicDescriptor(descriptor);
  if (descriptor.kind === 'action' && descriptor.componentType === 'action-inspect') {
    payload.currentValue = enrichActionInspect(ctx, descriptor.ownerId as ActionId, input.value);
  }
  assertPublicDescriptorShape(payload as unknown as Record<string, unknown>);
  return success(ctx, 'Component inspected', { data: payload });
}

export function selectedComponent(ctx: WebMcpContext): ToolResult {
  const ids = ctx.getSelection();
  const policy = permissions(ctx);
  const components = ids.flatMap((nodeId) => {
    const related = queryComponentsPaginated(ctx.bus.project, policy, { ownerId: nodeId, limit: 200 });
    const entity = related.components.find((c) => c.id === `entity-node/${nodeId}`);
    const ordered = entity ? [entity, ...related.components.filter((c) => c.id !== entity.id)] : related.components;
    return ordered;
  });
  for (const component of components) assertPublicDescriptorShape(component as unknown as Record<string, unknown>);
  return success(ctx, 'Selection inspected', {
    data: { selection: ids, count: components.length, components },
  });
}

export function selectComponent(
  ctx: WebMcpContext,
  input: {
    componentIds?: string[];
    mode?: 'replace' | 'add' | 'remove' | 'clear';
  },
): ToolResult {
  const mode = input.mode ?? 'replace';
  if (mode === 'clear') {
    ctx.setSelection([]);
    return success(ctx, 'Selection cleared', { data: { selection: [], mode } });
  }
  if (!Array.isArray(input.componentIds) || input.componentIds.length === 0) {
    return failure(ctx, 'INVALID_INPUT', 'componentIds is required unless mode is clear');
  }
  const resolved = [...new Set(resolveSelectionNodeIds(input.componentIds))]
    .filter((id) => Boolean(ctx.bus.project.nodes[id]));
  const current = ctx.getSelection();
  let next: string[];
  if (mode === 'add') next = [...new Set([...current, ...resolved])];
  else if (mode === 'remove') next = current.filter((id) => !resolved.includes(id));
  else next = resolved;
  ctx.setSelection(next);
  return success(ctx, `Selection ${mode}`, { changed: next, data: { selection: next, mode } });
}

export async function updateComponent(
  ctx: WebMcpContext,
  input: MutatingInput & {
    componentId: string;
    value?: unknown;
    patch?: Record<string, unknown>;
    properties?: Record<string, unknown>;
  },
): Promise<ToolResult> {
  if (!input.componentId?.trim()) return failure(ctx, 'INVALID_INPUT', 'componentId is required');
  if (input.expectedRevision === undefined) {
    return failure(ctx, 'REVISION_REQUIRED', 'expectedRevision is required for every persistent component edit');
  }
  if (input.expectedRevision !== ctx.bus.getRevision()) {
    return failure(ctx, 'STALE_REVISION', `Expected revision ${input.expectedRevision}, current revision is ${ctx.bus.getRevision()}`);
  }

  if (input.componentId.startsWith('action/')) {
    const descriptor = findComponentDescriptor(ctx.bus.project, permissions(ctx), input.componentId);
    if (!descriptor) return failure(ctx, 'NOT_FOUND', `Component not found: ${input.componentId}`);
    if (input.operation && input.operation !== 'invoke') {
      return failure(ctx, 'INVALID_INPUT', 'Action components require operation invoke');
    }
    return executeComponentUpdate(ctx, { ...input, operation: 'invoke' }, descriptor);
  }

  if (input.componentId.startsWith('factory/')) {
    return executeComponentUpdate(ctx, input, {
      id: input.componentId,
      kind: 'factory',
      componentType: input.componentId.slice('factory/'.length),
      ownerId: input.componentId.slice('factory/'.length),
      path: '',
      label: null,
      help: null,
      dataType: 'factory',
      currentValue: null,
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: true,
      registryScope: null,
      category: 'factory',
      validationFunction: `factory.create:${input.componentId.slice('factory/'.length)}`,
      validationRules: {
        enumValues: null,
        dependsOn: null,
        step: null,
        requiresRevision: false,
        requiresPermission: null,
        requiresConfirmation: null,
        allowedOperations: ['create', 'append', 'upsert'],
      },
    });
  }

  const descriptor = findComponentDescriptor(ctx.bus.project, permissions(ctx), input.componentId);
  if (!descriptor) return failure(ctx, 'NOT_FOUND', `Component not found: ${input.componentId}`);
  if (
    descriptor.validationRules.requiresPermission
    && !permissions(ctx)[descriptor.validationRules.requiresPermission]
  ) {
    return failure(ctx, 'PERMISSION_DENIED', `${descriptor.validationRules.requiresPermission} permission is required`);
  }
  if (
    !descriptor.mutable
    && input.operation !== 'create'
    && input.operation !== 'invoke'
    && descriptor.kind !== 'action'
  ) {
    return failure(ctx, 'VALIDATION_FAILED', `Component is not mutable: ${input.componentId}`);
  }
  return executeComponentUpdate(ctx, input, descriptor);
}

export function removeComponent(
  ctx: WebMcpContext,
  input: MutatingInput & { componentId: string },
): ToolResult {
  if (!input.componentId?.trim()) return failure(ctx, 'INVALID_INPUT', 'componentId is required');
  const descriptor = findComponentDescriptor(ctx.bus.project, permissions(ctx), input.componentId);
  if (descriptor && !descriptor.mutable) {
    return failure(ctx, 'VALIDATION_FAILED', `Component is not removable: ${input.componentId}`);
  }
  return executeComponentRemove(ctx, input);
}

export function resolvePublicToolName(name: string): typeof PUBLIC_WEBMCP_TOOL_NAMES[number] | null {
  if ((PUBLIC_WEBMCP_TOOL_NAMES as readonly string[]).includes(name)) return name as typeof PUBLIC_WEBMCP_TOOL_NAMES[number];
  return INTERNAL_COMPONENT_TOOL_ALIASES[name] ?? null;
}

export function isPublicProjectToolName(name: string): name is PublicProjectToolName {
  return (PUBLIC_PROJECT_TOOL_NAMES as readonly string[]).includes(name);
}

export function executePublicComponentTool(
  ctx: WebMcpContext,
  name: string,
  input: Record<string, unknown> = {},
): ToolResult | Promise<ToolResult> {
  const resolved = resolvePublicToolName(name);
  if (resolved && isPublicProjectToolName(resolved)) {
    return executePublicProjectTool(ctx, resolved, input);
  }
  switch (resolved) {
    case 'about':
      return about(ctx);
    case 'listComponents':
      return listComponents(ctx, input);
    case 'findComponents':
      return findComponents(ctx, input);
    case 'inspectComponent':
      return inspectComponent(ctx, input as { componentId: string; value?: unknown });
    case 'selectedComponent':
      return selectedComponent(ctx);
    case 'selectComponent':
      return selectComponent(ctx, input as { componentIds?: string[]; mode?: 'replace' | 'add' | 'remove' | 'clear' });
    case 'updateComponent':
      return updateComponent(ctx, input as never);
    case 'removeComponent':
      return removeComponent(ctx, input as never);
    default:
      return failure(ctx, 'NOT_FOUND', `Unknown public component tool: ${name}`);
  }
}

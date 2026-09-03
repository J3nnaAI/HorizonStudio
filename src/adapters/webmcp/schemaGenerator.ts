/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { propertyRegistry } from '../../core/propertyRegistry';
import type { RegistryEntry } from '../../core/propertyRegistry';

export interface GeneratedToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  scope: string;
}

function entryToJsonSchema(entry: RegistryEntry): Record<string, unknown> {
  const base: Record<string, unknown> = { description: entry.description ?? entry.label ?? entry.path };
  switch (entry.type) {
    case 'boolean':
      return { type: 'boolean', ...base };
    case 'integer':
      return { type: 'integer', minimum: entry.min, maximum: entry.max, ...base };
    case 'number':
      return { type: 'number', minimum: entry.min, maximum: entry.max, ...base };
    case 'string':
    case 'color':
    case 'asset':
    case 'reference':
      return { type: 'string', ...base };
    case 'enum':
      return { type: 'string', enum: entry.choices?.map((c) => c.value), ...base };
    case 'vec2':
    case 'vec3':
    case 'vec4':
    case 'quaternion':
      return {
        type: 'array',
        items: { type: 'number' },
        minItems: entry.type === 'vec2' ? 2 : entry.type === 'vec3' || entry.type === 'quaternion' ? (entry.type === 'quaternion' ? 4 : 3) : 4,
        maxItems: entry.type === 'vec2' ? 2 : entry.type === 'vec3' ? 3 : 4,
        ...base,
      };
    default:
      return { type: 'string', ...base };
  }
}

export function generateScopeToolSchemas(scopeId: string, prefix: string): GeneratedToolSchema[] {
  const scope = propertyRegistry.getScope(scopeId);
  if (!scope) return [];
  return scope.entries.map((entry) => ({
    name: `${prefix}_${entry.path.replace(/\./g, '_')}`,
    description: `Set ${scope.label} ${entry.label ?? entry.path}`,
    scope: scopeId,
    inputSchema: {
      type: 'object',
      properties: {
        ownerId: { type: 'string' },
        compositionId: { type: 'string' },
        presetId: { type: 'string' },
        value: entryToJsonSchema(entry),
      },
      required: ['value'],
      additionalProperties: false,
    },
  }));
}

export function generateAllRegistrySchemas(): GeneratedToolSchema[] {
  const scopes = [
    ['environment', 'horizon_environment'],
    ['render', 'horizon_render'],
    ['camera', 'horizon_camera'],
    ['light', 'horizon_light'],
    ['output', 'horizon_output'],
    ['quality', 'horizon_quality'],
  ] as const;
  return scopes.flatMap(([scope, prefix]) => generateScopeToolSchemas(scope, prefix));
}

export function registryDiscoveryMetadata() {
  return propertyRegistry.listScopes().map((scope) => ({
    id: scope.id,
    label: scope.label,
    description: scope.description,
    propertyCount: scope.entries.length,
    properties: scope.entries.map((entry) => ({
      path: entry.path,
      type: entry.type,
      label: entry.label,
      unit: entry.unit,
      animatable: entry.animatable,
      runtimeMutable: entry.runtimeMutable,
      min: entry.min,
      max: entry.max,
      choices: entry.choices,
      backends: entry.backends,
      dependsOn: entry.dependsOn,
    })),
  }));
}

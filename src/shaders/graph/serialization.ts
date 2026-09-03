/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_SHADER_GRAPH_LIMITS,
  type ShaderDiagnostic,
  type ShaderGraph,
  type ShaderGraphLimits,
} from './types';
import {
  ShaderGraphValidationError,
  assertValidShaderGraph,
  validateShaderGraph,
} from './validation';

export interface ShaderGraphSerializationOptions {
  pretty?: boolean;
  validate?: boolean;
  limits?: Partial<ShaderGraphLimits>;
}

export interface ShaderGraphParseResult {
  ok: boolean;
  graph?: ShaderGraph;
  diagnostics: ShaderDiagnostic[];
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function sortedRecord<T>(record: Record<string, T> | undefined): Record<string, T> | undefined {
  if (!record) return undefined;
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function canonicalGraph(graph: ShaderGraph): ShaderGraph {
  return {
    schemaVersion: graph.schemaVersion,
    id: graph.id,
    version: graph.version,
    domain: graph.domain,
    nodes: [...graph.nodes]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((node) => ({
        id: node.id,
        kind: node.kind,
        ...(node.label !== undefined ? { label: node.label } : {}),
        ...(node.valueType !== undefined ? { valueType: node.valueType } : {}),
        ...(node.value !== undefined
          ? { value: Array.isArray(node.value) ? [...node.value] : node.value }
          : {}),
        ...(node.parameter !== undefined ? { parameter: node.parameter } : {}),
        ...(node.textureSlot !== undefined ? { textureSlot: node.textureSlot } : {}),
        ...(node.swizzle !== undefined ? { swizzle: node.swizzle } : {}),
        ...(node.inputDefaults
          ? { inputDefaults: sortedRecord(node.inputDefaults) }
          : {}),
        ...(node.metadata ? { metadata: sortedRecord(node.metadata) } : {}),
      })),
    edges: [...graph.edges]
      .sort((a, b) => {
        const aKey = `${a.to.nodeId}.${a.to.port}:${a.from.nodeId}.${a.from.port}:${a.id ?? ''}`;
        const bKey = `${b.to.nodeId}.${b.to.port}:${b.from.nodeId}.${b.from.port}:${b.id ?? ''}`;
        return aKey.localeCompare(bKey);
      })
      .map((edge) => ({
        ...(edge.id !== undefined ? { id: edge.id } : {}),
        from: { nodeId: edge.from.nodeId, port: edge.from.port },
        to: { nodeId: edge.to.nodeId, port: edge.to.port },
      })),
    ...(graph.outputs
      ? {
          outputs: Object.fromEntries(
            Object.entries(graph.outputs)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, endpoint]) => [
                name,
                { nodeId: endpoint.nodeId, port: endpoint.port },
              ]),
          ),
        }
      : {}),
    ...(graph.metadata ? { metadata: sortedRecord(graph.metadata) } : {}),
  };
}

function containsForbiddenKey(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => FORBIDDEN_KEYS.has(key) || containsForbiddenKey(child),
  );
}

export function serializeShaderGraph(
  graph: ShaderGraph,
  options: ShaderGraphSerializationOptions = {},
): string {
  if (options.validate !== false) assertValidShaderGraph(graph, options.limits);
  const serialized = JSON.stringify(canonicalGraph(graph), null, options.pretty ? 2 : undefined);
  const maxBytes = { ...DEFAULT_SHADER_GRAPH_LIMITS, ...options.limits }.maxSerializedBytes;
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
    throw new ShaderGraphValidationError(
      [
        {
          severity: 'error',
          phase: 'validation',
          code: 'GRAPH_SIZE_EXCEEDED',
          message: `Serialized graph exceeds ${maxBytes} bytes`,
        },
      ],
      'Could not serialize shader graph',
    );
  }
  return serialized;
}

export function tryDeserializeShaderGraph(
  source: string,
  options: Omit<ShaderGraphSerializationOptions, 'pretty'> = {},
): ShaderGraphParseResult {
  const maxBytes = {
    ...DEFAULT_SHADER_GRAPH_LIMITS,
    ...options.limits,
  }.maxSerializedBytes;
  if (new TextEncoder().encode(source).byteLength > maxBytes) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: 'error',
          phase: 'parse',
          code: 'GRAPH_SIZE_EXCEEDED',
          message: `Serialized graph exceeds ${maxBytes} bytes`,
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const position = /position\s+(\d+)/i.exec(message);
    const offset = position ? Number(position[1]) : undefined;
    const prefix = offset === undefined ? '' : source.slice(0, offset);
    return {
      ok: false,
      diagnostics: [
        {
          severity: 'error',
          phase: 'parse',
          code: 'JSON_INVALID',
          message,
          ...(offset === undefined
            ? {}
            : {
                line: prefix.split('\n').length,
                column: prefix.length - prefix.lastIndexOf('\n'),
              }),
        },
      ],
    };
  }

  if (containsForbiddenKey(parsed)) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: 'error',
          phase: 'parse',
          code: 'FORBIDDEN_OBJECT_KEY',
          message: 'Graph contains a prototype-mutating object key',
        },
      ],
    };
  }

  const graph = parsed as ShaderGraph;
  if (options.validate === false) return { ok: true, graph, diagnostics: [] };
  const validation = validateShaderGraph(graph, options.limits);
  return {
    ok: validation.valid,
    graph: validation.valid ? canonicalGraph(graph) : undefined,
    diagnostics: validation.diagnostics,
  };
}

export function deserializeShaderGraph(
  source: string,
  options: Omit<ShaderGraphSerializationOptions, 'pretty'> = {},
): ShaderGraph {
  const result = tryDeserializeShaderGraph(source, options);
  if (!result.ok || !result.graph) {
    throw new ShaderGraphValidationError(result.diagnostics, 'Could not deserialize shader graph');
  }
  return result.graph;
}

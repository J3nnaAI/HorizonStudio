/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ShaderDef } from '../../core/types';

export const SHADER_GRAPH_SCHEMA_VERSION = 1 as const;

export type ShaderGraphDomain =
  | 'surface'
  | 'vertex'
  | 'deformation'
  | 'post'
  | 'transition'
  | 'field'
  | 'field-response';

export type ShaderValueType =
  | 'float'
  | 'int'
  | 'bool'
  | 'vec2'
  | 'vec3'
  | 'vec4'
  | 'color'
  | 'sampler2D';

export type ShaderGraphNodeKind =
  | 'constant'
  | 'parameter'
  | 'time'
  | 'uv'
  | 'screen-uv'
  | 'world-position'
  | 'object-position'
  | 'surface-normal'
  | 'view-direction'
  | 'scene-color'
  | 'transition-from'
  | 'transition-to'
  | 'depth'
  | 'texture-sample'
  | 'add'
  | 'subtract'
  | 'multiply'
  | 'divide'
  | 'min'
  | 'max'
  | 'power'
  | 'dot'
  | 'normalize'
  | 'absolute'
  | 'sine'
  | 'one-minus'
  | 'clamp'
  | 'saturate'
  | 'mix'
  | 'color-mix'
  | 'smoothstep'
  | 'remap'
  | 'fresnel'
  | 'noise'
  | 'fbm'
  | 'combine'
  | 'swizzle'
  | 'horizon-distance'
  | 'horizon-field'
  | 'micro-roughness'
  | 'graphite-base'
  | 'edge-response'
  | 'distance-fade'
  | 'pbr-output'
  | 'emission-output'
  | 'vertex-output'
  | 'post-output'
  | 'transition-output'
  | 'field-output';

export type ShaderLiteral =
  | number
  | boolean
  | [number, number]
  | [number, number, number]
  | [number, number, number, number];

export interface ShaderGraphNode {
  id: string;
  kind: ShaderGraphNodeKind;
  label?: string;
  valueType?: ShaderValueType;
  value?: ShaderLiteral;
  /** Parameter path used by parameter nodes. */
  parameter?: string;
  /** Texture slot used by texture-sample nodes. */
  textureSlot?: string;
  /** Component mask used by swizzle nodes. */
  swizzle?: string;
  /** Defaults for ports that are not connected. */
  inputDefaults?: Record<string, ShaderLiteral>;
  metadata?: Record<string, string | number | boolean>;
}

export interface ShaderGraphEndpoint {
  nodeId: string;
  port: string;
}

export interface ShaderGraphEdge {
  id?: string;
  from: ShaderGraphEndpoint;
  to: ShaderGraphEndpoint;
}

export interface ShaderGraph {
  schemaVersion: typeof SHADER_GRAPH_SCHEMA_VERSION;
  id: string;
  version: number;
  domain: ShaderGraphDomain;
  nodes: ShaderGraphNode[];
  edges: ShaderGraphEdge[];
  /**
   * Semantic graph outputs. Output-node kinds are also supported, which is
   * useful to node editors that represent the output as a visible node.
   */
  outputs?: Record<string, ShaderGraphEndpoint>;
  metadata?: Record<string, string | number | boolean>;
}

export interface ShaderGraphLimits {
  maxNodes: number;
  maxEdges: number;
  maxDepth: number;
  maxParameters: number;
  maxTextures: number;
  maxIdentifierLength: number;
  maxSerializedBytes: number;
}

export const DEFAULT_SHADER_GRAPH_LIMITS: Readonly<ShaderGraphLimits> = Object.freeze({
  maxNodes: 128,
  maxEdges: 512,
  maxDepth: 48,
  maxParameters: 64,
  maxTextures: 16,
  maxIdentifierLength: 80,
  maxSerializedBytes: 256 * 1024,
});

export type ShaderDiagnosticSeverity = 'error' | 'warning' | 'info';
export type ShaderDiagnosticPhase =
  | 'trust'
  | 'parse'
  | 'validation'
  | 'compile'
  | 'runtime';

export interface ShaderDiagnostic {
  severity: ShaderDiagnosticSeverity;
  phase: ShaderDiagnosticPhase;
  code: string;
  message: string;
  path?: string;
  nodeId?: string;
  edgeId?: string;
  line?: number;
  column?: number;
}

export interface ShaderGraphValidationResult {
  valid: boolean;
  diagnostics: ShaderDiagnostic[];
  nodeTypes: ReadonlyMap<string, ShaderValueType>;
  topologicalOrder: readonly string[];
  depth: number;
}

/**
 * Persistence extension for ShaderDef. It intentionally lives outside the
 * canonical core type until the project schema grows graph-native domains.
 */
export type GraphShaderDefinition = ShaderDef & {
  graph?: ShaderGraph;
  graphDomain?: ShaderGraphDomain;
  graphVersion?: number;
  graphValid?: boolean;
  graphError?: string;
  graphDiagnostics?: ShaderDiagnostic[];
  graphLastKnownGood?: string;
};

export function asGraphShaderDefinition(shader: ShaderDef): GraphShaderDefinition {
  return shader as GraphShaderDefinition;
}

export function graphDomainForShader(shader: ShaderDef): ShaderGraphDomain {
  const extended = asGraphShaderDefinition(shader);
  const domain = extended.graph?.domain ?? extended.graphDomain ?? shader.domain;
  return domain === 'volume' ? 'field' : domain;
}

export function attachShaderGraph<T extends ShaderDef>(
  shader: T,
  graph: ShaderGraph,
): T & GraphShaderDefinition {
  const extended = shader as T & GraphShaderDefinition;
  extended.graph = graph;
  extended.graphDomain = graph.domain;
  extended.graphVersion = graph.version;
  return extended;
}

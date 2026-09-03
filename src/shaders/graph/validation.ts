/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_SHADER_GRAPH_LIMITS,
  SHADER_GRAPH_SCHEMA_VERSION,
  type ShaderDiagnostic,
  type ShaderGraph,
  type ShaderGraphLimits,
  type ShaderGraphNode,
  type ShaderGraphValidationResult,
  type ShaderLiteral,
  type ShaderValueType,
} from './types';
import {
  REQUIRED_GRAPH_OUTPUT_BY_DOMAIN,
  SHADER_NODE_SPECS,
  TERMINAL_KIND_BY_DOMAIN,
  type ShaderPortConstraint,
} from './nodeRegistry';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const VALUE_TYPES = new Set<ShaderValueType>([
  'float',
  'int',
  'bool',
  'vec2',
  'vec3',
  'vec4',
  'color',
  'sampler2D',
]);

const REQUIRED_INPUTS: Readonly<Record<string, readonly string[]>> = {
  add: ['a', 'b'],
  subtract: ['a', 'b'],
  multiply: ['a', 'b'],
  divide: ['a', 'b'],
  min: ['a', 'b'],
  max: ['a', 'b'],
  power: ['a', 'b'],
  dot: ['a', 'b'],
  normalize: ['value'],
  absolute: ['value'],
  sine: ['value'],
  'one-minus': ['value'],
  clamp: ['value'],
  saturate: ['value'],
  mix: ['a', 'b', 'factor'],
  'color-mix': ['a', 'b', 'factor'],
  smoothstep: ['edge0', 'edge1', 'value'],
  remap: ['value', 'inMin', 'inMax', 'outMin', 'outMax'],
  fresnel: ['normal', 'view'],
  swizzle: ['value'],
  'horizon-distance': ['position'],
  'horizon-field': ['distance'],
  'micro-roughness': ['roughness', 'noise'],
  'graphite-base': ['baseColor'],
  'edge-response': ['fresnel'],
  'distance-fade': ['distance'],
  'post-output': ['color'],
  'transition-output': ['color'],
  'field-output': ['response'],
};

function diagnostic(
  diagnostics: ShaderDiagnostic[],
  code: string,
  message: string,
  details: Partial<ShaderDiagnostic> = {},
): void {
  diagnostics.push({
    severity: 'error',
    phase: 'validation',
    code,
    message,
    ...details,
  });
}

function isFiniteLiteral(value: ShaderLiteral | undefined): boolean {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= 4 &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

function literalMatches(type: ShaderValueType, value: ShaderLiteral | undefined): boolean {
  if (type === 'bool') return typeof value === 'boolean';
  if (type === 'float' || type === 'int') return typeof value === 'number';
  if (type === 'sampler2D') return value === undefined;
  if (!Array.isArray(value)) return false;
  const dimensions = type === 'vec2' ? 2 : type === 'vec4' ? 4 : 3;
  return value.length === dimensions;
}

function normalizeValueType(type: ShaderValueType): ShaderValueType {
  return type === 'color' ? 'vec3' : type;
}

function isVector(type: ShaderValueType): boolean {
  const normalized = normalizeValueType(type);
  return normalized === 'vec2' || normalized === 'vec3' || normalized === 'vec4';
}

function isNumeric(type: ShaderValueType): boolean {
  return type === 'float' || type === 'int';
}

function accepts(constraint: ShaderPortConstraint, actual: ShaderValueType): boolean {
  if (constraint === 'any') return true;
  if (constraint === 'numeric') return isNumeric(actual);
  if (constraint === 'numeric-or-vector') return isNumeric(actual) || isVector(actual);
  if (constraint === 'vector') return isVector(actual);
  const expected = normalizeValueType(constraint);
  const normalizedActual = normalizeValueType(actual);
  if (expected === normalizedActual) return true;
  return expected === 'float' && normalizedActual === 'int';
}

function fixedOutputType(constraint: ShaderPortConstraint): ShaderValueType | undefined {
  if (
    constraint !== 'any' &&
    constraint !== 'numeric' &&
    constraint !== 'numeric-or-vector' &&
    constraint !== 'vector'
  ) {
    return constraint;
  }
  return undefined;
}

function nodeSpec(kind: unknown) {
  return typeof kind === 'string' &&
    Object.prototype.hasOwnProperty.call(SHADER_NODE_SPECS, kind)
    ? SHADER_NODE_SPECS[kind as keyof typeof SHADER_NODE_SPECS]
    : undefined;
}

function inferNodeType(
  node: ShaderGraphNode,
  sourceType: (port: string) => ShaderValueType | undefined,
): ShaderValueType | undefined {
  if (node.kind === 'constant' || node.kind === 'parameter') return node.valueType;
  if (node.kind === 'combine') {
    return node.valueType === 'vec2' || node.valueType === 'vec4' ? node.valueType : 'vec3';
  }
  if (node.kind === 'swizzle') {
    const length = node.swizzle?.length ?? 0;
    if (length === 1) return 'float';
    if (length === 2) return 'vec2';
    if (length === 3) return 'vec3';
    if (length === 4) return 'vec4';
    return undefined;
  }
  if (node.kind === 'dot' || node.kind === 'noise' || node.kind === 'fbm') return 'float';
  if (
    node.kind === 'normalize' ||
    node.kind === 'absolute' ||
    node.kind === 'sine' ||
    node.kind === 'one-minus' ||
    node.kind === 'clamp' ||
    node.kind === 'saturate' ||
    node.kind === 'remap'
  ) {
    return sourceType(node.kind === 'clamp' || node.kind === 'remap' ? 'value' : 'value');
  }
  if (
    node.kind === 'add' ||
    node.kind === 'subtract' ||
    node.kind === 'multiply' ||
    node.kind === 'divide' ||
    node.kind === 'min' ||
    node.kind === 'max' ||
    node.kind === 'power' ||
    node.kind === 'mix'
  ) {
    return sourceType('a') ?? sourceType('b');
  }
  const spec = nodeSpec(node.kind);
  if (!spec) return undefined;
  const first = Object.values(spec.outputs)[0];
  return first ? fixedOutputType(first) : undefined;
}

function mergedLimits(overrides?: Partial<ShaderGraphLimits>): ShaderGraphLimits {
  return { ...DEFAULT_SHADER_GRAPH_LIMITS, ...overrides };
}

export function validateShaderGraph(
  graph: ShaderGraph,
  limitOverrides?: Partial<ShaderGraphLimits>,
): ShaderGraphValidationResult {
  const limits = mergedLimits(limitOverrides);
  const diagnostics: ShaderDiagnostic[] = [];
  const nodeTypes = new Map<string, ShaderValueType>();
  const topologicalOrder: string[] = [];

  if (!graph || typeof graph !== 'object') {
    diagnostic(diagnostics, 'GRAPH_INVALID', 'Shader graph must be an object', { path: '$' });
    return { valid: false, diagnostics, nodeTypes, topologicalOrder, depth: 0 };
  }
  if (graph.schemaVersion !== SHADER_GRAPH_SCHEMA_VERSION) {
    diagnostic(
      diagnostics,
      'SCHEMA_VERSION_UNSUPPORTED',
      `Expected shader graph schema ${SHADER_GRAPH_SCHEMA_VERSION}`,
      { path: 'schemaVersion' },
    );
  }
  if (
    typeof graph.id !== 'string' ||
    !IDENTIFIER.test(graph.id) ||
    graph.id.length > limits.maxIdentifierLength
  ) {
    diagnostic(diagnostics, 'GRAPH_ID_INVALID', 'Graph id is not a bounded identifier', { path: 'id' });
  }
  if (!Number.isSafeInteger(graph.version) || graph.version < 1) {
    diagnostic(diagnostics, 'GRAPH_VERSION_INVALID', 'Graph version must be a positive integer', {
      path: 'version',
    });
  }
  const domainSupported = Object.prototype.hasOwnProperty.call(
    TERMINAL_KIND_BY_DOMAIN,
    graph.domain,
  );
  if (!domainSupported) {
    diagnostic(diagnostics, 'DOMAIN_UNSUPPORTED', `Unsupported shader graph domain "${graph.domain}"`, {
      path: 'domain',
    });
  }
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    diagnostic(diagnostics, 'GRAPH_COLLECTION_INVALID', 'Graph nodes and edges must be arrays');
    return { valid: false, diagnostics, nodeTypes, topologicalOrder, depth: 0 };
  }
  if (graph.nodes.length > limits.maxNodes) {
    diagnostic(diagnostics, 'NODE_LIMIT_EXCEEDED', `Graph has more than ${limits.maxNodes} nodes`, {
      path: 'nodes',
    });
  }
  if (graph.edges.length > limits.maxEdges) {
    diagnostic(diagnostics, 'EDGE_LIMIT_EXCEEDED', `Graph has more than ${limits.maxEdges} edges`, {
      path: 'edges',
    });
  }
  try {
    if (JSON.stringify(graph).length > limits.maxSerializedBytes) {
      diagnostic(
        diagnostics,
        'GRAPH_SIZE_EXCEEDED',
        `Graph exceeds ${limits.maxSerializedBytes} serialized bytes`,
      );
    }
  } catch {
    diagnostic(diagnostics, 'GRAPH_NOT_SERIALIZABLE', 'Graph must contain JSON-serializable values');
  }

  const nodes = new Map<string, ShaderGraphNode>();
  const parameterTypes = new Map<string, ShaderValueType | undefined>();
  const textureSlots = new Set<string>();
  let parameterCount = 0;
  let textureCount = 0;
  for (const [index, node] of graph.nodes.entries()) {
    const path = `nodes[${index}]`;
    if (!node || typeof node !== 'object') {
      diagnostic(diagnostics, 'NODE_INVALID', 'Node must be an object', { path });
      continue;
    }
    if (
      typeof node.id !== 'string' ||
      !IDENTIFIER.test(node.id) ||
      node.id.length > limits.maxIdentifierLength
    ) {
      diagnostic(diagnostics, 'NODE_ID_INVALID', 'Node id is not a bounded identifier', {
        path: `${path}.id`,
        nodeId: node.id,
      });
      continue;
    }
    if (nodes.has(node.id)) {
      diagnostic(diagnostics, 'NODE_ID_DUPLICATE', `Duplicate node id "${node.id}"`, {
        path: `${path}.id`,
        nodeId: node.id,
      });
      continue;
    }
    nodes.set(node.id, node);
    const spec = nodeSpec(node.kind);
    if (!spec) {
      diagnostic(diagnostics, 'NODE_KIND_UNSUPPORTED', `Unsupported node kind "${node.kind}"`, {
        path: `${path}.kind`,
        nodeId: node.id,
      });
      continue;
    }
    if (spec.domains && !spec.domains.includes(graph.domain)) {
      diagnostic(
        diagnostics,
        'NODE_DOMAIN_MISMATCH',
        `Node "${node.kind}" is not available in the ${graph.domain} domain`,
        { path: `${path}.kind`, nodeId: node.id },
      );
    }
    if (node.kind === 'constant' || node.kind === 'parameter') {
      if (!node.valueType || !VALUE_TYPES.has(node.valueType) || node.valueType === 'sampler2D') {
        diagnostic(diagnostics, 'VALUE_TYPE_INVALID', `${node.kind} requires a non-texture valueType`, {
          path: `${path}.valueType`,
          nodeId: node.id,
        });
      } else if (node.value !== undefined && !literalMatches(node.valueType, node.value)) {
        diagnostic(
          diagnostics,
          'LITERAL_TYPE_MISMATCH',
          `Value does not match ${node.valueType}`,
          { path: `${path}.value`, nodeId: node.id },
        );
      }
      if (node.value !== undefined && !isFiniteLiteral(node.value)) {
        diagnostic(diagnostics, 'LITERAL_NONFINITE', 'Literal values must be finite', {
          path: `${path}.value`,
          nodeId: node.id,
        });
      }
    }
    if (node.kind === 'parameter') {
      parameterCount += 1;
      if (
        !node.parameter ||
        !IDENTIFIER.test(node.parameter) ||
        node.parameter.length > limits.maxIdentifierLength
      ) {
        diagnostic(diagnostics, 'PARAMETER_INVALID', 'Parameter path is not a bounded identifier', {
          path: `${path}.parameter`,
          nodeId: node.id,
        });
      } else if (parameterTypes.has(node.parameter)) {
        const previousType = parameterTypes.get(node.parameter);
        if (previousType !== node.valueType) {
          diagnostic(
            diagnostics,
            'PARAMETER_TYPE_CONFLICT',
            `Parameter "${node.parameter}" is declared with conflicting value types`,
            { path: `${path}.valueType`, nodeId: node.id },
          );
        }
      }
      if (node.parameter) parameterTypes.set(node.parameter, node.valueType);
    }
    if (node.kind === 'texture-sample') {
      textureCount += 1;
      if (
        !node.textureSlot ||
        !IDENTIFIER.test(node.textureSlot) ||
        node.textureSlot.length > limits.maxIdentifierLength
      ) {
        diagnostic(diagnostics, 'TEXTURE_SLOT_INVALID', 'Texture slot is not a bounded identifier', {
          path: `${path}.textureSlot`,
          nodeId: node.id,
        });
      } else if (textureSlots.has(node.textureSlot)) {
        diagnostics.push({
          severity: 'warning',
          phase: 'validation',
          code: 'TEXTURE_SLOT_REUSED',
          message: `Texture slot "${node.textureSlot}" is sampled by multiple nodes`,
          path: `${path}.textureSlot`,
          nodeId: node.id,
        });
      }
      if (node.textureSlot) textureSlots.add(node.textureSlot);
    }
    if (node.kind === 'swizzle' && !/^[xyzwrgba]{1,4}$/.test(node.swizzle ?? '')) {
      diagnostic(diagnostics, 'SWIZZLE_INVALID', 'Swizzle must contain one to four xyzw/rgba components', {
        path: `${path}.swizzle`,
        nodeId: node.id,
      });
    }
  }
  if (parameterCount > limits.maxParameters) {
    diagnostic(
      diagnostics,
      'PARAMETER_LIMIT_EXCEEDED',
      `Graph has more than ${limits.maxParameters} parameter nodes`,
    );
  }
  if (textureCount > limits.maxTextures) {
    diagnostic(
      diagnostics,
      'TEXTURE_LIMIT_EXCEEDED',
      `Graph has more than ${limits.maxTextures} texture nodes`,
    );
  }

  const incoming = new Map<string, Map<string, (typeof graph.edges)[number]>>();
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of nodes.keys()) {
    incoming.set(id, new Map());
    outgoing.set(id, []);
    indegree.set(id, 0);
  }

  for (const [index, edge] of graph.edges.entries()) {
    const path = `edges[${index}]`;
    if (
      !edge ||
      typeof edge !== 'object' ||
      !edge.from ||
      typeof edge.from !== 'object' ||
      !edge.to ||
      typeof edge.to !== 'object'
    ) {
      diagnostic(diagnostics, 'EDGE_INVALID', 'Edge must contain from and to endpoints', {
        path,
      });
      continue;
    }
    const edgeId = edge.id ?? String(index);
    const source = nodes.get(edge.from?.nodeId);
    const target = nodes.get(edge.to?.nodeId);
    if (!source || !target) {
      diagnostic(diagnostics, 'EDGE_NODE_MISSING', 'Edge references a missing node', {
        path,
        edgeId,
      });
      continue;
    }
    const sourceSpec = nodeSpec(source.kind);
    const targetSpec = nodeSpec(target.kind);
    if (!sourceSpec || !targetSpec) continue;
    if (!Object.prototype.hasOwnProperty.call(sourceSpec.outputs, edge.from.port)) {
      diagnostic(
        diagnostics,
        'EDGE_SOURCE_PORT_INVALID',
        `Node "${source.id}" has no output port "${edge.from.port}"`,
        { path: `${path}.from.port`, nodeId: source.id, edgeId },
      );
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(targetSpec.inputs, edge.to.port)) {
      diagnostic(
        diagnostics,
        'EDGE_TARGET_PORT_INVALID',
        `Node "${target.id}" has no input port "${edge.to.port}"`,
        { path: `${path}.to.port`, nodeId: target.id, edgeId },
      );
      continue;
    }
    if (incoming.get(target.id)!.has(edge.to.port)) {
      diagnostic(
        diagnostics,
        'INPUT_MULTIPLE_CONNECTIONS',
        `Input "${target.id}.${edge.to.port}" has multiple connections`,
        { path, nodeId: target.id, edgeId },
      );
      continue;
    }
    incoming.get(target.id)!.set(edge.to.port, edge);
    outgoing.get(source.id)!.push(target.id);
    indegree.set(target.id, (indegree.get(target.id) ?? 0) + 1);
  }

  const queue = [...nodes.keys()].filter((id) => indegree.get(id) === 0).sort();
  while (queue.length > 0) {
    const id = queue.shift()!;
    topologicalOrder.push(id);
    for (const target of outgoing.get(id) ?? []) {
      const remaining = (indegree.get(target) ?? 1) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        queue.push(target);
        queue.sort();
      }
    }
  }
  if (topologicalOrder.length !== nodes.size) {
    diagnostic(diagnostics, 'GRAPH_CYCLE', 'Shader graph must be acyclic', { path: 'edges' });
  }

  const depths = new Map<string, number>();
  let graphDepth = 0;
  for (const id of topologicalOrder) {
    const node = nodes.get(id)!;
    const nodeIncoming = incoming.get(id)!;
    let depth = 1;
    for (const edge of nodeIncoming.values()) {
      depth = Math.max(depth, (depths.get(edge.from.nodeId) ?? 0) + 1);
    }
    depths.set(id, depth);
    graphDepth = Math.max(graphDepth, depth);
    const sourceType = (port: string) => {
      const edge = nodeIncoming.get(port);
      return edge ? nodeTypes.get(edge.from.nodeId) : undefined;
    };
    const inferred = inferNodeType(node, sourceType);
    if (inferred) nodeTypes.set(id, inferred);

    const spec = nodeSpec(node.kind);
    if (!spec) continue;
    for (const [port, constraint] of Object.entries(spec.inputs)) {
      const edge = nodeIncoming.get(port);
      if (edge) {
        const actual = nodeTypes.get(edge.from.nodeId);
        if (actual && !accepts(constraint, actual)) {
          diagnostic(
            diagnostics,
            'PORT_TYPE_MISMATCH',
            `Input "${node.id}.${port}" expects ${constraint}, received ${actual}`,
            { nodeId: node.id, edgeId: edge.id },
          );
        }
      } else if (
        REQUIRED_INPUTS[node.kind]?.includes(port) &&
        node.inputDefaults?.[port] === undefined
      ) {
        diagnostic(
          diagnostics,
          'INPUT_REQUIRED',
          `Required input "${node.id}.${port}" is not connected and has no default`,
          { nodeId: node.id },
        );
      }
    }
    if (
      [
        'add',
        'subtract',
        'multiply',
        'divide',
        'min',
        'max',
        'power',
        'dot',
        'mix',
        'color-mix',
      ].includes(node.kind)
    ) {
      const aType = sourceType('a');
      const bType = sourceType('b');
      if (
        aType &&
        bType &&
        isVector(aType) &&
        isVector(bType) &&
        normalizeValueType(aType) !== normalizeValueType(bType)
      ) {
        diagnostic(
          diagnostics,
          'OPERAND_DIMENSION_MISMATCH',
          `Node "${node.id}" cannot combine ${aType} and ${bType}`,
          { nodeId: node.id },
        );
      }
    }
    if (node.kind === 'mix') {
      const valueType = sourceType('a') ?? sourceType('b');
      const factorType = sourceType('factor');
      if (
        valueType &&
        factorType &&
        isVector(factorType) &&
        normalizeValueType(valueType) !== normalizeValueType(factorType)
      ) {
        diagnostic(
          diagnostics,
          'FACTOR_DIMENSION_MISMATCH',
          `Mix factor ${factorType} does not match ${valueType}`,
          { nodeId: node.id },
        );
      }
    }
  }
  if (graphDepth > limits.maxDepth) {
    diagnostic(
      diagnostics,
      'DEPTH_LIMIT_EXCEEDED',
      `Graph depth ${graphDepth} exceeds the limit of ${limits.maxDepth}`,
    );
  }

  for (const [name, endpoint] of Object.entries(graph.outputs ?? {})) {
    const node = nodes.get(endpoint.nodeId);
    const spec = node ? nodeSpec(node.kind) : undefined;
    if (!node || !spec) {
      diagnostic(diagnostics, 'OUTPUT_NODE_MISSING', `Output "${name}" references a missing node`, {
        path: `outputs.${name}`,
      });
    } else if (!Object.prototype.hasOwnProperty.call(spec.outputs, endpoint.port)) {
      diagnostic(
        diagnostics,
        'OUTPUT_PORT_INVALID',
        `Output "${name}" references invalid port "${endpoint.port}"`,
        { path: `outputs.${name}`, nodeId: node.id },
      );
    } else {
      const expectedByName: Readonly<Record<string, ShaderPortConstraint>> = {
        baseColor: 'color',
        emission: 'color',
        metalness: 'float',
        roughness: 'float',
        opacity: 'float',
        position: 'vec3',
        offset: 'vec3',
        color: 'vec4',
        response: 'float',
      };
      const expected = expectedByName[name];
      const actual = nodeTypes.get(node.id);
      if (expected && actual && !accepts(expected, actual)) {
        diagnostic(
          diagnostics,
          'OUTPUT_TYPE_MISMATCH',
          `Output "${name}" expects ${expected}, received ${actual}`,
          { path: `outputs.${name}`, nodeId: node.id },
        );
      }
    }
  }

  if (domainSupported) {
    const terminalKind = TERMINAL_KIND_BY_DOMAIN[graph.domain];
    const hasTerminal = graph.nodes.some((node) => node.kind === terminalKind);
    const requiredOutput = REQUIRED_GRAPH_OUTPUT_BY_DOMAIN[graph.domain];
    if (!hasTerminal && !graph.outputs?.[requiredOutput]) {
      diagnostic(
        diagnostics,
        'DOMAIN_OUTPUT_MISSING',
        `${graph.domain} graph requires a ${terminalKind} node or "${requiredOutput}" output`,
        { path: 'outputs' },
      );
    }
  }

  return {
    valid: !diagnostics.some((entry) => entry.severity === 'error'),
    diagnostics,
    nodeTypes,
    topologicalOrder,
    depth: graphDepth,
  };
}

export class ShaderGraphValidationError extends Error {
  readonly diagnostics: ShaderDiagnostic[];

  constructor(diagnostics: ShaderDiagnostic[], message = 'Shader graph validation failed') {
    super(message);
    this.name = 'ShaderGraphValidationError';
    this.diagnostics = diagnostics;
  }
}

export function assertValidShaderGraph(
  graph: ShaderGraph,
  limits?: Partial<ShaderGraphLimits>,
): ShaderGraphValidationResult {
  const result = validateShaderGraph(graph, limits);
  if (!result.valid) throw new ShaderGraphValidationError(result.diagnostics);
  return result;
}

/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type ShaderDiagnostic,
  type ShaderGraph,
  type ShaderGraphEndpoint,
  type ShaderGraphLimits,
  type ShaderGraphNode,
  type ShaderLiteral,
  type ShaderValueType,
} from './types';
import { SHADER_NODE_SPECS, type ShaderPortConstraint } from './nodeRegistry';
import { validateShaderGraph } from './validation';

export type ShaderGraphBackend = 'webgl' | 'webgpu';

export interface CompiledGraphUniform {
  name: string;
  type: ShaderValueType;
  defaultValue?: ShaderLiteral;
  parameter?: string;
  textureSlot?: string;
  builtin?: 'time' | 'sceneColor' | 'transitionFrom' | 'transitionTo' | 'depth';
}

export interface CompiledShaderGraph {
  graphId: string;
  graphVersion: number;
  domain: ShaderGraph['domain'];
  backend: ShaderGraphBackend;
  cacheKey: string;
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, CompiledGraphUniform>;
  /** Generated source line for each node declaration. */
  sourceMap: Record<string, { stage: 'vertex' | 'fragment'; line: number }>;
}

export interface ShaderGraphCompileResult {
  ok: boolean;
  program?: CompiledShaderGraph;
  diagnostics: ShaderDiagnostic[];
}

export interface ShaderGraphCompileOptions {
  backend?: ShaderGraphBackend;
  limits?: Partial<ShaderGraphLimits>;
}

interface Expression {
  code: string;
  type: ShaderValueType;
}

const GLSL_TYPE: Readonly<Record<ShaderValueType, string>> = {
  float: 'float',
  int: 'int',
  bool: 'bool',
  vec2: 'vec2',
  vec3: 'vec3',
  vec4: 'vec4',
  color: 'vec3',
  sampler2D: 'sampler2D',
};

const PORT_DEFAULTS: Readonly<Record<string, ShaderLiteral>> = {
  uv: [0, 0],
  scale: 1,
  seed: 0,
  min: 0,
  max: 1,
  power: 5,
  edge0: 0,
  edge1: 1,
  factor: 0.5,
  normal: [0, 1, 0],
  view: [0, 0, 1],
  origin: [0, 0, 0],
  energy: 1,
  width: 0.05,
  falloff: 2,
  amount: 0,
  strength: 1,
  edge: 0,
  field: 0,
  near: 0,
  far: 1,
  baseColor: [0.5, 0.5, 0.5],
  emission: [0, 0, 0],
  color: [0, 0, 0],
  intensity: 1,
  metalness: 0,
  roughness: 0.5,
  opacity: 1,
  offset: [0, 0, 0],
  x: 0,
  y: 0,
  z: 0,
  w: 1,
};

function normalizeType(type: ShaderValueType): ShaderValueType {
  return type === 'color' ? 'vec3' : type;
}

function typeFromConstraint(
  constraint: ShaderPortConstraint | undefined,
  fallback: ShaderValueType = 'float',
): ShaderValueType {
  if (
    constraint &&
    constraint !== 'any' &&
    constraint !== 'numeric' &&
    constraint !== 'numeric-or-vector' &&
    constraint !== 'vector'
  ) {
    return constraint;
  }
  return fallback;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0.0';
  if (Number.isInteger(value)) return `${value}.0`;
  const text = String(value);
  return text.includes('e') ? value.toFixed(8).replace(/0+$/, '').replace(/\.$/, '.0') : text;
}

function literalExpression(value: ShaderLiteral, type?: ShaderValueType): Expression {
  if (typeof value === 'boolean') return { code: value ? 'true' : 'false', type: 'bool' };
  if (typeof value === 'number') {
    if (type === 'int') return { code: String(Math.trunc(value)), type: 'int' };
    return { code: formatNumber(value), type: type ?? 'float' };
  }
  const inferred: ShaderValueType =
    type ?? (value.length === 2 ? 'vec2' : value.length === 4 ? 'vec4' : 'vec3');
  const normalized = normalizeType(inferred);
  return {
    code: `${GLSL_TYPE[normalized]}(${value.map(formatNumber).join(', ')})`,
    type: inferred,
  };
}

function identifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([0-9])/, '_$1');
}

function hash(value: string): string {
  let current = 2166136261;
  for (let index = 0; index < value.length; index++) {
    current ^= value.charCodeAt(index);
    current = Math.imul(current, 16777619);
  }
  return (current >>> 0).toString(16).padStart(8, '0');
}

function vectorDimension(type: ShaderValueType): number {
  const normalized = normalizeType(type);
  if (normalized === 'vec2') return 2;
  if (normalized === 'vec3') return 3;
  if (normalized === 'vec4') return 4;
  return 1;
}

function cast(expression: Expression, target: ShaderValueType): Expression {
  const source = normalizeType(expression.type);
  const normalizedTarget = normalizeType(target);
  if (source === normalizedTarget) return { ...expression, type: target };
  if (normalizedTarget === 'float' && source === 'int') {
    return { code: `float(${expression.code})`, type: target };
  }
  if (vectorDimension(normalizedTarget) > 1 && vectorDimension(source) === 1) {
    return { code: `${GLSL_TYPE[normalizedTarget]}(${expression.code})`, type: target };
  }
  if (normalizedTarget === 'vec4' && source === 'vec3') {
    return { code: `vec4(${expression.code}, 1.0)`, type: target };
  }
  if (normalizedTarget === 'vec3' && source === 'vec4') {
    return { code: `${expression.code}.rgb`, type: target };
  }
  return { ...expression, type: target };
}

function noisePosition(expression: Expression): string {
  const type = normalizeType(expression.type);
  if (type === 'vec3') return expression.code;
  if (type === 'vec4') return `${expression.code}.xyz`;
  if (type === 'vec2') return `vec3(${expression.code}, 0.0)`;
  return `vec3(${expression.code})`;
}

export function compileShaderGraph(
  graph: ShaderGraph,
  options: ShaderGraphCompileOptions = {},
): ShaderGraphCompileResult {
  const backend = options.backend ?? 'webgl';
  const validation = validateShaderGraph(graph, options.limits);
  const diagnostics = [...validation.diagnostics];
  if (!validation.valid) return { ok: false, diagnostics };
  if (backend !== 'webgl') {
    diagnostics.push({
      severity: 'error',
      phase: 'compile',
      code: 'BACKEND_UNSUPPORTED',
      message: 'Graph compilation currently emits GLSL for the WebGL backend',
    });
    return { ok: false, diagnostics };
  }

  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, Map<string, ShaderGraphEndpoint>>();
  for (const node of graph.nodes) incoming.set(node.id, new Map());
  for (const edge of graph.edges) {
    incoming.get(edge.to.nodeId)?.set(edge.to.port, edge.from);
  }

  const expressions = new Map<string, Expression>();
  const uniforms: Record<string, CompiledGraphUniform> = {};
  const declarationLines: Array<{ nodeId: string; source: string }> = [];
  const usedUniformNames = new Map<string, string>();
  let needsNoise = false;

  const input = (
    node: ShaderGraphNode,
    port: string,
    preferred?: ShaderValueType,
  ): Expression => {
    const endpoint = incoming.get(node.id)?.get(port);
    if (endpoint) {
      const expression = expressions.get(endpoint.nodeId);
      if (expression) return preferred ? cast(expression, preferred) : expression;
    }
    const value = node.inputDefaults?.[port] ?? PORT_DEFAULTS[port] ?? 0;
    const constraint = SHADER_NODE_SPECS[node.kind]?.inputs[port];
    return literalExpression(value, preferred ?? typeFromConstraint(constraint));
  };

  const addUniform = (
    rawName: string,
    uniform: Omit<CompiledGraphUniform, 'name'>,
  ): string => {
    const semanticKey =
      uniform.parameter ??
      uniform.textureSlot ??
      uniform.builtin ??
      rawName;
    const existing = usedUniformNames.get(semanticKey);
    if (existing) return existing;
    let name = `u_${identifier(rawName)}`;
    let suffix = 2;
    while (uniforms[name]) name = `u_${identifier(rawName)}_${suffix++}`;
    uniforms[name] = { name, ...uniform };
    usedUniformNames.set(semanticKey, name);
    return name;
  };

  const expressionForNode = (node: ShaderGraphNode): Expression | undefined => {
    const inferred = validation.nodeTypes.get(node.id) ?? 'float';
    switch (node.kind) {
      case 'constant':
        return literalExpression(node.value ?? 0, node.valueType);
      case 'parameter': {
        const type = node.valueType ?? 'float';
        const name = addUniform(node.parameter ?? node.id, {
          type,
          defaultValue: node.value,
          parameter: node.parameter,
        });
        return { code: name, type };
      }
      case 'time': {
        const name = addUniform('time', { type: 'float', defaultValue: 0, builtin: 'time' });
        return { code: name, type: 'float' };
      }
      case 'uv':
        return { code: 'vUv', type: 'vec2' };
      case 'screen-uv':
        return { code: 'vUv', type: 'vec2' };
      case 'object-position':
        return {
          code: graph.domain === 'vertex' || graph.domain === 'deformation' ? 'position' : 'vObjectPosition',
          type: 'vec3',
        };
      case 'world-position':
        return {
          code:
            graph.domain === 'vertex' || graph.domain === 'deformation'
              ? '(modelMatrix * vec4(position, 1.0)).xyz'
              : 'vWorldPosition',
          type: 'vec3',
        };
      case 'surface-normal':
        return {
          code:
            graph.domain === 'vertex' || graph.domain === 'deformation'
              ? 'normalize(normalMatrix * normal)'
              : 'normalize(vWorldNormal)',
          type: 'vec3',
        };
      case 'view-direction':
        return {
          code:
            graph.domain === 'vertex' || graph.domain === 'deformation'
              ? 'normalize(cameraPosition - (modelMatrix * vec4(position, 1.0)).xyz)'
              : 'normalize(cameraPosition - vWorldPosition)',
          type: 'vec3',
        };
      case 'scene-color': {
        const name = addUniform('sceneColor', {
          type: 'sampler2D',
          builtin: 'sceneColor',
        });
        return { code: `texture2D(${name}, vUv)`, type: 'vec4' };
      }
      case 'transition-from': {
        const name = addUniform('transitionFrom', {
          type: 'sampler2D',
          builtin: 'transitionFrom',
        });
        return { code: `texture2D(${name}, vUv)`, type: 'vec4' };
      }
      case 'transition-to': {
        const name = addUniform('transitionTo', {
          type: 'sampler2D',
          builtin: 'transitionTo',
        });
        return { code: `texture2D(${name}, vUv)`, type: 'vec4' };
      }
      case 'depth': {
        const name = addUniform('depth', { type: 'sampler2D', builtin: 'depth' });
        return { code: `texture2D(${name}, vUv).r`, type: 'float' };
      }
      case 'texture-sample': {
        const name = addUniform(node.textureSlot ?? node.id, {
          type: 'sampler2D',
          textureSlot: node.textureSlot,
        });
        return { code: `texture2D(${name}, ${input(node, 'uv', 'vec2').code})`, type: 'vec4' };
      }
      case 'add':
      case 'subtract':
      case 'multiply':
      case 'divide':
      case 'min':
      case 'max':
      case 'power': {
        const a = input(node, 'a');
        const target = normalizeType(a.type);
        const b = cast(input(node, 'b'), target);
        const operator =
          node.kind === 'add'
            ? '+'
            : node.kind === 'subtract'
              ? '-'
              : node.kind === 'multiply'
                ? '*'
                : node.kind === 'divide'
                  ? '/'
                  : undefined;
        const code = operator
          ? `(${a.code} ${operator} ${b.code})`
          : `${node.kind === 'power' ? 'pow' : node.kind}(${a.code}, ${b.code})`;
        return { code, type: a.type };
      }
      case 'dot': {
        const a = input(node, 'a');
        const b = cast(input(node, 'b'), a.type);
        return { code: `dot(${a.code}, ${b.code})`, type: 'float' };
      }
      case 'normalize':
        return { code: `normalize(${input(node, 'value').code})`, type: inferred };
      case 'absolute':
        return { code: `abs(${input(node, 'value').code})`, type: inferred };
      case 'sine':
        return { code: `sin(${input(node, 'value').code})`, type: inferred };
      case 'one-minus': {
        const value = input(node, 'value');
        return { code: `(1.0 - ${value.code})`, type: value.type };
      }
      case 'clamp': {
        const value = input(node, 'value');
        return {
          code: `clamp(${value.code}, ${cast(input(node, 'min'), value.type).code}, ${cast(input(node, 'max'), value.type).code})`,
          type: value.type,
        };
      }
      case 'saturate': {
        const value = input(node, 'value');
        return { code: `clamp(${value.code}, 0.0, 1.0)`, type: value.type };
      }
      case 'mix':
      case 'color-mix': {
        const a = input(node, 'a');
        return {
          code: `mix(${a.code}, ${cast(input(node, 'b'), a.type).code}, ${input(node, 'factor').code})`,
          type: node.kind === 'color-mix' ? 'color' : a.type,
        };
      }
      case 'smoothstep': {
        const value = input(node, 'value');
        return {
          code: `smoothstep(${cast(input(node, 'edge0'), value.type).code}, ${cast(input(node, 'edge1'), value.type).code}, ${value.code})`,
          type: value.type,
        };
      }
      case 'remap': {
        const value = input(node, 'value');
        const inMin = cast(input(node, 'inMin'), value.type).code;
        const inMax = cast(input(node, 'inMax'), value.type).code;
        const outMin = cast(input(node, 'outMin'), value.type).code;
        const outMax = cast(input(node, 'outMax'), value.type).code;
        return {
          code: `(${outMin} + ((${value.code} - ${inMin}) / max(${inMax} - ${inMin}, 0.00001)) * (${outMax} - ${outMin}))`,
          type: value.type,
        };
      }
      case 'fresnel':
        return {
          code: `pow(1.0 - clamp(dot(normalize(${input(node, 'normal', 'vec3').code}), normalize(${input(node, 'view', 'vec3').code})), 0.0, 1.0), ${input(node, 'power', 'float').code})`,
          type: 'float',
        };
      case 'noise':
      case 'fbm': {
        needsNoise = true;
        const position = noisePosition(input(node, 'position'));
        const scaled = `(${position} * ${input(node, 'scale', 'float').code} + vec3(${input(node, 'seed', 'float').code}))`;
        return {
          code: `${node.kind === 'fbm' ? 'hzFbm' : 'hzNoise'}(${scaled})`,
          type: 'float',
        };
      }
      case 'combine': {
        const type =
          node.valueType === 'vec2' || node.valueType === 'vec4' ? node.valueType : 'vec3';
        const ports = type === 'vec2' ? ['x', 'y'] : type === 'vec4' ? ['x', 'y', 'z', 'w'] : ['x', 'y', 'z'];
        return {
          code: `${type}(${ports.map((port) => input(node, port, 'float').code).join(', ')})`,
          type,
        };
      }
      case 'swizzle':
        return {
          code: `${input(node, 'value').code}.${node.swizzle}`,
          type: inferred,
        };
      case 'horizon-distance':
        return {
          code: `abs(dot(${input(node, 'position', 'vec3').code} - ${input(node, 'origin', 'vec3').code}, normalize(${input(node, 'normal', 'vec3').code})))`,
          type: 'float',
        };
      case 'horizon-field':
        return {
          code: `(${input(node, 'energy', 'float').code} * exp(-pow(${input(node, 'distance', 'float').code} / max(${input(node, 'width', 'float').code}, 0.00001), max(${input(node, 'falloff', 'float').code}, 0.00001))))`,
          type: 'float',
        };
      case 'micro-roughness':
        return {
          code: `clamp(${input(node, 'roughness', 'float').code} + (${input(node, 'noise', 'float').code} - 0.5) * ${input(node, 'amount', 'float').code}, 0.0, 1.0)`,
          type: 'float',
        };
      case 'graphite-base': {
        const base = input(node, 'baseColor', 'color');
        const edge = input(node, 'edge', 'float');
        return {
          code: `mix(${base.code} * 0.72, ${base.code} * 1.18, clamp(${edge.code}, 0.0, 1.0))`,
          type: 'color',
        };
      }
      case 'edge-response':
        return {
          code: `clamp(${input(node, 'fresnel', 'float').code} * ${input(node, 'strength', 'float').code} + ${input(node, 'field', 'float').code}, 0.0, 1.0)`,
          type: 'float',
        };
      case 'distance-fade':
        return {
          code: `(1.0 - smoothstep(${input(node, 'near', 'float').code}, max(${input(node, 'far', 'float').code}, ${input(node, 'near', 'float').code} + 0.00001), ${input(node, 'distance', 'float').code}))`,
          type: 'float',
        };
      case 'pbr-output':
      case 'emission-output':
      case 'vertex-output':
      case 'post-output':
      case 'transition-output':
      case 'field-output':
        return undefined;
    }
  };

  for (const id of validation.topologicalOrder) {
    const node = nodes.get(id)!;
    const expression = expressionForNode(node);
    if (!expression) continue;
    const spec = SHADER_NODE_SPECS[node.kind];
    if (spec.terminal) continue;
    const variable = `hz_${identifier(node.id)}`;
    declarationLines.push({
      nodeId: node.id,
      source: `${GLSL_TYPE[normalizeType(expression.type)]} ${variable} = ${expression.code};`,
    });
    expressions.set(node.id, { code: variable, type: expression.type });
  }

  const endpointExpression = (
    endpoint: ShaderGraphEndpoint | undefined,
    type: ShaderValueType,
    fallback: ShaderLiteral,
  ): Expression => {
    if (!endpoint) return literalExpression(fallback, type);
    const expression = expressions.get(endpoint.nodeId);
    return expression ? cast(expression, type) : literalExpression(fallback, type);
  };

  const terminal = (kind: ShaderGraphNode['kind']): ShaderGraphNode | undefined =>
    graph.nodes.find((node) => node.kind === kind);
  const terminalEndpoint = (
    node: ShaderGraphNode | undefined,
    port: string,
  ): ShaderGraphEndpoint | undefined => incoming.get(node?.id ?? '')?.get(port);
  const outputEndpoint = (
    name: string,
    terminalNode: ShaderGraphNode | undefined,
    terminalPort = name,
  ): ShaderGraphEndpoint | undefined =>
    graph.outputs?.[name] ?? terminalEndpoint(terminalNode, terminalPort);

  const uniformDeclarations = Object.values(uniforms)
    .map((uniform) => `uniform ${GLSL_TYPE[normalizeType(uniform.type)]} ${uniform.name};`)
    .join('\n');
  const helpers = needsNoise
    ? `
float hzHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float hzNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hzHash(i), hzHash(i + vec3(1,0,0)), f.x),
        mix(hzHash(i + vec3(0,1,0)), hzHash(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hzHash(i + vec3(0,0,1)), hzHash(i + vec3(1,0,1)), f.x),
        mix(hzHash(i + vec3(0,1,1)), hzHash(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}
float hzFbm(vec3 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int octave = 0; octave < 5; octave++) {
    value += amplitude * hzNoise(p);
    p = p * 2.03 + vec3(17.1, 11.7, 5.3);
    amplitude *= 0.5;
  }
  return value;
}`
    : '';

  let vertexShader: string;
  let fragmentShader: string;
  let stage: 'vertex' | 'fragment' = 'fragment';
  const declarations = declarationLines.map((line) => `  ${line.source}`).join('\n');

  if (graph.domain === 'vertex' || graph.domain === 'deformation') {
    stage = 'vertex';
    const output = terminal('vertex-output');
    const positionEndpoint = outputEndpoint('position', output);
    const offsetEndpoint = outputEndpoint('offset', output);
    const position = endpointExpression(positionEndpoint, 'vec3', [0, 0, 0]);
    const offset = endpointExpression(offsetEndpoint, 'vec3', [0, 0, 0]);
    const finalPosition = positionEndpoint
      ? position.code
      : `position + ${offset.code}`;
    vertexShader = `
${uniformDeclarations}
varying vec2 vUv;
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
${helpers}
void main() {
  vUv = uv;
  vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
${declarations}
  vec3 hzPosition = ${finalPosition};
  gl_Position = projectionMatrix * modelViewMatrix * vec4(hzPosition, 1.0);
}`.trim();
    fragmentShader = `
varying vec2 vUv;
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
void main() {
  gl_FragColor = vec4(vec3(0.5) * (0.35 + 0.65 * abs(normalize(vWorldNormal).z)), 1.0);
}`.trim();
  } else if (graph.domain === 'surface') {
    const output = terminal('pbr-output');
    const emissionOutput = terminal('emission-output');
    const baseColor = endpointExpression(
      outputEndpoint('baseColor', output),
      'color',
      [0.5, 0.5, 0.5],
    );
    const emission = endpointExpression(
      outputEndpoint('emission', output) ?? terminalEndpoint(emissionOutput, 'color'),
      'color',
      [0, 0, 0],
    );
    const emissionIntensity = endpointExpression(
      terminalEndpoint(emissionOutput, 'intensity'),
      'float',
      1,
    );
    const opacity = endpointExpression(outputEndpoint('opacity', output), 'float', 1);
    vertexShader = `
varying vec2 vUv;
varying vec3 vObjectPosition;
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
void main() {
  vUv = uv;
  vObjectPosition = position;
  vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`.trim();
    fragmentShader = `
${uniformDeclarations}
varying vec2 vUv;
varying vec3 vObjectPosition;
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
${helpers}
void main() {
${declarations}
  vec3 hzBaseColor = ${baseColor.code};
  vec3 hzEmission = ${emission.code} * ${emissionIntensity.code};
  gl_FragColor = vec4(max(hzBaseColor + hzEmission, vec3(0.0)), clamp(${opacity.code}, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`.trim();
  } else {
    const outputKind =
      graph.domain === 'transition'
        ? 'transition-output'
        : graph.domain === 'post'
          ? 'post-output'
          : 'field-output';
    const output = terminal(outputKind);
    const isField = graph.domain === 'field' || graph.domain === 'field-response';
    const result = endpointExpression(
      outputEndpoint(isField ? 'response' : 'color', output),
      isField ? 'float' : 'vec4',
      isField ? 0 : [0, 0, 0, 1],
    );
    vertexShader = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`.trim();
    fragmentShader = `
${uniformDeclarations}
varying vec2 vUv;
${helpers}
void main() {
${declarations}
  gl_FragColor = ${isField ? `vec4(vec3(clamp(${result.code}, 0.0, 1.0)), 1.0)` : result.code};
}`.trim();
  }

  const declarationStartLine =
    (stage === 'vertex' ? vertexShader : fragmentShader)
      .split('\n')
      .findIndex((line) => line.includes(declarationLines[0]?.source ?? '\0')) + 1;
  const sourceMap: CompiledShaderGraph['sourceMap'] = {};
  declarationLines.forEach((entry, index) => {
    sourceMap[entry.nodeId] = { stage, line: declarationStartLine + index };
  });

  const serialized = JSON.stringify(graph);
  const program: CompiledShaderGraph = {
    graphId: graph.id,
    graphVersion: graph.version,
    domain: graph.domain,
    backend,
    cacheKey: `${graph.id}:${graph.version}:${backend}:${hash(serialized)}`,
    vertexShader,
    fragmentShader,
    uniforms,
    sourceMap,
  };
  return { ok: true, program, diagnostics };
}

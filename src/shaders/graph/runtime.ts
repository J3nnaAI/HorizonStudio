/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import type { PropertyDef, ShaderDef, TextureSlotDef } from '../../core/types';
import {
  type CompiledShaderGraph,
  type ShaderGraphBackend,
  type ShaderGraphCompileOptions,
  compileShaderGraph,
} from './compiler';
import { serializeShaderGraph } from './serialization';
import {
  asGraphShaderDefinition,
  attachShaderGraph,
  type GraphShaderDefinition,
  type ShaderDiagnostic,
  type ShaderGraph,
} from './types';

interface CachedGraphProgram {
  fingerprint: string;
  program: CompiledShaderGraph;
}

export interface ShaderDefinitionCompileResult {
  ok: boolean;
  program?: CompiledShaderGraph;
  diagnostics: ShaderDiagnostic[];
  usingLastKnownGood: boolean;
}

const graphPrograms = new Map<string, CachedGraphProgram>();

function cacheId(shaderId: string, backend: ShaderGraphBackend): string {
  return `${shaderId}:${backend}`;
}

function graphFingerprint(graph: ShaderGraph): string {
  try {
    return JSON.stringify(graph);
  } catch {
    return '';
  }
}

export function getShaderGraph(shader: ShaderDef): ShaderGraph | undefined {
  const graph = asGraphShaderDefinition(shader).graph;
  return graph && typeof graph === 'object' ? graph : undefined;
}

export function setShaderGraph<T extends ShaderDef>(
  shader: T,
  graph: ShaderGraph,
): T & GraphShaderDefinition {
  return attachShaderGraph(shader, graph);
}

export function createGraphShaderDefinition(options: {
  id: string;
  name: string;
  graph: ShaderGraph;
  parameters?: PropertyDef[];
  textureSlots?: TextureSlotDef[];
  backends?: ShaderDef['backends'];
}): GraphShaderDefinition {
  const legacyDomain: ShaderDef['domain'] =
    options.graph.domain === 'post' || options.graph.domain === 'transition'
      ? 'post'
      : options.graph.domain === 'field' || options.graph.domain === 'field-response'
        ? 'field'
        : 'surface';
  return attachShaderGraph(
    {
      id: options.id,
      name: options.name,
      domain: legacyDomain,
      parameters: options.parameters ?? [],
      textureSlots: options.textureSlots,
      backends: options.backends ?? ['webgl'],
    },
    options.graph,
  );
}

export function compileShaderDefinitionGraph(
  shader: ShaderDef,
  options: ShaderGraphCompileOptions = {},
): ShaderDefinitionCompileResult {
  const backend = options.backend ?? 'webgl';
  const graph = getShaderGraph(shader);
  const extended = asGraphShaderDefinition(shader);
  const cached = graphPrograms.get(cacheId(shader.id, backend));
  if (!graph) {
    const diagnostics: ShaderDiagnostic[] = [
      {
        severity: 'error',
        phase: 'validation',
        code: 'GRAPH_MISSING',
        message: `Shader "${shader.id}" has no node graph`,
      },
    ];
    extended.graphValid = false;
    extended.graphError = diagnostics[0].message;
    extended.graphDiagnostics = diagnostics;
    return {
      ok: false,
      program: cached?.program,
      diagnostics,
      usingLastKnownGood: Boolean(cached),
    };
  }

  const fingerprint = graphFingerprint(graph);
  if (cached?.fingerprint === fingerprint) {
    extended.graphValid = true;
    extended.graphError = undefined;
    extended.graphDiagnostics = [];
    extended.graphVersion = graph.version;
    extended.graphDomain = graph.domain;
    return {
      ok: true,
      program: cached.program,
      diagnostics: [],
      usingLastKnownGood: false,
    };
  }

  const result = compileShaderGraph(graph, options);
  extended.graphVersion = graph.version;
  extended.graphDomain = graph.domain;
  extended.graphDiagnostics = result.diagnostics;
  if (!result.ok || !result.program) {
    extended.graphValid = false;
    extended.graphError =
      result.diagnostics.find((entry) => entry.severity === 'error')?.message ??
      'Shader graph compilation failed';
    return {
      ok: false,
      program: cached?.program,
      diagnostics: result.diagnostics,
      usingLastKnownGood: Boolean(cached),
    };
  }

  graphPrograms.set(cacheId(shader.id, backend), {
    fingerprint,
    program: result.program,
  });
  extended.graphValid = true;
  extended.graphError = undefined;
  extended.graphLastKnownGood = serializeShaderGraph(graph);
  return {
    ok: true,
    program: result.program,
    diagnostics: result.diagnostics,
    usingLastKnownGood: false,
  };
}

export function ensureShaderGraphsCompiled(
  shaders: Record<string, ShaderDef>,
  options: ShaderGraphCompileOptions = {},
): Record<string, ShaderDefinitionCompileResult> {
  const results: Record<string, ShaderDefinitionCompileResult> = {};
  for (const shader of Object.values(shaders)) {
    if (!getShaderGraph(shader)) continue;
    results[shader.id] = compileShaderDefinitionGraph(shader, options);
  }
  return results;
}

export function getCompiledShaderGraph(
  shaderId: string,
  backend: ShaderGraphBackend = 'webgl',
): CompiledShaderGraph | undefined {
  return graphPrograms.get(cacheId(shaderId, backend))?.program;
}

export function invalidateShaderGraph(
  shaderId: string,
  backend?: ShaderGraphBackend,
): void {
  if (backend) {
    graphPrograms.delete(cacheId(shaderId, backend));
    return;
  }
  graphPrograms.delete(cacheId(shaderId, 'webgl'));
  graphPrograms.delete(cacheId(shaderId, 'webgpu'));
}

function uniformValue(
  uniform: CompiledShaderGraph['uniforms'][string],
  parameters: Record<string, unknown>,
): unknown {
  if (uniform.parameter) return parameters[uniform.parameter] ?? uniform.defaultValue ?? 0;
  if (uniform.builtin === 'time') return 0;
  return uniform.defaultValue ?? null;
}

function toThreeUniformValue(type: CompiledShaderGraph['uniforms'][string]['type'], value: unknown): unknown {
  if (type === 'color' && (typeof value === 'string' || typeof value === 'number')) {
    return new THREE.Color(value);
  }
  if ((type === 'color' || type === 'vec3') && Array.isArray(value)) {
    return new THREE.Vector3(Number(value[0]), Number(value[1]), Number(value[2]));
  }
  if (type === 'vec2' && Array.isArray(value)) {
    return new THREE.Vector2(Number(value[0]), Number(value[1]));
  }
  if (type === 'vec4' && Array.isArray(value)) {
    return new THREE.Vector4(
      Number(value[0]),
      Number(value[1]),
      Number(value[2]),
      Number(value[3]),
    );
  }
  return value;
}

export function createThreeMaterialFromGraph(
  program: CompiledShaderGraph,
  parameters: Record<string, unknown> = {},
): THREE.ShaderMaterial {
  const uniforms: Record<string, THREE.IUniform> = {};
  for (const uniform of Object.values(program.uniforms)) {
    uniforms[uniform.name] = {
      value: toThreeUniformValue(uniform.type, uniformValue(uniform, parameters)),
    };
  }
  const material = new THREE.ShaderMaterial({
    vertexShader: program.vertexShader,
    fragmentShader: program.fragmentShader,
    uniforms,
    transparent: program.domain === 'surface',
  });
  material.userData.shaderGraph = {
    graphId: program.graphId,
    graphVersion: program.graphVersion,
    cacheKey: program.cacheKey,
  };
  return material;
}

function updateThreeValue(current: unknown, next: unknown): unknown {
  if (current instanceof THREE.Color) {
    current.set(next as THREE.ColorRepresentation);
    return current;
  }
  if (current instanceof THREE.Vector2 && Array.isArray(next)) {
    current.fromArray(next as [number, number]);
    return current;
  }
  if (current instanceof THREE.Vector3 && Array.isArray(next)) {
    current.fromArray(next as [number, number, number]);
    return current;
  }
  if (current instanceof THREE.Vector4 && Array.isArray(next)) {
    current.fromArray(next as [number, number, number, number]);
    return current;
  }
  return next;
}

export function updateThreeMaterialFromGraph(
  material: THREE.ShaderMaterial,
  program: CompiledShaderGraph,
  parameters: Record<string, unknown>,
  builtins: Partial<Record<'time' | 'sceneColor' | 'transitionFrom' | 'transitionTo' | 'depth', unknown>> = {},
): void {
  for (const uniform of Object.values(program.uniforms)) {
    const target = material.uniforms[uniform.name];
    if (!target) continue;
    const value =
      uniform.builtin && Object.prototype.hasOwnProperty.call(builtins, uniform.builtin)
        ? builtins[uniform.builtin]
        : uniformValue(uniform, parameters);
    target.value = updateThreeValue(target.value, value);
  }
}

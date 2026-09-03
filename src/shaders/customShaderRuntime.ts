/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import type { PropertyDef, ShaderDef, TextureSlotDef } from '../core/types';
import { createId } from '../core/ids';
import { registerMaterialScope } from '../core/propertyRegistry';
import type { RegistryEntry } from '../core/propertyRegistry';
import type { ShaderDiagnostic } from './graph/types';
import { validateTextureSlotDefinitions } from './textureBindings';

export type CustomShaderTrustState = 'untrusted' | 'trusted' | 'revoked';

export type CustomShaderDefinition = ShaderDef & {
  moduleTrust?: CustomShaderTrustState;
  moduleDiagnostics?: ShaderDiagnostic[];
  moduleRevision?: number;
  moduleLastKnownGoodSource?: string;
};

export interface CustomShaderModule {
  id?: string;
  name: string;
  domain?: ShaderDef['domain'];
  backends?: ShaderDef['backends'];
  parameters?: PropertyDef[];
  textureSlots?: TextureSlotDef[];
  source?: string;
  /**
   * Optional factory. Return any THREE.Material.
   * If omitted, Horizon falls back to MeshPhysicalMaterial using `parameters`.
   */
  createThreeMaterial?: (
    three: typeof THREE,
    params: Record<string, unknown>,
  ) => THREE.Material;
  updateThreeMaterial?: (
    material: THREE.Material,
    three: typeof THREE,
    params: Record<string, unknown>,
  ) => void;
}

export interface CompiledCustomShader {
  definition: CustomShaderDefinition;
  module: CustomShaderModule;
  source: string;
  revision: number;
  diagnostics: ShaderDiagnostic[];
}

interface CompiledCustomShaderEntry extends CompiledCustomShader {
  previous?: CompiledCustomShaderEntry;
}

export interface CustomShaderCompileOptions {
  /**
   * Direct compilation is a trusted capability. Callers loading persisted or
   * imported source should set trust on the definition instead of bypassing it.
   */
  trust?: CustomShaderTrustState;
  maxSourceBytes?: number;
}

export interface CustomShaderCompileAttempt {
  ok: boolean;
  candidate?: CompiledCustomShader;
  active?: CompiledCustomShader;
  diagnostics: ShaderDiagnostic[];
  usingLastKnownGood: boolean;
}

const compiled = new Map<string, CompiledCustomShaderEntry>();
const runtimeDiagnostics = new Map<string, ShaderDiagnostic[]>();
const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024;

export const DEFAULT_CUSTOM_SHADER_TEMPLATE = `/**
 * Horizon custom shader module.
 * Export a default object (or assign to globalThis.horizonShader).
 */
export default {
  name: 'My Custom Shader',
  domain: 'surface',
  parameters: [
    { path: 'baseColor', type: 'color', default: '#4a90d9', value: '#4a90d9' },
    { path: 'metalness', type: 'number', default: 0.1, value: 0.1, min: 0, max: 1 },
    { path: 'roughness', type: 'number', default: 0.35, value: 0.35, min: 0, max: 1 },
    { path: 'emissiveColor', type: 'color', default: '#000000', value: '#000000' },
    { path: 'emissiveIntensity', type: 'number', default: 0, value: 0, min: 0, max: 10 },
    { path: 'bloom', type: 'boolean', default: false, value: false },
  ],
  createThreeMaterial(THREE, params) {
    return new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(params.baseColor ?? '#4a90d9'),
      metalness: params.metalness ?? 0.1,
      roughness: params.roughness ?? 0.35,
      emissive: new THREE.Color(params.emissiveColor ?? '#000000'),
      emissiveIntensity: params.emissiveIntensity ?? 0,
    });
  },
  updateThreeMaterial(material, THREE, params) {
    if (!(material instanceof THREE.MeshPhysicalMaterial)) return;
    material.color.set(params.baseColor ?? '#4a90d9');
    material.metalness = params.metalness ?? 0.1;
    material.roughness = params.roughness ?? 0.35;
    material.emissive.set(params.emissiveColor ?? '#000000');
    material.emissiveIntensity = params.emissiveIntensity ?? 0;
    material.userData.excludeFromBloom = params.bloom !== true;
    material.needsUpdate = true;
  },
};
`;

function propertyToRegistryEntry(param: PropertyDef): RegistryEntry {
  return {
    ...param,
    scope: (param.scope ?? 'all') as RegistryEntry['scope'],
    category: (param as unknown as { category?: string }).category ?? 'shader',
    label: param.label ?? param.path,
  };
}

function asCustomDefinition(shader: Partial<ShaderDef>): Partial<CustomShaderDefinition> {
  return shader as Partial<CustomShaderDefinition>;
}

function sourceDiagnostic(
  error: unknown,
  source: string,
  phase: ShaderDiagnostic['phase'] = 'compile',
): ShaderDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack ?? '' : '';
  const location = /<anonymous>:(\d+):(\d+)/.exec(stack);
  // new Function adds the function wrapper plus our loader prelude.
  const generatedLine = location ? Number(location[1]) : undefined;
  const line =
    generatedLine === undefined
      ? undefined
      : Math.max(1, Math.min(source.split('\n').length, generatedLine - 6));
  return {
    severity: 'error',
    phase,
    code: phase === 'runtime' ? 'CUSTOM_SHADER_RUNTIME_FAILED' : 'CUSTOM_SHADER_COMPILE_FAILED',
    message,
    ...(line === undefined ? {} : { line, column: Number(location?.[2] ?? 1) }),
  };
}

function validateCustomShaderModule(module: CustomShaderModule): ShaderDiagnostic[] {
  const diagnostics: ShaderDiagnostic[] = [];
  const add = (code: string, message: string, path?: string) => {
    diagnostics.push({ severity: 'error', phase: 'validation', code, message, path });
  };
  if (!module || typeof module !== 'object') {
    add('MODULE_EXPORT_INVALID', 'Custom shader module must export an object');
    return diagnostics;
  }
  if (!module.name || typeof module.name !== 'string' || module.name.length > 120) {
    add('MODULE_NAME_INVALID', 'Custom shader name must contain 1 to 120 characters', 'name');
  }
  if (module.id !== undefined && !/^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(module.id)) {
    add('MODULE_ID_INVALID', 'Custom shader id must be a bounded identifier', 'id');
  }
  if (
    module.domain !== undefined &&
    !['surface', 'post', 'field', 'volume'].includes(module.domain)
  ) {
    add('MODULE_DOMAIN_INVALID', `Unsupported custom shader domain "${module.domain}"`, 'domain');
  }
  if (
    module.createThreeMaterial !== undefined &&
    typeof module.createThreeMaterial !== 'function'
  ) {
    add('MATERIAL_FACTORY_INVALID', 'createThreeMaterial must be a function', 'createThreeMaterial');
  }
  if (
    module.updateThreeMaterial !== undefined &&
    typeof module.updateThreeMaterial !== 'function'
  ) {
    add('MATERIAL_UPDATE_INVALID', 'updateThreeMaterial must be a function', 'updateThreeMaterial');
  }
  if (
    module.backends !== undefined &&
    (!Array.isArray(module.backends) ||
      module.backends.some((backend) => backend !== 'webgl' && backend !== 'webgpu'))
  ) {
    add('MODULE_BACKENDS_INVALID', 'backends must contain only webgl and webgpu', 'backends');
  }
  if (module.parameters !== undefined && !Array.isArray(module.parameters)) {
    add('PARAMETERS_INVALID', 'parameters must be an array', 'parameters');
    return diagnostics;
  }
  const parameterPaths = new Set<string>();
  for (const [index, parameter] of (module.parameters ?? []).entries()) {
    const path = `parameters[${index}]`;
    if (!parameter || typeof parameter !== 'object') {
      add('PARAMETER_INVALID', 'Shader parameter must be an object', path);
      continue;
    }
    if (
      !parameter.path ||
      !/^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(parameter.path)
    ) {
      add('PARAMETER_PATH_INVALID', 'Shader parameter path is invalid', `${path}.path`);
    } else if (parameterPaths.has(parameter.path)) {
      add('PARAMETER_DUPLICATE', `Duplicate shader parameter "${parameter.path}"`, `${path}.path`);
    }
    parameterPaths.add(parameter.path);
    if (
      ![
        'boolean',
        'integer',
        'number',
        'string',
        'color',
        'vec2',
        'vec3',
        'vec4',
        'quaternion',
        'enum',
        'reference',
        'texture',
        'asset',
      ].includes(parameter.type)
    ) {
      add('PARAMETER_TYPE_INVALID', `Unsupported parameter type "${parameter.type}"`, `${path}.type`);
    }
  }
  if ((module.parameters?.length ?? 0) > 128) {
    add('PARAMETER_LIMIT_EXCEEDED', 'Custom shaders may expose at most 128 parameters', 'parameters');
  }
  if (module.textureSlots !== undefined && !Array.isArray(module.textureSlots)) {
    add('TEXTURE_SLOTS_INVALID', 'textureSlots must be an array', 'textureSlots');
    return diagnostics;
  }
  for (const entry of validateTextureSlotDefinitions(module.textureSlots)) {
    diagnostics.push({
      severity: entry.severity,
      phase: 'validation',
      code: entry.code,
      message: entry.message,
      path: entry.path,
    });
  }
  return diagnostics;
}

function evaluateModuleSource(source: string): CustomShaderModule {
  const rewritten = source
    .replace(/export\s+default\s+async\s+function/g, 'async function __horizonDefault')
    .replace(/export\s+default\s+function/g, 'function __horizonDefault')
    .replace(/export\s+default\s+class/g, 'class __horizonDefault')
    .replace(/export\s+default\s+/g, '__horizonExport = ');
  const loader = new Function(
    'THREE',
    `
      let __horizonExport;
      let horizonShader;
      const __horizonPreviousGlobal = globalThis.horizonShader;
      try {
        ${rewritten}
        if (typeof __horizonDefault !== 'undefined') __horizonExport = __horizonDefault;
        if (horizonShader) __horizonExport = horizonShader;
        if (globalThis.horizonShader !== __horizonPreviousGlobal) {
          __horizonExport = globalThis.horizonShader;
        }
        return __horizonExport;
      } finally {
        if (__horizonPreviousGlobal === undefined) delete globalThis.horizonShader;
        else globalThis.horizonShader = __horizonPreviousGlobal;
      }
    `,
  );
  const mod = loader(THREE) as CustomShaderModule;
  return mod;
}

export function compileCustomShaderModule(
  source: string,
  existing?: Partial<CustomShaderDefinition>,
  options: CustomShaderCompileOptions = {},
): CompiledCustomShader {
  const trust = options.trust ?? asCustomDefinition(existing ?? {}).moduleTrust ?? 'trusted';
  if (trust !== 'trusted') {
    throw new CustomShaderTrustError(trust);
  }
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  if (new TextEncoder().encode(source).byteLength > maxSourceBytes) {
    throw new Error(`Custom shader source exceeds ${maxSourceBytes} bytes`);
  }
  const module = evaluateModuleSource(source);
  const diagnostics = validateCustomShaderModule(module);
  if (diagnostics.some((entry) => entry.severity === 'error')) {
    throw new CustomShaderValidationError(diagnostics);
  }
  const id = existing?.id ?? module.id ?? createId('shader');
  const previous = compiled.get(id);
  const previousDefinition = asCustomDefinition(existing ?? {});
  const revision = (previousDefinition.moduleRevision ?? previous?.revision ?? 0) + 1;
  const definition: CustomShaderDefinition = {
    id,
    name: module.name,
    domain: module.domain ?? 'surface',
    backends: module.backends ?? ['webgpu', 'webgl'],
    parameters: module.parameters ?? [],
    textureSlots: module.textureSlots,
    source: module.source,
    kind: 'custom-js',
    moduleSource: source,
    moduleValid: true,
    moduleError: undefined,
  };
  definition.moduleTrust = 'trusted';
  definition.moduleDiagnostics = diagnostics;
  definition.moduleRevision = revision;
  definition.moduleLastKnownGoodSource = source;
  const compiledEntry: CompiledCustomShaderEntry = {
    definition,
    module,
    source,
    revision,
    diagnostics,
    previous: previous ? { ...previous, previous: undefined } : undefined,
  };
  compiled.set(id, compiledEntry);
  runtimeDiagnostics.delete(id);
  try {
    registerMaterialScope(id, definition.parameters.map(propertyToRegistryEntry));
  } catch {
    // Registry may already have the scope from a previous compile.
  }
  return compiledEntry;
}

export function getCompiledCustomShader(shaderId: string): CompiledCustomShader | undefined {
  return compiled.get(shaderId);
}

export function invalidateCustomShader(shaderId: string): void {
  compiled.delete(shaderId);
  runtimeDiagnostics.delete(shaderId);
}

export class CustomShaderTrustError extends Error {
  readonly trust: CustomShaderTrustState;

  constructor(trust: CustomShaderTrustState) {
    super(
      trust === 'revoked'
        ? 'Custom shader trust has been revoked'
        : 'Custom JavaScript shader must be explicitly trusted before execution',
    );
    this.name = 'CustomShaderTrustError';
    this.trust = trust;
  }
}

export class CustomShaderValidationError extends Error {
  readonly diagnostics: ShaderDiagnostic[];

  constructor(diagnostics: ShaderDiagnostic[]) {
    super(diagnostics[0]?.message ?? 'Custom shader validation failed');
    this.name = 'CustomShaderValidationError';
    this.diagnostics = diagnostics;
  }
}

export function getCustomShaderTrust(shader: ShaderDef): CustomShaderTrustState {
  return asCustomDefinition(shader).moduleTrust ?? 'untrusted';
}

export function setCustomShaderTrust(
  shader: ShaderDef,
  trust: CustomShaderTrustState,
): void {
  const definition = shader as CustomShaderDefinition;
  definition.moduleTrust = trust;
  if (trust !== 'trusted') {
    compiled.delete(shader.id);
    definition.moduleValid = false;
    definition.moduleError =
      trust === 'revoked'
        ? 'Custom shader trust has been revoked'
        : 'Custom JavaScript shader must be explicitly trusted before execution';
    definition.moduleDiagnostics = [
      {
        severity: 'error',
        phase: 'trust',
        code: trust === 'revoked' ? 'CUSTOM_SHADER_TRUST_REVOKED' : 'CUSTOM_SHADER_UNTRUSTED',
        message: definition.moduleError,
      },
    ];
  }
}

export function tryCompileCustomShaderModule(
  source: string,
  existing?: Partial<CustomShaderDefinition>,
  options: CustomShaderCompileOptions = {},
): CustomShaderCompileAttempt {
  const id = existing?.id;
  const active = id ? compiled.get(id) : undefined;
  try {
    const candidate = compileCustomShaderModule(source, existing, options);
    return {
      ok: true,
      candidate,
      active: candidate,
      diagnostics: candidate.diagnostics,
      usingLastKnownGood: false,
    };
  } catch (error) {
    const diagnostics =
      error instanceof CustomShaderValidationError
        ? error.diagnostics
        : error instanceof CustomShaderTrustError
          ? [
              {
                severity: 'error' as const,
                phase: 'trust' as const,
                code:
                  error.trust === 'revoked'
                    ? 'CUSTOM_SHADER_TRUST_REVOKED'
                    : 'CUSTOM_SHADER_UNTRUSTED',
                message: error.message,
              },
            ]
          : [sourceDiagnostic(error, source)];
    return {
      ok: false,
      active,
      diagnostics,
      usingLastKnownGood: Boolean(active),
    };
  }
}

export function getCustomShaderDiagnostics(shaderId: string): readonly ShaderDiagnostic[] {
  return runtimeDiagnostics.get(shaderId) ?? compiled.get(shaderId)?.diagnostics ?? [];
}

export function reportCustomShaderRuntimeFailure(shaderId: string, error: unknown): void {
  const current = compiled.get(shaderId);
  const diagnostic = sourceDiagnostic(error, current?.source ?? '', 'runtime');
  runtimeDiagnostics.set(shaderId, [diagnostic]);
  if (current) {
    const definition = current.definition as CustomShaderDefinition;
    definition.moduleValid = false;
    definition.moduleError = diagnostic.message;
    definition.moduleDiagnostics = [diagnostic];
    definition.moduleLastKnownGoodSource = current.previous?.source;
  }
  if (current?.previous) compiled.set(shaderId, current.previous);
}

export function ensureCustomShadersCompiled(
  shaders: Record<string, ShaderDef>,
): Record<string, CustomShaderCompileAttempt> {
  const attempts: Record<string, CustomShaderCompileAttempt> = {};
  for (const shader of Object.values(shaders)) {
    if (shader.kind !== 'custom-js' || !shader.moduleSource) continue;
    const definition = shader as CustomShaderDefinition;
    const trust = getCustomShaderTrust(shader);
    const active = compiled.get(shader.id);
    if (trust !== 'trusted') {
      const error = new CustomShaderTrustError(trust);
      const diagnostics: ShaderDiagnostic[] = [
        {
          severity: 'error',
          phase: 'trust',
          code: trust === 'revoked' ? 'CUSTOM_SHADER_TRUST_REVOKED' : 'CUSTOM_SHADER_UNTRUSTED',
          message: error.message,
        },
      ];
      definition.moduleValid = false;
      definition.moduleError = error.message;
      definition.moduleDiagnostics = diagnostics;
      attempts[shader.id] = {
        ok: false,
        diagnostics,
        usingLastKnownGood: false,
      };
      continue;
    }
    if (active?.source === shader.moduleSource && shader.moduleValid) {
      attempts[shader.id] = {
        ok: true,
        candidate: active,
        active,
        diagnostics: active.diagnostics,
        usingLastKnownGood: false,
      };
      continue;
    }
    const attempt = tryCompileCustomShaderModule(shader.moduleSource, shader, { trust });
    attempts[shader.id] = attempt;
    if (attempt.ok && attempt.candidate) {
      shader.moduleValid = true;
      shader.moduleError = undefined;
      definition.moduleDiagnostics = attempt.diagnostics;
      definition.moduleRevision = attempt.candidate.revision;
      definition.moduleLastKnownGoodSource = shader.moduleSource;
    } else {
      shader.moduleValid = false;
      shader.moduleError =
        attempt.diagnostics.find((entry) => entry.severity === 'error')?.message ??
        'Custom shader compilation failed';
      definition.moduleDiagnostics = attempt.diagnostics;
    }
  }
  return attempts;
}

export interface CustomMaterialCreationResult {
  material: THREE.Material;
  usedLastKnownGood: boolean;
  diagnostics: readonly ShaderDiagnostic[];
}

function defaultCustomMaterial(params: Record<string, unknown>): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color((params.baseColor as string) ?? '#808080'),
    metalness: (params.metalness as number) ?? 0,
    roughness: (params.roughness as number) ?? 0.5,
  });
}

export function createCustomThreeMaterial(
  shaderId: string,
  params: Record<string, unknown>,
): CustomMaterialCreationResult {
  const candidate = compiled.get(shaderId);
  if (!candidate?.module.createThreeMaterial) {
    return {
      material: defaultCustomMaterial(params),
      usedLastKnownGood: false,
      diagnostics: getCustomShaderDiagnostics(shaderId),
    };
  }
  try {
    const material = candidate.module.createThreeMaterial(THREE, params);
    if (!(material instanceof THREE.Material)) {
      throw new Error('createThreeMaterial must return a THREE.Material');
    }
    return {
      material,
      usedLastKnownGood: false,
      diagnostics: getCustomShaderDiagnostics(shaderId),
    };
  } catch (error) {
    reportCustomShaderRuntimeFailure(shaderId, error);
    const lastKnownGood = compiled.get(shaderId);
    if (lastKnownGood && lastKnownGood !== candidate && lastKnownGood.module.createThreeMaterial) {
      try {
        const material = lastKnownGood.module.createThreeMaterial(THREE, params);
        if (!(material instanceof THREE.Material)) {
          throw new Error('Last-known-good createThreeMaterial did not return a THREE.Material');
        }
        return {
          material,
          usedLastKnownGood: true,
          diagnostics: getCustomShaderDiagnostics(shaderId),
        };
      } catch (fallbackError) {
        reportCustomShaderRuntimeFailure(shaderId, fallbackError);
      }
    }
    return {
      material: defaultCustomMaterial(params),
      usedLastKnownGood: Boolean(lastKnownGood && lastKnownGood !== candidate),
      diagnostics: getCustomShaderDiagnostics(shaderId),
    };
  }
}

export function updateCustomThreeMaterial(
  shaderId: string,
  material: THREE.Material,
  params: Record<string, unknown>,
): boolean {
  const entry = compiled.get(shaderId);
  if (!entry?.module.updateThreeMaterial) return false;
  try {
    entry.module.updateThreeMaterial(material, THREE, params);
    return true;
  } catch (error) {
    reportCustomShaderRuntimeFailure(shaderId, error);
    return false;
  }
}

export function createMaterialDefaultsFromShader(shader: ShaderDef): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const entry of shader.parameters) {
    params[entry.path] = entry.value ?? entry.default;
  }
  return params;
}

/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PropertyDef, PropertyType } from './types';

export interface RegistryEntry extends PropertyDef {
  scope: 'realtime' | 'master' | 'all';
  category: string;
  group?: string;
  dependsOn?: { path: string; equals?: unknown; notEquals?: unknown };
  order?: number;
}

export interface RegistryScope {
  id: string;
  label: string;
  description?: string;
  entries: RegistryEntry[];
}

/**
 * Central schema for every property surface the editor, WebMCP layer,
 * runtime, and importer/serializer can bind to. One authoritative table
 * describing defaults, ranges, units, backends, dependencies, and animatability.
 */
class PropertyRegistry {
  private scopes = new Map<string, RegistryScope>();

  registerScope(scope: RegistryScope): void {
    const existing = this.scopes.get(scope.id);
    if (existing) {
      const merged = new Map<string, RegistryEntry>();
      for (const entry of existing.entries) merged.set(entry.path, entry);
      for (const entry of scope.entries) merged.set(entry.path, entry);
      this.scopes.set(scope.id, {
        ...existing,
        entries: [...merged.values()],
      });
      return;
    }
    this.scopes.set(scope.id, { ...scope, entries: [...scope.entries] });
  }

  getScope(id: string): RegistryScope | undefined {
    return this.scopes.get(id);
  }

  listScopes(): RegistryScope[] {
    return [...this.scopes.values()];
  }

  find(scopeId: string, path: string): RegistryEntry | undefined {
    return this.scopes.get(scopeId)?.entries.find((e) => e.path === path);
  }

  defaults(scopeId: string): Record<string, unknown> {
    const scope = this.scopes.get(scopeId);
    if (!scope) return {};
    const out: Record<string, unknown> = {};
    for (const entry of scope.entries) {
      setDeep(out, entry.path, cloneDefault(entry.default));
    }
    return out;
  }

  clampValue(entry: RegistryEntry, value: unknown): unknown {
    if (entry.type === 'number' || entry.type === 'integer') {
      const n = typeof value === 'number' ? value : Number(value);
      let clamped = Number.isFinite(n) ? n : (entry.default as number) ?? 0;
      if (entry.min !== undefined) clamped = Math.max(entry.min, clamped);
      if (entry.max !== undefined) clamped = Math.min(entry.max, clamped);
      if (entry.type === 'integer') clamped = Math.round(clamped);
      return clamped;
    }
    if (entry.type === 'boolean') return Boolean(value);
    if (entry.type === 'enum' && entry.choices) {
      const valid = entry.choices.some((c) => c.value === value);
      return valid ? value : entry.default;
    }
    return value;
  }

  validate(scopeId: string, key: string, value: unknown): { ok: true } | { ok: false; error: string } {
    const entry = this.find(scopeId, key);
    if (!entry) return { ok: true };
    if (entry.type === 'number' || entry.type === 'integer') {
      const n = Number(value);
      if (!Number.isFinite(n)) return { ok: false, error: `Invalid number for ${key}` };
      if (entry.min !== undefined && n < entry.min)
        return { ok: false, error: `${key} below min ${entry.min}` };
      if (entry.max !== undefined && n > entry.max)
        return { ok: false, error: `${key} above max ${entry.max}` };
    }
    if (entry.type === 'enum' && entry.choices) {
      if (!entry.choices.some((c) => c.value === value)) {
        return { ok: false, error: `${key} not in enum` };
      }
    }
    return { ok: true };
  }

  supportsBackend(scopeId: string, path: string, backend: 'webgpu' | 'webgl'): boolean {
    const entry = this.find(scopeId, path);
    if (!entry?.backends) return true;
    return entry.backends.includes(backend);
  }
}

function cloneDefault(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === 'object') return structuredClone(value);
  return value;
}

function setDeep(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (let index = 0; index < parts.length - 1; index++) {
    const key = parts[index];
    const next = cursor[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
}

export const propertyRegistry = new PropertyRegistry();

function e(
  path: string,
  type: PropertyType,
  def: unknown,
  extras: Partial<RegistryEntry> = {},
): RegistryEntry {
  return {
    path,
    type,
    default: def,
    value: def,
    scope: extras.scope ?? 'all',
    category: extras.category ?? 'general',
    ...extras,
  };
}

const VISIBILITY_ENTRIES: RegistryEntry[] = [
  e('visibility.visible', 'boolean', true, { category: 'visibility', label: 'visible', animatable: true, runtimeMutable: true, order: 900 }),
  e('visibility.opacity', 'number', 1, { category: 'visibility', label: 'opacity', min: 0, max: 1, step: .01, animatable: true, runtimeMutable: true, order: 901 }),
];

const CAMERA_ENTRIES: RegistryEntry[] = [
  ...VISIBILITY_ENTRIES,
  e('transform.position', 'vec3', [0, 0, 0], { category: 'transform', label: 'position', animatable: true, order: 10 }),
  e('transform.rotation', 'vec3', [0, 0, 0], { category: 'transform', label: 'rotation', animatable: true, unit: 'rad', order: 20 }),
  e('camera.lookAt', 'vec3', [0, 0, 0], { category: 'transform', label: 'look at', animatable: true, order: 25 }),
  e('camera.followTarget', 'reference', '', { category: 'targeting', label: 'follow target', order: 30 }),
  e('camera.focalLength', 'number', 50, {
    category: 'lens',
    label: 'focal length',
    unit: 'mm',
    min: 4,
    max: 800,
    step: 1,
    animatable: true,
    order: 100,
  }),
  e('camera.sensorHeight', 'number', 24, {
    category: 'lens',
    label: 'sensor height',
    unit: 'mm',
    min: 4,
    max: 70,
    step: 0.5,
    order: 110,
  }),
  e('camera.sensorWidth', 'number', 36, {
    category: 'lens',
    label: 'sensor width',
    unit: 'mm',
    min: 6,
    max: 100,
    step: 0.5,
    order: 111,
  }),
  e('camera.sensorPreset', 'enum', 'full-frame', {
    category: 'lens',
    label: 'sensor preset',
    choices: [
      { value: 'super-8', label: 'Super 8' },
      { value: '16mm', label: '16mm' },
      { value: 'super-16', label: 'Super 16' },
      { value: '35mm', label: '35mm Academy' },
      { value: 'super-35', label: 'Super 35' },
      { value: 'full-frame', label: 'Full Frame' },
      { value: 'vista-vision', label: 'VistaVision' },
      { value: 'imax', label: 'IMAX' },
      { value: 'custom', label: 'Custom' },
    ],
    order: 115,
  }),
  e('camera.aperture', 'number', 2.8, {
    category: 'lens',
    label: 'aperture',
    unit: 'f-stop',
    min: 0.7,
    max: 32,
    step: 0.05,
    animatable: true,
    order: 120,
  }),
  e('camera.focus', 'number', 5, {
    category: 'lens',
    label: 'focus distance',
    unit: 'm',
    min: 0.05,
    max: 10000,
    step: 0.05,
    animatable: true,
    order: 130,
  }),
  e('camera.depthOfField', 'boolean', false, {
    category: 'lens',
    label: 'depth of field',
    order: 140,
  }),
  e('camera.maxBlur', 'number', 0.008, {
    category: 'lens',
    label: 'maximum blur',
    min: 0,
    max: 0.05,
    step: 0.001,
    order: 145,
  }),
  e('camera.bladeCount', 'integer', 6, {
    category: 'lens',
    label: 'blade count',
    min: 2,
    max: 12,
    step: 1,
    order: 150,
  }),
  e('camera.bokehShape', 'enum', 'hexagonal', {
    category: 'lens',
    label: 'bokeh shape',
    choices: [
      { value: 'circular' },
      { value: 'hexagonal' },
      { value: 'octagonal' },
    ],
    order: 155,
  }),
  e('camera.anamorphicRatio', 'number', 1, {
    category: 'lens',
    label: 'anamorphic ratio',
    min: 0.5,
    max: 2.5,
    step: 0.01,
    order: 160,
  }),
  e('camera.shutterAngle', 'number', 180, {
    category: 'exposure',
    label: 'shutter angle',
    unit: 'deg',
    min: 0,
    max: 360,
    step: 1,
    order: 200,
  }),
  e('camera.shutterSpeed', 'number', 1 / 50, {
    category: 'exposure',
    label: 'shutter speed',
    unit: 's',
    min: 1 / 8000,
    max: 30,
    step: 0.001,
    order: 210,
  }),
  e('camera.iso', 'number', 200, {
    category: 'exposure',
    label: 'ISO',
    min: 25,
    max: 25600,
    step: 25,
    order: 220,
  }),
  e('camera.exposureCompensation', 'number', 0, {
    category: 'exposure',
    label: 'exposure comp',
    unit: 'EV',
    min: -8,
    max: 8,
    step: 0.1,
    order: 230,
  }),
  e('camera.orthographic', 'boolean', false, {
    category: 'projection',
    label: 'orthographic',
    order: 300,
  }),
  e('camera.orthographicSize', 'number', 5, {
    category: 'projection',
    label: 'ortho size',
    min: 0.1,
    max: 1000,
    step: 0.1,
    dependsOn: { path: 'camera.orthographic', equals: true },
    order: 310,
  }),
  e('camera.near', 'number', 0.1, {
    category: 'projection',
    label: 'near clip',
    min: 0.001,
    max: 1000,
    step: 0.01,
    order: 320,
  }),
  e('camera.far', 'number', 1000, {
    category: 'projection',
    label: 'far clip',
    min: 1,
    max: 100000,
    step: 1,
    order: 330,
  }),
  e('camera.lensShiftX', 'number', 0, {
    category: 'projection',
    label: 'lens shift X',
    min: -1,
    max: 1,
    step: 0.01,
    order: 340,
  }),
  e('camera.lensShiftY', 'number', 0, {
    category: 'projection',
    label: 'lens shift Y',
    min: -1,
    max: 1,
    step: 0.01,
    order: 341,
  }),
  e('camera.distortion', 'number', 0, {
    category: 'lens-defects',
    label: 'distortion',
    min: -1,
    max: 1,
    step: 0.001,
    order: 400,
  }),
  e('camera.breathing', 'number', 0, {
    category: 'lens-defects',
    label: 'breathing',
    min: 0,
    max: 1,
    step: 0.001,
    order: 410,
  }),
  e('camera.vignette', 'number', 0, {
    category: 'lens-defects',
    label: 'vignette',
    min: 0,
    max: 1,
    step: 0.001,
    order: 420,
  }),
];

const LIGHT_ENTRIES: RegistryEntry[] = [
  ...VISIBILITY_ENTRIES,
  e('transform.position', 'vec3', [0, 0, 0], { category: 'transform', label: 'position', animatable: true, order: 10 }),
  e('transform.rotation', 'vec3', [0, 0, 0], { category: 'transform', label: 'rotation', animatable: true, order: 20 }),
  e('light.type', 'enum', 'directional', {
    category: 'general',
    label: 'type',
    choices: [
      { value: 'ambient' },
      { value: 'hemisphere' },
      { value: 'directional' },
      { value: 'point' },
      { value: 'spot' },
      { value: 'rectArea', label: 'rect area' },
    ],
    order: 30,
  }),
  e('light.color', 'color', '#ffffff', { category: 'photometric', label: 'color', order: 40, animatable: true }),
  e('light.temperature', 'number', 5600, {
    category: 'photometric',
    label: 'color temperature',
    unit: 'K',
    min: 1000,
    max: 15000,
    step: 50,
    order: 45,
  }),
  e('light.useTemperature', 'boolean', false, {
    category: 'photometric',
    label: 'use temperature',
    order: 46,
  }),
  e('light.intensity', 'number', 1, {
    category: 'photometric',
    label: 'intensity',
    min: 0,
    max: 10000,
    step: 0.01,
    animatable: true,
    order: 50,
  }),
  e('light.unit', 'enum', 'unitless', {
    category: 'photometric',
    label: 'unit',
    choices: [
      { value: 'unitless' },
      { value: 'lumens' },
      { value: 'candela' },
      { value: 'lux' },
      { value: 'nits' },
    ],
    order: 55,
  }),
  e('light.diffuseContribution', 'number', 1, {
    category: 'photometric',
    label: 'diffuse contribution',
    min: 0,
    max: 4,
    step: 0.01,
    order: 60,
  }),
  e('light.specularContribution', 'number', 1, {
    category: 'photometric',
    label: 'specular contribution',
    min: 0,
    max: 4,
    step: 0.01,
    order: 61,
  }),
  e('light.volumetricContribution', 'number', 1, {
    category: 'photometric',
    label: 'volumetric contribution',
    min: 0,
    max: 4,
    step: 0.01,
    order: 62,
  }),
  e('light.iesAssetId', 'asset', '', { category: 'photometric', label: 'IES profile', order: 70 }),
  e('light.gobo.assetId', 'asset', '', { category: 'gobo', label: 'gobo texture', order: 80 }),
  e('light.gobo.scale', 'number', 1, {
    category: 'gobo',
    label: 'gobo scale',
    min: 0.01,
    max: 100,
    step: 0.01,
    order: 81,
  }),
  e('light.groundColor', 'color', '#080808', {
    category: 'photometric',
    label: 'ground color',
    dependsOn: { path: 'light.type', equals: 'hemisphere' },
    order: 90,
  }),
  e('light.distance', 'number', 0, {
    category: 'attenuation',
    label: 'distance',
    min: 0,
    max: 1000,
    step: 0.01,
    dependsOn: { path: 'light.type', notEquals: 'directional' },
    order: 100,
  }),
  e('light.decay', 'number', 2, {
    category: 'attenuation',
    label: 'decay',
    min: 0,
    max: 4,
    step: 0.01,
    order: 110,
  }),
  e('light.radius', 'number', 0.1, {
    category: 'shape',
    label: 'radius',
    min: 0,
    max: 100,
    step: 0.01,
    order: 120,
  }),
  e('light.softness', 'number', 0.5, {
    category: 'shape',
    label: 'softness',
    min: 0,
    max: 1,
    step: 0.01,
    order: 121,
  }),
  e('light.width', 'number', 1, {
    category: 'shape',
    label: 'width',
    min: 0.001,
    max: 100,
    step: 0.01,
    dependsOn: { path: 'light.type', equals: 'rectArea' },
    order: 130,
  }),
  e('light.height', 'number', 1, {
    category: 'shape',
    label: 'height',
    min: 0.001,
    max: 100,
    step: 0.01,
    dependsOn: { path: 'light.type', equals: 'rectArea' },
    order: 131,
  }),
  e('light.angle', 'number', Math.PI / 3, {
    category: 'shape',
    label: 'cone angle',
    min: 0.01,
    max: Math.PI / 2,
    step: 0.01,
    dependsOn: { path: 'light.type', equals: 'spot' },
    order: 140,
  }),
  e('light.penumbra', 'number', 0, {
    category: 'shape',
    label: 'penumbra',
    min: 0,
    max: 1,
    step: 0.01,
    dependsOn: { path: 'light.type', equals: 'spot' },
    order: 141,
  }),
  e('light.barnDoors', 'vec4', [0, 0, 0, 0], {
    category: 'shape',
    label: 'barn doors',
    dependsOn: { path: 'light.type', equals: 'spot' },
    order: 145,
  }),
  e('light.target', 'vec3', [0, 0, -1], { category: 'shape', label: 'target', animatable: true, order: 150 }),
  e('light.castShadow', 'boolean', false, {
    category: 'shadow',
    label: 'cast shadow',
    order: 200,
  }),
  e('light.shadowType', 'enum', 'pcfSoft', {
    category: 'shadow',
    label: 'shadow type',
    choices: [{ value: 'basic' }, { value: 'pcf' }, { value: 'pcfSoft' }, { value: 'vsm' }],
    order: 210,
  }),
  e('light.shadowMapSize', 'integer', 1024, {
    category: 'shadow',
    label: 'map size',
    min: 64,
    max: 8192,
    step: 64,
    order: 220,
  }),
  e('light.shadowBias', 'number', -0.0001, {
    category: 'shadow',
    label: 'bias',
    min: -0.01,
    max: 0.01,
    step: 0.00001,
    order: 230,
  }),
  e('light.shadowNormalBias', 'number', 0.02, {
    category: 'shadow',
    label: 'normal bias',
    min: 0,
    max: 1,
    step: 0.001,
    order: 231,
  }),
  e('light.shadowRadius', 'number', 1, {
    category: 'shadow',
    label: 'radius',
    min: 0,
    max: 16,
    step: 0.1,
    order: 240,
  }),
  e('light.shadowNear', 'number', 0.5, {
    category: 'shadow',
    label: 'near',
    min: 0.01,
    max: 10000,
    step: 0.1,
    order: 245,
  }),
  e('light.shadowFar', 'number', 500, {
    category: 'shadow',
    label: 'far',
    min: 0.1,
    max: 10000,
    step: 0.1,
    order: 246,
  }),
  e('light.shadowBounds', 'number', 10, {
    category: 'shadow',
    label: 'bounds',
    min: 0.1,
    max: 1000,
    step: 0.1,
    dependsOn: { path: 'light.type', equals: 'directional' },
    order: 247,
  }),
  e('light.shadowCascades', 'integer', 1, {
    category: 'shadow',
    label: 'cascades',
    min: 1,
    max: 4,
    step: 1,
    dependsOn: { path: 'light.type', equals: 'directional' },
    order: 248,
  }),
  e('light.linking.include', 'string', '', {
    category: 'linking',
    label: 'include tags',
    order: 300,
  }),
  e('light.linking.exclude', 'string', '', {
    category: 'linking',
    label: 'exclude tags',
    order: 310,
  }),
];

const MESH_ENTRIES: RegistryEntry[] = [
  ...VISIBILITY_ENTRIES,
  e('transform.position', 'vec3', [0, 0, 0], { category: 'transform', label: 'position', animatable: true, order: 10 }),
  e('transform.rotation', 'vec3', [0, 0, 0], { category: 'transform', label: 'rotation', animatable: true, order: 20 }),
  e('transform.scale', 'vec3', [1, 1, 1], { category: 'transform', label: 'scale', animatable: true, order: 30 }),
  e('mesh.primitive', 'enum', 'plane', {
    category: 'geometry',
    label: 'primitive',
    choices: [
      { value: 'plane' },
      { value: 'box' },
      { value: 'sphere' },
      { value: 'cylinder' },
      { value: 'cone' },
      { value: 'torus' },
      { value: 'imported' },
    ],
    order: 40,
  }),
  e('mesh.width', 'number', 1, {
    category: 'geometry',
    label: 'width',
    min: 0.001,
    max: 10000,
    step: 0.01,
    order: 50,
  }),
  e('mesh.height', 'number', 1, {
    category: 'geometry',
    label: 'height',
    min: 0.001,
    max: 10000,
    step: 0.01,
    order: 51,
  }),
  e('mesh.radius', 'number', 0.5, {
    category: 'geometry',
    label: 'radius',
    min: 0.001,
    max: 10000,
    step: 0.01,
    order: 52,
  }),
  e('mesh.radiusTop', 'number', 0.5, { category: 'geometry', label: 'radius top', min: 0, max: 10000, step: 0.01, order: 53 }),
  e('mesh.radiusBottom', 'number', 0.5, { category: 'geometry', label: 'radius bottom', min: 0, max: 10000, step: 0.01, order: 54 }),
  e('mesh.length', 'number', 1, { category: 'geometry', label: 'length', min: 0.001, max: 10000, step: 0.01, order: 55 }),
  e('mesh.radialSegments', 'integer', 32, { category: 'geometry', label: 'radial segments', min: 3, max: 512, step: 1, order: 56 }),
  e('mesh.heightSegments', 'integer', 1, { category: 'geometry', label: 'height segments', min: 1, max: 512, step: 1, order: 57 }),
  e('mesh.widthSegments', 'integer', 32, { category: 'geometry', label: 'width segments', min: 1, max: 512, step: 1, order: 58 }),
  e('mesh.openEnded', 'boolean', false, { category: 'geometry', label: 'open ended', order: 59 }),
  e('mesh.assetId', 'asset', '', { category: 'geometry', label: 'model asset', order: 60 }),
  e('mesh.castShadow', 'boolean', true, { category: 'rendering', label: 'cast shadow', order: 100 }),
  e('mesh.receiveShadow', 'boolean', true, { category: 'rendering', label: 'receive shadow', order: 110 }),
  e('mesh.reflectionVisible', 'boolean', true, { category: 'rendering', label: 'visible in reflections', order: 120 }),
  e('mesh.envMapIntensity', 'number', 1, { category: 'rendering', label: 'env map intensity', min: 0, max: 10, step: 0.01, order: 121 }),
  e('mesh.instances', 'integer', 1, { category: 'rendering', label: 'instances', min: 1, max: 100000, step: 1, order: 130 }),
  e('mesh.lod', 'integer', 0, { category: 'rendering', label: 'LOD level', min: 0, max: 8, step: 1, order: 140 }),
  e('mesh.subdivision', 'integer', 0, { category: 'geometry', label: 'subdivision', min: 0, max: 6, step: 1, order: 150 }),
  e('mesh.displacementStrength', 'number', 0, { category: 'geometry', label: 'displacement strength', min: -10, max: 10, step: 0.001, order: 155 }),
];

const TEXT_ENTRIES: RegistryEntry[] = [
  ...VISIBILITY_ENTRIES,
  ...MESH_ENTRIES.filter((entry) => entry.path.startsWith('transform.')),
  e('text.value', 'string', 'Text', { category: 'text', label: 'text', order: 40 }),
  e('text.size', 'number', 1, { category: 'text', label: 'size', min: 0.01, max: 1000, step: 0.01, order: 50, animatable: true }),
  e('text.depth', 'number', 0.1, { category: 'text', label: 'extrusion depth', min: 0, max: 100, step: 0.01, order: 60 }),
  e('text.bevel', 'number', 0.02, { category: 'text', label: 'bevel', min: 0, max: 1, step: 0.001, order: 70 }),
  e('text.letterSpacing', 'number', 0, { category: 'text', label: 'letter spacing', min: -1, max: 1, step: 0.001, order: 80 }),
  e('text.fontAssetId', 'asset', '', { category: 'text', label: 'font asset', order: 90 }),
];

const FIELD_ENTRIES: RegistryEntry[] = [
  ...VISIBILITY_ENTRIES,
  e('transform.position', 'vec3', [0, 0, 0], { category: 'transform', label: 'position', animatable: true, order: 10 }),
  e('energy', 'number', 0.6, { category: 'general', label: 'energy', min: 0, max: 100, step: 0.01, animatable: true, order: 20 }),
  e('color', 'color', '#ff6a1a', { category: 'general', label: 'color', animatable: true, order: 30 }),
  e('falloff', 'number', 2.5, { category: 'general', label: 'falloff', min: 0, max: 100, step: 0.01, order: 40 }),
  e('width', 'number', 0.02, { category: 'shape', label: 'width', min: 0, max: 10, step: 0.001, order: 50 }),
  e('scatter', 'number', 0.3, { category: 'shape', label: 'scatter', min: 0, max: 10, step: 0.01, order: 60 }),
  e('height', 'number', 2.4, { category: 'shape', label: 'height', min: 0, max: 100, step: 0.01, order: 70 }),
  e('flarePosition', 'number', 0.45, { category: 'flare', label: 'flare position', min: 0, max: 1, step: 0.01, order: 80 }),
  e('flareTightness', 'number', 155, { category: 'flare', label: 'flare tightness', min: 1, max: 1000, step: 1, order: 81 }),
  e('haloStrength', 'number', 1, { category: 'halo', label: 'halo strength', min: 0, max: 10, step: 0.01, order: 90 }),
  e('haloFalloff', 'number', 34, { category: 'halo', label: 'halo falloff', min: 0, max: 200, step: 0.1, order: 91 }),
];

const ENVIRONMENT_ENTRIES: RegistryEntry[] = [
  e('background.mode', 'enum', 'color', {
    category: 'background',
    label: 'mode',
    choices: [{ value: 'color' }, { value: 'image' }, { value: 'sky' }, { value: 'transparent' }],
    order: 10,
  }),
  e('background.color', 'color', '#050505', { category: 'background', label: 'color', order: 20 }),
  e('background.opacity', 'number', 1, {
    category: 'background',
    label: 'opacity',
    min: 0,
    max: 1,
    step: 0.01,
    order: 30,
  }),
  e('background.imageAssetId', 'asset', '', {
    category: 'background',
    label: 'image asset',
    dependsOn: { path: 'background.mode', equals: 'image' },
    order: 40,
  }),
  e('background.intensity', 'number', 1, {
    category: 'background',
    label: 'intensity',
    min: 0,
    max: 5,
    step: 0.01,
    dependsOn: { path: 'background.mode', equals: 'image' },
    order: 41,
  }),
  e('background.blur', 'number', 0, {
    category: 'background',
    label: 'blur',
    min: 0,
    max: 1,
    step: 0.01,
    dependsOn: { path: 'background.mode', equals: 'image' },
    order: 42,
  }),
  e('background.rotation', 'number', 0, {
    category: 'background',
    label: 'rotation',
    min: -Math.PI,
    max: Math.PI,
    step: 0.01,
    dependsOn: { path: 'background.mode', equals: 'image' },
    order: 43,
  }),
  e('background.visible', 'boolean', true, { category: 'background', label: 'visible', order: 50 }),

  e('ibl.enabled', 'boolean', false, { category: 'ibl', label: 'enabled', order: 100 }),
  e('ibl.assetId', 'asset', '', { category: 'ibl', label: 'HDRI asset', order: 110 }),
  e('ibl.intensity', 'number', 1, { category: 'ibl', label: 'intensity', min: 0, max: 20, step: 0.01, order: 120 }),
  e('ibl.rotation', 'number', 0, { category: 'ibl', label: 'rotation', min: -Math.PI, max: Math.PI, step: 0.01, order: 130 }),
  e('ibl.blur', 'number', 0, { category: 'ibl', label: 'blur', min: 0, max: 1, step: 0.01, order: 140 }),
  e('ibl.diffuse', 'boolean', true, { category: 'ibl', label: 'affects diffuse', order: 150 }),
  e('ibl.specular', 'boolean', true, { category: 'ibl', label: 'affects specular', order: 151 }),
  e('ibl.reflectionVisible', 'boolean', true, { category: 'ibl', label: 'in reflections', order: 160 }),
  e('ibl.refractionVisible', 'boolean', true, { category: 'ibl', label: 'in refractions', order: 161 }),

  e('sky.enabled', 'boolean', false, { category: 'sky', label: 'enabled', order: 200 }),
  e('sky.turbidity', 'number', 3.4, { category: 'sky', label: 'turbidity', min: 1, max: 20, step: 0.1, order: 210 }),
  e('sky.rayleigh', 'number', 2.5, { category: 'sky', label: 'rayleigh', min: 0, max: 10, step: 0.01, order: 220 }),
  e('sky.mieCoefficient', 'number', 0.005, { category: 'sky', label: 'mie coefficient', min: 0, max: 0.1, step: 0.0001, order: 230 }),
  e('sky.mieDirectionalG', 'number', 0.8, { category: 'sky', label: 'mie directional G', min: 0, max: 0.9999, step: 0.001, order: 240 }),
  e('sky.sunElevation', 'number', 15, { category: 'sky', label: 'sun elevation', unit: 'deg', min: -90, max: 90, step: 0.1, order: 250 }),
  e('sky.sunAzimuth', 'number', 180, { category: 'sky', label: 'sun azimuth', unit: 'deg', min: -180, max: 180, step: 0.1, order: 251 }),
  e('sky.sunIntensity', 'number', 1, { category: 'sky', label: 'sun intensity', min: 0, max: 20, step: 0.01, order: 260 }),
  e('sky.groundColor', 'color', '#0a0a0a', { category: 'sky', label: 'ground color', order: 270 }),
  e('sky.groundProjection', 'boolean', false, { category: 'sky', label: 'ground projection', order: 280 }),

  e('fog.enabled', 'boolean', true, { category: 'fog', label: 'enabled', order: 300 }),
  e('fog.mode', 'enum', 'exponential', {
    category: 'fog',
    label: 'mode',
    choices: [{ value: 'exponential' }, { value: 'linear' }, { value: 'height' }],
    order: 310,
  }),
  e('fog.color', 'color', '#050505', { category: 'fog', label: 'color', order: 320 }),
  e('fog.density', 'number', 0.025, {
    category: 'fog',
    label: 'density',
    min: 0,
    max: 0.5,
    step: 0.001,
    dependsOn: { path: 'fog.mode', equals: 'exponential' },
    order: 330,
  }),
  e('fog.near', 'number', 1, {
    category: 'fog',
    label: 'near',
    min: 0,
    max: 1000,
    step: 0.1,
    dependsOn: { path: 'fog.mode', equals: 'linear' },
    order: 340,
  }),
  e('fog.far', 'number', 100, {
    category: 'fog',
    label: 'far',
    min: 0.1,
    max: 10000,
    step: 0.5,
    dependsOn: { path: 'fog.mode', equals: 'linear' },
    order: 341,
  }),
  e('fog.heightFalloff', 'number', 0.1, {
    category: 'fog',
    label: 'height falloff',
    min: 0,
    max: 10,
    step: 0.001,
    dependsOn: { path: 'fog.mode', equals: 'height' },
    order: 350,
  }),
  e('fog.heightMin', 'number', 0, {
    category: 'fog',
    label: 'height min',
    min: -1000,
    max: 1000,
    step: 0.01,
    dependsOn: { path: 'fog.mode', equals: 'height' },
    order: 351,
  }),
  e('fog.heightMax', 'number', 10, {
    category: 'fog',
    label: 'height max',
    min: -1000,
    max: 1000,
    step: 0.01,
    dependsOn: { path: 'fog.mode', equals: 'height' },
    order: 352,
  }),

  e('volumetrics.enabled', 'boolean', false, { category: 'volumetrics', label: 'enabled', order: 400 }),
  e('volumetrics.mist', 'number', 0, { category: 'volumetrics', label: 'mist', min: 0, max: 1, step: 0.01, order: 410 }),
  e('volumetrics.scattering', 'number', 0.5, { category: 'volumetrics', label: 'scattering', min: 0, max: 4, step: 0.01, order: 420 }),
  e('volumetrics.anisotropy', 'number', 0.2, { category: 'volumetrics', label: 'anisotropy', min: -0.99, max: 0.99, step: 0.01, order: 430 }),
  e('volumetrics.noiseScale', 'number', 1, { category: 'volumetrics', label: 'noise scale', min: 0, max: 10, step: 0.01, order: 440 }),
  e('volumetrics.noiseIntensity', 'number', 0.3, { category: 'volumetrics', label: 'noise intensity', min: 0, max: 4, step: 0.01, order: 441 }),
  e('volumetrics.godRays', 'number', 0, { category: 'volumetrics', label: 'god rays', min: 0, max: 2, step: 0.01, order: 450 }),
  e('volumetrics.steps', 'integer', 32, { category: 'volumetrics', label: 'steps', min: 4, max: 256, step: 4, order: 460 }),
  e('volumetrics.shadowSteps', 'integer', 8, { category: 'volumetrics', label: 'shadow steps', min: 0, max: 64, step: 1, order: 461 }),

  e('atmosphere.haze', 'number', 0, { category: 'grading', label: 'haze', min: 0, max: 1, step: 0.01, order: 500 }),
  e('atmosphere.washout', 'number', 0, { category: 'grading', label: 'washout', min: 0, max: 1, step: 0.01, order: 510 }),
  e('atmosphere.colorCast', 'color', '#ffffff', { category: 'grading', label: 'color cast', order: 520 }),
  e('atmosphere.colorCastStrength', 'number', 0, { category: 'grading', label: 'color cast strength', min: 0, max: 1, step: 0.01, order: 521 }),
  e('atmosphere.exposure', 'number', 0, { category: 'grading', label: 'exposure', unit: 'EV', min: -5, max: 5, step: 0.05, order: 530 }),
  e('atmosphere.saturation', 'number', 1, { category: 'grading', label: 'saturation', min: 0, max: 2, step: 0.01, order: 540 }),
  e('atmosphere.contrast', 'number', 1, { category: 'grading', label: 'contrast', min: 0, max: 2, step: 0.01, order: 550 }),
  e('atmosphere.highlightRolloff', 'number', 0.5, { category: 'grading', label: 'highlight rolloff', min: 0, max: 1, step: 0.01, order: 560 }),
  e('atmosphere.vignette', 'number', 0, { category: 'grading', label: 'vignette', min: 0, max: 1, step: 0.01, order: 570 }),
  e('atmosphere.chromaticAberration', 'number', 0, { category: 'grading', label: 'chromatic aberration', min: 0, max: 1, step: 0.01, order: 580 }),
  e('atmosphere.filmGrain', 'number', 0, { category: 'grading', label: 'film grain', min: 0, max: 1, step: 0.01, order: 590 }),
  e('atmosphere.sharpening', 'number', 0, { category: 'grading', label: 'sharpening', min: 0, max: 2, step: 0.01, order: 600 }),
  e('atmosphere.lensDirt', 'number', 0, { category: 'grading', label: 'lens dirt', min: 0, max: 1, step: 0.01, order: 610 }),
  e('atmosphere.anamorphicStreak', 'number', 0, { category: 'grading', label: 'anamorphic streak', min: 0, max: 1, step: 0.01, order: 620 }),
];

const RENDER_ENTRIES: RegistryEntry[] = [
  e('activePresetId', 'string', '', { category: 'general', label: 'active preset', order: 10 }),
  e('qualityProfileId', 'string', 'interactive', { category: 'general', label: 'quality profile', order: 20 }),
  e('masterBackend', 'enum', 'auto', {
    category: 'general',
    label: 'master backend',
    choices: [{ value: 'auto' }, { value: 'webgpu' }, { value: 'webgl' }],
    order: 30,
  }),
  e('realtimeBackend', 'enum', 'auto', {
    category: 'general',
    label: 'realtime backend',
    choices: [{ value: 'auto' }, { value: 'webgpu' }, { value: 'webgl' }],
    order: 31,
  }),
  e('deterministicSeed', 'integer', 1, {
    category: 'general',
    label: 'deterministic seed',
    min: 0,
    max: 2 ** 31 - 1,
    step: 1,
    order: 40,
  }),

  e('colorManagement.workingSpace', 'enum', 'linear-srgb', {
    category: 'color',
    label: 'working space',
    choices: [{ value: 'linear-srgb' }, { value: 'linear-p3' }, { value: 'linear-rec2020' }],
    order: 100,
  }),
  e('colorManagement.outputSpace', 'enum', 'srgb', {
    category: 'color',
    label: 'output space',
    choices: [{ value: 'srgb' }, { value: 'display-p3' }, { value: 'rec2020-pq' }],
    order: 110,
  }),
  e('colorManagement.toneMapping', 'enum', 'aces', {
    category: 'color',
    label: 'tone mapping',
    choices: [
      { value: 'none' },
      { value: 'linear' },
      { value: 'reinhard' },
      { value: 'cineon' },
      { value: 'aces' },
      { value: 'agx' },
      { value: 'agx-neutral' },
      { value: 'khronos-neutral' },
    ],
    order: 120,
  }),
  e('colorManagement.toneMappingExposure', 'number', 1, {
    category: 'color',
    label: 'exposure',
    min: 0,
    max: 8,
    step: 0.01,
    order: 130,
  }),
  e('colorManagement.contrast', 'number', 1, { category: 'color', label: 'contrast', min: 0, max: 2, step: 0.01, order: 140 }),
  e('colorManagement.saturation', 'number', 1, { category: 'color', label: 'saturation', min: 0, max: 2, step: 0.01, order: 150 }),
  e('colorManagement.whiteBalance', 'number', 0, { category: 'color', label: 'white balance', unit: 'K', min: -3000, max: 3000, step: 10, order: 160 }),
  e('colorManagement.tint', 'number', 0, { category: 'color', label: 'tint', min: -1, max: 1, step: 0.01, order: 170 }),
  e('colorManagement.lutAssetId', 'asset', '', { category: 'color', label: 'LUT asset', order: 180 }),
  e('colorManagement.lutStrength', 'number', 1, { category: 'color', label: 'LUT strength', min: 0, max: 1, step: 0.01, order: 181 }),
  e('colorManagement.gamutClipMode', 'enum', 'compress', {
    category: 'color',
    label: 'gamut clip',
    choices: [{ value: 'none' }, { value: 'clip' }, { value: 'compress' }],
    order: 190,
  }),

  e('post.enabled', 'boolean', true, { category: 'post', label: 'enabled', order: 200 }),
  e('post.bloom.enabled', 'boolean', true, { category: 'post-bloom', label: 'bloom enabled', order: 210 }),
  e('post.bloom.threshold', 'number', 0.9, { category: 'post-bloom', label: 'threshold', min: 0, max: 5, step: 0.01, order: 211 }),
  e('post.bloom.strength', 'number', 0.4, { category: 'post-bloom', label: 'strength', min: 0, max: 5, step: 0.01, order: 212 }),
  e('post.bloom.radius', 'number', 0.28, { category: 'post-bloom', label: 'radius', min: 0, max: 2, step: 0.01, order: 213 }),
  e('post.bloom.highlightsOnly', 'boolean', false, { category: 'post-bloom', label: 'highlights only', order: 214 }),
  e('post.bloom.anamorphicStreak', 'number', 0, { category: 'post-bloom', label: 'anamorphic streak', min: 0, max: 1, step: 0.01, order: 215 }),
  e('post.bloom.streakAngle', 'number', 0, { category: 'post-bloom', label: 'streak angle', unit: 'rad', min: -Math.PI, max: Math.PI, step: 0.01, order: 216 }),

  e('post.dof.enabled', 'boolean', false, { category: 'post-dof', label: 'DOF enabled', order: 220 }),
  e('post.dof.aperture', 'number', 2.8, { category: 'post-dof', label: 'aperture', min: 0.7, max: 32, step: 0.05, order: 221 }),
  e('post.dof.focus', 'number', 5, { category: 'post-dof', label: 'focus', min: 0.05, max: 10000, step: 0.05, order: 222 }),
  e('post.dof.maxBlur', 'number', 0.008, { category: 'post-dof', label: 'max blur', min: 0, max: 0.05, step: 0.001, order: 223 }),
  e('post.dof.quality', 'enum', 'medium', {
    category: 'post-dof',
    label: 'quality',
    choices: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
    order: 224,
  }),
  e('post.dof.bokehShape', 'enum', 'hexagonal', {
    category: 'post-dof',
    label: 'bokeh shape',
    choices: [{ value: 'circular' }, { value: 'hexagonal' }, { value: 'octagonal' }],
    order: 225,
  }),
  e('post.dof.bladeCount', 'integer', 6, { category: 'post-dof', label: 'blade count', min: 2, max: 12, step: 1, order: 226 }),
  e('post.dof.focusPickerId', 'string', '', { category: 'post-dof', label: 'focus picker', order: 227 }),

  e('post.motionBlur.enabled', 'boolean', false, { category: 'post-mb', label: 'motion blur enabled', order: 230 }),
  e('post.motionBlur.shutterAngle', 'number', 180, { category: 'post-mb', label: 'shutter angle', unit: 'deg', min: 0, max: 360, step: 1, order: 231 }),
  e('post.motionBlur.strength', 'number', 1, { category: 'post-mb', label: 'strength', min: 0, max: 4, step: 0.01, order: 232 }),
  e('post.motionBlur.samples', 'integer', 8, { category: 'post-mb', label: 'samples', min: 1, max: 64, step: 1, order: 233 }),

  e('post.vignette.enabled', 'boolean', false, { category: 'post-vignette', label: 'enabled', order: 240 }),
  e('post.vignette.strength', 'number', 0.3, { category: 'post-vignette', label: 'strength', min: 0, max: 1, step: 0.01, order: 241 }),
  e('post.vignette.radius', 'number', 0.6, { category: 'post-vignette', label: 'radius', min: 0, max: 2, step: 0.01, order: 242 }),
  e('post.vignette.softness', 'number', 0.5, { category: 'post-vignette', label: 'softness', min: 0, max: 1, step: 0.01, order: 243 }),
  e('post.vignette.color', 'color', '#000000', { category: 'post-vignette', label: 'color', order: 244 }),

  e('post.filmGrain.enabled', 'boolean', false, { category: 'post-grain', label: 'enabled', order: 250 }),
  e('post.filmGrain.strength', 'number', 0.15, { category: 'post-grain', label: 'strength', min: 0, max: 1, step: 0.01, order: 251 }),
  e('post.filmGrain.size', 'number', 1, { category: 'post-grain', label: 'size', min: 0.1, max: 8, step: 0.05, order: 252 }),
  e('post.filmGrain.animated', 'boolean', true, { category: 'post-grain', label: 'animated', order: 253 }),

  e('post.sharpen.enabled', 'boolean', false, { category: 'post-sharpen', label: 'enabled', order: 260 }),
  e('post.sharpen.strength', 'number', 0.5, { category: 'post-sharpen', label: 'strength', min: 0, max: 2, step: 0.01, order: 261 }),
  e('post.sharpen.radius', 'number', 1, { category: 'post-sharpen', label: 'radius', min: 0.1, max: 4, step: 0.1, order: 262 }),

  e('post.chromaticAberration.enabled', 'boolean', false, { category: 'post-ca', label: 'enabled', order: 270 }),
  e('post.chromaticAberration.strength', 'number', 0.15, { category: 'post-ca', label: 'strength', min: 0, max: 1, step: 0.01, order: 271 }),

  e('post.lensDirt.enabled', 'boolean', false, { category: 'post-dirt', label: 'enabled', order: 280 }),
  e('post.lensDirt.strength', 'number', 0.3, { category: 'post-dirt', label: 'strength', min: 0, max: 1, step: 0.01, order: 281 }),
  e('post.lensDirt.assetId', 'asset', '', { category: 'post-dirt', label: 'texture', order: 282 }),

  e('post.toneCurve.enabled', 'boolean', false, { category: 'post-curve', label: 'enabled', order: 290 }),
  e('post.toneCurve.shadowLift', 'number', 0, { category: 'post-curve', label: 'shadow lift', min: -1, max: 1, step: 0.01, order: 291 }),
  e('post.toneCurve.midtoneOffset', 'number', 0, { category: 'post-curve', label: 'midtone offset', min: -1, max: 1, step: 0.01, order: 292 }),
  e('post.toneCurve.highlightGain', 'number', 0, { category: 'post-curve', label: 'highlight gain', min: -1, max: 1, step: 0.01, order: 293 }),

  e('shadows.enabled', 'boolean', true, { category: 'shadows', label: 'enabled', order: 300 }),
  e('shadows.type', 'enum', 'pcfSoft', {
    category: 'shadows',
    label: 'type',
    choices: [{ value: 'basic' }, { value: 'pcf' }, { value: 'pcfSoft' }, { value: 'vsm' }],
    order: 310,
  }),
  e('shadows.mapSize', 'integer', 2048, { category: 'shadows', label: 'map size', min: 64, max: 8192, step: 64, order: 320 }),
  e('shadows.cascades', 'integer', 1, { category: 'shadows', label: 'cascades', min: 1, max: 4, step: 1, order: 330 }),
  e('shadows.bias', 'number', -0.0001, { category: 'shadows', label: 'bias', min: -0.01, max: 0.01, step: 0.00001, order: 340 }),
  e('shadows.normalBias', 'number', 0.02, { category: 'shadows', label: 'normal bias', min: 0, max: 1, step: 0.001, order: 341 }),
  e('shadows.radius', 'number', 1, { category: 'shadows', label: 'radius', min: 0, max: 16, step: 0.1, order: 350 }),
  e('shadows.near', 'number', 0.5, { category: 'shadows', label: 'near', min: 0.01, max: 10000, step: 0.1, order: 360 }),
  e('shadows.far', 'number', 500, { category: 'shadows', label: 'far', min: 0.1, max: 10000, step: 0.1, order: 361 }),
  e('shadows.bounds', 'number', 20, { category: 'shadows', label: 'directional bounds', min: 0.1, max: 1000, step: 0.5, order: 362 }),

  e('ao.enabled', 'boolean', true, { category: 'ao', label: 'enabled', order: 400 }),
  e('ao.mode', 'enum', 'gtao', {
    category: 'ao',
    label: 'mode',
    choices: [{ value: 'off' }, { value: 'ssao' }, { value: 'gtao' }],
    order: 410,
  }),
  e('ao.intensity', 'number', 0.9, { category: 'ao', label: 'intensity', min: 0, max: 4, step: 0.01, order: 420 }),
  e('ao.radius', 'number', 0.8, { category: 'ao', label: 'radius', min: 0.01, max: 10, step: 0.01, order: 430 }),
  e('ao.samples', 'integer', 16, { category: 'ao', label: 'samples', min: 1, max: 64, step: 1, order: 440 }),
  e('ao.bias', 'number', 0.01, { category: 'ao', label: 'bias', min: 0, max: 1, step: 0.001, order: 450 }),
  e('ao.falloff', 'number', 0.3, { category: 'ao', label: 'falloff', min: 0, max: 4, step: 0.01, order: 460 }),

  e('reflections.ssr.enabled', 'boolean', false, {
    category: 'ssr',
    label: 'SSR enabled',
    backends: ['webgpu'],
    order: 500,
  }),
  e('reflections.ssr.quality', 'enum', 'medium', {
    category: 'ssr',
    label: 'quality',
    choices: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
    backends: ['webgpu'],
    order: 510,
  }),
  e('reflections.ssr.thickness', 'number', 0.2, { category: 'ssr', label: 'thickness', min: 0.01, max: 4, step: 0.01, order: 520 }),
  e('reflections.ssr.maxSteps', 'integer', 32, { category: 'ssr', label: 'max steps', min: 4, max: 256, step: 1, order: 530 }),
  e('reflections.ssr.intensity', 'number', 1, { category: 'ssr', label: 'intensity', min: 0, max: 4, step: 0.01, order: 540 }),
  e('reflections.probes.enabled', 'boolean', false, { category: 'probes', label: 'probes enabled', order: 550 }),
  e('reflections.probes.updatePolicy', 'enum', 'once', {
    category: 'probes',
    label: 'update policy',
    choices: [{ value: 'once' }, { value: 'every_n_frames' }, { value: 'realtime' }],
    order: 560,
  }),
  e('reflections.probes.updateInterval', 'integer', 30, { category: 'probes', label: 'interval (frames)', min: 1, max: 600, step: 1, order: 570 }),
  e('reflections.probes.boxProjection', 'boolean', false, { category: 'probes', label: 'box projection', order: 580 }),
];

const QUALITY_ENTRIES: RegistryEntry[] = [
  e('renderScale', 'number', 1, { category: 'general', label: 'render scale', min: 0.25, max: 2, step: 0.05, order: 10 }),
  e('pixelRatioCap', 'number', 2, { category: 'general', label: 'pixel ratio cap', min: 0.5, max: 4, step: 0.1, order: 20 }),
  e('antialiasing', 'enum', 'smaa', {
    category: 'antialiasing',
    label: 'AA mode',
    choices: [
      { value: 'none' },
      { value: 'smaa' },
      { value: 'msaa2' },
      { value: 'msaa4' },
      { value: 'msaa8' },
      { value: 'taa' },
    ],
    order: 30,
  }),
  e('msaaSamples', 'integer', 4, { category: 'antialiasing', label: 'MSAA samples', min: 1, max: 16, step: 1, order: 40 }),
  e('taaSamples', 'integer', 8, { category: 'antialiasing', label: 'TAA samples', min: 1, max: 64, step: 1, order: 50 }),
  e('spatialSamples', 'integer', 1, { category: 'sampling', label: 'spatial samples', min: 1, max: 256, step: 1, scope: 'master', order: 60 }),
  e('temporalSamples', 'integer', 1, { category: 'sampling', label: 'temporal samples', min: 1, max: 64, step: 1, scope: 'master', order: 70 }),
  e('motionBlurSamples', 'integer', 8, { category: 'sampling', label: 'motion blur samples', min: 1, max: 128, step: 1, order: 80 }),
  e('shadowMapSize', 'integer', 2048, { category: 'shadows', label: 'shadow map size', min: 64, max: 8192, step: 64, order: 90 }),
  e('shadowCascades', 'integer', 1, { category: 'shadows', label: 'cascades', min: 1, max: 4, step: 1, order: 91 }),
  e('reflectionResolution', 'integer', 512, { category: 'reflections', label: 'reflection resolution', min: 64, max: 4096, step: 64, order: 100 }),
  e('volumetricSteps', 'integer', 24, { category: 'volumetrics', label: 'volumetric steps', min: 4, max: 256, step: 4, order: 110 }),
  e('volumetricShadowSteps', 'integer', 4, { category: 'volumetrics', label: 'shadow steps', min: 0, max: 64, step: 1, order: 120 }),
  e('bloomQuality', 'enum', 'medium', {
    category: 'post',
    label: 'bloom quality',
    choices: [{ value: 'off' }, { value: 'low' }, { value: 'medium' }, { value: 'high' }],
    order: 130,
  }),
  e('ssaoQuality', 'enum', 'off', {
    category: 'post',
    label: 'AO quality',
    choices: [{ value: 'off' }, { value: 'low' }, { value: 'medium' }, { value: 'high' }],
    order: 140,
  }),
  e('ssrQuality', 'enum', 'off', {
    category: 'post',
    label: 'SSR quality',
    choices: [{ value: 'off' }, { value: 'low' }, { value: 'medium' }, { value: 'high' }],
    backends: ['webgpu'],
    order: 150,
  }),
  e('dofQuality', 'enum', 'medium', {
    category: 'post',
    label: 'DOF quality',
    choices: [{ value: 'off' }, { value: 'low' }, { value: 'medium' }, { value: 'high' }],
    order: 160,
  }),
  e('motionBlurQuality', 'enum', 'off', {
    category: 'post',
    label: 'motion blur',
    choices: [{ value: 'off' }, { value: 'low' }, { value: 'medium' }, { value: 'high' }],
    order: 170,
  }),
  e('textureBudgetMb', 'integer', 512, { category: 'memory', label: 'texture budget', unit: 'MB', min: 32, max: 8192, step: 32, order: 180 }),
  e('particleBudget', 'integer', 100000, { category: 'memory', label: 'particle budget', min: 100, max: 10000000, step: 100, order: 190 }),
  e('postQuality', 'enum', 'medium', {
    category: 'post',
    label: 'post quality',
    choices: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
    order: 200,
  }),
  e('adaptive', 'boolean', true, { category: 'adaptive', label: 'adaptive', order: 210 }),
  e('frameTargetMs', 'number', 16.7, { category: 'adaptive', label: 'frame target', unit: 'ms', min: 4, max: 60, step: 0.1, order: 220 }),
];

const OUTPUT_ENTRIES: RegistryEntry[] = [
  e('width', 'integer', 1920, { category: 'dimensions', label: 'width', min: 1, max: 16384, step: 1, order: 10 }),
  e('height', 'integer', 1080, { category: 'dimensions', label: 'height', min: 1, max: 16384, step: 1, order: 20 }),
  e('pixelAspect', 'number', 1, { category: 'dimensions', label: 'pixel aspect', min: 0.5, max: 3, step: 0.001, order: 30 }),
  e('fps', 'number', 30, { category: 'time', label: 'fps', min: 1, max: 240, step: 1, order: 40 }),
  e('frameStart', 'integer', 0, { category: 'time', label: 'frame start', min: 0, max: 1000000, step: 1, order: 50 }),
  e('frameEnd', 'integer', 240, { category: 'time', label: 'frame end', min: 0, max: 1000000, step: 1, order: 60 }),
  e('format', 'enum', 'png', {
    category: 'format',
    label: 'format',
    choices: [
      { value: 'png' },
      { value: 'webp' },
      { value: 'jpeg' },
      { value: 'sequence-png', label: 'PNG Sequence' },
      { value: 'sequence-webp', label: 'WebP Sequence' },
      { value: 'video-webm', label: 'WebM (WebCodecs)' },
      { value: 'video-mp4', label: 'MP4 (WebCodecs)' },
    ],
    order: 70,
  }),
  e('bitDepth', 'enum', 8, {
    category: 'format',
    label: 'bit depth',
    choices: [
      { value: 8 as unknown as string },
      { value: 16 as unknown as string },
      { value: 32 as unknown as string },
    ],
    order: 80,
  }),
  e('colorSpace', 'enum', 'sRGB', {
    category: 'format',
    label: 'color space',
    choices: [{ value: 'sRGB' }, { value: 'linear' }, { value: 'display-p3' }],
    order: 90,
  }),
  e('transparent', 'boolean', false, { category: 'format', label: 'transparent', order: 100 }),
  e('premultipliedAlpha', 'boolean', true, { category: 'format', label: 'premultiplied alpha', order: 110 }),
  e('outputBackground', 'enum', 'scene', {
    category: 'format',
    label: 'output background',
    choices: [{ value: 'scene' }, { value: 'transparent' }, { value: 'color' }, { value: 'image' }],
    order: 120,
  }),
  e('outputBackgroundColor', 'color', '#000000', {
    category: 'format',
    label: 'background color',
    dependsOn: { path: 'outputBackground', equals: 'color' },
    order: 121,
  }),
  e('filenameTemplate', 'string', 'horizon_{preset}_{frame:04d}', { category: 'files', label: 'filename template', order: 130 }),
  e('overwritePolicy', 'enum', 'increment', {
    category: 'files',
    label: 'overwrite policy',
    choices: [{ value: 'skip' }, { value: 'overwrite' }, { value: 'increment' }],
    order: 140,
  }),
  e('videoBitrateMbps', 'number', 30, { category: 'video', label: 'bitrate', unit: 'Mbps', min: 0.1, max: 1200, step: 0.1, order: 200 }),
  e('videoKeyframeInterval', 'integer', 60, { category: 'video', label: 'keyframe interval', min: 1, max: 600, step: 1, order: 210 }),
  e('videoCodec', 'enum', 'auto', {
    category: 'video',
    label: 'codec',
    choices: [{ value: 'auto' }, { value: 'avc' }, { value: 'hevc' }, { value: 'vp9' }, { value: 'av1' }],
    order: 220,
  }),
  e('videoContainer', 'enum', 'auto', {
    category: 'video',
    label: 'container',
    choices: [{ value: 'auto' }, { value: 'mp4' }, { value: 'webm' }],
    order: 230,
  }),
  e('jpegQuality', 'integer', 92, { category: 'still', label: 'JPEG quality', min: 1, max: 100, step: 1, order: 240 }),
  e('webpQuality', 'integer', 92, { category: 'still', label: 'WebP quality', min: 1, max: 100, step: 1, order: 250 }),
];

const AOV_ENTRIES: RegistryEntry[] = [
  e('name', 'string', 'beauty', { category: 'general', label: 'name', order: 10 }),
  e('kind', 'enum', 'beauty', {
    category: 'general',
    label: 'kind',
    choices: [
      { value: 'beauty' },
      { value: 'depth' },
      { value: 'normal' },
      { value: 'worldNormal' },
      { value: 'objectId' },
      { value: 'materialId' },
      { value: 'emission' },
      { value: 'shadow' },
      { value: 'motionVector' },
      { value: 'alpha' },
      { value: 'ao' },
      { value: 'reflection' },
    ],
    order: 20,
  }),
  e('enabled', 'boolean', true, { category: 'general', label: 'enabled', order: 30 }),
  e('bitDepth', 'enum', 8, {
    category: 'format',
    label: 'bit depth',
    choices: [
      { value: 8 as unknown as string },
      { value: 16 as unknown as string },
      { value: 32 as unknown as string },
    ],
    order: 40,
  }),
  e('channels', 'enum', 'rgba', {
    category: 'format',
    label: 'channels',
    choices: [{ value: 'rgba' }, { value: 'rgb' }, { value: 'r' }, { value: 'depth' }],
    order: 50,
  }),
  e('colorSpace', 'enum', 'linear', {
    category: 'format',
    label: 'color space',
    choices: [{ value: 'linear' }, { value: 'sRGB' }, { value: 'data' }],
    order: 60,
  }),
];

const DOM_LAYOUT_ENTRIES: RegistryEntry[] = [
  ...VISIBILITY_ENTRIES,
  e('layout.space', 'enum', 'screen', {
    category: 'layout',
    label: 'anchor space',
    choices: [{ value: 'screen', label: 'Camera / screen' }, { value: 'world', label: 'World' }],
    order: 1,
  }),
  e('transform.position', 'vec3', [0, 0, 0], {
    category: 'world-anchor',
    label: 'world position',
    animatable: true,
    order: 2,
  }),
  e('layout.worldScale', 'number', 1, {
    category: 'world-anchor',
    label: 'perspective scale',
    min: 0.05,
    max: 20,
    step: 0.05,
    animatable: true,
    order: 3,
  }),
  e('layout.position', 'vec2', [50, 50], { category: 'layout', label: 'position (%)', animatable: true, order: 10 }),
  e('layout.size', 'vec2', [40, 20], { category: 'layout', label: 'size (%)', animatable: true, order: 20 }),
  e('layout.anchor', 'vec2', [0.5, 0.5], { category: 'layout', label: 'anchor', animatable: true, order: 30 }),
  e('layout.rotation', 'number', 0, { category: 'layout', label: 'rotation', unit: 'deg', animatable: true, order: 40 }),
  e('layout.scale', 'number', 1, { category: 'layout', label: 'scale', min: 0, max: 20, step: 0.01, animatable: true, order: 50 }),
  e('layout.opacity', 'number', 1, { category: 'layout', label: 'opacity', min: 0, max: 1, step: 0.01, animatable: true, order: 60 }),
  e('layout.zIndex', 'integer', 0, { category: 'layout', label: 'stack order', min: -1000, max: 1000, order: 70 }),
  e('interaction.enabled', 'boolean', false, { category: 'interaction', label: 'hit testing', order: 100 }),
];

const DYNAMIC_TEXT_ENTRIES: RegistryEntry[] = [
  e('text.value', 'string', 'Dynamic Text', { category: 'content', label: 'text', animatable: true, runtimeMutable: true, order: 1 }),
  e('text.color', 'color', '#f5f5f5', { category: 'appearance', label: 'color', animatable: true, runtimeMutable: true, order: 10 }),
  e('text.fontSize', 'number', 32, { category: 'appearance', label: 'font size', min: 6, max: 320, step: 1, animatable: true, runtimeMutable: true, order: 20 }),
  e('text.fontWeight', 'integer', 700, { category: 'appearance', label: 'font weight', min: 100, max: 900, step: 100, runtimeMutable: true, order: 30 }),
  e('text.lineHeight', 'number', 1, { category: 'appearance', label: 'line height', min: 0.5, max: 3, step: 0.05, runtimeMutable: true, order: 40 }),
  e('text.letterSpacing', 'number', -0.04, { category: 'appearance', label: 'letter spacing', min: -0.2, max: 1, step: 0.01, runtimeMutable: true, order: 50 }),
  ...DOM_LAYOUT_ENTRIES,
];
const HTML_ENTRIES: RegistryEntry[] = [
  e('html.content', 'string', '<div>HTML layer</div>', { category: 'content', label: 'HTML', animatable: true, runtimeMutable: true, order: 1 }),
  ...DOM_LAYOUT_ENTRIES,
];
const SVG_ENTRIES: RegistryEntry[] = [
  e('svg.content', 'string', '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="36" fill="currentColor"/></svg>', { category: 'content', label: 'SVG', animatable: true, runtimeMutable: true, order: 1 }),
  ...DOM_LAYOUT_ENTRIES,
];
const IMAGE_LAYER_ENTRIES: RegistryEntry[] = [
  e('asset.id', 'asset', '', { category: 'content', label: 'image asset', runtimeMutable: true, order: 1 }),
  e('image.fit', 'enum', 'contain', { category: 'content', label: 'fit', choices: [{ value: 'contain' }, { value: 'cover' }, { value: 'fill' }], order: 2 }),
  ...DOM_LAYOUT_ENTRIES,
];
const VIDEO_LAYER_ENTRIES: RegistryEntry[] = [
  e('asset.id', 'asset', '', { category: 'content', label: 'video asset', order: 1 }),
  e('media.alphaMode', 'enum', 'auto', {
    category: 'compositing',
    label: 'alpha',
    choices: [{ value: 'auto' }, { value: 'straight' }, { value: 'packed-sbs' }, { value: 'premultiplied' }, { value: 'opaque' }],
    order: 5,
  }),
  e('media.autoplay', 'boolean', false, { category: 'playback', label: 'autoplay', order: 10 }),
  e('media.loop', 'boolean', false, { category: 'playback', label: 'loop', order: 20 }),
  e('media.muted', 'boolean', true, { category: 'playback', label: 'muted', order: 30 }),
  e('media.volume', 'number', 1, { category: 'playback', label: 'volume', min: 0, max: 1, step: 0.01, animatable: true, order: 40 }),
  e('media.currentTime', 'number', 0, { category: 'playback', label: 'time', min: 0, step: 0.01, animatable: true, order: 50 }),
  ...DOM_LAYOUT_ENTRIES,
];
const AUDIO_LAYER_ENTRIES: RegistryEntry[] = [
  e('asset.id', 'asset', '', { category: 'content', label: 'audio asset', order: 1 }),
  e('media.autoplay', 'boolean', false, { category: 'playback', label: 'autoplay', order: 10 }),
  e('media.loop', 'boolean', false, { category: 'playback', label: 'loop', order: 20 }),
  e('media.muted', 'boolean', false, { category: 'playback', label: 'muted', order: 30 }),
  e('media.volume', 'number', 1, { category: 'playback', label: 'volume', min: 0, max: 1, step: 0.01, animatable: true, order: 40 }),
  e('media.currentTime', 'number', 0, { category: 'playback', label: 'time', min: 0, step: 0.01, animatable: true, order: 50 }),
];
const EFFECT_LAYER_ENTRIES: RegistryEntry[] = [
  ...VISIBILITY_ENTRIES,
  e('effect.kind', 'enum', 'colorGrade', { category: 'effect', label: 'effect', choices: [{ value: 'colorGrade' }, { value: 'blur' }, { value: 'vignette' }, { value: 'customPost' }], order: 1 }),
  e('effect.amount', 'number', 1, { category: 'effect', label: 'amount', min: 0, max: 4, step: 0.01, animatable: true, order: 2 }),
  e('effect.shaderId', 'string', '', { category: 'effect', label: 'post shader', order: 3 }),
];
const HELPER_ENTRIES: RegistryEntry[] = [
  ...VISIBILITY_ENTRIES,
  e('helper.kind', 'enum', 'guide', { category: 'helper', label: 'kind', choices: [{ value: 'guide' }, { value: 'grid' }, { value: 'safeArea' }], order: 1 }),
  e('helper.publish', 'boolean', false, { category: 'helper', label: 'include in publish', order: 2 }),
];

propertyRegistry.registerScope({ id: 'camera', label: 'Camera', entries: CAMERA_ENTRIES });
propertyRegistry.registerScope({ id: 'light', label: 'Light', entries: LIGHT_ENTRIES });
propertyRegistry.registerScope({ id: 'mesh', label: 'Mesh', entries: MESH_ENTRIES });
propertyRegistry.registerScope({ id: 'text3d', label: 'Text', entries: TEXT_ENTRIES });
propertyRegistry.registerScope({ id: 'dynamicText', label: 'Dynamic Text', entries: DYNAMIC_TEXT_ENTRIES });
propertyRegistry.registerScope({ id: 'html', label: 'HTML', entries: HTML_ENTRIES });
propertyRegistry.registerScope({ id: 'svg', label: 'SVG', entries: SVG_ENTRIES });
propertyRegistry.registerScope({ id: 'image', label: 'Image', entries: IMAGE_LAYER_ENTRIES });
propertyRegistry.registerScope({ id: 'video', label: 'Video', entries: VIDEO_LAYER_ENTRIES });
propertyRegistry.registerScope({ id: 'audio', label: 'Audio', entries: AUDIO_LAYER_ENTRIES });
propertyRegistry.registerScope({ id: 'effect', label: 'Effect', entries: EFFECT_LAYER_ENTRIES });
propertyRegistry.registerScope({ id: 'helper', label: 'Helper', entries: HELPER_ENTRIES });
propertyRegistry.registerScope({ id: 'field', label: 'Field', entries: FIELD_ENTRIES });
propertyRegistry.registerScope({ id: 'environment', label: 'Environment', entries: ENVIRONMENT_ENTRIES });
propertyRegistry.registerScope({ id: 'render', label: 'Render', entries: RENDER_ENTRIES });
propertyRegistry.registerScope({ id: 'quality', label: 'Quality Profile', entries: QUALITY_ENTRIES });
propertyRegistry.registerScope({ id: 'output', label: 'Output', entries: OUTPUT_ENTRIES });
propertyRegistry.registerScope({ id: 'aov', label: 'AOV', entries: AOV_ENTRIES });

export function registerMaterialScope(shaderId: string, entries: RegistryEntry[]): void {
  propertyRegistry.registerScope({ id: `material:${shaderId}`, label: shaderId, entries });
}

export function materialEntries(shaderId: string): RegistryEntry[] {
  return propertyRegistry.getScope(`material:${shaderId}`)?.entries ?? [];
}

export function findEntry(scope: string, path: string): RegistryEntry | undefined {
  return propertyRegistry.find(scope, path);
}

export function scopeDefaults(scope: string): Record<string, unknown> {
  return propertyRegistry.defaults(scope);
}

export function clampToRegistry(scope: string, path: string, value: unknown): unknown {
  const entry = propertyRegistry.find(scope, path);
  if (!entry) return value;
  return propertyRegistry.clampValue(entry, value);
}

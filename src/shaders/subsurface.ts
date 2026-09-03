/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MaterialDef, ShaderDef } from '../core/types';
import { createId } from '../core/ids';

export const SUBSURFACE_SHADER_ID = 'shd_subsurface';

export function createSubsurfaceShader(): ShaderDef {
  return {
    id: SUBSURFACE_SHADER_ID,
    name: 'Subsurface',
    domain: 'surface',
    backends: ['webgpu', 'webgl'],
    parameters: [
      { path: 'baseColor', type: 'color', default: '#e5c8b8', value: '#e5c8b8' },
      { path: 'subsurfaceColor', type: 'color', default: '#ff6a4a', value: '#ff6a4a' },
      { path: 'subsurfaceStrength', type: 'number', label: 'Scattering strength', default: 0.6, value: 0.6, min: 0, max: 4, animatable: true },
      { path: 'subsurfaceRadius', type: 'number', label: 'Scattering radius', description: 'Controls the broad and tight scattering lobes through the material.', default: 0.4, value: 0.4, min: 0.01, max: 4, animatable: true },
      { path: 'subsurfaceBackscatter', type: 'number', label: 'Backscatter', default: 0.65, value: 0.65, min: 0, max: 1, animatable: true },
      { path: 'subsurfaceWrap', type: 'number', label: 'Light wrap', default: 0.45, value: 0.45, min: 0, max: 1, animatable: true },
      { path: 'roughness', type: 'number', default: 0.55, value: 0.55, min: 0, max: 1 },
      { path: 'metalness', type: 'number', default: 0, value: 0, min: 0, max: 1 },
      { path: 'transmission', type: 'number', label: 'Diffuse transmission', default: 0.08, value: 0.08, min: 0, max: 1, animatable: true },
      { path: 'thickness', type: 'number', label: 'Material thickness', default: 0.35, value: 0.35, min: 0, max: 10, animatable: true },
      { path: 'ior', type: 'number', label: 'Index of refraction', default: 1.4, value: 1.4, min: 1, max: 2.5 },
      { path: 'attenuationDistance', type: 'number', label: 'Scattering distance', default: 0.65, value: 0.65, min: 0.01, max: 100, animatable: true },
      { path: 'sheen', type: 'number', default: 0.1, value: 0.1, min: 0, max: 1 },
      { path: 'sheenColor', type: 'color', default: '#ffffff', value: '#ffffff' },
      { path: 'clearcoat', type: 'number', default: 0, value: 0, min: 0, max: 1 },
      { path: 'clearcoatRoughness', type: 'number', default: 0.4, value: 0.4, min: 0, max: 1 },
      { path: 'emissiveColor', type: 'color', default: '#000000', value: '#000000' },
      { path: 'emissiveIntensity', type: 'number', default: 0, value: 0, min: 0, max: 10 },
      { path: 'bloom', type: 'boolean', default: false, value: false },
    ],
    textureSlots: [
      { slot: 'map', role: 'baseColor', colorSpace: 'sRGB', uvChannel: 0 },
      { slot: 'normalMap', role: 'normal', colorSpace: 'data', uvChannel: 0 },
      { slot: 'aoMap', role: 'ambientOcclusion', colorSpace: 'data', channel: 'r', uvChannel: 1 },
      { slot: 'thicknessMap', role: 'thickness', colorSpace: 'data', channel: 'g', uvChannel: 0 },
    ],
  };
}

export function createSubsurfaceMaterial(name = 'Subsurface', overrides: Partial<MaterialDef['parameters']> = {}): MaterialDef {
  return {
    id: createId('material'),
    name,
    shaderId: SUBSURFACE_SHADER_ID,
    parameters: {
      baseColor: '#e5c8b8',
      subsurfaceColor: '#ff6a4a',
      subsurfaceStrength: 0.6,
      subsurfaceRadius: 0.4,
      subsurfaceBackscatter: 0.65,
      subsurfaceWrap: 0.45,
      roughness: 0.55,
      metalness: 0,
      transmission: 0.08,
      thickness: 0.35,
      ior: 1.4,
      attenuationDistance: 0.65,
      sheen: 0.1,
      sheenColor: '#ffffff',
      clearcoat: 0,
      clearcoatRoughness: 0.4,
      emissiveColor: '#000000',
      emissiveIntensity: 0,
      bloom: false,
      ...overrides,
    },
  };
}

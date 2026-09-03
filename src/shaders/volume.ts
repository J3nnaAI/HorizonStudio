/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MaterialDef, ShaderDef } from '../core/types';
import { createId } from '../core/ids';

export const VOLUME_SHADER_ID = 'shd_volume';

export function createVolumeShader(): ShaderDef {
  return {
    id: VOLUME_SHADER_ID,
    name: 'Volume',
    domain: 'volume',
    backends: ['webgpu', 'webgl'],
    parameters: [
      { path: 'color', type: 'color', default: '#e5c8b8', value: '#e5c8b8' },
      { path: 'density', type: 'number', default: 0.5, value: 0.5, min: 0, max: 20, animatable: true },
      { path: 'scattering', type: 'number', default: 1, value: 1, min: 0, max: 4 },
      { path: 'anisotropy', type: 'number', default: 0.2, value: 0.2, min: -0.99, max: 0.99 },
      { path: 'noiseScale', type: 'number', default: 1, value: 1, min: 0.01, max: 20 },
      { path: 'noiseIntensity', type: 'number', default: 0.5, value: 0.5, min: 0, max: 4 },
      { path: 'steps', type: 'integer', default: 32, value: 32, min: 4, max: 256 },
      { path: 'shadowSteps', type: 'integer', default: 4, value: 4, min: 0, max: 64 },
      { path: 'emissiveColor', type: 'color', default: '#000000', value: '#000000' },
      { path: 'emissiveIntensity', type: 'number', default: 0, value: 0, min: 0, max: 10 },
      { path: 'bloom', type: 'boolean', default: true, value: true },
    ],
  };
}

export function createVolumeMaterial(name = 'Volume', overrides: Partial<MaterialDef['parameters']> = {}): MaterialDef {
  return {
    id: createId('material'),
    name,
    shaderId: VOLUME_SHADER_ID,
    parameters: {
      color: '#e5c8b8',
      density: 0.5,
      scattering: 1,
      anisotropy: 0.2,
      noiseScale: 1,
      noiseIntensity: 0.5,
      steps: 32,
      shadowSteps: 4,
      emissiveColor: '#000000',
      emissiveIntensity: 0,
      bloom: true,
      ...overrides,
    },
  };
}

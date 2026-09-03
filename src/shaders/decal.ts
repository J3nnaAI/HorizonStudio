/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MaterialDef, ShaderDef } from '../core/types';
import { createId } from '../core/ids';

export const DECAL_SHADER_ID = 'shd_decal';

export function createDecalShader(): ShaderDef {
  return {
    id: DECAL_SHADER_ID,
    name: 'Decal',
    domain: 'surface',
    backends: ['webgpu', 'webgl'],
    parameters: [
      { path: 'color', type: 'color', default: '#ffffff', value: '#ffffff' },
      { path: 'opacity', type: 'number', default: 1, value: 1, min: 0, max: 1, animatable: true },
      { path: 'roughness', type: 'number', default: 0.6, value: 0.6, min: 0, max: 1 },
      { path: 'metalness', type: 'number', default: 0, value: 0, min: 0, max: 1 },
      { path: 'depthOffset', type: 'number', default: -0.001, value: -0.001, min: -0.1, max: 0.1 },
      { path: 'polygonOffsetFactor', type: 'number', default: -1, value: -1, min: -8, max: 8 },
      { path: 'polygonOffsetUnits', type: 'number', default: -4, value: -4, min: -32, max: 32 },
      { path: 'projectionScale', type: 'number', default: 1, value: 1, min: 0.01, max: 10 },
    ],
    textureSlots: [
      { slot: 'map', role: 'baseColor', colorSpace: 'sRGB', uvChannel: 0 },
      { slot: 'alphaMap', role: 'opacity', colorSpace: 'data', channel: 'r', uvChannel: 0 },
      { slot: 'normalMap', role: 'normal', colorSpace: 'data', uvChannel: 0 },
    ],
  };
}

export function createDecalMaterial(name = 'Decal', overrides: Partial<MaterialDef['parameters']> = {}): MaterialDef {
  return {
    id: createId('material'),
    name,
    shaderId: DECAL_SHADER_ID,
    parameters: {
      color: '#ffffff',
      opacity: 1,
      roughness: 0.6,
      metalness: 0,
      depthOffset: -0.001,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
      projectionScale: 1,
      ...overrides,
    },
  };
}

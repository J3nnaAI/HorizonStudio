/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MaterialDef, ShaderDef } from '../core/types';
import { createId } from '../core/ids';

export const UNLIT_SHADER_ID = 'shd_unlit';

export function createUnlitShader(): ShaderDef {
  return {
    id: UNLIT_SHADER_ID,
    name: 'Unlit',
    domain: 'surface',
    backends: ['webgpu', 'webgl'],
    parameters: [
      { path: 'color', type: 'color', default: '#ffffff', value: '#ffffff', animatable: true },
      { path: 'opacity', type: 'number', default: 1, value: 1, min: 0, max: 1, animatable: true },
      { path: 'transparent', type: 'boolean', default: false, value: false },
      { path: 'doubleSided', type: 'boolean', default: false, value: false },
      { path: 'toneMapped', type: 'boolean', default: true, value: true },
      { path: 'depthWrite', type: 'boolean', default: true, value: true },
      { path: 'bloom', type: 'boolean', default: true, value: true },
    ],
    textureSlots: [
      { slot: 'map', role: 'baseColor', colorSpace: 'sRGB', uvChannel: 0 },
      { slot: 'alphaMap', role: 'opacity', colorSpace: 'data', uvChannel: 0 },
    ],
  };
}

export function createUnlitMaterial(name = 'Unlit', overrides: Partial<MaterialDef['parameters']> = {}): MaterialDef {
  return {
    id: createId('material'),
    name,
    shaderId: UNLIT_SHADER_ID,
    parameters: {
      color: '#ffffff',
      opacity: 1,
      transparent: false,
      doubleSided: false,
      toneMapped: true,
      depthWrite: true,
      bloom: true,
      ...overrides,
    },
  };
}

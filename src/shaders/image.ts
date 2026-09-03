/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ShaderDef } from '../core/types';

export const IMAGE_SHADER_ID = 'shd_image';

export function createImageShader(): ShaderDef {
  return {
    id: IMAGE_SHADER_ID,
    name: 'Image Surface',
    domain: 'surface',
    backends: ['webgpu', 'webgl'],
    parameters: [
      { path: 'assetId', type: 'asset', default: '', value: '' },
      { path: 'opacity', type: 'number', default: 1, value: 1, min: 0, max: 1, animatable: true, runtimeMutable: true },
      { path: 'roughness', type: 'number', default: 0.78, value: 0.78, min: 0, max: 1 },
      { path: 'metalness', type: 'number', default: 0, value: 0, min: 0, max: 1 },
      { path: 'emissiveIntensity', type: 'number', default: 0, value: 0, min: 0, max: 10, animatable: true },
      { path: 'emissiveColor', type: 'color', default: '#000000', value: '#000000' },
      { path: 'doubleSided', type: 'boolean', default: true, value: true },
      { path: 'toneMapped', type: 'boolean', default: true, value: true },
      { path: 'transparent', type: 'boolean', default: true, value: true },
      { path: 'depthWrite', type: 'boolean', default: false, value: false },
      { path: 'bloom', type: 'boolean', default: false, value: false },
    ],
    textureSlots: [
      { slot: 'map', role: 'baseColor', colorSpace: 'sRGB', uvChannel: 0 },
      { slot: 'alphaMap', role: 'opacity', colorSpace: 'data', channel: 'a', uvChannel: 0 },
      { slot: 'emissiveMap', role: 'emissive', colorSpace: 'sRGB', uvChannel: 0 },
    ],
  };
}
